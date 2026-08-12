import { existsSync } from 'node:fs';
import type { LoadedConfig } from '../config/load.js';
import { findProject } from '../config/load.js';
import type { ProjectConfig } from '../config/schema.js';

export interface ProjectMatch {
  project: ProjectConfig;
  /** How we found it: an explicit `@name`, a name in the text, or the sticky default. */
  via: 'explicit' | 'mention' | 'sticky';
  confidence: number;
}

/** `@swb do the thing` / `in swb: do the thing` / `swb> do the thing` */
const EXPLICIT = [/^@([\w.-]+)\s+/, /^in\s+([\w.-]+)\s*[:,]\s*/i, /^([\w.-]+)>\s*/];

export function stripProjectPrefix(text: string): { text: string; key?: string } {
  for (const re of EXPLICIT) {
    const m = re.exec(text);
    if (m) return { text: text.slice(m[0].length).trim(), key: m[1] };
  }
  return { text };
}

/**
 * Named shortcut registry. Explicit beats mention beats sticky, and we never
 * guess a project we cannot see on disk — a run in a missing directory just
 * fails later in a more confusing way.
 */
export function resolveProject(cfg: LoadedConfig, text: string, sticky?: string): { match?: ProjectMatch; text: string } {
  const stripped = stripProjectPrefix(text);
  if (stripped.key) {
    const p = findProject(cfg, stripped.key);
    if (p) return { match: { project: p, via: 'explicit', confidence: 1 }, text: stripped.text };
    // An explicit prefix we don't recognise is probably not a project at all.
    return { text };
  }

  const lower = text.toLowerCase();
  for (const p of cfg.projects) {
    const keys = [p.name, ...(p.aliases ?? [])];
    for (const k of keys) {
      const re = new RegExp(`\\b${escapeRe(k.toLowerCase())}\\b`);
      if (re.test(lower)) return { match: { project: p, via: 'mention', confidence: 0.7 }, text };
    }
  }

  if (sticky) {
    const p = findProject(cfg, sticky);
    if (p) return { match: { project: p, via: 'sticky', confidence: 0.4 }, text };
  }
  return { text };
}

export function projectExists(p: ProjectConfig): boolean {
  return existsSync(p.path);
}

export function listProjects(cfg: LoadedConfig): Array<ProjectConfig & { exists: boolean }> {
  return cfg.projects.map((p) => ({ ...p, exists: projectExists(p) }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
