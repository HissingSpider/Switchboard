import { EventEmitter } from 'node:events';
import { ClaudeProcess, type ClaudeEvent } from '../runner/claude.js';
import { logger } from '../core/logger.js';

const log = logger('voice:warm');

export interface WarmSessionOptions {
  bin: string;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpConfigPath?: string | null;
  settingsPath?: string | null;
  permissionMode?: string;
  env?: Record<string, string>;
  /** Restart the process after this many turns; long sessions get slow and expensive. */
  maxTurnsBeforeRecycle?: number;
  /** Recycle after this long idle, so a session left open overnight isn't resumed cold. */
  idleRecycleMs?: number;
}

export interface WarmTurn {
  /** Subscribe to text fragments as they arrive — feed these to the TTS streamer. */
  onText: (listener: (text: string) => void) => void;
  /** Fires when the turn is complete. */
  done: Promise<{ text: string; costUsd: number; ms: number }>;
  /** Abandon this turn; the process stays warm for the next one. */
  abandon: () => void;
}

/**
 * A resident `claude -p` that never gets torn down between turns.
 *
 * Cold-starting the CLI costs 1.5-3 seconds — more than the entire budget for a
 * spoken answer. Keeping one process alive in stream-json input mode turns that
 * into a socket write. The cost is one idle process and a session that grows;
 * both are handled by recycling.
 */
export class WarmSession extends EventEmitter {
  private proc: ClaudeProcess | null = null;
  private busy = false;
  private turns = 0;
  private lastUsedAt = Date.now();
  private starting: Promise<void> | null = null;
  sessionId: string | null = null;
  totalCostUsd = 0;

  constructor(private readonly opts: WarmSessionOptions) {
    super();
  }

  get ready(): boolean {
    return Boolean(this.proc?.running);
  }

  get inUse(): boolean {
    return this.busy;
  }

  /** Bring the process up and hold it there. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.proc?.running) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve) => {
      const proc = new ClaudeProcess({
        bin: this.opts.bin,
        cwd: this.opts.cwd,
        // The first prompt is a no-op that exists only to force the model,
        // tools and MCP servers to load before anyone is waiting on them.
        prompt: 'Reply with exactly: ready',
        model: this.opts.model,
        appendSystemPrompt: this.opts.systemPrompt,
        allowedTools: this.opts.allowedTools,
        mcpConfigPath: this.opts.mcpConfigPath,
        settingsPath: this.opts.settingsPath,
        permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
        env: this.opts.env,
        interactive: true,
      });
      this.proc = proc;

      const onEvent = (ev: ClaudeEvent): void => {
        if (ev.type === 'init') {
          this.sessionId = ev.sessionId;
        } else if (ev.type === 'result') {
          this.totalCostUsd += ev.costUsd;
          proc.off('event', onEvent);
          this.starting = null;
          resolve();
        } else if (ev.type === 'exit') {
          proc.off('event', onEvent);
          this.starting = null;
          resolve();
        }
      };
      proc.on('event', onEvent);
      proc.on('event', (ev: ClaudeEvent) => {
        if (ev.type === 'exit') {
          log.warn('warm session exited', { code: ev.code });
          this.proc = null;
          this.busy = false;
          this.emit('exit', ev.code);
        }
      });
      proc.start();
    });
    return this.starting;
  }

  /**
   * Send one turn. Text arrives incrementally through `onText` so the first
   * sentence can be spoken while the model is still writing the second.
   */
  ask(prompt: string): WarmTurn {
    if (!this.proc?.running) throw new Error('warm session is not running');
    if (this.busy) throw new Error('warm session is already handling a turn');
    this.busy = true;
    this.turns++;
    this.lastUsedAt = Date.now();

    const proc = this.proc;
    const started = Date.now();
    let abandoned = false;
    let full = '';
    const listeners: Array<(t: string) => void> = [];

    const done = new Promise<{ text: string; costUsd: number; ms: number }>((resolve) => {
      const onEvent = (ev: ClaudeEvent): void => {
        if (abandoned) return;
        if (ev.type === 'text') {
          full += ev.text;
          for (const fn of listeners) fn(ev.text);
        } else if (ev.type === 'result') {
          proc.off('event', onEvent);
          this.busy = false;
          this.totalCostUsd += ev.costUsd;
          resolve({ text: full || ev.text, costUsd: ev.costUsd, ms: Date.now() - started });
        } else if (ev.type === 'exit') {
          proc.off('event', onEvent);
          this.busy = false;
          resolve({ text: full, costUsd: 0, ms: Date.now() - started });
        }
      };
      proc.on('event', onEvent);
    });

    proc.send(prompt);

    return {
      onText: (fn) => void listeners.push(fn),
      done,
      abandon: () => {
        abandoned = true;
        this.busy = false;
      },
    };
  }

  /** True when this session should be replaced before the next turn. */
  get stale(): boolean {
    const maxTurns = this.opts.maxTurnsBeforeRecycle ?? 30;
    const idleMs = this.opts.idleRecycleMs ?? 20 * 60_000;
    return this.turns >= maxTurns || Date.now() - this.lastUsedAt > idleMs;
  }

  /** Tear down and bring up a fresh one. Cheap to call when idle. */
  async recycle(): Promise<void> {
    if (this.busy) return;
    this.stop();
    this.turns = 0;
    this.sessionId = null;
    await this.start();
  }

  stop(): void {
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this.busy = false;
  }
}

/**
 * `onText` is a callback but callers want a subscribe-then-await shape. This
 * adapts a turn into that, wiring the streamer before the first token lands.
 */
export function streamTurn(turn: WarmTurn, onChunk: (text: string) => void): Promise<{ text: string; costUsd: number; ms: number }> {
  turn.onText(onChunk);
  return turn.done;
}
