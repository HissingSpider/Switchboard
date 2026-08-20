import { EventEmitter } from 'node:events';
import type { Db } from '../store/db.js';
import type { EventLog } from '../store/eventlog.js';
import { shortId } from '../core/ids.js';

export type ConfirmStatus = 'pending' | 'approved' | 'denied' | 'timeout';

export interface Confirmation {
  id: string;
  runId: string;
  createdAt: string;
  answeredAt: string | null;
  tool: string;
  detail: string;
  tier: string;
  status: ConfirmStatus;
  answeredBy: string | null;
  channel: string | null;
  /**
   * The standing rule this answer could be turned into, computed at the gate
   * where the real tool call is still in hand. Null means "always" is not on
   * offer for this one, and the dashboard shows no button for it.
   */
  alwaysSpec: string | null;
  alwaysMode: 'glob' | 'exact' | null;
}

interface Row {
  id: string;
  run_id: string;
  created_at: string;
  answered_at: string | null;
  tool: string;
  detail: string;
  tier: string;
  status: string;
  answered_by: string | null;
  channel: string | null;
  always_spec: string | null;
  always_mode: string | null;
}

const toConfirm = (r: Row): Confirmation => ({
  id: r.id,
  runId: r.run_id,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  tool: r.tool,
  detail: r.detail,
  tier: r.tier,
  status: r.status as ConfirmStatus,
  answeredBy: r.answered_by,
  channel: r.channel,
  alwaysSpec: r.always_spec,
  alwaysMode: r.always_mode === 'exact' ? 'exact' : r.always_spec ? 'glob' : null,
});

