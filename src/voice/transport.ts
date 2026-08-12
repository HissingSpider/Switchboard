import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { join } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { logger } from '../core/logger.js';
import { resolveMcpSet, writeMcpConfig } from '../runner/mcp.js';
import { VoiceSession, type VoiceSessionDeps } from './session.js';
import { WarmSession } from './warm.js';
import { pickStt } from './stt.js';
import { pickTts } from './tts.js';
import { SAMPLE_RATE, type VoiceClientMessage, type VoiceServerMessage, type SttEngine, type TtsEngine } from './types.js';

const log = logger('voice:transport');

export const VOICE_PATH = '/voice';

/**
 * Transport is a plain WebSocket carrying raw PCM, not WebRTC.
 *
 * WebRTC buys jitter buffers, NAT traversal and Opus — none of which we need:
 * the phone and the Mac Mini are on the same tailnet, which is already
 * encrypted, already routable, and fast enough that a 20 ms PCM frame is 640
 * bytes of nothing. Skipping it removes a signalling server, a TURN dependency
 * and a codec from the latency path.
 *
 * Binary frames are audio. Text frames are JSON control messages.
 */
export interface VoiceServerDeps extends Omit<VoiceSessionDeps, 'send' | 'sendAudio' | 'stt' | 'tts' | 'warm'> {
  /** Escalate a confirmation to a text channel; returns the channel name. */
  escalate?: (text: string) => Promise<string | undefined>;
}

export interface VoiceConfig {
  enabled: boolean;
  /** 'whisper' | 'macos'. */
  sttEngine?: string;
  whisperBinary?: string;
  whisperModel?: string;
  /** 'piper' | 'kokoro' | 'say'. */
  ttsEngine?: string;
  ttsVoice?: string;
  piperModel?: string;
  /** Continuous listening rather than push-to-talk. */
  openMic?: boolean;
  /** Model for the warm conversational session — a small one is the point. */
  model?: string;
  wakeWord?: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: true,
  openMic: false,
  ttsVoice: 'Samantha',
};

const VOICE_SYSTEM_PROMPT = [
  'You are being listened to, not read. Everything you say is spoken aloud by a text-to-speech engine.',
  'Answer in one or two sentences. No markdown, no lists, no code blocks, no URLs — say "I sent you the link" instead.',
  'Lead with the answer. If you need to look something up, look it up; do not narrate that you are about to.',
  'If a question actually requires editing files, say so in one sentence rather than trying to do it here.',
].join(' ');

