import { resolve, sep } from 'node:path';
import type { CapabilityManifest } from './manifest.js';
import type { PolicyDecision } from '../policy/policy.js';
import type { ToolCall } from '../policy/match.js';

/**
 * Manifest enforcement at execution time.
 *
 * The manifest is only a promise until something checks it. This sits between
 * the profile decision and the tool call: whatever the permission profile would
 * have allowed, a skill-scoped run may still only do what its manifest declared.
 *
 * Enforcement is deny-by-default in both directions. An undeclared host, an
 * undeclared path, an undeclared command prefix — all refused, and refused with
 * a message that names the missing declaration, so the fix is to widen the
 * manifest in a reviewable diff rather than to work around the sandbox.
 */
export interface SandboxContext {
  skill: string;
  manifest: CapabilityManifest;
  /** Absolute path the run is working in; relative manifest paths resolve here. */
  workdir: string;
  /** Always readable regardless of the manifest — the skill's own directory. */
  skillDir?: string;
}

function absolutePaths(paths: string[], workdir: string): string[] {
  return paths.map((p) => (p.startsWith('/') || p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : resolve(workdir, p)));
}

function within(target: string, roots: string[]): boolean {
  const t = resolve(target);
  return roots.some((r) => {
    const root = resolve(r);
    return t === root || t.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/** `api.github.com` matches `api.github.com` and `*.github.com`, not `github.com.evil.tld`. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === h) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".github.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return false;
  });
}

/** The first token of a shell command, ignoring env prefixes like `FOO=1`. */
export function commandHead(command: string): string {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens[i] ?? '';
}

const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export interface SandboxVerdict {
  allowed: boolean;
  reason: string;
  /** What the skill would have to declare for this to be permitted. */
  missingDeclaration?: string;
}

export function checkSandbox(call: ToolCall, ctx: SandboxContext): SandboxVerdict {
  const m = ctx.manifest;
  // Reading is the cheap, safe default: the run's own workdir and the skill's
  // own directory are always readable, and declared paths add to that. Writes
  // and network are where a manifest actually has to grant something.
  const readRoots = [
    ctx.workdir,
    ...(ctx.skillDir ? [ctx.skillDir] : []),
    ...absolutePaths(m.readPaths, ctx.workdir),
    ...absolutePaths(m.writePaths, ctx.workdir),
  ];
  const writeRoots = absolutePaths(m.writePaths, ctx.workdir);

  // --- MCP -----------------------------------------------------------
  if (call.tool.startsWith('mcp__')) {
    const server = call.tool.split('__')[1] ?? '';
    if (!m.mcp.includes(server)) {
      return { allowed: false, reason: `skill "${ctx.skill}" did not declare MCP server "${server}"`, missingDeclaration: `mcp: [${server}]` };
    }
    return { allowed: true, reason: `mcp "${server}" is declared` };
  }

  // --- network -------------------------------------------------------
  if (NETWORK_TOOLS.has(call.tool)) {
    if (!m.network.length) {
      return { allowed: false, reason: `skill "${ctx.skill}" declared no network access`, missingDeclaration: 'network: [host]' };
    }
    if (call.tool === 'WebSearch') return { allowed: true, reason: 'search is covered by a non-empty network declaration' };
    const url = String(call.input.url ?? '');
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return { allowed: false, reason: `"${url}" is not a URL` };
    }
    if (!hostAllowed(host, m.network)) {
      return { allowed: false, reason: `skill "${ctx.skill}" did not declare host "${host}"`, missingDeclaration: `network: [${host}]` };
    }
    return { allowed: true, reason: `host "${host}" is declared` };
  }

  // --- writes --------------------------------------------------------
  if (WRITE_TOOLS.has(call.tool)) {
    const target = String(call.input.file_path ?? call.input.notebook_path ?? '');
    if (!writeRoots.length) {
      return { allowed: false, reason: `skill "${ctx.skill}" declared no write paths`, missingDeclaration: 'write-paths: [path]' };
    }
    if (!target || !within(target, writeRoots)) {
      return { allowed: false, reason: `"${target}" is outside the skill's declared write paths`, missingDeclaration: `write-paths: [${target}]` };
    }
    return { allowed: true, reason: 'write path is declared' };
  }

  // --- reads ---------------------------------------------------------
  if (READ_TOOLS.has(call.tool)) {
    const target = String(call.input.file_path ?? call.input.path ?? '');
    if (!target) return { allowed: true, reason: 'read with no explicit path' };
    if (!within(target, readRoots)) {
      return { allowed: false, reason: `"${target}" is outside the skill's declared read paths`, missingDeclaration: `read-paths: [${target}]` };
    }
    return { allowed: true, reason: 'read path is declared' };
  }

  // --- shell ---------------------------------------------------------
  if (call.tool === 'Bash') {
    const command = String(call.input.command ?? '');
    if (!m.commands.length) {
      return { allowed: false, reason: `skill "${ctx.skill}" declared no commands`, missingDeclaration: 'commands: [name]' };
    }
    // Chained commands are checked as a whole: a declaration for `git` must not
    // become a licence to run `git status && curl evil.example`.
    const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
    for (const segment of segments) {
      const head = commandHead(segment);
      if (!m.commands.some((c) => head === c || segment.startsWith(c))) {
        return { allowed: false, reason: `skill "${ctx.skill}" did not declare command "${head}"`, missingDeclaration: `commands: [${head}]` };
      }
    }
    return { allowed: true, reason: 'every command segment is declared' };
  }

  // Anything else (TodoWrite, Task, …) is inert as far as capabilities go.
  return { allowed: true, reason: 'no capability required' };
}

/**
 * Fold the sandbox verdict into the policy decision. The manifest can only ever
 * make a decision stricter — it never upgrades a `confirm` to an `allow`.
 */
export function applySandbox(decision: PolicyDecision, call: ToolCall, ctx: SandboxContext | undefined): PolicyDecision {
  if (!ctx) return decision;
  if (decision.tier === 'deny') return decision;

  const verdict = checkSandbox(call, ctx);
  if (!verdict.allowed) {
    return {
      tier: 'deny',
      rule: `sandbox:${ctx.skill}`,
      reason: `${verdict.reason}${verdict.missingDeclaration ? ` — declare \`${verdict.missingDeclaration}\` in its SKILL.md if it genuinely needs this` : ''}`,
    };
  }

  if (decision.tier === 'confirm' && !ctx.manifest.tier2) {
    return {
      tier: 'deny',
      rule: `sandbox:${ctx.skill}`,
      reason: `skill "${ctx.skill}" is not permitted tier-2 actions (${decision.reason})`,
    };
  }

  return decision;
}
