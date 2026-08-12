import type { Db } from './db.js';
import type { CapabilityManifest, TrustTier } from '../skills/manifest.js';
import { EMPTY_MANIFEST, TRUST_ORDER } from '../skills/manifest.js';

export interface SkillRecord {
  name: string;
  trust: TrustTier;
  createdAt: string;
  updatedAt: string;
  /** Run that authored it — null for skills a human wrote. */
  authoredBy: string | null;
  /** The request that exposed the gap this skill fills. */
  originTask: string | null;
  manifest: CapabilityManifest;
  retiredAt: string | null;
  runs: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  flagged: boolean;
  flagReason: string | null;
}

export interface SkillHistoryEntry {
  id: number;
  skill: string;
  ts: string;
  runId: string | null;
  action: 'authored' | 'edited' | 'promoted' | 'demoted' | 'retired' | 'restored';
  detail: string | null;
  diff: string | null;
}

interface Row {
  name: string;
  trust: string;
  created_at: string;
  updated_at: string;
  authored_by: string | null;
  origin_task: string | null;
  manifest: string;
  retired_at: string | null;
  runs: number;
  successes: number;
  failures: number;
  consecutive_failures: number;
  last_used_at: string | null;
  flagged: number;
  flag_reason: string | null;
}

function toSkill(r: Row): SkillRecord {
  let manifest: CapabilityManifest = EMPTY_MANIFEST;
  try {
    manifest = { ...EMPTY_MANIFEST, ...(JSON.parse(r.manifest) as CapabilityManifest) };
  } catch {
    /* a corrupt manifest degrades to the empty one, which grants nothing */
  }
  return {
    name: r.name,
    trust: r.trust as TrustTier,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    authoredBy: r.authored_by,
    originTask: r.origin_task,
    manifest,
    retiredAt: r.retired_at,
    runs: r.runs,
    successes: r.successes,
    failures: r.failures,
    consecutiveFailures: r.consecutive_failures,
    lastUsedAt: r.last_used_at,
    flagged: Boolean(r.flagged),
    flagReason: r.flag_reason,
  };
}

/** Consecutive failures past this and the skill is flagged for review. */
export const FAILURE_FLAG_THRESHOLD = 3;

/**
 * Everything about a skill that isn't in its SKILL.md: what it's allowed to do,
 * how well it actually works, who wrote it and why.
 *
 * Kept out of the file so a skill cannot edit its own trust tier or launder its
 * failure record by rewriting its own frontmatter.
 */
export class SkillStore {
  constructor(private readonly db: Db) {}

