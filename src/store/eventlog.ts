import { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import type { NewEvent, SwbEvent, EventKind } from './events.js';

export interface ReplayQuery {
  runId?: string;
  sinceId?: number;
  kinds?: EventKind[];
  limit?: number;
  /** Free-text match against summary. */
  search?: string;
}

interface Row {
  id: number;
  ts: string;
  run_id: string | null;
  kind: string;
  summary: string;
  data: string;
  source: string;
}

function toEvent(r: Row): SwbEvent {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.data) as Record<string, unknown>;
  } catch {
    data = { _unparsed: r.data };
  }
  return { id: r.id, ts: r.ts, runId: r.run_id, kind: r.kind as EventKind, summary: r.summary, data, source: r.source };
}

/**
 * Append-only event log. Everything the system does goes through here exactly
 * once; the dashboard, the iMessage downsample and the audit trail are all just
 * different reads of this table.
 */
export class EventLog {
  private readonly bus = new EventEmitter();

  constructor(private readonly db: Db) {
    this.bus.setMaxListeners(0);
  }

  append(ev: NewEvent): SwbEvent {
    const ts = ev.ts ?? new Date().toISOString();
    const data = JSON.stringify(ev.data ?? {});
    const info = this.db
      .prepare('INSERT INTO events (ts, run_id, kind, summary, data, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, ev.runId, ev.kind, ev.summary, data, ev.source);
    const stored: SwbEvent = {
      id: Number(info.lastInsertRowid),
      ts,
      runId: ev.runId,
      kind: ev.kind,
      summary: ev.summary,
      data: ev.data ?? {},
      source: ev.source,
    };
    this.bus.emit('event', stored);
    if (stored.runId) this.bus.emit(`run:${stored.runId}`, stored);
    return stored;
  }

  replay(q: ReplayQuery = {}): SwbEvent[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.runId) {
      where.push('run_id = ?');
      args.push(q.runId);
    }
    if (q.sinceId !== undefined) {
      where.push('id > ?');
      args.push(q.sinceId);
    }
    if (q.kinds?.length) {
      where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`);
      args.push(...q.kinds);
    }
    if (q.search) {
      where.push('summary LIKE ?');
      args.push(`%${q.search}%`);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`;
    args.push(q.limit ?? 500);
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toEvent);
  }

  /** Most recent events first — what the dashboard wants on first paint. */
  tail(limit = 100, runId?: string): SwbEvent[] {
    const sql = runId
      ? 'SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM events ORDER BY id DESC LIMIT ?';
    const rows = (runId ? this.db.prepare(sql).all(runId, limit) : this.db.prepare(sql).all(limit)) as unknown as Row[];
    return rows.map(toEvent).reverse();
  }

  lastId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get() as { n: number };
    return Number(row.n);
  }

  /** Live subscription. Returns an unsubscribe function. */
  subscribe(fn: (ev: SwbEvent) => void, runId?: string): () => void {
    const channel = runId ? `run:${runId}` : 'event';
    this.bus.on(channel, fn);
    return () => this.bus.off(channel, fn);
  }

  /** Delete events older than `days`. Returns rows removed. 0 = keep forever. */
  prune(days: number): number {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const info = this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    return Number(info.changes);
  }
}
