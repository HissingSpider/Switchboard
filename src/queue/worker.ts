import type { LoadedConfig } from '../config/load.js';
import { findProject } from '../config/load.js';
import type { RunRegistry } from '../runner/registry.js';
import { BudgetExceededError } from '../runner/registry.js';
import type { RunStore, RunRecord, Channel } from '../store/runs.js';
import type { EventLog } from '../store/eventlog.js';
import type { ArtifactStore } from '../store/artifacts.js';
import type { Db } from '../store/db.js';
import type { DeerDawnClient, BoardCard } from './deerdawn.js';
import { logger } from '../core/logger.js';

const log = logger('queue');

/**
 * Switchboard as a worker on a DeerDawn queue.
 *
 * The board is the source of truth for what should happen; this just picks up
 * cards and does them. The important property is that the board always reflects
 * reality: a card is moved to In Progress *before* the run starts and to Done
 * or Blocked when it ends, so a crashed daemon leaves a card visibly stuck in
 * progress rather than silently back in the backlog.
 */
export interface ClaimedCard {
  card: BoardCard;
  runId: string;
  claimedAt: string;
}

/** `[swb] fix the flaky test` routes to the project registered as `swb`. */
export function parseCardTitle(title: string): { project?: string; text: string } {
  const m = /^\s*\[([\w.-]+)\]\s*(.+)$/.exec(title);
  return m ? { project: m[1], text: m[2]!.trim() } : { text: title.trim() };
}

export function matchesFilter(title: string, filters: string[] | undefined): boolean {
  if (!filters?.length) return true;
  return filters.some((f) => title.toLowerCase().startsWith(f.toLowerCase()));
}

