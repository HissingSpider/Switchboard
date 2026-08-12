import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import type { RunRegistry } from '../runner/registry.js';
import type { RunStore, RunRecord } from '../store/runs.js';
import type { EventLog } from '../store/eventlog.js';
import type { SkillStore } from '../store/skills.js';
import { SkillRegistry, loadSkill } from './loader.js';
import { parseManifest, validateManifest, describeManifest, EMPTY_MANIFEST, type CapabilityManifest } from './manifest.js';
import { onManifestChange } from './trust.js';
import { waitForRun } from '../agents/handoff.js';
import { logger } from '../core/logger.js';

const log = logger('skills:author');

/**
 * Self-authoring skills.
 *
 * When a run hits something it has no repeatable way to do, the useful response
 * isn't to improvise once and forget — it's to write the tool, prove it works,
 * and keep it. That's what this does: detect the gap, check we don't already
 * have something for it, spawn a run whose entire job is to author the skill,
 * make that run write its own tests and pass them, register the result at the
 * lowest trust tier, and retry the thing the human originally asked for.
 *
 * Every step is a real, budgeted, audited run. Nothing here bypasses the gate.
 */

// ------------------------------------------------------------ gap detection

export interface Gap {
  /** What the run couldn't do, in its own words. */
  need: string;
  /** The original request that exposed it. */
  originTask: string;
  /** How sure we are this is a real capability gap, 0..1. */
  confidence: number;
  evidence: string;
}

