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
  /**
   * What the project is *called*. The shortcut is for typing and texting; it is
   * never what anything reads back to you. Unset, the dashboard falls back to
   * the directory name un-camel-cased, which is right often enough that this
   * only has to be set where it isn't.
   */
  label?: string;
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

/**
 * What a project is called, for anything a person reads. The shortcut is what
 * you type; it is never what gets read back to you. Unset, the directory name
 * un-camel-cased is right often enough that `label` only has to be set where
 * it isn't.
 */
export function projectLabel(project: Pick<ProjectConfig, 'name' | 'label' | 'path'>): string {
  if (project.label) return project.label;
  const base = project.path.replace(/\/+$/, '').split('/').pop();
  if (!base) return project.name;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
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
  /**
   * Stop the whole run on the first denial instead of letting it carry on
   * without the tool. Read-only investigation wants this: a diagnosis that
   * silently skipped the step it needed is worse than one that stops and says
   * what it wanted to do.
   */
  haltOnDeny?: boolean;
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
  /**
   * VAPID contact, sent to Apple and Google on every push. Must be a real
   * `mailto:` address or an `https:` URL — Apple returns BadJwtToken for
   * anything it considers implausible, including `mailto:you@localhost`.
   */
  pushSubject?: string;
}

export interface ImessageConfig {
  enabled: boolean;
  /**
   * 'native' drives Messages.app directly — no third-party app, one permission.
   * 'bluebubbles' uses a BlueBubbles server, which adds typing indicators and
   * reactions at the cost of another service to run.
   */
  mode?: 'native' | 'bluebubbles';
  /** Poll interval for the native reader. */
  pollMs?: number;
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

export interface VoiceSettings {
  enabled: boolean;
  /** 'whisper' | 'macos'. Auto-detected when unset. */
  sttEngine?: string;
  whisperBinary?: string;
  whisperModel?: string;
  /** 'piper' | 'kokoro' | 'say'. Falls back to macOS `say`, which is always there. */
  ttsEngine?: string;
  ttsVoice?: string;
  piperModel?: string;
  /** Continuous listening instead of push-to-talk. */
  openMic?: boolean;
  /** Model for the resident conversational session. Small and fast beats smart here. */
  model?: string;
  /** openWakeWord model name for hands-free. Off when unset. */
  wakeWord?: string;
}

export interface DeerDawnConfig {
  enabled: boolean;
  /** Project whose backlog Switchboard is allowed to pull work from. */
  queueProjectId?: string;
  /** MCP server name for DeerDawn inside the worker set. */
  mcpServer?: string;
  /** How often to look for new cards. Each poll costs a small model call. */
  pollIntervalMs?: number;
  /** Never run more than this many queued cards at once. */
  maxConcurrentCards?: number;
  /** Where a queued card's confirmations and results should land. */
  notifyChannel?: string;
  notifyThreadId?: string;
  /** Only pull cards whose title starts with one of these markers. Empty = all. */
  labelFilter?: string[];
}

export interface VaultConfig {
  enabled: boolean;
  /** Absolute path to the Obsidian vault. */
  path?: string;
  /** The only subfolder agents may write to. */
  writeSubfolder?: string;
  /** Commit vault changes after each write. */
  git?: boolean;
}

export interface HealthCheckStep {
  name: string;
  /** Shell command, or an MCP-flavoured instruction the investigator follows. */
  run?: string;
  ask?: string;
  /** Substring that must appear in the output for the step to pass. */
  expect?: string;
}

export interface ProjectHealth {
  project: string;
  /** Where it runs — a URL, a Vercel project, a launchd label. */
  deployTarget?: string;
  /** Where errors show up — a PostHog project, a log path, a Sentry DSN name. */
  errorSource?: string;
  /** The three numbers that say whether it is healthy. */
  keyMetrics?: string[];
  repoPath?: string;
  /** Ordered checks, cheapest first. */
  checks?: HealthCheckStep[];
}

/**
 * Which model each lane runs on.
 *
 * The router already sorts every message into chat, query or task before a
 * process is spawned, and those three lanes differ by roughly 5x in what an
 * answer is worth. Sending "ok" and "refactor the scheduler" to the same model
 * is the single largest avoidable cost in the system.
 *
 * Values are passed straight to `claude --model`, so a tier alias (`haiku`,
 * `sonnet`, `opus`) or a pinned id (`claude-sonnet-5`) both work. The aliases
 * are the defaults because they track the current model in each tier; pin an id
 * when a lane needs to stay on a known model.
 *
 * Unset means "whatever the CLI itself would pick" — which is what `task` does
 * by default, because the top tier is the one place not to economise.
 */
export interface ModelsConfig {
  /** Conversational reply. No repo, no tools. */
  chat?: string;
  /** Read-only answer. May read a repo, never writes. */
  query?: string;
  /** Real work: write access, a branch, a diff. */
  task?: string;
  /**
   * Mechanical model calls that are not conversation at all — today the
   * DeerDawn bridge, which calls one MCP tool and emits a fixed JSON shape.
   * It runs on a timer whether or not there is work, so it is the one call
   * whose cost is paid continuously rather than per request.
   */
  bridge?: string;
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
  /** Per-lane model selection. See ModelsConfig. */
  models: ModelsConfig;
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
  voice: VoiceSettings;
  deerdawn: DeerDawnConfig;
  vault: VaultConfig;
  /** Per-project health manifests, used by investigation runs. */
  health: ProjectHealth[];
  /** Path to the entity map: spoken concepts -> IDs, events, paths, tables. */
  entityMapPath?: string;
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
    // Investigation: reads run without asking, and the first proposed write
    // stops the run and reports rather than queueing a confirmation nobody
    // asked for. Diagnosis and repair are separate decisions.
    name: 'investigate',
    allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git status*)', 'Bash(git show*)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(rg *)', 'Bash(tail *)', 'Bash(head *)', 'mcp__*__get*', 'mcp__*__list*', 'mcp__*__search*', 'mcp__*__read*', 'mcp__*__query*'],
    confirm: [],
    deny: ['Write', 'Edit', 'NotebookEdit', 'Bash(git commit*)', 'Bash(git push*)', 'Bash(rm *)', 'Bash(mv *)', 'Bash(npm install*)'],
    fallback: 'deny',
    permissionMode: 'plan',
    haltOnDeny: true,
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
  // `task` is deliberately unset: the lane that writes code is the one place
  // where picking the cheaper model is a false economy.
  models: { chat: 'haiku', query: 'sonnet', bridge: 'haiku' },
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
  imessage: { enabled: false, mode: 'native', pollMs: 1500, allowlist: [], webhookPath: '/hooks/bluebubbles' },
  telegram: { enabled: false, allowlist: [] },
  voice: { enabled: true, openMic: false, ttsVoice: 'Samantha' },
  deerdawn: { enabled: false, mcpServer: 'deerdawn', pollIntervalMs: 600_000, maxConcurrentCards: 1 },
  vault: { enabled: false, writeSubfolder: 'switchboard', git: true },
  health: [],
  entityMapPath: '~/.switchboard/entities.json',
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