export class QueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, ClaimedCard>();
  /**
   * Cards finished during this process's lifetime. If a `move` to done silently
   * fails — the board is down, the card was deleted — the card stays in the
   * backlog and would otherwise be claimed again on the next poll, forever,
   * spending real money each time.
   */
  private readonly completed = new Set<string>();
  private polling = false;

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly client: DeerDawnClient,
    private readonly registry: RunRegistry,
    private readonly runs: RunStore,
    private readonly events: EventLog,
    private readonly artifacts: ArtifactStore,
    private readonly db: Db,
  ) {
    // Attached in the constructor, not in start(): a card claimed by a manual
    // `swb queue poll` still has to have its outcome written back to the board.
    this.registry.on('finished', (rec: RunRecord) => void this.onRunFinished(rec));
  }

  get enabled(): boolean {
    return Boolean(this.cfg.deerdawn.enabled && this.cfg.deerdawn.queueProjectId);
  }

  start(): void {
    if (!this.enabled) return;
    const interval = Math.max(60_000, this.cfg.deerdawn.pollIntervalMs ?? 600_000);
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    // Don't poll on the very first tick — the daemon has just started and the
    // model call would compete with everything else coming up.
    setTimeout(() => void this.poll(), 30_000).unref();
    log.info('queue worker started', { project: this.cfg.deerdawn.queueProjectId, intervalMs: interval });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { enabled: boolean; inFlight: ClaimedCard[]; project?: string } {
    return { enabled: this.enabled, inFlight: [...this.inFlight.values()], project: this.cfg.deerdawn.queueProjectId };
  }

  /** Look for work. Safe to call by hand; overlapping polls are dropped. */
  async poll(): Promise<{ claimed: number; skipped: string[] }> {
    if (!this.enabled || this.polling) return { claimed: 0, skipped: [] };
    const projectId = this.cfg.deerdawn.queueProjectId!;
    const capacity = (this.cfg.deerdawn.maxConcurrentCards ?? 1) - this.inFlight.size;
    if (capacity <= 0) return { claimed: 0, skipped: ['at card concurrency limit'] };

    this.polling = true;
    const skipped: string[] = [];
    let claimed = 0;
    try {
      const cards = await this.client.backlog(projectId);
      for (const card of cards) {
        if (claimed >= capacity) break;
        if (this.inFlight.has(card.id)) continue;
        if (this.completed.has(card.id)) {
          skipped.push(`${card.title} (already done this session — the board did not move it)`);
          continue;
        }
        if (!matchesFilter(card.title, this.cfg.deerdawn.labelFilter)) {
          skipped.push(`${card.title} (label filter)`);
          continue;
        }
        const result = await this.claim(projectId, card);
        if (result) claimed++;
        else skipped.push(card.title);
      }
    } catch (err) {
      log.warn('poll failed', { err: (err as Error).message });
    } finally {
      this.polling = false;
    }
    return { claimed, skipped };
  }

  /**
   * Claim first, run second. If the move fails we never start the run — two
   * workers racing for the same card is worse than a card sitting still.
   */
  private async claim(projectId: string, card: BoardCard): Promise<boolean> {
    const moved = await this.client.move(projectId, card.id, 'in_progress');
    if (!moved) {
      log.info('could not claim card', { card: card.title });
      return false;
    }

    const { project: prefix, text } = parseCardTitle(card.title);
    const project = prefix ? findProject(this.cfg, prefix) : undefined;
    if (prefix && !project) {
      // The card names a project we don't have. Put it back rather than running
      // it somewhere arbitrary.
      await this.client.move(projectId, card.id, 'blocked');
      await this.client.recordOutcome(projectId, card, {
        runId: '-',
        status: 'not started',
        summary: `Switchboard has no project registered as "${prefix}".`,
      });
      this.events.append({
        runId: null,
        kind: 'system.error',
        source: 'queue',
        summary: `card "${card.title}" names unknown project "${prefix}" — moved to blocked`,
        data: { card },
      });
      return false;
    }

    const brief = await this.client.brief(projectId, card).catch(() => undefined);
    const prompt = [
      brief ?? text,
      '',
      `(This is DeerDawn card "${card.title}". When you finish, state in one line what changed and what a`,
      `reviewer should look at. If you cannot finish, say exactly what blocked you.)`,
    ].join('\n');

    try {
      const run = this.registry.submit({
        prompt,
        project: project?.name,
        intent: 'task',
        channel: (this.cfg.deerdawn.notifyChannel as Channel) ?? 'dashboard',
        // A queued card has no conversation of its own, so it borrows one —
        // otherwise a confirm-by-reply has nowhere to land and times out.
        threadId: this.cfg.deerdawn.notifyThreadId ?? `queue:${card.id}`,
      });

      this.inFlight.set(run.id, { card, runId: run.id, claimedAt: new Date().toISOString() });
      this.db
        .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
        .run(`queue.card.${run.id}`, JSON.stringify(card), new Date().toISOString());

      this.events.append({
        runId: run.id,
        kind: 'run.queued',
        source: 'queue',
        summary: `claimed card "${card.title}"${project ? ` for ${project.name}` : ''}`,
        data: { card, project: project?.name, briefed: Boolean(brief) },
      });
      return true;
    } catch (err) {
      // Budget exhausted, or the project is locked — hand the card back.
      await this.client.move(projectId, card.id, 'backlog');
      const message = err instanceof BudgetExceededError ? err.message : (err as Error).message;
      this.events.append({
        runId: null,
        kind: 'system.error',
        source: 'queue',
        summary: `released card "${card.title}": ${message}`,
        data: { card },
      });
      return false;
    }
  }

  private async onRunFinished(rec: RunRecord): Promise<void> {
    const claimed = this.inFlight.get(rec.id);
    if (!claimed) return;
    this.inFlight.delete(rec.id);
    this.completed.add(claimed.card.id);
    const projectId = this.cfg.deerdawn.queueProjectId!;

    const diff = this.artifacts.read(rec.id, 'changes.diff');
    const diffSummary = diff ? summarizeDiff(diff) : undefined;
    const succeeded = rec.status === 'done';

    await this.client.recordOutcome(projectId, claimed.card, {
      runId: rec.id,
      status: rec.status,
      summary: (rec.result ?? rec.error ?? '').trim().slice(0, 1500) || 'No summary was produced.',
      branch: rec.branch,
      diff: diffSummary,
      costUsd: rec.costUsd,
      vaultPath: (this.readKv(`vault.run.${rec.id}`) ?? undefined) as string | undefined,
    });

    await this.client.move(projectId, claimed.card.id, succeeded ? 'done' : 'blocked');

    this.events.append({
      runId: rec.id,
      kind: succeeded ? 'run.finished' : 'run.failed',
      source: 'queue',
      summary: `card "${claimed.card.title}" → ${succeeded ? 'done' : 'blocked'}${diffSummary ? ` (${diffSummary})` : ''}`,
      data: { card: claimed.card, status: rec.status },
    });

    void this.poll();
  }

  private readKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  }

  /** On boot, anything we had claimed is orphaned — say so on the board. */
  async reconcile(): Promise<number> {
    if (!this.enabled) return 0;
    const rows = this.db.prepare(`SELECT key, value FROM kv WHERE key LIKE 'queue.card.%'`).all() as unknown as Array<{ key: string; value: string }>;
    let released = 0;
    for (const row of rows) {
      const runId = row.key.replace('queue.card.', '');
      const rec = this.runs.get(runId);
      if (rec && (rec.status === 'running' || rec.status === 'queued')) continue;
      if (rec && rec.status === 'done') continue;
      try {
        const card = JSON.parse(row.value) as BoardCard;
        await this.client.move(this.cfg.deerdawn.queueProjectId!, card.id, 'blocked');
        released++;
      } catch {
        /* malformed row */
      }
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(row.key);
    }
    return released;
  }
}

export function summarizeDiff(patch: string): string {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return `${files.size} file${files.size === 1 ? '' : 's'}, +${added}/-${removed}`;
}
