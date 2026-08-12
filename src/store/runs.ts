import type { Db } from './db.js';
import type { TaskClass } from '../config/schema.js';

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'killed' | 'stuck';
export type Intent = 'chat' | 'query' | 'task';
export type Channel = 'imessage' | 'telegram' | 'dashboard' | 'schedule' | 'trigger' | 'cli';

export interface RunRecord {
  id: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  project: string | null;
  projectPath: string | null;
  agent: string | null;
  taskClass: TaskClass;
  intent: Intent;
  channel: Channel | null;
  threadId: string | null;
  sessionId: string | null;
  parentRunId: string | null;
  prompt: string;
  branch: string | null;
  exitCode: number | null;
  error: string | null;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  result: string | null;
}

interface Row {
  id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  project: string | null;
  project_path: string | null;
  agent: string | null;
  task_class: string;
  intent: string;
  channel: string | null;
  thread_id: string | null;
  session_id: string | null;
  parent_run_id: string | null;
  prompt: string;
  branch: string | null;
  exit_code: number | null;
  error: string | null;
  cost_usd: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  result: string | null;
}

function toRun(r: Row): RunRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as RunStatus,
    project: r.project,
    projectPath: r.project_path,
    agent: r.agent,
    taskClass: r.task_class as TaskClass,
    intent: r.intent as Intent,
    channel: r.channel as Channel | null,
    threadId: r.thread_id,
    sessionId: r.session_id,
    parentRunId: r.parent_run_id,
    prompt: r.prompt,
    branch: r.branch,
    exitCode: r.exit_code,
    error: r.error,
    costUsd: r.cost_usd,
    turns: r.turns,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    result: r.result,
  };
}

export interface CreateRunInput {
  id: string;
  prompt: string;
  project?: string | null;
  projectPath?: string | null;
  agent?: string | null;
  taskClass?: TaskClass;
  intent?: Intent;
  channel?: Channel | null;
  threadId?: string | null;
  sessionId?: string | null;
  parentRunId?: string | null;
}

export class RunStore {
  constructor(private readonly db: Db) {}

  create(input: CreateRunInput): RunRecord {
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at, status, project, project_path, agent, task_class, intent, channel, thread_id, session_id, parent_run_id, prompt)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        new Date().toISOString(),
        input.project ?? null,
        input.projectPath ?? null,
        input.agent ?? null,
        input.taskClass ?? 'coding',
        input.intent ?? 'task',
        input.channel ?? null,
        input.threadId ?? null,
        input.sessionId ?? null,
        input.parentRunId ?? null,
        input.prompt,
      );
    return this.get(input.id)!;
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Accepts a full id or a unique prefix — humans text "kill 8k2" more often than the full id. */
  resolve(idOrPrefix: string): RunRecord | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2')
      .all(`%${idOrPrefix}%`) as unknown as Row[];
    return rows.length === 1 ? toRun(rows[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<RunRecord, 'id'>>): void {
    const map: Record<string, string> = {
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      status: 'status',
      project: 'project',
      projectPath: 'project_path',
      agent: 'agent',
      taskClass: 'task_class',
      intent: 'intent',
      channel: 'channel',
      threadId: 'thread_id',
      sessionId: 'session_id',
      parentRunId: 'parent_run_id',
      branch: 'branch',
      exitCode: 'exit_code',
      error: 'error',
      costUsd: 'cost_usd',
      turns: 'turns',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      result: 'result',
    };
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      args.push(v as string | number | null);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  active(): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at ASC`).all() as unknown as Row[]).map(toRun);
  }

  list(opts: { limit?: number; status?: RunStatus; project?: string; search?: string; before?: string } = {}): RunRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.project) {
      where.push('project = ?');
      args.push(opts.project);
    }
    if (opts.search) {
      where.push('(prompt LIKE ? OR result LIKE ? OR id LIKE ?)');
      args.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`);
    }
    if (opts.before) {
      where.push('created_at < ?');
      args.push(opts.before);
    }
    args.push(opts.limit ?? 50);
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toRun);
  }

  /** Spend since the first of the current month, used for the credit burn-down. */
  monthSpend(now = new Date()): number {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM runs WHERE created_at >= ?').get(start) as { n: number };
    return Number(row.n);
  }

  spendByProject(sinceIso: string): Array<{ project: string; costUsd: number; runs: number }> {
    return this.db
      .prepare(
        `SELECT COALESCE(project, '(none)') AS project, SUM(cost_usd) AS costUsd, COUNT(*) AS runs
         FROM runs WHERE created_at >= ? GROUP BY project ORDER BY costUsd DESC`,
      )
      .all(sinceIso) as unknown as Array<{ project: string; costUsd: number; runs: number }>;
  }

  /** On boot, anything still marked running is a leftover from a crash. */
  reconcileOrphans(): string[] {
    const orphans = (this.db.prepare(`SELECT id FROM runs WHERE status IN ('running','queued')`).all() as unknown as Array<{ id: string }>).map((r) => r.id);
    if (orphans.length) {
      this.db
        .prepare(`UPDATE runs SET status = 'failed', error = 'orphaned by daemon restart', finished_at = ? WHERE status IN ('running','queued')`)
        .run(new Date().toISOString());
    }
    return orphans;
  }
}
