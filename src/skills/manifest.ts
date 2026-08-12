/**
 * Capability manifests.
 *
 * A skill declares, up front and in its own frontmatter, everything it needs to
 * touch: which hosts, which paths, which MCP servers, whether it may take a
 * tier-2 (confirm-gated) action at all. The runner then enforces exactly that
 * and denies anything undeclared.
 *
 * This matters most for skills the machine wrote itself. A self-authored skill
 * has no author to hold responsible, so the manifest is the contract: it can
 * only ever do what it said it would, and widening the manifest is a visible,
 * reviewable diff rather than a quiet change in behaviour.
 */
import { parseFrontmatter } from './loader.js';

export type TrustTier = 'sandboxed' | 'restricted' | 'trusted';

export const TRUST_ORDER: TrustTier[] = ['sandboxed', 'restricted', 'trusted'];

export interface CapabilityManifest {
  /** Hostnames the skill may reach. `[]` means no network at all. */
  network: string[];
  /** Path prefixes the skill may read. Relative paths resolve against the run's workdir. */
  readPaths: string[];
  /** Path prefixes the skill may write. */
  writePaths: string[];
  /** MCP servers, by name, the skill may call. */
  mcp: string[];
  /** Shell command prefixes the skill may run. `[]` means no Bash. */
  commands: string[];
  /** Whether the skill may attempt an action that needs confirm-by-reply. */
  tier2: boolean;
  /** Free-text note about why these capabilities are needed. */
  rationale?: string;
}

export const EMPTY_MANIFEST: CapabilityManifest = {
  network: [],
  readPaths: [],
  writePaths: [],
  mcp: [],
  commands: [],
  tier2: false,
};

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Read the manifest out of a SKILL.md's frontmatter. A skill with no manifest
 * gets the empty one — read-only, no network, no shell. Silence is never
 * interpreted as permission.
 */
export function parseManifest(source: string): CapabilityManifest {
  const { data } = parseFrontmatter(source);
  return {
    network: list(data.network),
    readPaths: list(data['read-paths'] ?? data.readPaths),
    writePaths: list(data['write-paths'] ?? data.writePaths),
    mcp: list(data.mcp),
    commands: list(data.commands),
    tier2: /^(true|yes)$/i.test(data.tier2 ?? data['tier-2'] ?? ''),
    rationale: data.rationale,
  };
}

export function manifestToFrontmatter(m: CapabilityManifest): string {
  const lines: string[] = [];
  if (m.network.length) lines.push(`network: [${m.network.join(', ')}]`);
  if (m.readPaths.length) lines.push(`read-paths: [${m.readPaths.join(', ')}]`);
  if (m.writePaths.length) lines.push(`write-paths: [${m.writePaths.join(', ')}]`);
  if (m.mcp.length) lines.push(`mcp: [${m.mcp.join(', ')}]`);
  if (m.commands.length) lines.push(`commands: [${m.commands.join(', ')}]`);
  if (m.tier2) lines.push('tier2: true');
  if (m.rationale) lines.push(`rationale: ${m.rationale}`);
  return lines.join('\n');
}

export interface ManifestProblem {
  field: keyof CapabilityManifest | 'trust';
  message: string;
}

/**
 * What a manifest is allowed to *ask for* at each trust tier. A sandboxed skill
 * cannot declare its way into tier-2 actions, no matter what it writes.
 */
export function ceilingFor(trust: TrustTier): { network: boolean; write: boolean; commands: boolean; mcp: boolean; tier2: boolean } {
  switch (trust) {
    case 'sandboxed':
      return { network: false, write: false, commands: false, mcp: false, tier2: false };
    case 'restricted':
      return { network: true, write: true, commands: true, mcp: true, tier2: false };
    case 'trusted':
      return { network: true, write: true, commands: true, mcp: true, tier2: true };
  }
}

export function validateManifest(m: CapabilityManifest, trust: TrustTier): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const ceiling = ceilingFor(trust);

  if (m.network.length && !ceiling.network) problems.push({ field: 'network', message: `a ${trust} skill may not use the network` });
  if (m.writePaths.length && !ceiling.write) problems.push({ field: 'writePaths', message: `a ${trust} skill may not write files` });
  if (m.commands.length && !ceiling.commands) problems.push({ field: 'commands', message: `a ${trust} skill may not run commands` });
  if (m.mcp.length && !ceiling.mcp) problems.push({ field: 'mcp', message: `a ${trust} skill may not call MCP servers` });
  if (m.tier2 && !ceiling.tier2) problems.push({ field: 'tier2', message: `only a trusted skill may request tier-2 actions` });

  for (const host of m.network) {
    if (host === '*') problems.push({ field: 'network', message: 'network: * is never accepted — name the hosts' });
    else if (!/^[a-z0-9.*-]+$/i.test(host)) problems.push({ field: 'network', message: `"${host}" is not a hostname` });
  }
  for (const path of [...m.readPaths, ...m.writePaths]) {
    if (path === '/' || path === '~' || path === '*') {
      problems.push({ field: 'writePaths', message: `"${path}" is the whole machine — narrow it` });
    }
  }
  for (const cmd of m.commands) {
    if (/^(sudo|rm|dd|mkfs|shutdown)\b/.test(cmd)) problems.push({ field: 'commands', message: `"${cmd}" is never grantable` });
  }
  return problems;
}

/** Sum of two manifests — used when a skill calls another skill. */
export function intersect(a: CapabilityManifest, b: CapabilityManifest): CapabilityManifest {
  const both = <T>(x: T[], y: T[]): T[] => x.filter((v) => y.includes(v));
  return {
    network: both(a.network, b.network),
    readPaths: both(a.readPaths, b.readPaths),
    writePaths: both(a.writePaths, b.writePaths),
    mcp: both(a.mcp, b.mcp),
    commands: both(a.commands, b.commands),
    tier2: a.tier2 && b.tier2,
  };
}

export function describeManifest(m: CapabilityManifest): string {
  const parts: string[] = [];
  parts.push(m.network.length ? `network: ${m.network.join(', ')}` : 'no network');
  parts.push(m.writePaths.length ? `writes: ${m.writePaths.join(', ')}` : 'no writes');
  parts.push(m.commands.length ? `commands: ${m.commands.join(', ')}` : 'no shell');
  if (m.mcp.length) parts.push(`mcp: ${m.mcp.join(', ')}`);
  if (m.tier2) parts.push('may request tier-2');
  return parts.join(' · ');
}

/** Is `next` asking for anything `previous` did not have? */
export function widens(previous: CapabilityManifest, next: CapabilityManifest): string[] {
  const added: string[] = [];
  const diff = (label: string, before: string[], after: string[]): void => {
    const extra = after.filter((v) => !before.includes(v));
    if (extra.length) added.push(`${label}: +${extra.join(', ')}`);
  };
  diff('network', previous.network, next.network);
  diff('read', previous.readPaths, next.readPaths);
  diff('write', previous.writePaths, next.writePaths);
  diff('mcp', previous.mcp, next.mcp);
  diff('commands', previous.commands, next.commands);
  if (next.tier2 && !previous.tier2) added.push('tier2: newly requested');
  return added;
}
