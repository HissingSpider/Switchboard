import type { Db } from '../store/db.js';
import type { LoadedConfig } from '../config/load.js';
import type { RunRegistry } from '../runner/registry.js';
import type { RunStore, RunRecord, Channel } from '../store/runs.js';
import type { EventLog } from '../store/eventlog.js';
import type { EntityRegistry } from './entities.js';
import { healthFor, describeHealth, recheck } from './health.js';
import { shortId } from '../core/ids.js';
import { logger } from '../core/logger.js';

const log = logger('investigate');

export type InvestigationStatus = 'open' | 'answered' | 'blocked' | 'abandoned';
export type FindingKind = 'observation' | 'hypothesis' | 'ruled_out' | 'cause' | 'blocked';

export interface Finding {
  id: number;
  investigation: string;
  ts: string;
  step: number;
  kind: FindingKind;
  text: string;
  evidence: string | null;
  vaultPath: string | null;
}

export interface Investigation {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  project: string | null;
  status: InvestigationStatus;
  channel: string | null;
  threadId: string | null;
  runId: string | null;
  step: number;
  answer: string | null;
  originCheck: string | null;
}

interface Row {
  id: string;
  created_at: string;
  updated_at: string;
  question: string;
  project: string | null;
  status: string;
  channel: string | null;
  thread_id: string | null;
  run_id: string | null;
  step: number;
  answer: string | null;
  origin_check: string | null;
}

const toInvestigation = (r: Row): Investigation => ({
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  question: r.question,
  project: r.project,
  status: r.status as InvestigationStatus,
  channel: r.channel,
  threadId: r.thread_id,
  runId: r.run_id,
  step: r.step,
  answer: r.answer,
  originCheck: r.origin_check,
});

const INVESTIGATION_PROMPT = (question: string, context: string, findings: Finding[], step: number) =>
  [
    step === 0 ? 'Investigate this. Do not fix anything.' : 'Continue this investigation. Do not fix anything.',
    '',
    `Question: ${question}`,
    context ? `\n${context}` : '',
    findings.length
      ? `\nWhat has already been established:\n${findings.map((f) => `- [${f.kind}] ${f.text}`).join('\n')}\n\nDo not re-derive any of that.`
      : '',
    '',
    'You have read access only. If you conclude that something needs changing, STOP and say',
    'what you would change and why — do not attempt it. Fixing is a separate decision.',
    '',
    'Work in small steps. After each meaningful step, emit a line in exactly this form:',
    '  FINDING <observation|hypothesis|ruled_out|cause|blocked>: <one sentence>',
    'so the investigation can be resumed without repeating work.',
    '',
    'Finish with a line beginning "ANSWER:" giving the shortest true answer to the question,',
    'or "BLOCKED:" and what you would need in order to continue.',
  ]
    .filter((line) => line !== '')
    .join('\n');

/**
 * A resumable investigation.
 *
 * Diagnosis is not one model call. It is a sequence — look at the number, form
 * a hypothesis, rule it out, look somewhere else — and any step can hit a turn
 * cap, a rate limit, or a daemon restart. Checkpointing every finding means the
 * next attempt starts from what is known rather than from the question, which
 * is the difference between a diagnosis that converges and one that loops.
 *
 * Read-only is enforced at the runner via the `investigate` permission profile,
 * not by asking nicely here.
 */
export class InvestigationService {
  constructor(
    private readonly db: Db,
    private readonly cfg: LoadedConfig,
    private readonly registry: RunRegistry,
    private readonly runs: RunStore,
    private readonly events: EventLog,
    private readonly entities: EntityRegistry,
  ) {}

  /**
   * Start one. Returns immediately — the answer arrives later on whichever
   * channel asked, which is the point: you ask from your phone and put it away.
   */
  start(input: { question: string; project?: string; channel?: Channel; threadId?: string; originCheck?: string }): Investigation {
    const id = `i-${shortId(4)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO investigations (id, created_at, updated_at, question, project, status, channel, thread_id, step, origin_check)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?)`,
      )
      .run(id, now, now, input.question, input.project ?? null, input.channel ?? null, input.threadId ?? null, input.originCheck ?? null);

