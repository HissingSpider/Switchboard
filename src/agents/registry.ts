import { readdirSync, readFileSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AgentConfig, SwitchboardConfig, TaskClass } from '../config/schema.js';
import { parseFrontmatter } from '../skills/loader.js';
import { logger } from '../core/logger.js';

const log = logger('agents');

/**
 * Agents are defined either inline in config.json or as one markdown file per
 * agent in <dataDir>/agents. The markdown form is the nicer one to edit: the
 * frontmatter is the config and the body is the persona.
 *
 *   ---
 *   name: dev
 *   description: writes code in real repos
 *   model: claude-opus-5
 *   taskClass: coding
 *   permissionProfile: coding
 *   memoryProject: project_abc
 *   defaultFor: [imessage, dashboard]
 *   ---
 *   You are terse. Never push. Report files changed.
 */
export function parseAgentFile(path: string): { agent: AgentConfig; problems: string[] } {
  const problems: string[] = [];
  const raw = readFileSync(path, 'utf8');

  if (extname(path) === '.json') {
    const agent = JSON.parse(raw) as AgentConfig;
    if (!agent.name) problems.push(`${path}: missing name`);
    return { agent, problems };
  }

  const { data, body } = parseFrontmatter(raw);
  const name = data.name ?? basename(path, extname(path));
  if (!data.name) problems.push(`${path}: no name in frontmatter, using filename "${name}"`);
  const list = (v?: string): string[] | undefined => {
    if (!v) return undefined;
    const items = v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    return items.length ? items : undefined;
  };

  const agent: AgentConfig = {
    name,
    description: data.description,
    persona: body.trim() || undefined,
    model: data.model,
    taskClass: (data.taskClass as TaskClass) ?? undefined,
    mcpSet: data.mcpSet,
    permissionProfile: data.permissionProfile,
    tools: list(data.tools),
    memoryProject: data.memoryProject,
    defaultProject: data.defaultProject,
    defaultFor: list(data.defaultFor),
  };
  if (!agent.persona) problems.push(`${path}: empty persona body`);
  return { agent, problems };
}

export interface AgentValidation {
  ok: boolean;
  problems: string[];
}

export function validateAgents(agents: AgentConfig[], cfg: SwitchboardConfig): AgentValidation {
  const problems: string[] = [];
  const seen = new Set<string>();
  const defaults = new Map<string, string>();
  for (const a of agents) {
    if (!a.name) problems.push('an agent has no name');
    if (seen.has(a.name)) problems.push(`duplicate agent "${a.name}"`);
    seen.add(a.name);
    if (a.permissionProfile && !cfg.permissionProfiles.some((p) => p.name === a.permissionProfile)) {
      problems.push(`agent "${a.name}": unknown permission profile "${a.permissionProfile}"`);
    }
    if (a.mcpSet && !cfg.mcpSets.some((m) => m.name === a.mcpSet)) {
      problems.push(`agent "${a.name}": unknown MCP set "${a.mcpSet}"`);
    }
    if (a.defaultProject && !cfg.projects.some((p) => p.name === a.defaultProject || (p.aliases ?? []).includes(a.defaultProject!))) {
      problems.push(`agent "${a.name}": unknown default project "${a.defaultProject}"`);
    }
    for (const ch of a.defaultFor ?? []) {
      const existing = defaults.get(ch);
      if (existing) problems.push(`agents "${existing}" and "${a.name}" both claim to be default for ${ch}`);
      else defaults.set(ch, a.name);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Which agent owns a thread. Explicit `!name` wins for one message; an explicit
 * `use <name>` switch sticks to the thread; otherwise the channel default.
 */
export class AgentRegistry extends EventEmitter {
  private agents = new Map<string, AgentConfig>();
  private threadOwner = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  lastProblems: string[] = [];

  constructor(
    private readonly cfg: SwitchboardConfig,
    private readonly dir: string,
  ) {
    super();
    this.reload();
  }

  reload(): { count: number; problems: string[] } {
    const merged = new Map<string, AgentConfig>();
    for (const a of this.cfg.agents) merged.set(a.name, a);

    const problems: string[] = [];
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) {
        if (!['.md', '.json'].includes(extname(f))) continue;
        try {
          const { agent, problems: p } = parseAgentFile(join(this.dir, f));
          problems.push(...p);
          // File definitions win over inline config — they're the editable surface.
          merged.set(agent.name, { ...merged.get(agent.name), ...agent });
        } catch (err) {
          problems.push(`${f}: ${(err as Error).message}`);
        }
      }
    }

    const list = [...merged.values()];
    const validation = validateAgents(list, this.cfg);
    problems.push(...validation.problems);

    // Never swap in a broken set — keep serving the last good one.
    if (validation.ok || this.agents.size === 0) {
      this.agents = merged;
      this.emit('reloaded', list);
    } else {
      log.warn('agent config rejected, keeping previous set', { problems });
    }
    this.lastProblems = problems;
    return { count: this.agents.size, problems };
  }

  /** Debounced hot reload — editors write files in several bursts. */
  watchForChanges(): void {
    if (!existsSync(this.dir) || this.watcher) return;
    this.watcher = watch(this.dir, () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        const { count, problems } = this.reload();
        log.info('agents reloaded', { count, problems: problems.length });
      }, 300);
    });
    this.watcher.unref?.();
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  all(): AgentConfig[] {
    return [...this.agents.values()];
  }

  get(name?: string): AgentConfig | undefined {
    if (!name) return undefined;
    const direct = this.agents.get(name);
    if (direct) return direct;
    const lower = name.toLowerCase();
    return this.all().find((a) => a.name.toLowerCase() === lower);
  }

  defaultFor(channel: string): AgentConfig | undefined {
    return this.all().find((a) => (a.defaultFor ?? []).includes(channel)) ?? this.all()[0];
  }

  /** Sticky per-thread assignment set by `use <agent>`. */
  setThreadAgent(threadId: string, agentName: string): boolean {
    const agent = this.get(agentName);
    if (!agent) return false;
    this.threadOwner.set(threadId, agent.name);
    return true;
  }

  threadAgent(threadId: string, channel: string): AgentConfig | undefined {
    const owner = this.threadOwner.get(threadId);
    return (owner ? this.get(owner) : undefined) ?? this.defaultFor(channel);
  }

  clearThread(threadId: string): void {
    this.threadOwner.delete(threadId);
  }

  /** DeerDawn project backing an agent's memory, if any. */
  memoryProject(name: string): string | undefined {
    return this.get(name)?.memoryProject;
  }
}

/**
 * Surface-aware voice: the same persona, tightened for the channel it is
 * speaking on. Appended after the agent's own persona so the persona still
 * sets the character and this only sets the register.
 */
export function surfaceVoice(channel: string): string {
  switch (channel) {
    case 'imessage':
    case 'telegram':
      return 'You are replying over text message. Two or three sentences, no markdown, no headers, no bullet lists. Lead with the answer.';
    case 'dashboard':
      return 'You are replying in a web dashboard. Markdown is fine. Show the detail that supports your conclusion.';
    case 'schedule':
    case 'trigger':
      return 'You were started by a schedule, not a person. Say nothing unless there is something worth waking someone for.';
    default:
      return '';
  }
}
