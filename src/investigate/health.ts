import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoadedConfig } from '../config/load.js';
import type { ProjectHealth, HealthCheckStep } from '../config/schema.js';

const exec = promisify(execFile);

/**
 * Per-project health manifest.
 *
 * "Is the site OK?" has a different answer for every project, and the answer
 * always depends on the same five facts: where it runs, where its errors show
 * up, which three numbers matter, where the code is, and what to check first.
 * Writing those down once turns a vague question into a sequence.
 *
 * The checks are ordered cheapest-first on purpose: an HTTP 200 from the deploy
 * target answers most "is it down" questions in 200ms without a model call.
 */
export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
  ms: number;
  /** Set when the step could not be run at all, as opposed to failing. */
  skipped?: string;
}

export interface HealthReport {
  project: string;
  ok: boolean;
  results: CheckResult[];
  /** The first failing check — the one a fix has to make pass again. */
  firstFailure?: CheckResult;
  /** Steps a model has to carry out, because they are questions not commands. */
  pending: HealthCheckStep[];
}

export function healthFor(cfg: LoadedConfig, project: string): ProjectHealth | undefined {
  return cfg.health.find((h) => h.project === project);
}

export function describeHealth(h: ProjectHealth): string {
  return [
    `Project: ${h.project}`,
    h.deployTarget ? `Runs at: ${h.deployTarget}` : '',
    h.errorSource ? `Errors show up in: ${h.errorSource}` : '',
    h.keyMetrics?.length ? `The numbers that matter: ${h.keyMetrics.join(', ')}` : '',
    h.repoPath ? `Code: ${h.repoPath}` : '',
    h.checks?.length ? `Check in this order: ${h.checks.map((c) => c.name).join(' → ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Run the runnable part of the check sequence. Steps phrased as `ask` are left
 * for the investigation run — this only executes what is deterministic, and
 * stops at the first failure because everything after it is likely noise.
 */
export async function runChecks(
  h: ProjectHealth,
  opts: { cwd?: string; stopOnFailure?: boolean; timeoutMs?: number } = {},
): Promise<HealthReport> {
  const results: CheckResult[] = [];
  const pending: HealthCheckStep[] = [];
  const stopOnFailure = opts.stopOnFailure ?? true;

  for (const step of h.checks ?? []) {
    if (!step.run) {
      pending.push(step);
      continue;
    }
    const started = Date.now();
    try {
      const { stdout, stderr } = await exec('/bin/sh', ['-c', step.run], {
        cwd: opts.cwd ?? h.repoPath,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = `${stdout}${stderr}`.trim();
      const ok = step.expect ? output.includes(step.expect) : true;
      results.push({ name: step.name, ok, output: output.slice(0, 4000), ms: Date.now() - started });
      if (!ok && stopOnFailure) break;
    } catch (err) {
      const message = (err as Error & { stdout?: string; stderr?: string }).stdout ?? (err as Error).message;
      results.push({ name: step.name, ok: false, output: String(message).slice(0, 4000), ms: Date.now() - started });
      if (stopOnFailure) break;
    }
  }

  const firstFailure = results.find((r) => !r.ok);
  return { project: h.project, ok: !firstFailure, results, firstFailure, pending };
}

/** Re-run one named check — what a fix has to satisfy before claiming success. */
export async function recheck(h: ProjectHealth, name: string, cwd?: string): Promise<CheckResult> {
  const step = (h.checks ?? []).find((c) => c.name === name);
  if (!step) return { name, ok: false, output: '', ms: 0, skipped: 'no such check in the health manifest' };
  if (!step.run) return { name, ok: false, output: '', ms: 0, skipped: 'this check is a question, not a command' };
  const report = await runChecks({ ...h, checks: [step] }, { cwd, stopOnFailure: false });
  return report.results[0] ?? { name, ok: false, output: '', ms: 0, skipped: 'check produced no result' };
}

export function formatReport(report: HealthReport): string {
  const lines = report.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} (${r.ms}ms)${r.ok ? '' : `\n    ${r.output.split('\n')[0] ?? ''}`}`);
  if (report.pending.length) lines.push(...report.pending.map((p) => `· ${p.name} (needs judgement: ${p.ask ?? ''})`));
  lines.push('', report.ok ? `${report.project}: healthy` : `${report.project}: ${report.firstFailure?.name} failed`);
  return lines.join('\n');
}

export const EXAMPLE_HEALTH: ProjectHealth = {
  project: 'example',
  deployTarget: 'https://example.com',
  errorSource: 'PostHog project 12345, error tracking',
  keyMetrics: ['signups per day', 'first-sync rate', 'p95 API latency'],
  repoPath: '~/projects/example',
  checks: [
    { name: 'site responds', run: 'curl -sS -o /dev/null -w "%{http_code}" https://example.com', expect: '200' },
    { name: 'build passes', run: 'npm run build' },
    { name: 'tests pass', run: 'npm test' },
    { name: 'error rate', ask: 'Is the error count in the last hour above its usual range?' },
  ],
};