    this.events.append({
      runId: null,
      kind: 'run.queued',
      source: 'investigate',
      summary: `investigating: ${input.question}`,
      data: { investigation: id, project: input.project },
    });

    this.advance(id);
    return this.get(id)!;
  }

  /** Spawn the next step of an investigation. */
  advance(id: string): RunRecord | undefined {
    const inv = this.get(id);
    if (!inv || inv.status !== 'open') return undefined;

    const health = inv.project ? healthFor(this.cfg, inv.project) : undefined;
    const context = [this.entities.contextFor(inv.question), health ? describeHealth(health) : '']
      .filter(Boolean)
      .join('\n\n');

    const run = this.registry.submit({
      prompt: INVESTIGATION_PROMPT(inv.question, context, this.findings(id), inv.step),
      project: inv.project ?? undefined,
      intent: 'query',
      taskClass: 'assistant',
      channel: (inv.channel as Channel) ?? 'dashboard',
      threadId: inv.threadId ?? `investigation:${id}`,
      // This is what actually makes the run read-only: the profile denies every
      // write and halts on the first attempt.
      permissionProfile: 'investigate',
    });
    this.db.prepare('UPDATE investigations SET run_id = ?, updated_at = ? WHERE id = ?').run(run.id, new Date().toISOString(), id);
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(`investigation.run.${run.id}`, id, new Date().toISOString());
    return run;
  }

  /** Called when a run finishes; harvests findings and decides whether to continue. */
  onRunFinished(rec: RunRecord): Investigation | undefined {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(`investigation.run.${rec.id}`) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    const id = row.value;
    const inv = this.get(id);
    if (!inv) return undefined;

    const text = rec.result ?? '';
    const harvested = parseFindings(text);
    for (const f of harvested) this.addFinding(id, f.kind, f.text);

    const answer = parseAnswer(text);
    const blocked = parseBlocked(text);
    const step = inv.step + 1;

    if (answer) {
      this.finish(id, 'answered', answer);
    } else if (blocked) {
      this.addFinding(id, 'blocked', blocked);
      this.finish(id, 'blocked', blocked);
    } else if (rec.status !== 'done') {
      // Ran out of turns, was killed, crashed — resumable, so resume it, but
      // not forever.
      if (step >= 5) this.finish(id, 'blocked', 'gave up after five steps without an answer');
      else {
        this.db.prepare('UPDATE investigations SET step = ?, updated_at = ? WHERE id = ?').run(step, new Date().toISOString(), id);
        log.info('resuming investigation', { id, step });
        this.advance(id);
      }
    } else {
      // Finished cleanly but said neither ANSWER nor BLOCKED — take the result.
      this.finish(id, 'answered', text.trim().slice(0, 2000) || 'no answer given');
    }

    return this.get(id);
  }

  private finish(id: string, status: InvestigationStatus, answer: string): void {
    this.db
      .prepare('UPDATE investigations SET status = ?, answer = ?, updated_at = ? WHERE id = ?')
      .run(status, answer, new Date().toISOString(), id);
    const inv = this.get(id)!;
    // A critical event, so the notification service pushes it back to whichever
    // channel asked — the callback the fire-and-forget shape depends on.
    this.events.append({
      runId: inv.runId,
      kind: status === 'answered' ? 'run.finished' : 'run.stuck',
      source: 'investigate',
      summary: `${inv.question}\n\n${answer}`,
      data: { investigation: id, status, findings: this.findings(id).length },
    });
  }

  get(id: string): Investigation | undefined {
    const row = this.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? toInvestigation(row) : undefined;
  }

  list(limit = 25): Investigation[] {
    return (this.db.prepare('SELECT * FROM investigations ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map(toInvestigation);
  }

  open(): Investigation[] {
    return (this.db.prepare(`SELECT * FROM investigations WHERE status = 'open' ORDER BY created_at ASC`).all() as unknown as Row[]).map(toInvestigation);
  }

  addFinding(investigation: string, kind: FindingKind, text: string, evidence?: string, vaultPath?: string): Finding {
    const inv = this.get(investigation);
    const info = this.db
      .prepare('INSERT INTO findings (investigation, ts, step, kind, text, evidence, vault_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(investigation, new Date().toISOString(), inv?.step ?? 0, kind, text, evidence ?? null, vaultPath ?? null);
    return this.findings(investigation).find((f) => f.id === Number(info.lastInsertRowid))!;
  }

  findings(investigation: string): Finding[] {
    return (
      this.db.prepare('SELECT * FROM findings WHERE investigation = ? ORDER BY id ASC').all(investigation) as unknown as Array<
        Finding & { vault_path: string | null }
      >
    ).map((f) => ({ ...f, vaultPath: f.vault_path }));
  }

  /**
   * Turn a finished investigation into a fix — and hold the fix to the check
   * that exposed the problem. Reporting "fixed" without re-running that check
   * is the single most common way an agent lies without meaning to.
   */
  async proposeFix(id: string, opts: { channel?: Channel; threadId?: string } = {}): Promise<RunRecord | undefined> {
    const inv = this.get(id);
    if (!inv || inv.status !== 'answered') return undefined;
    const cause = this.findings(id).find((f) => f.kind === 'cause');

    const run = this.registry.submit({
      prompt: [
        `Fix this. It has already been diagnosed — do not re-investigate.`,
        '',
        `Problem: ${inv.question}`,
        `Diagnosis: ${inv.answer}`,
        cause ? `Cause: ${cause.text}` : '',
        '',
        inv.originCheck
          ? `When you are done, re-run the check called "${inv.originCheck}" and paste its output. Do not report success unless that check passes.`
          : 'When you are done, re-run whatever check would have caught this and paste its output.',
      ]
        .filter(Boolean)
        .join('\n'),
      project: inv.project ?? undefined,
      intent: 'task',
      channel: opts.channel ?? (inv.channel as Channel) ?? 'dashboard',
      threadId: opts.threadId ?? inv.threadId ?? `investigation:${id}`,
    });

    this.db
      .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(`fix.investigation.${run.id}`, id, new Date().toISOString());
    return run;
  }

  /**
   * Verify a fix by re-running the originating check ourselves. The run's own
   * claim of success is not evidence.
   */
  async verifyFix(rec: RunRecord): Promise<{ verified: boolean; detail: string } | undefined> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(`fix.investigation.${rec.id}`) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    const inv = this.get(row.value);
    if (!inv?.originCheck || !inv.project) return undefined;

    const health = healthFor(this.cfg, inv.project);
    if (!health) return undefined;

    const result = await recheck(health, inv.originCheck, health.repoPath);
    const verified = result.ok;
    this.addFinding(inv.id, verified ? 'observation' : 'blocked', `after ${rec.id}: check "${inv.originCheck}" ${verified ? 'passes' : 'still fails'}`, result.output.slice(0, 500));

    this.events.append({
      runId: rec.id,
      kind: verified ? 'run.finished' : 'run.failed',
      source: 'investigate',
      summary: verified
        ? `verified: "${inv.originCheck}" passes again after ${rec.id}`
        : `NOT fixed: "${inv.originCheck}" still fails after ${rec.id} — ${result.skipped ?? result.output.split('\n')[0] ?? ''}`,
      data: { investigation: inv.id, check: inv.originCheck, verified },
    });

    return { verified, detail: result.output.slice(0, 500) };
  }
}

/** `FINDING cause: the migration never ran` */
export function parseFindings(text: string): Array<{ kind: FindingKind; text: string }> {
  const out: Array<{ kind: FindingKind; text: string }> = [];
  const re = /^\s*FINDING\s+(observation|hypothesis|ruled_out|cause|blocked)\s*:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ kind: m[1]!.toLowerCase() as FindingKind, text: m[2]!.trim() });
  }
  return out;
}

export function parseAnswer(text: string): string | undefined {
  const m = /^\s*ANSWER\s*:\s*([\s\S]+?)(?:\n\s*(?:FINDING|BLOCKED)\b|$)/im.exec(text);
  return m ? m[1]!.trim() : undefined;
}

export function parseBlocked(text: string): string | undefined {
  const m = /^\s*BLOCKED\s*:\s*([\s\S]+?)(?:\n\s*(?:FINDING|ANSWER)\b|$)/im.exec(text);
  return m ? m[1]!.trim() : undefined;
}
