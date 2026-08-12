import type { LoadedConfig } from '../config/load.js';
import type { Intent } from '../store/runs.js';
import type { TaskClass } from '../config/schema.js';
import { resolveProject, type ProjectMatch } from './projects.js';
import { inferTaskClass } from '../runner/profiles.js';

export type Command =
  | { kind: 'status' }
  | { kind: 'runs'; limit: number }
  | { kind: 'kill'; runId: string }
  | { kind: 'follow'; runId: string; text: string }
  | { kind: 'reset' }
  | { kind: 'help' }
  | { kind: 'projects' }
  | { kind: 'agents' }
  | { kind: 'switchAgent'; agent: string }
  | { kind: 'cost' }
  | { kind: 'diff'; runId?: string };

export interface RoutedMessage {
  /** A slash-style control command bypasses the model entirely. */
  command?: Command;
  /** Chat = conversational reply, query = read-only answer, task = real work. */
  intent: Intent;
  taskClass: TaskClass;
  project?: ProjectMatch;
  agent?: string;
  /** Prompt with routing prefixes stripped. */
  prompt: string;
  /** Should the run continue the thread's existing session? */
  continueSession: boolean;
}

const COMMANDS: Array<[RegExp, (m: RegExpExecArray) => Command]> = [
  [/^\/?(status|what'?s running|running)$/i, () => ({ kind: 'status' })],
  [/^\/?runs?(?:\s+(\d+))?$/i, (m) => ({ kind: 'runs', limit: Number(m[1] ?? 10) })],
  [/^\/?(?:kill|stop|abort)\s+(\S+)$/i, (m) => ({ kind: 'kill', runId: m[1]! })],
  [/^\/?(?:tell|also|and)\s+(r-\S+)\s+(.+)$/is, (m) => ({ kind: 'follow', runId: m[1]!, text: m[2]! })],
  [/^\/?(reset|new|clear)$/i, () => ({ kind: 'reset' })],
  [/^\/?(help|\?)$/i, () => ({ kind: 'help' })],
  [/^\/?projects?$/i, () => ({ kind: 'projects' })],
  [/^\/?agents?$/i, () => ({ kind: 'agents' })],
  [/^\/?(?:use|be|as)\s+([\w.-]+)$/i, (m) => ({ kind: 'switchAgent', agent: m[1]! })],
  [/^\/?(cost|spend|budget)$/i, () => ({ kind: 'cost' })],
  [/^\/?diff(?:\s+(\S+))?$/i, (m) => ({ kind: 'diff', runId: m[1] })],
];

export function parseCommand(text: string): Command | undefined {
  const t = text.trim();
  for (const [re, build] of COMMANDS) {
    const m = re.exec(t);
    if (m) return build(m);
  }
  return undefined;
}

/** `!agentname rest of message` picks an agent for this message only. */
function stripAgent(text: string): { text: string; agent?: string } {
  const m = /^!([\w.-]+)\s+/.exec(text);
  return m ? { text: text.slice(m[0].length).trim(), agent: m[1] } : { text };
}

const QUERY_HINTS = /^(what|where|when|who|why|how|is|are|does|do|did|can|could|should|show me|list|tell me about|explain|summar)/i;
const TASK_HINTS = /\b(fix|add|implement|refactor|write|create|update|remove|delete|rename|migrate|build|deploy|test|run|install|bump|ship)\b/i;
const CHAT_HINTS = /^(hi|hey|hello|thanks|thank you|ok|cool|nice|lol|good morning|good night)\b/i;

/**
 * Three lanes, decided by cheap rules rather than a model call — the router
 * runs on every inbound message and a model round-trip per text is both slow
 * and a waste of credits.
 *
 * chat  → short conversational reply, no tools, no repo
 * query → read-only, may look at a repo, never writes
 * task  → a real run with write access and a git branch
 */
export function routeMessage(cfg: LoadedConfig, raw: string, opts: { stickyProject?: string; stickyAgent?: string } = {}): RoutedMessage {
  const command = parseCommand(raw);
  if (command) {
    return { command, intent: 'chat', taskClass: 'assistant', prompt: raw, continueSession: false };
  }

  const agentStripped = stripAgent(raw.trim());
  const { match, text } = resolveProject(cfg, agentStripped.text, opts.stickyProject);
  const body = text.trim();

  let intent: Intent;
  if (CHAT_HINTS.test(body) && body.length < 40) intent = 'chat';
  else if (TASK_HINTS.test(body)) intent = 'task';
  else if (QUERY_HINTS.test(body)) intent = 'query';
  else intent = match ? 'task' : 'chat';

  const taskClass: TaskClass = intent === 'task' ? inferTaskClass(body, Boolean(match)) : 'assistant';

  return {
    intent,
    taskClass,
    project: match,
    agent: agentStripped.agent ?? opts.stickyAgent,
    prompt: body,
    // Chat and query are conversational; tasks start clean so a stale session
    // cannot drag an unrelated repo's context into a new job.
    continueSession: intent !== 'task',
  };
}

/** Extra system-prompt text that keeps read-only lanes read-only. */
export function laneSystemPrompt(intent: Intent): string {
  switch (intent) {
    case 'chat':
      return 'Reply in at most three sentences. No tools unless the answer genuinely needs one.';
    case 'query':
      return 'Answer the question from what you can read. Do not modify any file. Be brief and concrete.';
    case 'task':
      return '';
  }
}

export const HELP_TEXT = [
  'Switchboard',
  '  <text>              run it (project inferred, or use @project)',
  '  @proj <text>        run in a specific project',
  '  !agent <text>       route to a specific agent',
  '  status              what is running now',
  '  runs [n]            recent runs',
  '  kill <id>           stop a run',
  '  tell <id> <text>    inject a follow-up into a live run',
  '  diff [id]           diff stat for a run',
  '  cost                spend this month',
  '  projects / agents   what is configured',
  '  ok <id> / no <id>   answer a confirmation',
  '  reset               forget this thread\'s session',
].join('\n');
