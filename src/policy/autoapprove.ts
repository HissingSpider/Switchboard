import { createHash } from 'node:crypto';
import { ClaudeProcess } from '../runner/claude.js';
import { WarmSession } from '../voice/warm.js';
import type { LoadedConfig } from '../config/load.js';
import type { EventLog } from '../store/eventlog.js';
import type { ToolCall } from './match.js';
import { anyMatch, argLine } from './match.js';
import { logger } from '../core/logger.js';

const log = logger('autoapprove');

/**
 * Auto-approval: a cheap model deciding which confirmations are worth your
 * attention.
 *
 * The gate is right about *what* needs a decision and hopeless at judging *how
 * much* it matters — `rm -rf node_modules` and `rm -rf ~/Documents` are the same
 * shape. So a small fast model reads the actual command in context and answers
 * one question: is this recoverable?
 *
 * The design is deliberately lopsided. A wrong "ask" costs you two seconds of
 * annoyance. A wrong "approve" can be unrecoverable. So:
 *
 *  - It can only ever turn `confirm` into `allow`. It never overrides a deny,
 *    and never sees anything the hard-deny list already refused.
 *  - Categories that leave the machine — send, publish, push, purchase, delete
 *    remote data — are never auto-approvable, whatever the model says. Those
 *    are not judgement calls about recoverability; they are decisions with your
 *    name on them.
 *  - Anything other than a confident, well-reasoned "safe" falls through to
 *    asking you. Timeouts, malformed output, low confidence, an unparseable
 *    command: all ask.
 *  - Every decision is written to the event log with the model's reasoning, so
 *    an auto-approval is as auditable as one you made yourself.
 */
export interface AutoApproveConfig {
  enabled: boolean;
  /** A small fast model. This is a judgement about blast radius, not a hard problem. */
  model?: string;
  /** Below this confidence it asks you regardless. 0..1 */
  minConfidence?: number;
  /** Seconds to wait before giving up and asking. */
  timeoutSec?: number;
  /**
   * Shapes that can never be auto-approved, on top of the built-in list.
   * Uses the same spec syntax as permission profiles.
   */
  neverAutoApprove?: string[];
}

export const DEFAULT_AUTO_APPROVE: AutoApproveConfig = {
  enabled: false,
  minConfidence: 0.85,
  timeoutSec: 20,
};

/**
 * Never auto-approvable, regardless of what the classifier concludes.
 *
 * Everything here either leaves this machine or destroys something that no
 * `git checkout` brings back. The classifier is not consulted, because the
 * question is not "is this recoverable" — it is "should a machine be allowed to
 * decide this on your behalf", and the answer is no.
 */
export const NEVER_AUTO: Array<{ spec: string; why: string }> = [
  { spec: 'Bash(*git push*)', why: 'publishes to a remote' },
  { spec: 'Bash(*gh pr*)', why: 'opens or changes a pull request' },
  { spec: 'Bash(*gh release*)', why: 'publishes a release' },
  { spec: 'Bash(*npm publish*)', why: 'publishes a package' },
  { spec: 'Bash(*rm -rf /*)', why: 'destroys the filesystem' },
  { spec: 'Bash(*osascript*)', why: 'drives other applications' },
  { spec: 'Bash(*security *)', why: 'touches the Keychain' },
  { spec: 'Bash(*sudo *)', why: 'escalates privilege' },
  { spec: 'Bash(*curl*-X POST*)', why: 'sends data off this machine' },
  { spec: 'Bash(*curl*-d *)', why: 'sends data off this machine' },
  { spec: 'mcp__*__send*', why: 'sends a message as you' },
  { spec: 'mcp__*__post*', why: 'posts content as you' },
  { spec: 'mcp__*__buy*', why: 'spends money' },
  { spec: 'mcp__*__delete*', why: 'deletes remote data' },
  { spec: 'mcp__*__deploy*', why: 'deploys' },
];

export type AutoVerdict =
  | { decision: 'approve'; confidence: number; reason: string; ms: number }
  | { decision: 'ask'; reason: string; ms: number };

