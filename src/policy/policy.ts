import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { ActionTier, PermissionProfile } from '../config/schema.js';
import { anyMatch, type ToolCall } from './match.js';

export interface PolicyDecision {
  tier: ActionTier;
  /** Which rule produced the decision — logged on every gated action. */
  rule: string;
  reason: string;
}

/**
 * Irreversible actions are gated by shape, not by which profile is loaded.
 * These are checked before profile rules so no per-project config can quietly
 * open up "send an email" or "buy a thing".
 */
export const IRREVERSIBLE_PATTERNS: Array<{ spec: string; label: string }> = [
  { spec: 'Bash(*git push*)', label: 'push to a remote' },
  { spec: 'Bash(*gh pr create*)', label: 'open a pull request' },
  { spec: 'Bash(*gh release*)', label: 'publish a release' },
  { spec: 'Bash(*npm publish*)', label: 'publish a package' },
  { spec: 'Bash(*rm -rf*)', label: 'recursive delete' },
  { spec: 'Bash(*osascript*Messages*)', label: 'send an iMessage' },
  { spec: 'Bash(*curl*-X POST*)', label: 'POST to an external service' },
  { spec: 'Bash(*curl*-d *)', label: 'POST to an external service' },
  { spec: 'mcp__*__send*', label: 'send a message' },
  { spec: 'mcp__*__post*', label: 'post content' },
  { spec: 'mcp__*__buy*', label: 'make a purchase' },
  { spec: 'mcp__*__delete*', label: 'delete remote data' },
  { spec: 'mcp__*__deploy*', label: 'deploy' },
];

/** Never allowed, from any profile, ever. */
export const HARD_DENY: Array<{ spec: string; label: string }> = [
  { spec: 'Bash(*sudo *)', label: 'privilege escalation' },
  { spec: 'Bash(*rm -rf /*)', label: 'destroy the filesystem' },
  { spec: 'Bash(*diskutil *)', label: 'disk management' },
  { spec: 'Bash(*shutdown*)', label: 'shut down the machine' },
  { spec: 'Bash(*csrutil*)', label: 'disable system integrity protection' },
  { spec: 'Bash(*security *-w*)', label: 'dump Keychain secrets' },
  { spec: 'Bash(*launchctl unload*)', label: 'unload system services' },
];

export interface PolicyContext {
  profile: PermissionProfile;
  /** Absolute path the run is scoped to. Writes outside it are denied. */
  workdir?: string;
  /** Extra directories writes may touch (scratch dir, artifacts dir). */
  extraWritable?: string[];
}

function withinAny(path: string, roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function decide(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  // 1. Hard deny — no profile can override.
  const hard = HARD_DENY.find((h) => anyMatch([h.spec], call));
  if (hard) return { tier: 'deny', rule: hard.spec, reason: `hard-denied: ${hard.label}` };

  // 2. Write scope — an unattended worker must not edit outside its project.
  if (WRITE_TOOLS.has(call.tool) && ctx.workdir) {
    const target = String(call.input?.file_path ?? call.input?.notebook_path ?? '');
    if (target && !withinAny(target, [ctx.workdir, ...(ctx.extraWritable ?? [])])) {
      return { tier: 'deny', rule: 'write-scope', reason: `write outside the run workdir (${target})` };
    }
  }

  // 3. Explicit profile deny.
  const denied = anyMatch(ctx.profile.deny ?? [], call);
  if (denied) return { tier: 'deny', rule: denied, reason: 'denied by permission profile' };

  // 4. Irreversible shapes always need a human, even if the profile allows them.
  const irreversible = IRREVERSIBLE_PATTERNS.find((p) => anyMatch([p.spec], call));
  if (irreversible) {
    return { tier: 'confirm', rule: irreversible.spec, reason: `irreversible action: ${irreversible.label}` };
  }

  // 5. Profile confirm, then allow.
  const confirmed = anyMatch(ctx.profile.confirm ?? [], call);
  if (confirmed) return { tier: 'confirm', rule: confirmed, reason: 'profile requires confirmation' };

  const allowed = anyMatch(ctx.profile.allow ?? [], call);
  if (allowed) return { tier: 'allow', rule: allowed, reason: 'allowed by permission profile' };

  return { tier: ctx.profile.fallback ?? 'confirm', rule: 'fallback', reason: 'no rule matched' };
}

/**
 * Startup integrity check: the policy file must live outside anything a worker
 * can write to, and its hash must match what we recorded. A worker that edits
 * its own policy is the failure mode this guards against.
 */
export interface IntegrityResult {
  ok: boolean;
  hash: string;
  problems: string[];
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function checkPolicyIntegrity(policyFile: string, workerWritableRoots: string[], expectedHash?: string): IntegrityResult {
  const problems: string[] = [];
  if (!existsSync(policyFile)) {
    return { ok: false, hash: '', problems: [`policy file missing: ${policyFile}`] };
  }
  if (withinAny(policyFile, workerWritableRoots)) {
    problems.push(`policy file ${policyFile} is inside a worker-writable root — move it out`);
  }
  const mode = statSync(policyFile).mode & 0o777;
  if (mode & 0o022) problems.push(`policy file is group/world writable (mode ${mode.toString(8)})`);
  const hash = hashFile(policyFile);
  if (expectedHash && expectedHash !== hash) {
    problems.push(`policy file hash changed (expected ${expectedHash.slice(0, 12)}, got ${hash.slice(0, 12)})`);
  }
  return { ok: problems.length === 0, hash, problems };
}