export class VoiceServer {
  private readonly sessions = new Map<WebSocket, VoiceSession>();
  private stt: SttEngine;
  private tts: TtsEngine;
  private warm: WarmSession | null = null;

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly voiceCfg: VoiceConfig,
    private readonly deps: VoiceServerDeps,
  ) {
    this.stt = pickStt({ binary: voiceCfg.whisperBinary, model: voiceCfg.whisperModel });
    this.tts = pickTts({ engine: voiceCfg.ttsEngine, voice: voiceCfg.ttsVoice, piperModel: voiceCfg.piperModel });
  }

  get enabled(): boolean {
    return this.voiceCfg.enabled;
  }

  status(): { enabled: boolean; stt: string; sttReady: boolean; tts: string; ttsReady: boolean; sessions: number; warm: boolean } {
    return {
      enabled: this.enabled,
      stt: this.stt.name,
      sttReady: this.stt.available,
      tts: this.tts.name,
      ttsReady: this.tts.available,
      sessions: this.sessions.size,
      warm: Boolean(this.warm?.ready),
    };
  }

  /**
   * Bring up the warm session before anyone connects. Called on daemon start so
   * the first spoken question doesn't pay for a cold CLI.
   */
  async prewarm(): Promise<void> {
    if (!this.enabled) return;
    this.warm = this.buildWarmSession();
    await Promise.all([
      this.warm.start().catch((err: Error) => log.warn('warm session failed to start', { err: err.message })),
      this.stt.warm?.().catch(() => undefined) ?? Promise.resolve(),
    ]);
    log.info('voice ready', this.status());
  }

  private buildWarmSession(): WarmSession {
    const servers = resolveMcpSet(this.cfg, this.cfg.routerMcpSet);
    const mcpConfigPath = writeMcpConfig(join(this.cfg.resolved.dataDir, 'voice'), servers);
    return new WarmSession({
      bin: this.cfg.claudeBin,
      cwd: this.cfg.resolved.scratchDir,
      model: this.voiceCfg.model,
      systemPrompt: VOICE_SYSTEM_PROMPT,
      // The voice lane is read-mostly by design; anything that writes goes
      // through the task lane, which is a real gated run.
      allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      mcpConfigPath,
      permissionMode: 'default',
      maxTurnsBeforeRecycle: 25,
    });
  }

  /** Attach a newly upgraded socket. */
  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.enabled) {
      ws.close(1013, 'voice disabled');
      return;
    }
    const url = new URL(req.url ?? VOICE_PATH, 'http://localhost');
    const threadId = url.searchParams.get('thread') ?? `voice:${req.socket.remoteAddress ?? 'local'}`;
    const agent = url.searchParams.get('agent') ?? undefined;
    const project = url.searchParams.get('project') ?? undefined;

    if (!this.warm) this.warm = this.buildWarmSession();

    const send = (msg: VoiceServerMessage): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    const sendAudio = (pcm: Buffer): void => {
      if (ws.readyState === 1) ws.send(pcm, { binary: true });
    };

    const session = new VoiceSession(
      { ...this.deps, stt: this.stt, tts: this.tts, warm: this.warm, send, sendAudio, escalate: this.deps.escalate },
      { threadId, agent, project, openMic: this.voiceCfg.openMic },
    );
    this.sessions.set(ws, session);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session.pushAudio(data);
        return;
      }
      let msg: VoiceClientMessage;
      try {
        msg = JSON.parse(String(data)) as VoiceClientMessage;
      } catch {
        return;
      }
      this.handleControl(session, msg, send);
    });

    ws.on('close', () => {
      void session.close();
      this.sessions.delete(ws);
    });
    ws.on('error', (err) => log.warn('voice socket error', { err: err.message }));

    void session.start();
  }

  private handleControl(session: VoiceSession, msg: VoiceClientMessage, send: (m: VoiceServerMessage) => void): void {
    switch (msg.type) {
      case 'hello':
        if (msg.sampleRate !== SAMPLE_RATE) {
          send({ type: 'error', message: `expected ${SAMPLE_RATE} Hz mono PCM16, got ${msg.sampleRate}` });
        }
        return;
      case 'stop':
        session.finishUtterance();
        return;
      case 'interrupt':
        session.interrupt('user');
        return;
      case 'text':
        session.handleText(msg.text);
        return;
      case 'bye':
        void session.close();
        return;
      case 'start':
        return;
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) await session.close();
    this.sessions.clear();
    this.warm?.stop();
    this.warm = null;
  }

  /** Speak to every connected voice client — used by proactive notifications. */
  async broadcast(text: string): Promise<number> {
    let spoken = 0;
    for (const session of this.sessions.values()) {
      await session.say(text);
      spoken++;
    }
    return spoken;
  }

  latency(): Array<{ lane: string; count: number; p50: number; p95: number }> {
    const merged = new Map<string, { count: number; p50: number; p95: number }>();
    for (const session of this.sessions.values()) {
      for (const row of session.latency.summary()) {
        const prev = merged.get(row.lane);
        merged.set(row.lane, {
          count: (prev?.count ?? 0) + row.count,
          p50: Math.max(prev?.p50 ?? 0, row.p50),
          p95: Math.max(prev?.p95 ?? 0, row.p95),
        });
      }
    }
    return [...merged.entries()].map(([lane, v]) => ({ lane, ...v }));
  }
}
