import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_CONFIG, type SwitchboardConfig, type ProjectConfig, type PermissionProfile } from './schema.js';

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid Switchboard config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function expandPath(p: string): string {
  const expanded = p.startsWith('~') ? p.replace('~', homedir()) : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export function configPath(): string {
  return process.env.SWB_CONFIG ? expandPath(process.env.SWB_CONFIG) : expandPath('~/.switchboard/config.json');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shallow-merge one level deep so partial config files still get every default. */
function mergeDefaults(raw: Record<string, unknown>): SwitchboardConfig {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(raw)) {
    const base = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
    out[k] = isObject(base) && isObject(v) ? { ...base, ...v } : v;
  }
  return out as unknown as SwitchboardConfig;
}

export function validate(cfg: SwitchboardConfig): string[] {
  const problems: string[] = [];
  const seenProjects = new Set<string>();

  for (const p of cfg.projects ?? []) {
    if (!p.name) problems.push('a project is missing `name`');
    if (!p.path) problems.push(`project "${p.name}" is missing \`path\``);
    for (const key of [p.name, ...(p.aliases ?? [])]) {
      if (seenProjects.has(key)) problems.push(`duplicate project name/alias "${key}"`);
      seenProjects.add(key);
    }
    if (p.permissionProfile && !cfg.permissionProfiles.some((x) => x.name === p.permissionProfile)) {
      problems.push(`project "${p.name}" references unknown permission profile "${p.permissionProfile}"`);
    }
    if (p.mcpSet && !cfg.mcpSets.some((x) => x.name === p.mcpSet)) {
      problems.push(`project "${p.name}" references unknown MCP set "${p.mcpSet}"`);
    }
  }

  const agentNames = new Set<string>();
  for (const a of cfg.agents ?? []) {
    if (!a.name) problems.push('an agent is missing `name`');
    if (agentNames.has(a.name)) problems.push(`duplicate agent "${a.name}"`);
    agentNames.add(a.name);
    if (a.permissionProfile && !cfg.permissionProfiles.some((x) => x.name === a.permissionProfile)) {
      problems.push(`agent "${a.name}" references unknown permission profile "${a.permissionProfile}"`);
    }
    if (a.defaultProject && !seenProjects.has(a.defaultProject)) {
      problems.push(`agent "${a.name}" references unknown project "${a.defaultProject}"`);
    }
  }

  if (!cfg.permissionProfiles.some((x) => x.name === cfg.defaultPermissionProfile)) {
    problems.push(`defaultPermissionProfile "${cfg.defaultPermissionProfile}" is not defined`);
  }
  if (cfg.caps.maxTurns <= 0) problems.push('caps.maxTurns must be > 0');
  if (cfg.caps.maxCostUsd <= 0) problems.push('caps.maxCostUsd must be > 0');
  if (cfg.maxConcurrentRuns <= 0) problems.push('maxConcurrentRuns must be > 0');
  if (cfg.gateway.port < 1 || cfg.gateway.port > 65535) problems.push('gateway.port out of range');
  if (cfg.imessage.enabled && cfg.imessage.mode === 'bluebubbles' && !cfg.imessage.serverUrl) {
    problems.push('imessage.mode is "bluebubbles" but imessage.serverUrl is unset');
  }
  if (cfg.imessage.enabled && cfg.imessage.allowlist.length === 0) {
    problems.push('imessage.enabled with an empty allowlist — that would accept texts from anyone');
  }
  if (cfg.telegram.enabled && !cfg.telegram.botTokenRef) problems.push('telegram.enabled but telegram.botTokenRef is unset');

  return problems;
}

export interface LoadedConfig extends SwitchboardConfig {
  /** Absolute, ~-expanded copies of the path fields. */
  readonly resolved: {
    dataDir: string;
    scratchDir: string;
    skillsDir: string;
    dbPath: string;
    artifactsDir: string;
    logsDir: string;
    configFile: string;
  };
}

export function resolvePaths(cfg: SwitchboardConfig, file: string): LoadedConfig {
  const dataDir = expandPath(cfg.dataDir);
  return {
    ...cfg,
    projects: cfg.projects.map((p) => ({ ...p, path: expandPath(p.path) })),
    resolved: {
      dataDir,
      scratchDir: expandPath(cfg.scratchDir),
      skillsDir: expandPath(cfg.skillsDir),
      dbPath: resolve(dataDir, 'switchboard.db'),
      artifactsDir: resolve(dataDir, 'runs'),
      logsDir: resolve(dataDir, 'logs'),
      configFile: file,
    },
  };
}

export function loadConfig(file = configPath()): LoadedConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError([`${file} is not valid JSON: ${(err as Error).message}`]);
    }
  }
  const merged = mergeDefaults(raw);
  const problems = validate(merged);
  if (problems.length) throw new ConfigError(problems);
  const cfg = resolvePaths(merged, file);
  for (const dir of [cfg.resolved.dataDir, cfg.resolved.artifactsDir, cfg.resolved.logsDir, cfg.resolved.scratchDir, cfg.resolved.skillsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

export function writeExampleConfig(file = configPath()): string {
  mkdirSync(dirname(file), { recursive: true });
  const example = {
    ...DEFAULT_CONFIG,
    projects: [
      { name: 'swb', path: '~/Desktop/Switchboard', aliases: ['switchboard'], permissionProfile: 'coding' },
    ] satisfies ProjectConfig[],
    agents: [
      {
        name: 'dev',
        description: 'Writes code in real repos.',
        persona: 'You are terse. Report files changed. Never push.',
        taskClass: 'coding',
        defaultFor: ['dashboard', 'imessage'],
      },
    ],
  };
  writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`);
  return file;
}

export function findProject(cfg: SwitchboardConfig, key: string): ProjectConfig | undefined {
  const k = key.toLowerCase();
  return cfg.projects.find((p) => p.name.toLowerCase() === k || (p.aliases ?? []).some((a) => a.toLowerCase() === k));
}

export function profileFor(cfg: SwitchboardConfig, name?: string): PermissionProfile {
  const found = cfg.permissionProfiles.find((p) => p.name === (name ?? cfg.defaultPermissionProfile));
  if (found) return found;
  const fallback = cfg.permissionProfiles.find((p) => p.name === cfg.defaultPermissionProfile);
  if (!fallback) throw new Error(`no permission profile "${name}" and no default`);
  return fallback;
}
