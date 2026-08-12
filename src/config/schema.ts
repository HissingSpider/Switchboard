/**
 * Switchboard configuration.
 *
 * Everything the daemon needs to know that isn't runtime state lives here.
 * Secrets do NOT live here — see src/secrets/keychain.ts. Config may reference
 * a secret by name (`keychain:switchboard/bluebubbles`) and the loader resolves it.
 */

export type TaskClass = 'coding' | 'assistant' | 'computer-use';

/** Three-tier action gating, enforced at the runner via a PreToolUse hook. */
export type ActionTier = 'allow' | 'confirm' | 'deny';

export interface ProjectConfig {
  /** Shortcut name the human types: "swb", "dd", "site". */
  name: string;
  /** Absolute path to the working directory. */
  path: string;
  /** Optional aliases the intent router will also match. */
  aliases?: string[];
  /** Permission profile name from `permissionProfiles`; falls back to `defaultPermissionProfile`. */
  permissionProfile?: string;
  /** MCP set name from `mcpSets`; falls back to the worker set. */
  mcpSet?: string;
  /** DeerDawn project id this repo maps to, if any. */
  deerdawnProjectId?: string;
  /** Skip git branch-per-run for scratch dirs. */
  git?: boolean;
}

export interface PermissionProfile {
  name: string;
  /** Tool names (or `Tool(pattern)` specs) that run without asking. */
  allow: string[];
  /** Tool specs that require confirm-by-reply before running. */
  confirm: string[];
  /** Tool specs that are refused outright, no confirmation possible. */
  deny: string[];
  /** Default tier for anything not matched above. */
  fallback: ActionTier;
  /** Passed to `claude --permission-mode`. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

export interface McpSet {
  name: string;
  /** Path to an .mcp.json-shaped file, or inline server definitions. */
  file?: string;
  servers?: Record<string, unknown>;
}

export interface AgentConfig {
  name: string;
  description?: string;
  /** Appended to the system prompt via --append-system-prompt. */
  persona?: string;
  /** Path to a markdown file whose contents become the persona. */
  personaFile?: string;
  model?: string;
  taskClass?: TaskClass;
  mcpSet?: string;
  permissionProfile?: string;
  /** Tools this agent may use at all (passed as --allowedTools). */
  tools?: string[];
  /** DeerDawn project id backing this agent's memory. */
  memoryProject?: string;
  /** Default project shortcut when the agent is addressed without one. */
  defaultProject?: string;
  /** Channels where this agent is the default responder. */
  defaultFor?: string[];
}

export interface CapsConfig {
  /** Hard stop on assistant turns per run (claude --max-turns). */
  maxTurns: number;
  /** Hard stop on USD spend per run; runner kills the process when exceeded. */
  maxCostUsd: number;
  /** Wall-clock ceiling per run in ms. */
  maxWallMs: number;
  /** Rolling monthly budget in USD; new runs are refused past this. */
  monthlyBudgetUsd: number;
  /** No output for this long => the run is considered stuck. */
  idleTimeoutMs: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  /** Bearer token for the dashboard and any non-loopback access. */
  authTokenRef?: string;
  /** Extra hostnames allowed through the Host/Origin check (e.g. the Tailscale name). */
  trustedHosts?: string[];
}

export interface ImessageConfig {
  enabled: boolean;
  /** BlueBubbles server base URL, e.g. http://127.0.0.1:1234 */
  serverUrl?: string;
  passwordRef?: string;
  /** Handles allowed to drive the bridge. Everything else is dropped silently. */
  allowlist: string[];
  /** Path the BlueBubbles webhook posts to. */
  webhookPath?: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botTokenRef?: string;
  allowlist: string[];
}

export interface NotificationRule {
  /** Event kinds that trigger a push. */
  on: string[];
  /** Only for runs matching this task class. */
  taskClass?: TaskClass;
  /** 'push' texts the human; 'dashboard' only writes to the event log. */
  action: 'push' | 'dashboard';
  /** Minimum seconds between pushes of this rule. */
  throttleSec?: number;
}

