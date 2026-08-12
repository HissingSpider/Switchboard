import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** The subset of the `claude -p --output-format stream-json` protocol we act on. */
export interface StreamInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
}

export interface StreamAssistant {
  type: 'assistant';
  session_id?: string;
  message: {
    id?: string;
    model?: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
}

export interface StreamUser {
  type: 'user';
  session_id?: string;
  message: {
    content: Array<{ type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }>;
  };
}

export interface StreamResult {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type StreamMessage = StreamInit | StreamAssistant | StreamUser | StreamResult | { type: string; [k: string]: unknown };

export interface ClaudeOptions {
  bin: string;
  cwd: string;
  prompt: string;
  model?: string;
  /** Resume an existing session instead of starting fresh. */
  resumeSessionId?: string;
  maxTurns?: number;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfigPath?: string | null;
  settingsPath?: string | null;
  permissionMode?: string;
  env?: Record<string, string>;
  /** Keep stdin open in stream-json mode so follow-ups can be injected. */
  interactive?: boolean;
}

export type ClaudeEvent =
  | { type: 'init'; sessionId: string; model?: string; tools?: string[]; mcp?: Array<{ name: string; status: string }> }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; isError: boolean; preview: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'result'; ok: boolean; costUsd: number; turns: number; text: string; subtype: string }
  | { type: 'stderr'; line: string }
  | { type: 'raw'; line: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null };

function preview(value: unknown, n = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * One `claude -p` process, normalised into a typed event stream.
 *
 * Nothing in here knows about the event log, git or channels — it is a thin,
 * testable wrapper. The test harness swaps `bin` for a fake process that speaks
 * the same protocol.
 */
export class ClaudeProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killedIntentionally = false;
  sessionId: string | null = null;
  lastOutputAt = Date.now();
  costUsd = 0;
  turns = 0;
  inputTokens = 0;
  outputTokens = 0;

  constructor(private readonly opts: ClaudeOptions) {
    super();
  }

  buildArgs(): string[] {
    const o = this.opts;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (o.interactive) args.push('--input-format', 'stream-json');
    if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
    if (o.model) args.push('--model', o.model);
    if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
    if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
    if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
    if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));
    if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
    if (o.settingsPath) args.push('--settings', o.settingsPath);
    if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
    if (!o.interactive) args.push(o.prompt);
    return args;
  }

  start(): void {
    const o = this.opts;
    const child = spawn(o.bin, this.buildArgs(), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    if (o.interactive) {
      this.send(o.prompt);
    } else {
      child.stdin.end();
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      this.lastOutputAt = Date.now();
      if (!line.trim()) return;
      this.emit('event', { type: 'raw', line } satisfies ClaudeEvent);
      let msg: StreamMessage;
      try {
        msg = JSON.parse(line) as StreamMessage;
      } catch {
        return; // non-JSON chatter on stdout is not fatal
      }
      this.handle(msg);
    });

    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      this.lastOutputAt = Date.now();
      this.emit('event', { type: 'stderr', line } satisfies ClaudeEvent);
    });

    child.on('error', (err) => {
      this.emit('event', { type: 'stderr', line: `spawn failed: ${err.message}` } satisfies ClaudeEvent);
      this.emit('event', { type: 'exit', code: 127, signal: null } satisfies ClaudeEvent);
    });

    child.on('close', (code, signal) => {
      // A SIGTERM we sent surfaces as 143; that is a kill, not a crash.
      const effective = this.killedIntentionally ? 143 : code;
      this.emit('event', { type: 'exit', code: effective, signal } satisfies ClaudeEvent);
    });
  }

  private handle(msg: StreamMessage): void {
    switch (msg.type) {
      case 'system': {
        const m = msg as StreamInit;
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          this.emit('event', {
            type: 'init',
            sessionId: m.session_id,
            model: m.model,
            tools: m.tools,
            mcp: m.mcp_servers,
          } satisfies ClaudeEvent);
        }
        break;
      }
      case 'assistant': {
        const m = msg as StreamAssistant;
        if (m.session_id) this.sessionId ??= m.session_id;
        this.turns += 1;
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            this.emit('event', { type: 'text', text: block.text } satisfies ClaudeEvent);
          } else if (block.type === 'thinking') {
            this.emit('event', { type: 'thinking', text: block.thinking } satisfies ClaudeEvent);
          } else if (block.type === 'tool_use') {
            this.emit('event', { type: 'tool_use', id: block.id, name: block.name, input: block.input } satisfies ClaudeEvent);
          }
        }
        const u = m.message?.usage;
        if (u) {
          this.inputTokens += u.input_tokens ?? 0;
          this.outputTokens += u.output_tokens ?? 0;
          this.emit('event', { type: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens } satisfies ClaudeEvent);
        }
        break;
      }
      case 'user': {
        const m = msg as StreamUser;
        for (const block of m.message?.content ?? []) {
          if (block.type === 'tool_result') {
            this.emit('event', {
              type: 'tool_result',
              id: block.tool_use_id,
              isError: Boolean(block.is_error),
              preview: preview(block.content),
            } satisfies ClaudeEvent);
          }
        }
        break;
      }
      case 'result': {
        const m = msg as StreamResult;
        this.costUsd = m.total_cost_usd ?? this.costUsd;
        if (typeof m.num_turns === 'number') this.turns = m.num_turns;
        if (m.session_id) this.sessionId ??= m.session_id;
        this.emit('event', {
          type: 'result',
          ok: !m.is_error && m.subtype === 'success',
          costUsd: this.costUsd,
          turns: this.turns,
          text: m.result ?? '',
          subtype: m.subtype,
        } satisfies ClaudeEvent);
        break;
      }
      default:
        break;
    }
  }

  /** Inject a follow-up user message into a running session. */
  send(text: string): boolean {
    if (!this.child?.stdin.writable || !this.opts.interactive) return false;
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    return this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** Close stdin so the session ends after the current turn. */
  finishInput(): void {
    if (this.child?.stdin.writable) this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.child || this.child.killed) return;
    this.killedIntentionally = true;
    this.child.kill(signal);
    // If it ignores SIGTERM, stop being polite.
    const pid = this.child.pid;
    setTimeout(() => {
      if (pid && this.child && this.child.exitCode === null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 5000).unref();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }
}
