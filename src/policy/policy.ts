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

/**
 * Tools that cannot change anything, and therefore should never cost a
 * confirmation.
 *
 * The justification for ungating a read is narrow and worth stating: a read
 * cannot leak on its own. Getting data *out* needs an outbound action — send,
 * post, publish, a POST body — and every one of those is caught by
 * IRREVERSIBLE_PATTERNS above any profile. So the gate belongs on what leaves,
 * not on what is looked at, and asking a human whether a schema lookup may
 * proceed buys nothing but a 600-second timer.
 */
const INERT_TOOLS = new Set(['read', 'grep', 'glob', 'notebookread', 'toolsearch', 'listmcpresources', 'readmcpresource']);

/**
 * An MCP tool name is the only evidence we have about what it does, so treating
 * a leading verb as proof is a guess. These two lists make the guess safe: the
 * name must *start* with a read verb and contain no mutating one, so
 * `get_settings` passes and `search_and_replace` does not.
 */
const MCP_READ_VERBS = new Set([
  'get', 'list', 'search', 'read', 'query', 'find', 'fetch',
  'describe', 'inspect', 'recall', 'view', 'count', 'browse', 'lookup', 'status',
]);

const MCP_MUTATING_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'write', 'set', 'add', 'insert', 'put',
  'post', 'send', 'patch', 'edit', 'replace', 'move', 'rename', 'archive',
  'publish', 'deploy', 'buy', 'pay', 'merge', 'push', 'upload', 'revoke',
  'grant', 'install', 'run', 'exec', 'kill', 'stop', 'start', 'reset', 'clear',
  'purge', 'drop', 'import', 'sync', 'apply', 'approve', 'assign', 'cancel',
  'invite', 'share', 'restore', 'seed', 'mark', 'manage', 'upsert', 'record',
]);

/**
 * Split `mcp__deerdawn__get_project_map` into ['get','project','map'].
 *
 * Words, not substrings: `get_settings` contains "set" and would otherwise be
 * read as a mutation of settings.
 */
function mcpNameWords(tool: string): string[] | undefined {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(tool);
  const bare = m?.[1] ?? (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('_') : undefined);
  if (!bare) return undefined;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Is this call a read that no profile author would have wanted to be asked
 * about? Deliberately conservative: anything ambiguous answers false and takes
 * the profile's own fallback.
 */
export function isObviouslyReadOnly(call: ToolCall): boolean {
  if (INERT_TOOLS.has(call.tool.toLowerCase())) return true;
  const words = mcpNameWords(call.tool);
  if (!words?.length) return false;
  if (!MCP_READ_VERBS.has(words[0]!)) return false;
  return !words.some((w) => MCP_MUTATING_WORDS.has(w));
}

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

  // 6. An unlisted read, on a profile that asks about the unexpected.
  //
  // Only when the fallback is `confirm`. That fallback means "check with me
  // about things I did not anticipate", and a schema lookup is not what it was
  // guarding. `fallback: deny` means no, and stays no — a built-in must never
  // widen a profile that closed itself.
  const fallback = ctx.profile.fallback ?? 'confirm';
  if (fallback === 'confirm' && isObviouslyReadOnly(call)) {
    return { tier: 'allow', rule: 'read-only', reason: 'read-only: cannot change anything, and reads cannot leak on their own' };
  }

  return { tier: fallback, rule: 'fallback', reason: 'no rule matched' };
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
