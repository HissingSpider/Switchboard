import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expandPath } from '../config/load.js';

/**
 * The entity map: what you say out loud, and what the machine has to look at.
 *
 * "How's signup doing?" is a complete question to a person and useless to an
 * agent — it has to become a PostHog insight id, an event name, a table, a repo
 * path and a number to compare against. Without this map every investigation
 * begins by rediscovering the same twenty facts, badly and expensively.
 *
 * Twenty entries is the right order of magnitude. This is a hand-curated map of
 * the things actually talked about, not an attempt to describe the whole system.
 */
export interface Entity {
  /** Canonical name. */
  name: string;
  /** What a person calls it out loud. */
  aliases: string[];
  /** One line a model can act on. */
  description?: string;
  posthog?: {
    projectId?: string;
    insightId?: string;
    eventName?: string;
    /** A saved SQL/HogQL query name. */
    query?: string;
  };
  /** Repo-relative or absolute paths where this lives. */
  paths?: string[];
  /** Database tables that back it. */
  tables?: string[];
  /** What "normal" looks like, so a number can be judged rather than reported. */
  baseline?: string;
  /** Project this belongs to, if any. */
  project?: string;
}

export interface EntityMap {
  entities: Entity[];
  updatedAt?: string;
}

export const EXAMPLE_ENTITY_MAP: EntityMap = {
  entities: [
    {
      name: 'signup',
      aliases: ['sign up', 'signups', 'registration', 'new users'],
      description: 'Account creation, from landing on the form to a first successful session.',
      posthog: { eventName: 'user_signed_up', insightId: 'REPLACE_ME' },
      paths: ['app/(auth)/signup'],
      tables: ['users'],
      baseline: '20-40 per day on weekdays, roughly half that at weekends',
    },
    {
      name: 'first sync',
      aliases: ['onboarding', 'activation', 'first context load'],
      description: 'A new account successfully loading context for the first time.',
      posthog: { eventName: 'first_sync_completed' },
      baseline: 'about 60% of signups within 24h',
    },
  ],
};

export class EntityRegistry {
  private entities: Entity[] = [];
  readonly path: string;

  constructor(path: string) {
    this.path = expandPath(path);
    this.reload();
  }

  reload(): number {
    if (!existsSync(this.path)) {
      this.entities = [];
      return 0;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as EntityMap | Entity[];
      this.entities = Array.isArray(parsed) ? parsed : (parsed.entities ?? []);
    } catch {
      this.entities = [];
    }
    return this.entities.length;
  }

  all(): Entity[] {
    return this.entities;
  }

  get(name: string): Entity | undefined {
    const n = name.toLowerCase();
    return this.entities.find((e) => e.name.toLowerCase() === n || e.aliases.some((a) => a.toLowerCase() === n));
  }

  /**
   * Which entities is this utterance about? Longest alias first, so "first sync"
   * wins over "sync" and a question about onboarding doesn't resolve to the
   * wrong thing.
   */
  resolve(text: string, limit = 4): Entity[] {
    const haystack = ` ${text.toLowerCase()} `;
    const scored: Array<{ entity: Entity; score: number }> = [];
    for (const entity of this.entities) {
      let best = 0;
      for (const term of [entity.name, ...entity.aliases]) {
        const t = term.toLowerCase();
        if (haystack.includes(` ${t} `) || haystack.includes(` ${t}?`) || haystack.includes(` ${t},`)) {
          best = Math.max(best, t.length + 10);
        } else if (haystack.includes(t)) {
          best = Math.max(best, t.length);
        }
      }
      if (best) scored.push({ entity, score: best });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entity);
  }

  /**
   * The block injected into an investigation's prompt. Only the entities the
   * question is about — the whole map would be most of the context window and
   * would bury the two that matter.
   */
  contextFor(text: string): string {
    const hits = this.resolve(text);
    if (!hits.length) return '';
    const lines = ['What these terms refer to concretely:'];
    for (const e of hits) {
      const parts: string[] = [`- ${e.name}`];
      if (e.description) parts.push(`  ${e.description}`);
      if (e.posthog?.eventName) parts.push(`  PostHog event: ${e.posthog.eventName}`);
      if (e.posthog?.insightId) parts.push(`  PostHog insight: ${e.posthog.insightId}`);
      if (e.posthog?.query) parts.push(`  Saved query: ${e.posthog.query}`);
      if (e.paths?.length) parts.push(`  Code: ${e.paths.join(', ')}`);
      if (e.tables?.length) parts.push(`  Tables: ${e.tables.join(', ')}`);
      if (e.baseline) parts.push(`  Normal looks like: ${e.baseline}`);
      lines.push(parts.join('\n'));
    }
    return lines.join('\n');
  }

  /** Entities with no baseline are the ones that will produce useless answers. */
  gaps(): Array<{ name: string; missing: string[] }> {
    return this.entities
      .map((e) => {
        const missing: string[] = [];
        if (!e.baseline) missing.push('baseline');
        if (!e.posthog?.eventName && !e.posthog?.insightId && !e.posthog?.query) missing.push('posthog');
        if (!e.paths?.length) missing.push('paths');
        return { name: e.name, missing };
      })
      .filter((g) => g.missing.length);
  }

  write(map: EntityMap): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ ...map, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    this.reload();
  }

  /** Write a starter map so there is something to edit rather than invent. */
  seed(): string {
    if (existsSync(this.path)) return this.path;
    this.write(EXAMPLE_ENTITY_MAP);
    return this.path;
  }
}