export interface HeartbeatJob {
  name: string;
  /** 5-field cron expression. */
  cron: string;
  project?: string;
  agent?: string;
  prompt: string;
  enabled?: boolean;
}

export interface TriggerConfig {
  name: string;
  kind: 'file' | 'webhook' | 'poll';
  /** file: glob-ish path to watch. webhook: path suffix. poll: URL. */
  target: string;
  intervalMs?: number;
  project?: string;
  agent?: string;
  prompt: string;
  enabled?: boolean;
}

export interface SwitchboardConfig {
  /** Root for the sqlite db, artifacts and logs. */
  dataDir: string;
  /** Where scratch (non-repo) work happens. */
  scratchDir: string;
  /** Directory scanned for SKILL.md files. */
  skillsDir: string;
  /** Path to the claude CLI. */
  claudeBin: string;
  /** Max runs executing at once across all projects. */
  maxConcurrentRuns: number;
  gateway: GatewayConfig;
  caps: CapsConfig;
  projects: ProjectConfig[];
  agents: AgentConfig[];
  permissionProfiles: PermissionProfile[];
  defaultPermissionProfile: string;
  mcpSets: McpSet[];
  /** MCP set used by the router (cheap, read-mostly). */
  routerMcpSet: string;
  /** MCP set used by unattended workers. */
  workerMcpSet: string;
  imessage: ImessageConfig;
  telegram: TelegramConfig;
  notifications: NotificationRule[];
  heartbeats: HeartbeatJob[];
  triggers: TriggerConfig[];
  /** Days to keep run artifacts before pruning. 0 = keep forever. */
  artifactRetentionDays: number;
  /** Seconds to wait on a confirm-by-reply before aborting the action. */
  confirmTimeoutSec: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_PERMISSION_PROFILES: PermissionProfile[] = [
  {
    name: 'coding',
    allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Task', 'WebFetch', 'WebSearch', 'Bash(git *)', 'Bash(npm *)', 'Bash(pnpm *)', 'Bash(node *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(rg *)'],
    confirm: ['Bash(git push*)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(rm *)'],
    deny: ['Bash(sudo *)', 'Bash(shutdown *)', 'Bash(*rm -rf /*)', 'Bash(diskutil *)'],
    fallback: 'confirm',
    permissionMode: 'bypassPermissions',
  },
  {
    name: 'assistant',
    allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite'],
    confirm: ['Write', 'Edit', 'Bash'],
    deny: ['Bash(sudo *)'],
    fallback: 'confirm',
    permissionMode: 'default',
  },
  {
    name: 'readonly',
    allow: ['Read', 'Grep', 'Glob'],
    confirm: [],
    deny: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
    fallback: 'deny',
    permissionMode: 'plan',
  },
];

export const DEFAULT_CONFIG: SwitchboardConfig = {
  dataDir: '~/.switchboard',
  scratchDir: '~/.switchboard/scratch',
  skillsDir: '~/.switchboard/skills',
  claudeBin: 'claude',
  maxConcurrentRuns: 3,
  gateway: { host: '127.0.0.1', port: 7788, trustedHosts: [] },
  caps: {
    maxTurns: 40,
    maxCostUsd: 5,
    maxWallMs: 30 * 60_000,
    monthlyBudgetUsd: 200,
    idleTimeoutMs: 5 * 60_000,
  },
  projects: [],
  agents: [],
  permissionProfiles: DEFAULT_PERMISSION_PROFILES,
  defaultPermissionProfile: 'coding',
  mcpSets: [],
  routerMcpSet: 'router',
  workerMcpSet: 'worker',
  imessage: { enabled: false, allowlist: [], webhookPath: '/hooks/bluebubbles' },
  telegram: { enabled: false, allowlist: [] },
  notifications: [
    { on: ['run.finished', 'run.failed'], action: 'push' },
    { on: ['action.confirm_requested'], action: 'push' },
    { on: ['run.progress'], action: 'dashboard' },
  ],
  heartbeats: [],
  triggers: [],
  artifactRetentionDays: 30,
  confirmTimeoutSec: 600,
  logLevel: 'info',
};