const YES = /^(y|yes|ok|okay|go|do it|approve|approved|confirm|sure|yep|yeah|👍)$/i;
const NO = /^(n|no|nope|stop|abort|deny|denied|cancel|don'?t|nah|👎)$/i;

/** "ok c-3f9x" / "yes 3f9x" / bare "yes" (applies to the only pending item). */
export function parseConfirmReply(text: string): { answer: 'approve' | 'deny'; id?: string } | undefined {
  const trimmed = text.trim();
  const m = /^(\S+)\s+(?:c-)?([a-z0-9]{4,8})$/i.exec(trimmed);
  if (m) {
    const word = m[1]!;
    if (YES.test(word)) return { answer: 'approve', id: m[2]!.toLowerCase() };
    if (NO.test(word)) return { answer: 'deny', id: m[2]!.toLowerCase() };
  }
  if (YES.test(trimmed)) return { answer: 'approve' };
  if (NO.test(trimmed)) return { answer: 'deny' };
  return undefined;
}

/**
 * Confirm-by-reply. The runner asks; the human answers on whatever channel
 * asked them. Timeouts default to abort — never to approve.
 */
export class ConfirmService {
  private readonly bus = new EventEmitter();

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly timeoutSec: number,
  ) {
    this.bus.setMaxListeners(0);
  }

  /**
   * Raise a confirmation and wait. Resolves 'approved' | 'denied' | 'timeout'.
   * The prompt is emitted as an event; adapters turn it into a text.
   */
  async request(input: {
    runId: string;
    tool: string;
    detail: string;
    tier: string;
    channel?: string | null;
    timeoutSec?: number;
    alwaysSpec?: string | null;
    alwaysMode?: 'glob' | 'exact' | null;
    /**
     * Called once the id exists. A push notification carries approve/deny
     * buttons that post back to `/api/confirmations/<id>`, so it cannot be sent
     * before there is an id to name — a notification whose buttons 404 is worse
     * than no notification, because it looks answered.
     */
    onCreated?: (id: string) => void;
  }): Promise<{
    id: string;
    status: ConfirmStatus;
  }> {
    const id = `c-${shortId(4)}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO confirmations (id, run_id, created_at, tool, detail, tier, status, channel, always_spec, always_mode)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        createdAt,
        input.tool,
        input.detail,
        input.tier,
        input.channel ?? null,
        input.alwaysSpec ?? null,
        input.alwaysSpec ? (input.alwaysMode ?? 'glob') : null,
      );

    const timeoutSec = input.timeoutSec ?? this.timeoutSec;
    input.onCreated?.(id);
    this.log.append({
      runId: input.runId,
      kind: 'action.confirm_requested',
      source: 'policy',
      summary: `${input.runId} wants to ${input.tool}: ${truncate(input.detail, 160)} — reply "ok ${id.slice(2)}" or "no ${id.slice(2)}" (${timeoutSec}s)`,
      data: { confirmId: id, tool: input.tool, detail: input.detail, tier: input.tier, timeoutSec },
    });

    const status = await new Promise<ConfirmStatus>((resolveP) => {
      const timer = setTimeout(() => {
        this.bus.off(id, onAnswer);
        this.finish(id, 'timeout', null);
        resolveP('timeout');
      }, timeoutSec * 1000);
      const onAnswer = (s: ConfirmStatus): void => {
        clearTimeout(timer);
        resolveP(s);
      };
      this.bus.once(id, onAnswer);
    });

    return { id, status };
  }

  private finish(id: string, status: ConfirmStatus, answeredBy: string | null): Confirmation | undefined {
    const row = this.get(id);
    if (!row || row.status !== 'pending') return row;
    this.db
      .prepare('UPDATE confirmations SET status = ?, answered_at = ?, answered_by = ? WHERE id = ?')
      .run(status, new Date().toISOString(), answeredBy, id);
    const updated = this.get(id)!;
    this.log.append({
      runId: updated.runId,
      kind: status === 'approved' ? 'action.confirm_answered' : status === 'denied' ? 'action.denied' : 'action.confirm_answered',
      source: 'policy',
      summary: `${id} ${status}${answeredBy ? ` by ${answeredBy}` : ' (no reply, aborting)'} — ${updated.tool}`,
      data: { confirmId: id, status, answeredBy, tool: updated.tool, detail: updated.detail },
    });
    return updated;
  }

  answer(id: string, approve: boolean, answeredBy: string): Confirmation | undefined {
    const row = this.get(id);
    if (!row || row.status !== 'pending') return row;
    const status: ConfirmStatus = approve ? 'approved' : 'denied';
    const updated = this.finish(id, status, answeredBy);
    this.bus.emit(id, status);
    return updated;
  }

  /** Resolve a bare or partial id the human texted back. */
  resolveId(partial: string): Confirmation | undefined {
    const direct = this.get(partial) ?? this.get(`c-${partial}`);
    if (direct) return direct;
    const rows = this.db
      .prepare(`SELECT * FROM confirmations WHERE status = 'pending' AND id LIKE ? ORDER BY created_at DESC LIMIT 2`)
      .all(`%${partial}%`) as unknown as Row[];
    return rows.length === 1 ? toConfirm(rows[0]!) : undefined;
  }

  get(id: string): Confirmation | undefined {
    const row = this.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? toConfirm(row) : undefined;
  }

  pending(runId?: string): Confirmation[] {
    const rows = (
      runId
        ? this.db.prepare(`SELECT * FROM confirmations WHERE status = 'pending' AND run_id = ? ORDER BY created_at ASC`).all(runId)
        : this.db.prepare(`SELECT * FROM confirmations WHERE status = 'pending' ORDER BY created_at ASC`).all()
    ) as unknown as Row[];
    return rows.map(toConfirm);
  }

  /** Full audit trail for the dashboard. */
  audit(limit = 200): Confirmation[] {
    return (this.db.prepare('SELECT * FROM confirmations ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map(toConfirm);
  }

  /** Handle a free-text reply from a channel. Returns what it did, if anything. */
  handleReply(text: string, answeredBy: string): { confirmation: Confirmation; approved: boolean } | undefined {
    const parsed = parseConfirmReply(text);
    if (!parsed) return undefined;
    let target: Confirmation | undefined;
    if (parsed.id) {
      target = this.resolveId(parsed.id);
    } else {
      const open = this.pending();
      // A bare "yes" is only safe when there is exactly one thing it could mean.
      if (open.length === 1) target = open[0];
    }
    if (!target) return undefined;
    const updated = this.answer(target.id, parsed.answer === 'approve', answeredBy);
    return updated ? { confirmation: updated, approved: parsed.answer === 'approve' } : undefined;
  }

  /** On boot, no pending confirmation can still have a waiter. Fail them closed. */
  expireOrphans(): number {
    const open = this.pending();
    for (const c of open) this.finish(c.id, 'timeout', null);
    return open.length;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