  register(input: {
    name: string;
    manifest: CapabilityManifest;
    trust?: TrustTier;
    authoredBy?: string | null;
    originTask?: string | null;
  }): SkillRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.name);
    if (existing) {
      this.db
        .prepare('UPDATE skills SET manifest = ?, updated_at = ? WHERE name = ?')
        .run(JSON.stringify(input.manifest), now, input.name);
      return this.get(input.name)!;
    }
    this.db
      .prepare(
        `INSERT INTO skills (name, trust, created_at, updated_at, authored_by, origin_task, manifest)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.trust ?? 'sandboxed',
        now,
        now,
        input.authoredBy ?? null,
        input.originTask ?? null,
        JSON.stringify(input.manifest),
      );
    this.addHistory(input.name, 'authored', input.authoredBy ?? null, input.originTask ?? 'registered');
    return this.get(input.name)!;
  }

  get(name: string): SkillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as unknown as Row | undefined;
    return row ? toSkill(row) : undefined;
  }

  all(includeRetired = false): SkillRecord[] {
    const sql = includeRetired ? 'SELECT * FROM skills ORDER BY name' : 'SELECT * FROM skills WHERE retired_at IS NULL ORDER BY name';
    return (this.db.prepare(sql).all() as unknown as Row[]).map(toSkill);
  }

  /** Skills that need a human to look at them. */
  reviewQueue(): SkillRecord[] {
    return this.all(true).filter((s) => s.flagged || (s.trust === 'sandboxed' && s.runs >= 3) || (s.retiredAt === null && s.consecutiveFailures > 0));
  }

  /** Record one use. Success resets the consecutive-failure counter. */
  recordUse(name: string, ok: boolean, opts: { runId?: string | null; ms?: number; error?: string } = {}): SkillRecord | undefined {
    if (!this.get(name)) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO skill_uses (skill, run_id, ts, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, opts.runId ?? null, now, ok ? 1 : 0, opts.ms ?? null, opts.error ?? null);

    if (ok) {
      this.db
        .prepare('UPDATE skills SET runs = runs + 1, successes = successes + 1, consecutive_failures = 0, last_used_at = ? WHERE name = ?')
        .run(now, name);
    } else {
      this.db
        .prepare('UPDATE skills SET runs = runs + 1, failures = failures + 1, consecutive_failures = consecutive_failures + 1, last_used_at = ? WHERE name = ?')
        .run(now, name);
    }

    const updated = this.get(name)!;
    // Auto-flag rather than auto-retire: a skill that fails three times might be
    // broken, or the world might have changed underneath it. That's a judgement
    // call, so it goes in the queue instead of being decided here.
    if (!updated.flagged && updated.consecutiveFailures >= FAILURE_FLAG_THRESHOLD) {
      this.flag(name, `${updated.consecutiveFailures} failures in a row`);
      return this.get(name)!;
    }
    return updated;
  }

  successRate(name: string): number | undefined {
    const s = this.get(name);
    if (!s || s.runs === 0) return undefined;
    return s.successes / s.runs;
  }

  flag(name: string, reason: string): void {
    this.db.prepare('UPDATE skills SET flagged = 1, flag_reason = ? WHERE name = ?').run(reason, name);
    this.addHistory(name, 'demoted', null, `flagged: ${reason}`);
  }

  unflag(name: string): void {
    this.db.prepare('UPDATE skills SET flagged = 0, flag_reason = NULL, consecutive_failures = 0 WHERE name = ?').run(name);
  }

  /**
   * Move a skill up or down the trust ladder. Promotion to `trusted` is
   * deliberately not something the system does on its own — see
   * `src/skills/trust.ts`.
   */
  setTrust(name: string, trust: TrustTier, by: string, detail?: string): SkillRecord | undefined {
    const current = this.get(name);
    if (!current) return undefined;
    const up = TRUST_ORDER.indexOf(trust) > TRUST_ORDER.indexOf(current.trust);
    this.db.prepare('UPDATE skills SET trust = ?, updated_at = ? WHERE name = ?').run(trust, new Date().toISOString(), name);
    this.addHistory(name, up ? 'promoted' : 'demoted', null, `${current.trust} → ${trust} by ${by}${detail ? `: ${detail}` : ''}`);
    return this.get(name);
  }

  retire(name: string, reason: string): void {
    this.db.prepare('UPDATE skills SET retired_at = ? WHERE name = ?').run(new Date().toISOString(), name);
    this.addHistory(name, 'retired', null, reason);
  }

  restore(name: string): void {
    this.db.prepare('UPDATE skills SET retired_at = NULL, flagged = 0, consecutive_failures = 0 WHERE name = ?').run(name);
    this.addHistory(name, 'restored', null, 'restored from the retirement queue');
  }

  addHistory(skill: string, action: SkillHistoryEntry['action'], runId: string | null, detail?: string, diff?: string): void {
    this.db
      .prepare('INSERT INTO skill_history (skill, ts, run_id, action, detail, diff) VALUES (?, ?, ?, ?, ?, ?)')
      .run(skill, new Date().toISOString(), runId, action, detail ?? null, diff ?? null);
  }

  history(skill: string, limit = 50): SkillHistoryEntry[] {
    return this.db
      .prepare('SELECT * FROM skill_history WHERE skill = ? ORDER BY id DESC LIMIT ?')
      .all(skill, limit) as unknown as SkillHistoryEntry[];
  }

  recentUses(skill: string, limit = 20): Array<{ ts: string; ok: number; ms: number | null; error: string | null; run_id: string | null }> {
    return this.db
      .prepare('SELECT ts, ok, ms, error, run_id FROM skill_uses WHERE skill = ? ORDER BY id DESC LIMIT ?')
      .all(skill, limit) as unknown as Array<{ ts: string; ok: number; ms: number | null; error: string | null; run_id: string | null }>;
  }

  /** Skills untouched for this long are candidates for retirement. */
  stale(days = 90): SkillRecord[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.all().filter((s) => (s.lastUsedAt ?? s.createdAt) < cutoff);
  }
}
