import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath } from '../config/load.js';
import type { McpSet, SwitchboardConfig } from '../config/schema.js';
import { resolveSecretRefs } from '../secrets/keychain.js';

/**
 * The router and the workers do not get the same MCPs.
 *
 * The router runs constantly on every inbound message and only needs to read
 * memory and classify — give it a small, cheap, read-mostly set. Unattended
 * workers get the heavy set (DeerDawn writes, browser control, whatever the
 * project needs) because they are the ones actually doing the work.
 */
export function resolveMcpSet(cfg: SwitchboardConfig, name: string): Record<string, unknown> {
  const set: McpSet | undefined = cfg.mcpSets.find((s) => s.name === name);
  if (!set) return {};
  if (set.servers) return set.servers;
  if (set.file) {
    const path = expandPath(set.file);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ?? (parsed as Record<string, unknown>);
  }
  return {};
}

/**
 * Materialise an .mcp.json for one run. Secret refs are resolved here, at the
 * last possible moment, so tokens exist on disk only inside the run directory.
 */
export function writeMcpConfig(dir: string, servers: Record<string, unknown>): string | null {
  if (!Object.keys(servers).length) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mcp.json');
  const resolved = resolveSecretRefs({ mcpServers: servers });
  writeFileSync(path, `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function setNameFor(cfg: SwitchboardConfig, opts: { role: 'router' | 'worker'; projectMcpSet?: string; agentMcpSet?: string }): string {
  if (opts.role === 'router') return cfg.routerMcpSet;
  return opts.agentMcpSet ?? opts.projectMcpSet ?? cfg.workerMcpSet;
}

/** Names of MCP servers in a set — used by the doctor to probe reachability. */
export function serverNames(servers: Record<string, unknown>): string[] {
  return Object.keys(servers);
}
