import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SkillRegistry, loadSkill } from './loader.js';

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
triggers: []
---

# ${name}

## When to use this

Describe the situation that should pull this skill in. Be concrete — the
description above is what selection matches on, this section is what the model
reads once it's here.

## Steps

1. …
2. …

## Notes

- Keep the body under ~200 lines. Push detail into \`references/\`.
- Put anything deterministic into \`scripts/\` and call it instead of
  re-deriving it in the model.
`;

const SCRIPT_TEMPLATE = `#!/usr/bin/env node
// Helper for this skill. Deterministic work belongs here, not in the prompt.
const [, , ...args] = process.argv;
console.log(JSON.stringify({ ok: true, args }));
`;

export function scaffoldSkill(root: string, name: string, description: string): ScaffoldResult {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('skill name must be lowercase-kebab-case');
  const dir = join(root, name);
  if (existsSync(dir)) throw new Error(`skill "${name}" already exists at ${dir}`);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'references'), { recursive: true });

  const skillFile = join(dir, 'SKILL.md');
  writeFileSync(skillFile, SKILL_TEMPLATE(name, description));
  const scriptFile = join(dir, 'scripts', 'run.mjs');
  writeFileSync(scriptFile, SCRIPT_TEMPLATE);
  chmodSync(scriptFile, 0o755);
  writeFileSync(join(dir, 'references', 'notes.md'), '# Reference notes\n\nLonger material the skill body links to.\n');

  return { dir, files: [skillFile, scriptFile] };
}

export interface SkillTestResult {
  name: string;
  ok: boolean;
  problems: string[];
  /** Which phrases in the sample set actually selected this skill. */
  selectedBy: string[];
}

/**
 * Test a skill without running a model: does it parse, does it validate, and
 * do the phrases you expect to trigger it actually select it?
 */
export function testSkill(root: string, name: string, phrases: string[] = []): SkillTestResult {
  const skill = loadSkill(join(root, name));
  if (!skill) return { name, ok: false, problems: ['no SKILL.md, or it is missing a description'], selectedBy: [] };
  const registry = new SkillRegistry(root);
  const problems = registry.validate().find((v) => v.skill === name)?.problems ?? [];
  const selectedBy = phrases.filter((p) => registry.select(p, 3).some((s) => s.name === name));
  const missed = phrases.filter((p) => !selectedBy.includes(p));
  if (missed.length) problems.push(`not selected by: ${missed.join(' | ')}`);
  return { name, ok: problems.length === 0, problems, selectedBy };
}

export function registerSkillPaths(root: string): string[] {
  return new SkillRegistry(root).all().map((s) => s.file);
}