const GAP_PHRASES: Array<{ re: RegExp; confidence: number }> = [
  { re: /\bi (don'?t|do not) have (a|any) (way|tool|script|command) to\b/i, confidence: 0.9 },
  { re: /\b(there|we) (is|are|'s) no (existing )?(tool|script|skill|helper) (for|to)\b/i, confidence: 0.85 },
  { re: /\bi (would|'d) need (a|to write a) (script|tool|helper)\b/i, confidence: 0.8 },
  { re: /\bno (built-?in|automated) way to\b/i, confidence: 0.75 },
  { re: /\bi had to do (this|that) (by hand|manually)\b/i, confidence: 0.6 },
  { re: /\bthis (is|was) tedious (and|to) repeat\b/i, confidence: 0.5 },
];

/**
 * Look for a capability gap in what a run said.
 *
 * Deliberately conservative. A false positive spends real money writing a skill
 * nobody wanted; a false negative just means the human asks again tomorrow.
 */
export function detectGap(text: string, originTask: string): Gap | undefined {
  for (const { re, confidence } of GAP_PHRASES) {
    const match = re.exec(text);
    if (!match) continue;
    // Take the sentence the phrase appeared in — that's the actual need.
    const start = text.lastIndexOf('.', match.index) + 1;
    const endMark = text.indexOf('.', match.index + match[0].length);
    const sentence = text.slice(start, endMark === -1 ? undefined : endMark + 1).trim();
    return { need: sentence || match[0], originTask, confidence, evidence: match[0] };
  }
  return undefined;
}

export function shouldAuthor(gap: Gap, minConfidence = 0.75): boolean {
  return gap.confidence >= minConfidence;
}

// -------------------------------------------------------------------- dedup

export interface DuplicateMatch {
  name: string;
  score: number;
  reason: string;
}

/**
 * Before writing anything, check whether we already solved this. Skill sprawl
 * is the failure mode of self-authoring: twelve slightly different scripts for
 * the same job, none of them the one the model reaches for.
 */
export function findDuplicates(registry: SkillRegistry, need: string, threshold = 4): DuplicateMatch[] {
  const selected = registry.select(need, 5);
  const needWords = new Set(
    need
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

  return selected
    .map((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.triggers.join(' ')}`.toLowerCase();
      let score = 0;
      const overlap: string[] = [];
      for (const w of needWords) {
        if (haystack.includes(w)) {
          score += 1;
          overlap.push(w);
        }
      }
      return { name: skill.name, score, reason: overlap.length ? `overlaps on: ${overlap.join(', ')}` : 'selected by description' };
    })
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- authoring

export interface AuthoringResult {
  status: 'authored' | 'duplicate' | 'failed' | 'rejected';
  skill?: string;
  runId?: string;
  /** Why we stopped, if we did. */
  reason: string;
  manifest?: CapabilityManifest;
  testsPassed?: boolean;
}

const AUTHORING_PROMPT = (gap: Gap, skillsDir: string, name: string) =>
  [
    `Write a new Switchboard skill that fills this gap, then prove it works.`,
    '',
    `The gap: ${gap.need}`,
    `It came up while doing: ${gap.originTask}`,
    '',
    `Create the directory ${join(skillsDir, name)} containing:`,
    '',
    `1. SKILL.md with YAML frontmatter. Required keys:`,
    `     name: ${name}`,
    `     description: one or two sentences naming the situation this applies to,`,
    `                  written so a model choosing between skills can tell.`,
    `     triggers: [a few literal phrases]`,
    `   Then a capability manifest — declare ONLY what the skill genuinely needs:`,
    `     network: [hostnames]        omit entirely if it needs none`,
    `     read-paths: [paths]`,
    `     write-paths: [paths]`,
    `     commands: [command names]   the first word only, e.g. git, node`,
    `     mcp: [server names]`,
    `     rationale: why these are needed`,
    `   Anything you do not declare will be BLOCKED at runtime. Do not declare`,
    `   anything "just in case" — a wider manifest means a lower trust tier.`,
    `   Do not set tier2; a new skill cannot have it.`,
    `   Then the body: when to use it, the steps, and any gotchas.`,
    '',
    `2. scripts/run.mjs — the deterministic part. Anything that does not need`,
    `   judgement belongs here, not in the prose. Node, no dependencies.`,
    '',
    `3. test/cases.json — an array of test cases, each { "name", "argv", "expect" }`,
    `   where expect is a substring that must appear in the script's stdout.`,
    `   Write at least three, including one failure case. They must pass against`,
    `   the real script: run \`node scripts/run.mjs <argv>\` yourself and check.`,
    '',
    `Constraints: no network calls in the tests. Keep SKILL.md under 200 lines.`,
    `Finish by running your own test cases and reporting pass/fail for each.`,
  ].join('\n');

export interface AuthoringDeps {
  cfg: LoadedConfig;
  registry: RunRegistry;
  runs: RunStore;
  events: EventLog;
  skills: SkillRegistry;
  store: SkillStore;
}

/** Turn a need into a plausible kebab-case skill name. */
export function nameFor(need: string, taken: Set<string>): string {
  const words = need
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 3);
  let base = words.join('-') || 'new-skill';
  if (base.length > 40) base = base.slice(0, 40).replace(/-[^-]*$/, '');
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'need', 'would', 'could', 'should',
  'there', 'their', 'from', 'into', 'about', 'because', 'script', 'tool', 'way', 'any',
]);

/**
 * The full flow. Returns without authoring if we already have something, or if
 * the authored skill can't pass its own tests.
 */
export async function authorSkill(d: AuthoringDeps, gap: Gap, opts: { force?: boolean } = {}): Promise<AuthoringResult> {
  // 1. Do we already have this?
  const duplicates = findDuplicates(d.skills, gap.need);
  if (duplicates.length && !opts.force) {
    d.events.append({
      runId: null,
      kind: 'system.start',
      source: 'skills',
      summary: `not authoring a skill for "${truncate(gap.need, 60)}" — "${duplicates[0]!.name}" already covers it (${duplicates[0]!.reason})`,
      data: { gap, duplicates },
    });
    return { status: 'duplicate', skill: duplicates[0]!.name, reason: duplicates[0]!.reason };
  }

  const taken = new Set(d.skills.all().map((s) => s.name));
  const name = nameFor(gap.need, taken);
  const skillDir = join(d.cfg.resolved.skillsDir, name);

  d.events.append({
    runId: null,
    kind: 'run.queued',
    source: 'skills',
    summary: `authoring skill "${name}" for: ${truncate(gap.need, 100)}`,
    data: { gap, name },
  });

  // 2. Spawn a real run to write it. Its workdir is the skills directory, so
  //    the normal write-scope check already confines it to skills.
  const run = d.registry.submit({
    prompt: AUTHORING_PROMPT(gap, d.cfg.resolved.skillsDir, name),
    intent: 'task',
    taskClass: 'coding',
    channel: 'dashboard',
    threadId: `skill-authoring:${name}`,
  });

  const finished = await waitForRun(d.registry, run.id, 20 * 60_000);
  if (!finished || finished.status !== 'done') {
    cleanup(skillDir);
    return { status: 'failed', runId: run.id, reason: `authoring run ${finished?.status ?? 'timed out'}` };
  }

  // 3. Did it actually produce a loadable skill?
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    cleanup(skillDir);
    return { status: 'failed', runId: run.id, reason: 'the authoring run produced no SKILL.md' };
  }
  const loaded = loadSkill(skillDir);
  if (!loaded) {
    cleanup(skillDir);
    return { status: 'failed', runId: run.id, reason: 'SKILL.md is missing a usable description' };
  }

  // 4. Manifest sanity. A new skill is sandboxed, so it may not declare much.
  const manifest = parseManifest(readFileSync(skillFile, 'utf8'));
  const problems = validateManifest(manifest, 'sandboxed');
  // Sandboxed can't declare anything, so this always trips for a useful skill.
  // What we actually care about is whether it declared something *ungrantable*.
  const fatal = problems.filter((p) => /never grantable|whole machine|not a hostname|never accepted/.test(p.message));
  if (fatal.length) {
    cleanup(skillDir);
    return { status: 'rejected', runId: run.id, reason: `manifest rejected: ${fatal.map((p) => p.message).join('; ')}` };
  }

  // 5. Self-test before it is allowed to exist.
  const tests = await runSelfTests(skillDir);
  if (!tests.ok) {
    d.events.append({
      runId: run.id,
      kind: 'run.failed',
      source: 'skills',
      summary: `"${name}" failed its own tests (${tests.failed}/${tests.total}) — not registering`,
      data: { name, results: tests.results },
    });
    cleanup(skillDir);
    return { status: 'failed', runId: run.id, reason: `failed its own tests: ${tests.results.filter((r) => !r.ok).map((r) => r.name).join(', ')}`, testsPassed: false };
  }

  // 6. Register at the bottom of the ladder.
  d.store.register({ name, manifest, trust: 'sandboxed', authoredBy: run.id, originTask: gap.originTask });
  d.skills.reload();

  d.events.append({
    runId: run.id,
    kind: 'run.finished',
    source: 'skills',
    summary: `authored "${name}" — ${tests.total} self-tests passed, sandboxed — ${describeManifest(manifest)}`,
    data: { name, manifest, tests: tests.results, gap },
  });

  return { status: 'authored', skill: name, runId: run.id, reason: `${tests.total} self-tests passed`, manifest, testsPassed: true };
}

/** Author the skill, then re-run what the human originally asked for. */
export async function authorAndRetry(d: AuthoringDeps, gap: Gap, original: RunRecord): Promise<{ authoring: AuthoringResult; retryRunId?: string }> {
  const authoring = await authorSkill(d, gap);
  if (authoring.status !== 'authored' && authoring.status !== 'duplicate') return { authoring };

  const skillName = authoring.skill!;
  const retry = d.registry.submit({
    prompt: [
      original.prompt,
      '',
      `(A skill called "${skillName}" now exists for the part you were missing. Read`,
      `${join(d.cfg.resolved.skillsDir, skillName, 'SKILL.md')} before you start.)`,
    ].join('\n'),
    project: original.project ?? undefined,
    agent: original.agent ?? undefined,
    intent: 'task',
    channel: original.channel ?? 'dashboard',
    threadId: original.threadId ?? undefined,
    parentRunId: original.id,
  });

  d.events.append({
    runId: retry.id,
    kind: 'run.queued',
    source: 'skills',
    summary: `retrying ${original.id} with the new "${skillName}" skill`,
    data: { originalRunId: original.id, skill: skillName },
  });

  return { authoring, retryRunId: retry.id };
}

// ------------------------------------------------------------------- testing

export interface TestCase {
  name: string;
  argv?: string[];
  expect?: string;
  /** Set when the case is meant to fail. */
  expectFailure?: boolean;
}

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Run a skill's own test cases against its own script. This is the gate between
 * "the model wrote some files" and "this is a skill": nothing gets registered
 * on the strength of the authoring run's say-so.
 */
export async function runSelfTests(skillDir: string): Promise<{ ok: boolean; total: number; failed: number; results: TestResult[] }> {
  const casesFile = join(skillDir, 'test', 'cases.json');
  const script = join(skillDir, 'scripts', 'run.mjs');
  if (!existsSync(casesFile)) {
    return { ok: false, total: 0, failed: 1, results: [{ name: 'test/cases.json', ok: false, detail: 'no test cases were written' }] };
  }

  let cases: TestCase[];
  try {
    cases = JSON.parse(readFileSync(casesFile, 'utf8')) as TestCase[];
  } catch (err) {
    return { ok: false, total: 0, failed: 1, results: [{ name: 'test/cases.json', ok: false, detail: `unparseable: ${(err as Error).message}` }] };
  }
  if (!Array.isArray(cases) || cases.length < 3) {
    return { ok: false, total: cases?.length ?? 0, failed: 1, results: [{ name: 'coverage', ok: false, detail: 'fewer than three test cases' }] };
  }
  if (!existsSync(script)) {
    return { ok: false, total: cases.length, failed: cases.length, results: [{ name: 'scripts/run.mjs', ok: false, detail: 'missing' }] };
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const results: TestResult[] = [];
  for (const c of cases) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [script, ...(c.argv ?? [])], {
        cwd: skillDir,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        // The test run gets no inherited secrets.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test' },
      });
      const output = `${stdout}${stderr}`;
      if (c.expectFailure) {
        results.push({ name: c.name, ok: false, detail: 'expected a failure but the script succeeded' });
      } else if (c.expect && !output.includes(c.expect)) {
        results.push({ name: c.name, ok: false, detail: `expected "${c.expect}" in the output` });
      } else {
        results.push({ name: c.name, ok: true, detail: 'passed' });
      }
    } catch (err) {
      const message = (err as Error).message;
      results.push(
        c.expectFailure
          ? { name: c.name, ok: true, detail: 'failed as expected' }
          : { name: c.name, ok: false, detail: message.slice(0, 200) },
      );
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, total: results.length, failed, results };
}

/** Re-read a skill's manifest from disk and reconcile trust if it changed. */
export function reconcileManifest(store: SkillStore, skillsDir: string, name: string, runId: string | null): void {
  const file = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) return;
  const next = parseManifest(readFileSync(file, 'utf8'));
  const record = store.get(name);
  const previous = record?.manifest ?? EMPTY_MANIFEST;
  const change = onManifestChange(store, name, previous, next, runId);
  store.register({ name, manifest: next });
  if (change.widened.length) {
    log.warn('skill manifest widened', { name, widened: change.widened, demotedTo: change.demotedTo });
  }
}

function cleanup(dir: string): void {
  // A half-written skill is worse than none: it will be offered to the model
  // by name and then fail. Remove it.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
