import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  /** Everything after the frontmatter. */
  body: string;
  dir: string;
  file: string;
  /** Executable helpers shipped alongside SKILL.md. */
  scripts: string[];
  /** Extra reference files the skill can pull in on demand. */
  references: string[];
  /** Optional explicit trigger words, in addition to description matching. */
  triggers: string[];
  allowedTools?: string[];
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/** Minimal YAML frontmatter reader — key: value and key: [a, b] only. */
export function parseFrontmatter(src: string): Frontmatter {
  if (!src.startsWith('---')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const head = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\n/, '');
  const data: Record<string, string> = {};
  let lastKey = '';
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = m[1]!;
      data[lastKey] = m[2]!.trim();
    } else if (lastKey && /^\s+/.test(line)) {
      data[lastKey] = `${data[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

function parseList(v?: string): string[] {
  if (!v) return [];
  const trimmed = v.trim().replace(/^\[|\]$/g, '');
  return trimmed
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function loadSkill(dir: string): Skill | undefined {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return undefined;
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  const name = data.name ?? dir.split('/').pop()!;
  if (!data.description) return undefined; // description-based selection needs one
  return {
    name,
    description: data.description,
    body,
    dir,
    file,
    scripts: listFiles(join(dir, 'scripts')),
    references: listFiles(join(dir, 'references')),
    triggers: parseList(data.triggers),
    allowedTools: parseList(data['allowed-tools'] ?? data.allowedTools).length
      ? parseList(data['allowed-tools'] ?? data.allowedTools)
      : undefined,
  };
}

/**
 * Skills are progressive disclosure: the loader only ever puts name +
 * description in front of the model. The body is loaded when the skill is
 * actually selected, so a hundred skills cost a hundred lines of context.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(private readonly root: string) {
    this.reload();
  }

  reload(): number {
    this.skills.clear();
    if (!existsSync(this.root)) return 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = loadSkill(join(this.root, entry.name));
      if (skill) this.skills.set(skill.name, skill);
    }
    return this.skills.size;
  }

  all(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** The one-line-per-skill catalogue injected into a run's system prompt. */
  catalogue(): string {
    const list = this.all();
    if (!list.length) return '';
    const lines = list.map((s) => `- ${s.name}: ${s.description}`);
    return [
      'Available skills. When one matches the task, read its SKILL.md before doing anything else:',
      ...lines,
      '',
      `Skill files live under ${this.root}/<name>/SKILL.md.`,
    ].join('\n');
  }

  /**
   * Cheap description-based selection, used when we want to pre-load a skill
   * rather than let the model pick. Scores on trigger words first, then on
   * description word overlap.
   */
  select(text: string, limit = 3): Skill[] {
    const words = new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    const scored = this.all().map((s) => {
      let score = 0;
      for (const t of s.triggers) if (text.toLowerCase().includes(t.toLowerCase())) score += 5;
      for (const w of s.description.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length > 3 && words.has(w)) score += 1;
      }
      if (text.toLowerCase().includes(s.name.toLowerCase())) score += 8;
      return { skill: s, score };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.skill);
  }

  /** Full text of a skill, for injecting once selected. */
  expand(name: string): string | undefined {
    const s = this.get(name);
    if (!s) return undefined;
    const parts = [`# Skill: ${s.name}`, s.description, '', s.body];
    if (s.scripts.length) parts.push('', 'Scripts:', ...s.scripts.map((p) => `- ${p}`));
    if (s.references.length) parts.push('', 'References:', ...s.references.map((p) => `- ${p}`));
    return parts.join('\n');
  }

  validate(): Array<{ skill: string; problems: string[] }> {
    const out: Array<{ skill: string; problems: string[] }> = [];
    for (const s of this.all()) {
      const problems: string[] = [];
      if (s.description.length < 20) problems.push('description is too short to select on');
      if (s.description.length > 500) problems.push('description is over 500 chars');
      if (!/^[a-z0-9-]+$/.test(s.name)) problems.push('name should be lowercase-kebab-case');
      if (s.body.trim().length < 50) problems.push('body is essentially empty');
      if (problems.length) out.push({ skill: s.name, problems });
    }
    return out;
  }
}
