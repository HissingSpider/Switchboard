import { EventEmitter } from 'node:events';
import type { LoadedConfig } from '../config/load.js';
import type { RunRegistry } from '../runner/registry.js';
import { BudgetExceededError } from '../runner/registry.js';
import type { RunStore, RunRecord } from '../store/runs.js';
import type { SessionStore } from '../store/sessions.js';
import type { EventLog } from '../store/eventlog.js';
import type { ConfirmService } from '../policy/confirm.js';
import type { AgentRegistry } from '../agents/registry.js';
import { resolveProject } from '../router/projects.js';
import { shortId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { Endpointer, EnergyVad, BargeInDetector, DEFAULT_ENDPOINTER } from './vad.js';
import { SentenceStreamer } from './tts.js';
import { EchoGuard } from './echo.js';
import { WarmSession } from './warm.js';
import { classifyInstant, classifyLane, BUDGETS, FillerPicker, TurnTimer, LatencyTracker, type InstantIntent } from './lanes.js';
import { speakable, FRAME_BYTES, type SttEngine, type TtsEngine, type Lane, type VoiceServerMessage } from './types.js';

const log = logger('voice');

export interface VoiceSessionDeps {
  cfg: LoadedConfig;
  registry: RunRegistry;
  runs: RunStore;
  sessions: SessionStore;
  events: EventLog;
  confirms: ConfirmService;
  agents: AgentRegistry;
  stt: SttEngine;
  tts: TtsEngine;
  warm: WarmSession;
  /** Send a control message to the client. */
  send: (msg: VoiceServerMessage) => void;
  /** Send raw PCM16 audio to the client. */
  sendAudio: (pcm: Buffer) => void;
  /** Escalate a confirmation to a text channel. Returns where it went. */
  escalate?: (text: string) => Promise<string | undefined>;
}

export interface VoiceSessionOptions {
  threadId: string;
  agent?: string;
  project?: string;
  /** Continuous listening vs push-to-talk. */
  openMic?: boolean;
}

/**
 * One live voice conversation.
 *
 * The whole design is about the gap between the user stopping and us starting.
 * Everything here — the warm session, the lanes, the filler, sentence-streamed
 * TTS — exists to shrink that gap or to cover it convincingly when it can't be
 * shrunk. Correctness rules that matter: a voice utterance never approves a
 * gated action, and a spoken task is a real run with a real audit trail.
 */
export class VoiceSession extends EventEmitter {
  readonly id = `v-${shortId(4)}`;
  readonly threadId: string;
  private readonly vad = new EnergyVad();
  private readonly endpointer: Endpointer;
  private readonly bargeIn = new BargeInDetector();
  private readonly echo = new EchoGuard();
  private readonly fillers = new FillerPicker();
  readonly latency = new LatencyTracker();

  private speaking = false;
  private streamer: SentenceStreamer | null = null;
  private currentTurn: TurnTimer | null = null;
  private abandonCurrent: (() => void) | null = null;
  private lastSpoken = '';
  private stickyProject?: string;
  private pendingTasks = new Map<string, string>();
  private closed = false;
  private tail = Buffer.alloc(0);

  constructor(
    private readonly d: VoiceSessionDeps,
    private readonly opts: VoiceSessionOptions,
  ) {
    super();
    this.threadId = opts.threadId;
    this.stickyProject = opts.project;
    this.endpointer = new Endpointer(this.vad, {
      ...DEFAULT_ENDPOINTER,
      // Open-mic needs a longer silence window or it cuts you off mid-thought.
      silenceMs: opts.openMic ? 900 : 600,
    });

    // A run finishing is the only thing that speaks without being spoken to.
    this.onRunFinished = this.onRunFinished.bind(this);
    this.d.registry.on('finished', this.onRunFinished);
  }

  async start(): Promise<void> {
    await this.d.warm.start().catch((err: Error) => log.warn('warm start failed', { err: err.message }));
    void this.d.stt.warm?.();
    this.d.events.append({
      runId: null,
      kind: 'message.in',
      source: 'voice',
      summary: `voice session ${this.id} opened on ${this.threadId}`,
      data: { sessionId: this.id, threadId: this.threadId, stt: this.d.stt.name, tts: this.d.tts.name },
    });
    this.d.send({
      type: 'ready',
      sessionId: this.id,
      threadId: this.threadId,
      agent: this.opts.agent,
      sttReady: this.d.stt.available,
      ttsReady: this.d.tts.available,
    });
  }

  /** Raw PCM16 @16 kHz from the client. */
  pushAudio(chunk: Buffer): void {
    if (this.closed) return;

    // While we're talking, the mic is only being watched for barge-in. Feeding
    // it to the endpointer as well would transcribe our own voice back at us.
    if (this.speaking) {
      const data = Buffer.concat([this.tail, chunk]);
      const usable = data.length - (data.length % FRAME_BYTES);
      this.tail = Buffer.from(data.subarray(usable));
      for (let off = 0; off < usable; off += FRAME_BYTES) {
        const frame = data.subarray(off, off + FRAME_BYTES);
        // Our own voice coming back through the speaker must not count as
        // barge-in, so the frame has to clear the echo-aware threshold first.
        if (!this.echo.isForeign(frame)) continue;
        if (this.bargeIn.observe(frame, this.vad)) {
          this.interrupt('barge-in');
          break;
        }
      }
      return;
    }

    for (const ev of this.endpointer.push(chunk)) {
      if (ev.type === 'speech_start') this.d.send({ type: 'listening' });
      else if (ev.type === 'speech_end' || ev.type === 'timeout') void this.handleUtterance(ev.pcm);
    }
  }

  /** Push-to-talk release. */
  finishUtterance(): void {
    const pcm = this.endpointer.finish();
    if (pcm?.length) void this.handleUtterance(pcm);
  }

  /** Typed input from the client — same pipeline, skipping STT. */
  handleText(text: string): void {
    void this.respondTo(text);
  }

  private async handleUtterance(pcm: Buffer): Promise<void> {
    if (!this.d.stt.available) {
      await this.say("Speech recognition isn't set up on this machine yet.");
      return;
    }
    try {
      const transcript = await this.d.stt.transcribe(pcm);
      if (!transcript.text || transcript.text.length < 2) return;
      this.d.send({ type: 'final', text: transcript.text });
      await this.respondTo(transcript.text);
    } catch (err) {
      log.warn('transcription failed', { err: (err as Error).message });
      this.d.send({ type: 'error', message: `transcription failed: ${(err as Error).message}` });
    }
  }

  private async respondTo(text: string): Promise<void> {
    this.d.events.append({
      runId: null,
      kind: 'message.in',
      source: 'voice',
      summary: `voice: ${text}`,
      data: { sessionId: this.id, threadId: this.threadId, text },
    });

    // A confirmation is never answered by voice. Speech recognition mishears
    // "no" as "go" often enough that treating it as consent for an irreversible
    // action is not a risk worth taking — say so and leave it on text.
    const openConfirms = this.d.confirms.pending();
    if (openConfirms.length && /^(yes|yeah|yep|ok|okay|no|nope|approve|deny)\b/i.test(text.trim())) {
      const c = openConfirms[0]!;
      const where = await this.d.escalate?.(
        `${c.runId} wants to ${c.tool}: ${c.detail}\nReply "ok ${c.id.slice(2)}" or "no ${c.id.slice(2)}".`,
      );
      this.d.send({ type: 'confirm_escalated', confirmId: c.id, via: where ?? 'none' });
      await this.say(
        where
          ? `I can't approve that by voice. I've sent it to your ${where} — answer it there.`
          : "I can't approve that by voice, and I couldn't reach a text channel to send it to.",
      );
      return;
    }

    const lane = classifyLane(text);
    this.d.send({ type: 'thinking', lane });

    switch (lane) {
      case 'instant':
        return this.handleInstant(text);
      case 'task':
        return this.handleTask(text);
      case 'query':
        return this.handleQuery(text);
    }
  }

  // ------------------------------------------------------------ instant lane

  private async handleInstant(text: string): Promise<void> {
    const intent = classifyInstant(text);
    const timer = this.beginTurn('instant');
    const reply = intent ? this.answerInstant(intent) : undefined;
    if (reply === undefined) {
      // Classified instant but we have no local answer — fall through rather
      // than say nothing.
      timer.settle();
      return this.handleQuery(text);
    }
    this.latency.record('instant', timer.settle());
    if (reply) await this.say(reply);
  }

  private answerInstant(intent: InstantIntent): string | undefined {
    switch (intent.kind) {
      case 'stop':
        this.interrupt('user');
        return '';
      case 'cancel_run': {
        const active = this.d.runs.active();
        const target = active[active.length - 1];
        if (!target) return 'Nothing is running.';
        this.d.registry.kill(target.id, 'cancelled by voice');
        return `Killed ${spellRunId(target.id)}.`;
      }
      case 'status': {
        const s = this.d.registry.status();
        const active = this.d.runs.active();
        if (!active.length) return 'Nothing running.';
        return `${active.length} running: ${active.map((r) => `${r.project ?? 'scratch'}, ${shorten(r.prompt)}`).join('. ')}. ${s.queued} queued.`;
      }
      case 'runs': {
        const recent = this.d.runs.list({ limit: 3 });
        if (!recent.length) return 'No runs yet.';
        return recent.map((r) => `${r.status}, ${r.project ?? 'scratch'}, ${shorten(r.prompt)}`).join('. ');
      }
      case 'cost': {
        const spend = this.d.runs.monthSpend();
        return `${formatMoney(spend)} of ${formatMoney(this.d.cfg.caps.monthlyBudgetUsd)} this month.`;
      }
      case 'repeat':
        return this.lastSpoken || 'I have not said anything yet.';
      case 'acknowledge':
        return '';
      case 'goodbye':
        void this.close();
        return 'Talk later.';
      case 'time':
        return `It's ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    }
  }

  // -------------------------------------------------------------- query lane

  private async handleQuery(text: string): Promise<void> {
    const timer = this.beginTurn('query');

    if (!this.d.warm.ready) {
      await this.d.warm.start().catch(() => undefined);
    }
    if (!this.d.warm.ready || this.d.warm.inUse) {
      timer.settle();
      await this.say("I'm still busy with the last thing — say it again in a moment.");
      return;
    }

    const context = this.stickyProject ? `\n\n(The current project is ${this.stickyProject}.)` : '';
    const turn = this.d.warm.ask(`${text}${context}`);
    this.abandonCurrent = turn.abandon;

    const streamer = new SentenceStreamer(this.d.tts, async (pcm, sentence) => {
      if (!timer.done) this.latency.record('query', timer.settle());
      // The client renders what it is hearing, so every sentence that goes out
      // as audio also goes out as text — otherwise a spoken answer leaves no
      // trace in the transcript.
      this.d.send({ type: 'say', text: sentence, audioBytes: pcm.length });
      await this.emitAudio(pcm);
    });
    this.streamer = streamer;
    this.speaking = true;

    turn.onText((chunk) => streamer.push(chunk));
    const result = await turn.done;
    await streamer.end();
    this.finishSpeaking();
    this.lastSpoken = speakable(result.text);
    timer.settle();

    this.d.events.append({
      runId: null,
      kind: 'message.out',
      source: 'voice',
      summary: `voice reply (${result.ms}ms, ${formatMoney(result.costUsd)}): ${shorten(result.text, 160)}`,
      data: { sessionId: this.id, ms: result.ms, costUsd: result.costUsd, lane: 'query' },
    });

    // Recycling between turns keeps the next one fast and the session small.
    if (this.d.warm.stale) void this.d.warm.recycle();
  }

  // --------------------------------------------------------------- task lane

  private async handleTask(text: string): Promise<void> {
    const timer = this.beginTurn('task');
    const { match, text: stripped } = resolveProject(this.d.cfg, text, this.stickyProject);
    if (match) this.stickyProject = match.project.name;

    try {
      const run = this.d.registry.submit({
        prompt: stripped,
        project: match?.project.name,
        agent: this.opts.agent,
        intent: 'task',
        channel: 'dashboard',
        threadId: this.threadId,
        continueSession: false,
      });
      this.pendingTasks.set(run.id, stripped);
      this.d.send({ type: 'run_started', runId: run.id });
      this.latency.record('task', timer.settle());
      // Verbal ack now; the result comes back whenever it comes back.
      await this.say(match ? `Started that in ${match.project.name}. I'll tell you when it's done.` : "Started. I'll tell you when it's done.");
    } catch (err) {
      timer.settle();
      if (err instanceof BudgetExceededError) {
        await this.say("I can't start that — the monthly budget is used up.");
        return;
      }
      await this.say(`I couldn't start that. ${(err as Error).message}`);
    }
  }

  private onRunFinished(run: RunRecord): void {
    const prompt = this.pendingTasks.get(run.id);
    if (!prompt) return;
    this.pendingTasks.delete(run.id);
    const summary =
      run.status === 'done'
        ? `Finished ${shorten(prompt)}. ${describeResult(run)}`
        : `${shorten(prompt)} ${run.status === 'killed' ? 'was stopped' : 'failed'}. ${run.error ?? ''}`;
    this.d.send({ type: 'run_finished', runId: run.id, summary });
    void this.say(summary);
  }

  // ---------------------------------------------------------------- speaking

  private beginTurn(lane: Lane): TurnTimer {
    this.currentTurn?.settle();
    const timer = new TurnTimer(
      BUDGETS[lane],
      () => void this.sayFiller(lane),
      () => void this.say("Sorry — that's taking longer than expected."),
    );
    this.currentTurn = timer;
    return timer;
  }

  private async sayFiller(lane: Lane): Promise<void> {
    if (this.speaking) return;
    await this.say(this.fillers.pick(lane), { filler: true });
  }

  /** Synthesise and stream one utterance to the client. */
  async say(text: string, opts: { filler?: boolean } = {}): Promise<void> {
    const clean = speakable(text);
    if (!clean || this.closed) return;
    this.d.send({ type: 'say', text: clean, audioBytes: 0 });
    if (!opts.filler) this.lastSpoken = clean;

    const streamer = new SentenceStreamer(this.d.tts, async (pcm) => this.emitAudio(pcm));
    this.streamer = streamer;
    this.speaking = true;
    streamer.push(clean);
    await streamer.end();
    this.finishSpeaking();

    if (!opts.filler) {
      this.d.events.append({
        runId: null,
        kind: 'message.out',
        source: 'voice',
        summary: `spoke: ${shorten(clean, 160)}`,
        data: { sessionId: this.id, threadId: this.threadId, text: clean },
      });
    }
  }

  private async emitAudio(pcm: Buffer): Promise<void> {
    if (this.closed || !this.speaking) return;
    this.echo.observeOutput(pcm);
    this.d.sendAudio(pcm);
  }

  private finishSpeaking(): void {
    this.speaking = false;
    this.streamer = null;
    this.bargeIn.reset();
    this.endpointer.reset();
    this.echo.reset();
    this.tail = Buffer.alloc(0);
    this.d.send({ type: 'audio_end' });
  }

  /** Cut off playback immediately — barge-in or an explicit "stop". */
  interrupt(reason: 'barge-in' | 'user'): void {
    if (!this.speaking && !this.currentTurn) return;
    this.streamer?.cancel();
    this.abandonCurrent?.();
    this.abandonCurrent = null;
    this.currentTurn?.settle();
    this.currentTurn = null;
    this.speaking = false;
    this.streamer = null;
    this.bargeIn.reset();
    this.endpointer.reset();
    this.d.send({ type: 'interrupted', reason });
    this.d.events.append({
      runId: null,
      kind: 'message.out',
      source: 'voice',
      summary: `interrupted (${reason})`,
      data: { sessionId: this.id, reason },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.streamer?.cancel();
    this.d.registry.off('finished', this.onRunFinished);
    this.d.events.append({
      runId: null,
      kind: 'message.out',
      source: 'voice',
      summary: `voice session ${this.id} closed`,
      data: { sessionId: this.id, latency: this.latency.summary() },
    });
    this.emit('closed');
  }
}

function shorten(text: string, n = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Run ids get read aloud, so space them out rather than saying "rbq6f4". */
function spellRunId(id: string): string {
  return id.replace('r-', 'run ').split('').join(' ').replace(/r u n/, 'run');
}

function formatMoney(usd: number): string {
  if (usd < 1) return `${Math.round(usd * 100)} cents`;
  return `${usd.toFixed(2)} dollars`;
}

function describeResult(run: RunRecord): string {
  const result = (run.result ?? '').trim();
  if (!result) return 'No summary.';
  const firstSentence = result.split(/(?<=[.!?])\s/)[0] ?? result;
  return speakable(shorten(firstSentence, 220));
}