const PROMPT = (call: ToolCall, context: { project?: string; workdir?: string; task?: string }) =>
  [
    'You are a safety check for an unattended coding agent. Answer one question about one action.',
    '',
    'The action:',
    `  tool: ${call.tool}`,
    `  argument: ${argLine(call)}`,
    context.project ? `  project: ${context.project}` : '',
    context.workdir ? `  working directory: ${context.workdir}` : '',
    context.task ? `  the task it was asked to do: ${context.task}` : '',
    '',
    'Question: if this action turns out to be wrong, can it be fully undone in under a minute',
    'by someone sitting at this machine, without contacting anyone else or losing work they',
    'cannot recreate?',
    '',
    'Say SAFE only when all of these hold:',
    '  - It affects only files inside the working directory, or nothing at all.',
    '  - It is covered by version control, or the files are regenerable (build output,',
    '    node_modules, caches, lockfiles that can be reinstalled).',
    '  - It does not send, publish, deploy, purchase, or delete anything outside this machine.',
    '  - It does not touch credentials, keys, or system configuration.',
    '  - It is plainly related to the task above.',
    '',
    'If you are unsure, say ASK. Being wrong about SAFE is far worse than being wrong about ASK.',
    '',
    'Reply with exactly one line of JSON and nothing else:',
    '{"verdict":"SAFE"|"ASK","confidence":0.0-1.0,"reason":"<under 15 words>"}',
  ]
    .filter(Boolean)
    .join('\n');

