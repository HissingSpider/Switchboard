import type { Db } from './db.js';

export interface SessionKey {
  threadId: string;
  agent?: string;
  project?: string;
}

/**
 * Thread → claude session_id map. A "thread" is whatever the channel calls a
 * conversation: an iMessage chat guid, a Telegram chat id, a dashboard tab.
 * Keyed by (thread, agent, project) so one iMessage thread can hold separate
 * continuations per agent and per repo.
 */
export class SessionStore {
  constructor(private readonly db: Db) {}

  private key(k: SessionKey): [string, string, string] {
    return [k.threadId, k.agent ?? '', k.project ?? ''];
  }

  get(k: SessionKey): string | undefined {
    const row = this.db
      .prepare('SELECT session_id FROM sessions WHERE thread_id = ? AND agent = ? AND project = ?')
      .get(...this.key(k)) as { session_id?: string } | undefined;
    return row?.session_id;
  }

  set(k: SessionKey, sessionId: string): void {
    const [t, a, p] = this.key(k);
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (thread_id, agent, project, session_id, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(t, a, p, sessionId, new Date().toISOString());
  }

  clear(k: SessionKey): void {
    this.db.prepare('DELETE FROM sessions WHERE thread_id = ? AND agent = ? AND project = ?').run(...this.key(k));
  }

  /** Drop every continuation for a thread — what `/reset` in a chat should do. */
  clearThread(threadId: string): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE thread_id = ?').run(threadId).changes);
  }

  /** Forget continuations older than `days`; resuming a stale session usually fails anyway. */
  prune(days = 14): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff).changes);
  }
}
