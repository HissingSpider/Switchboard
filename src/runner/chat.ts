import { WarmSession } from '../voice/warm.js';
import type { LoadedConfig } from '../config/load.js';
import { logger } from '../core/logger.js';

const log = logger('chat');

/**
 * The sentinel a tool-free reply uses to hand the question back.
 *
 * Chat is a catch-all — the router sends anything without a project and without
 * a task or query hint here — so some of what lands is not conversation at all.
 * The model is given one unambiguous way to say "this needs tools", and that
 * answer costs one cheap turn.
 */
export const ESCALATE = 'NEEDS_TOOLS';

/**
 * How long a conversational turn may take before the session is written off.
 *
 * Generous next to the 2s a warm reply actually takes, because the cost of
 * being wrong is only a cold spawn — and mean next to the cold path's own caps,
 * because a chat turn that has taken half a minute has already lost the race it
 * existed to win.
 */
const TURN_TIMEOUT_MS = 45_000;

/**
 * Questions that are about this machine rather than about the world.
 *
 * The sentinel alone is not enough, and the failure is quiet rather than loud:
 * asked to list the scratch directory, a tool-free session answered from the
 * environment block the CLI puts in its own prompt and was *right*, which is
 * worse than being wrong because nothing looks broken. A model asked to
 * self-assess will sometimes decide it knows.
 *
 * So the same technique the router already uses decides it first: a cheap rule,
 * no model call, and a bias toward escalating. Being wrong here costs one
 * unnecessary query run; being wrong the other way costs a confident answer
 * about a filesystem nobody read.
 */