export class AutoApprover {
  /**
   * A resident classifier process.
   *
   * Spawning `claude -p` per check costs ~12 seconds, almost all of it CLI
   * startup rather than the model — which makes the feature slower than the
   * interruption it replaces. Holding one process open turns that into a socket
   * write.
   */
  private warm: WarmSession | null = null;
  /**
   * Verdicts for identical questions. A run that deletes build output in four
   * places asks once; the answer cannot differ between them, and paying twice
   * for the same judgement is pure latency.
   */
  private readonly cache = new Map<string, { verdict: AutoVerdict; at: number }>();

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly events: EventLog,
    private readonly settings: AutoApproveConfig,
  ) {}

  /** Bring the classifier up so the first gated action doesn't pay for it. */
  async prewarm(): Promise<void> {
    if (!this.enabled || this.warm) return;
    this.warm = new WarmSession({
      bin: this.cfg.claudeBin,
      cwd: this.cfg.resolved.scratchDir,
      model: this.settings.model,
      allowedTools: [],
      permissionMode: 'plan',
      systemPrompt: 'You are a classifier. Every reply is one line of JSON and nothing else.',
      maxTurnsBeforeRecycle: 50,
    });
    await this.warm.start().catch((err: Error) => {
      log.warn('classifier failed to warm — falling back to a fresh process per check', { err: err.message });
      this.warm = null;
    });
  }

  stop(): void {
    this.warm?.stop();
    this.warm = null;
  }

  private cacheKey(call: ToolCall, task?: string): string {
    return createHash('sha256').update(`${call.tool}\u0000${argLine(call)}\u0000${task ?? ''}`).digest('hex');
  }

  get enabled(): boolean {
    return Boolean(this.settings.enabled);
  }

  /** Why an action is not eligible, before any model is asked. */
  ineligible(call: ToolCall): string | undefined {
    const builtIn = NEVER_AUTO.find((n) => anyMatch([n.spec], call));
    if (builtIn) return builtIn.why;
    const custom = anyMatch(this.settings.neverAutoApprove ?? [], call);
    if (custom) return `matches your neverAutoApprove rule ${custom}`;
    return undefined;
  }

  /**
   * Decide. Always resolves — every failure path is an `ask`, because the whole
   * point is that uncertainty goes to the human.
   */
  async consider(call: ToolCall, context: { runId: string; project?: string; workdir?: string; task?: string }): Promise<AutoVerdict> {
    const started = Date.now();
    if (!this.enabled) return { decision: 'ask', reason: 'auto-approve is off', ms: 0 };

    const blocked = this.ineligible(call);
    if (blocked) {
      this.record(context.runId, call, { decision: 'ask', reason: `never auto-approved: ${blocked}`, ms: Date.now() - started });
      return { decision: 'ask', reason: `never auto-approved: ${blocked}`, ms: Date.now() - started };
    }

    // An identical question already answered is answered.
    const key = this.cacheKey(call, context.task);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      return { ...hit.verdict, ms: Date.now() - started };
    }

    let verdict: AutoVerdict;
    try {
      verdict = await this.askModel(call, context, started);
      // Only cache a decisive answer. Caching a timeout would turn one slow
      // moment into ten minutes of unnecessary interruptions.
      if (!/timed out|failed/.test(verdict.reason)) this.cache.set(key, { verdict, at: Date.now() });
    } catch (err) {
      verdict = { decision: 'ask', reason: `safety check failed: ${(err as Error).message}`, ms: Date.now() - started };
    }
    this.record(context.runId, call, verdict);
    return verdict;
  }

  private async askModel(call: ToolCall, context: { project?: string; workdir?: string; task?: string }, started: number): Promise<AutoVerdict> {
    // The warm path, when it is up and not mid-question.
    if (this.warm?.ready && !this.warm.inUse) {
      const turn = this.warm.ask(PROMPT(call, context));
      const timeout = new Promise<AutoVerdict>((r) =>
        setTimeout(() => r({ decision: 'ask', reason: 'safety check timed out', ms: Date.now() - started }), (this.settings.timeoutSec ?? 20) * 1000),
      );
      const answered = turn.done.then((res) => this.interpret(res.text, started));
      const verdict = await Promise.race([answered, timeout]);
      if (verdict.decision === 'ask' && verdict.reason.includes('timed out')) turn.abandon();
      if (this.warm.stale) void this.warm.recycle();
      return verdict;
    }

    return new Promise<AutoVerdict>((resolve) => {
      const proc = new ClaudeProcess({
        bin: this.cfg.claudeBin,
        cwd: this.cfg.resolved.scratchDir,
        prompt: PROMPT(call, context),
        model: this.settings.model,
        maxTurns: 1,
        // No tools at all: this is a judgement about text, and a safety check
        // that can act is not a safety check.
        allowedTools: [],
        permissionMode: 'plan',
        appendSystemPrompt: 'You are a classifier. Emit one line of JSON and nothing else.',
      });

      let text = '';
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ decision: 'ask', reason: 'safety check timed out', ms: Date.now() - started });
      }, (this.settings.timeoutSec ?? 20) * 1000);

      proc.on('event', (ev: { type: string; text?: string }) => {
        if (ev.type === 'text') text += ev.text ?? '';
        else if (ev.type === 'result') text = text || ((ev as { text?: string }).text ?? '');
        else if (ev.type === 'exit') {
          clearTimeout(timeout);
          resolve(this.interpret(text, started));
        }
      });
      proc.start();
    });
  }

  /** Exposed for testing: every non-SAFE path must fall through to asking. */
  interpret(text: string, started: number): AutoVerdict {
    const ms = Date.now() - started;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { decision: 'ask', reason: 'safety check gave no verdict', ms };

    let parsed: { verdict?: string; confidence?: number; reason?: string };
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as typeof parsed;
    } catch {
      return { decision: 'ask', reason: 'safety check output was unparseable', ms };
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const reason = String(parsed.reason ?? '').slice(0, 120) || 'no reason given';
    const min = this.settings.minConfidence ?? 0.85;

    // Anything that is not an explicit, confident SAFE goes to the human.
    if (parsed.verdict !== 'SAFE') return { decision: 'ask', reason, ms };
    if (confidence < min) return { decision: 'ask', reason: `${reason} (confidence ${confidence.toFixed(2)} < ${min})`, ms };
    return { decision: 'approve', confidence, reason, ms };
  }

  private record(runId: string, call: ToolCall, verdict: AutoVerdict): void {
    this.events.append({
      runId,
      kind: verdict.decision === 'approve' ? 'action.confirm_answered' : 'action.gated',
      source: 'autoapprove',
      summary:
        verdict.decision === 'approve'
          ? `auto-approved ${call.tool}: ${truncate(argLine(call), 80)} — ${verdict.reason}`
          : `asking you about ${call.tool}: ${verdict.reason}`,
      data: {
        tool: call.tool,
        argument: argLine(call),
        decision: verdict.decision,
        reason: verdict.reason,
        confidence: verdict.decision === 'approve' ? verdict.confidence : undefined,
        ms: verdict.ms,
        auto: true,
      },
    });
    if (verdict.decision === 'approve') {
      log.info('auto-approved', { tool: call.tool, reason: verdict.reason, ms: verdict.ms });
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
