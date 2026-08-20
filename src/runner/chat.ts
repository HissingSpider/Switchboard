import { WarmSession } from '../voice/warm.js';
import type { LoadedConfig } from '../config/load.js';
import { logger } from '../core/logger.js';

const log = logger('chat');

/**
 * The sentinel a tool-free reply uses to hand the question back.
 *
 * Chat is a catch-all — the router sends anything without a project and without
 * a task or query hint here — so some of what lands is not conversation at all.
 * Rather than guess from the text, the model is given one unambiguous way to
 * say "this needs tools", and that answer costs one cheap turn.
 */
export const ESCALATE = 'NEEDS_TOOLS';

const SYSTEM = [
  'You are answering one conversational turn for the person who owns this machine.',
  'Reply in at most three sentences, in plain prose.',
  '',
  'You have no tools in this session. If answering properly would need reading a',
  'file, running a command, looking at a repository, or fetching anything, reply',
  `with exactly ${ESCALATE} and nothing else — the question will be re-asked in a`,
  'session that has tools. Do not apologise, do not guess, do not explain.',
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

      const res = await warm.ask(prompt).done;
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