const NEEDS_TOOLS = [
  // Anything that names a path, a file, or a repository.
  /(^|\s)[~./][\w./-]*\/|\b[\w-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|json|ya?ml|toml|md|txt|css|html|sh|sql|lock)\b/i,
  // Reading, listing, running, or counting something on disk.
  /\b(read|open|cat|list|ls|grep|search|find|show me|print|count|diff|log|tail|head|inspect|check)\b.*\b(file|files|dir|directory|folder|repo|repository|branch|commit|code|log|logs|output|contents?)\b/i,
  /\b(what'?s|whats|what is) in\b/i,
  // Talking about the machine's own state or the user's own things.
  /\b(my|the|this|your) (repo|repository|project|codebase|branch|commit|config|settings?|scratch|directory|folder|machine|mac|disk|logs?)\b/i,
  /\b(how many|how much) .*\b(lines?|files?|commits?|runs?|tests?|errors?)\b/i,
  // Anything that has to leave the machine to be true.
  /\b(look up|google|browse|fetch|download|current|latest|today'?s|right now)\b/i,
  // Running something *here*. The verb alone is not enough: "how do I run a
  // marathon" is conversation, and sending it down the query lane costs a cold
  // spawn on the expensive model to answer a question about running.
  /\b(npm|npx|pnpm|yarn|git|node|cargo|make|docker|launchctl|brew)\b/i,
  /\b(run|execute|build|deploy|compile|install|restart)\b.*\b(it|this|that|the (test|tests|build|suite|script|command|daemon|server)|npm|script|command|tests?|suite|build)\b/i,
];

/**
 * Would answering this honestly need something the tool-free session does not
 * have? Deliberately over-inclusive — see NEEDS_TOOLS.
 */
export function needsTools(prompt: string): boolean {
  return NEEDS_TOOLS.some((re) => re.test(prompt));
}

const SYSTEM = [
  'You are answering one conversational turn for the person who owns this machine.',
  'Reply in at most three sentences, in plain prose.',
  '',
  'You have NO tools and NO access to this machine in this session.',
  '',
  `Reply with exactly ${ESCALATE}, and nothing else, whenever a truthful answer`,
  'would depend on something you cannot see: the contents of a file or directory,',
  'the state of a repository, command output, anything on disk, or anything that',
  'has changed recently in the world.',
  '',
  'This includes cases where you can make a confident guess. Your working',
  'directory and environment appear in your own context; they are not evidence',
  `about the machine, and a question about them is still ${ESCALATE}.`,
  '',
  'Do not apologise, do not hedge, do not explain the limitation. Either answer',
  `from general knowledge, or reply ${ESCALATE}.`,
].join('\n');

export type ChatOutcome =
  | { kind: 'answered'; text: string; costUsd: number; ms: number }
  /** The turn needs tools. It was misrouted as chat and belongs in the query lane. */
  | { kind: 'escalate' }
  /** Nothing is wrong with the turn; the session just could not take it. */
  | { kind: 'unavailable' };

/**
 * A resident `claude -p` for the chat lane.
 *
 * Cold-starting the CLI costs seconds, which is most of the latency of "how's it
 * going" and all of the reason texting the machine feels slow. Holding one
 * process open turns that into a socket write.
 *
 * Only the chat lane can use it, and the reason is the gate rather than the
 * model: `src/runner/hook.ts` reads `SWB_RUN_ID` from its own process
 * environment, so a process shared between runs would attribute every gated
 * call to whichever run happened to start it — and the event log is the only
 * source of truth we have. A shared process is therefore only safe where
 * nothing is gated at all, which is what `allowedTools: []` guarantees.
 */
export class ChatResponder {
  private warm: WarmSession | null = null;
  /**
   * One resident process is one conversation. Serving a second thread from it
   * would let an iMessage thread read what was said on the dashboard, so a
   * thread switch recycles instead — paying a cold start exactly when the topic
   * changed anyway.
   */
  private boundThread: string | null = null;

  /**
   * How long one turn may take. Settable so a test can prove the timeout
   * without waiting out the real one.
   */
  turnTimeoutMs = TURN_TIMEOUT_MS;

  constructor(private readonly cfg: LoadedConfig) {}

  get enabled(): boolean {
    return this.cfg.models?.chat !== undefined;
  }

  /** Bring the process up so the first message doesn't pay for it. */
  async prewarm(): Promise<void> {
    if (!this.enabled || this.warm) return;
    await this.session().catch((err: Error) => {
      log.warn('chat session failed to warm — chat will spawn per message', { err: err.message });
    });
  }

  private async session(): Promise<WarmSession> {
    if (this.warm?.ready) return this.warm;
    this.warm = new WarmSession({
      bin: this.cfg.claudeBin,
      cwd: this.cfg.resolved.scratchDir,
      model: this.cfg.models?.chat,
      // The whole safety argument rests on this being empty. Adding a tool here
      // means a gated call attributed to the wrong run.
      allowedTools: [],
      permissionMode: 'plan',
      systemPrompt: SYSTEM,
      maxTurnsBeforeRecycle: 40,
    });
    await this.warm.start();
    return this.warm;
  }

  /**
   * Answer if this turn is one the warm session can take.
   *
   * The two ways of not answering are kept apart on purpose. `escalate` means
   * the question was misrouted and needs the query lane's model and tools;
   * `unavailable` means the question was fine and the session simply could not
   * take it, so nothing about the run should change. Collapsing them would send
   * a tool-using question to a cold process still on the cheap chat model.
   */
  async reply(threadId: string, prompt: string): Promise<ChatOutcome> {
    if (!this.enabled) return { kind: 'unavailable' };

    // Decided before the model is asked, because a model asked to judge its own
    // blind spot sometimes decides it can see.
    if (needsTools(prompt)) return { kind: 'escalate' };

    try {
      let warm = await this.session();

      // Busy means another thread is mid-turn. Queueing behind it would make
      // this reply slower than the cold spawn it is replacing.
      if (warm.inUse) return { kind: 'unavailable' };

      if (this.boundThread !== threadId || warm.stale) {
        if (this.boundThread !== null || warm.stale) {
          this.warm?.stop();
          this.warm = null;
          warm = await this.session();
        }
        this.boundThread = threadId;
      }

      // A turn with no ceiling is a turn that can wedge forever: WarmSession
      // resolves on `result` or `exit`, so a process that stays alive and says
      // nothing never settles. Left unbounded it strands the run in `queued`,
      // where sweep() cannot cap it and kill() cannot reach it, and leaves the
      // session marked busy — quietly turning warm chat off until a restart.
      const turn = warm.ask(prompt);
      const res = await Promise.race([
        turn.done,
        new Promise<null>((r) => setTimeout(() => r(null), this.turnTimeoutMs)),
      ]);
      if (!res) {
        // Abandon frees the session for the next turn; the process is recycled
        // because one that missed a whole turn has stopped being trustworthy.
        turn.abandon();
        log.warn('warm chat turn timed out — recycling the session', { threadId });
        this.warm?.stop();
        this.warm = null;
        this.boundThread = null;
        return { kind: 'unavailable' };
      }
      const text = res.text.trim();
      if (text.toUpperCase().includes(ESCALATE)) return { kind: 'escalate' };
      // An empty answer is a broken session, not a considered refusal.
      if (!text) return { kind: 'unavailable' };
      return { kind: 'answered', text, costUsd: res.costUsd, ms: res.ms };
    } catch (err) {
      log.warn('warm chat failed — falling back to a spawned run', { err: (err as Error).message });
      this.warm = null;
      this.boundThread = null;
      return { kind: 'unavailable' };
    }
  }

  stop(): void {
    this.warm?.stop();
    this.warm = null;
    this.boundThread = null;
  }
}
