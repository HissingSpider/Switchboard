import { ClaudeProcess } from '../runner/claude.js';
import type { LoadedConfig } from '../config/load.js';
import { resolveMcpSet, writeMcpConfig } from '../runner/mcp.js';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const log = logger('queue:deerdawn');

/**
 * Talking to DeerDawn from the daemon.
 *
 * DeerDawn is an MCP server, and MCP servers are spoken to by models, not by
 * daemons. Rather than reimplement its protocol we run the smallest possible
 * `claude -p` with only the DeerDawn tools available and a contract that its
 * entire output must be one JSON object. That is a real model call, so polling
 * is deliberately infrequent and every call is budgeted like any other run.
 *
 * The alternative — a REST client — would be cheaper, but it would encode
 * assumptions about an API this project does not own. This way the bridge stays
 * honest: if DeerDawn's tools change, the model adapts.
 */
export interface BoardCard {
  id: string;
  title: string;
  phase: string;
}

export interface DeerDawnClient {
  /** Cards sitting in the queue project's backlog. */
  backlog(projectId: string): Promise<BoardCard[]>;
  /** Move a card between phases. Returns false if it had already moved. */
  move(projectId: string, cardId: string, phase: string): Promise<boolean>;
  /** Write an outcome back against a card. */
  recordOutcome(projectId: string, card: BoardCard, outcome: RunOutcome): Promise<boolean>;
  /** A briefing for one card, built by DeerDawn rather than by us. */
  brief(projectId: string, card: BoardCard): Promise<string | undefined>;
}

export interface RunOutcome {
  runId: string;
  status: string;
  summary: string;
  branch?: string | null;
  diff?: string;
  costUsd?: number;
  vaultPath?: string;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const JSON_CONTRACT = [
  'Your entire response must be exactly one JSON object and nothing else.',
  'No prose, no markdown fence, no explanation. If a tool call fails, respond',
  'with {"ok": false, "error": "<what went wrong>"}.',
].join(' ');

export class McpBridgeClient implements DeerDawnClient {
  private mcpConfigPath: string | null = null;

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly server = 'deerdawn',
  ) {}

  private configPath(): string | null {
    if (this.mcpConfigPath !== null) return this.mcpConfigPath;
    const all = resolveMcpSet(this.cfg, this.cfg.workerMcpSet);
    // Only DeerDawn: the bridge has no business reaching anything else.
    const only = all[this.server] ? { [this.server]: all[this.server] } : {};
    this.mcpConfigPath = writeMcpConfig(join(this.cfg.resolved.dataDir, 'queue'), only);
    return this.mcpConfigPath;
  }

  /** One short model call with a strict JSON contract. */
  private async ask(instruction: string, timeoutMs = 120_000): Promise<BridgeResult> {
    const mcpConfigPath = this.configPath();
    if (!mcpConfigPath) return { ok: false, error: `MCP server "${this.server}" is not in the worker set` };

    const proc = new ClaudeProcess({
      bin: this.cfg.claudeBin,
      cwd: this.cfg.resolved.scratchDir,
      prompt: `${instruction}\n\n${JSON_CONTRACT}`,
      // Calling one MCP tool and emitting a fixed JSON shape is not work that
      // rewards a larger model, and this runs on a timer forever.
      model: this.cfg.models?.bridge,
      maxTurns: 8,
      allowedTools: [`mcp__${this.server}__*`],
      mcpConfigPath,
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: 'You are a data bridge, not an assistant. Emit JSON only.',
    });

    return new Promise<BridgeResult>((resolve) => {
      let text = '';
      const timer = setTimeout(() => {
        proc.kill();
        resolve({ ok: false, error: 'deerdawn bridge timed out' });
      }, timeoutMs);

      proc.on('event', (ev: { type: string; text?: string; code?: number | null }) => {
        if (ev.type === 'text') text += ev.text ?? '';
        else if (ev.type === 'result') text = text || (ev as { text?: string }).text || '';
        else if (ev.type === 'exit') {
          clearTimeout(timer);
          resolve(parseJsonish(text));
        }
      });
      proc.start();
    });
  }

  async backlog(projectId: string): Promise<BoardCard[]> {
    const result = await this.ask(
      [
        `List the task board for DeerDawn project "${projectId}".`,
        'Return {"ok": true, "cards": [{"id": "...", "title": "...", "phase": "..."}]} containing',
        'ONLY the cards currently in the Backlog column, oldest first.',
      ].join(' '),
    );
    if (!result.ok) {
      log.warn('backlog read failed', { error: result.error });
      return [];
    }
    const cards = (result.data as { cards?: BoardCard[] })?.cards ?? [];
    return cards.filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string');
  }

  async move(projectId: string, cardId: string, phase: string): Promise<boolean> {
    const result = await this.ask(
      `Move card "${cardId}" on DeerDawn project "${projectId}" to the ${phase} phase. Return {"ok": true} on success.`,
    );
    return result.ok;
  }

  async recordOutcome(projectId: string, card: BoardCard, outcome: RunOutcome): Promise<boolean> {
    const detail = [
      `Run ${outcome.runId} finished ${outcome.status}.`,
      outcome.summary,
      outcome.branch ? `Branch: ${outcome.branch}` : '',
      outcome.diff ? `Diff: ${outcome.diff}` : '',
      outcome.costUsd !== undefined ? `Cost: $${outcome.costUsd.toFixed(3)}` : '',
      outcome.vaultPath ? `Notes: ${outcome.vaultPath}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.ask(
      [
        `Record this outcome against DeerDawn project "${projectId}" for the card "${card.title}".`,
        'Use record_debug_finding (or record_finding if that is the tool you have) with the text below,',
        'then return {"ok": true}.',
        '',
        detail,
      ].join('\n'),
    );
    return result.ok;
  }

  async brief(projectId: string, card: BoardCard): Promise<string | undefined> {
    const result = await this.ask(
      [
        `Call build_subagent_brief for DeerDawn project "${projectId}" and the subtask "${card.title}".`,
        'Return {"ok": true, "brief": "<the brief verbatim>"}.',
      ].join(' '),
    );
    if (!result.ok) return undefined;
    const brief = (result.data as { brief?: string })?.brief;
    return typeof brief === 'string' && brief.trim() ? brief : undefined;
  }
}

/**
 * Models add prose even when told not to. Take the outermost JSON object rather
 * than failing on a stray sentence.
 */
export function parseJsonish(text: string): BridgeResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty response' };
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: `no JSON in response: ${trimmed.slice(0, 120)}` };
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { ok?: boolean; error?: string };
    if (parsed.ok === false) return { ok: false, error: parsed.error ?? 'bridge reported failure' };
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: `unparseable JSON: ${(err as Error).message}` };
  }
}

/** A client that does nothing, for when DeerDawn is switched off. */
export class NullDeerDawnClient implements DeerDawnClient {
  async backlog(): Promise<BoardCard[]> {
    return [];
  }
  async move(): Promise<boolean> {
    return false;
  }
  async recordOutcome(): Promise<boolean> {
    return false;
  }
  async brief(): Promise<string | undefined> {
    return undefined;
  }
}
