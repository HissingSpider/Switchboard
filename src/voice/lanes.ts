import type { Lane } from './types.js';

/**
 * Latency lanes.
 *
 * A voice assistant is judged almost entirely on the gap between you finishing
 * a sentence and it starting one. Different questions can't have the same
 * budget, so we sort them up front and spend accordingly:
 *
 *   instant  no model at all — answered from local state.        target < 150 ms
 *   query    the warm resident session, read-only tools.         target < 1.5 s
 *   task     a real spawned run; we ack by voice and report back. ack < 300 ms
 */
export interface LaneBudget {
  lane: Lane;
  /** If nothing has been spoken by now, say a filler. */
  fillerAfterMs: number;
  /** If nothing has been spoken by now, apologise and stop waiting. */
  giveUpAfterMs: number;
}

export const BUDGETS: Record<Lane, LaneBudget> = {
  instant: { lane: 'instant', fillerAfterMs: 400, giveUpAfterMs: 3_000 },
  query: { lane: 'query', fillerAfterMs: 900, giveUpAfterMs: 25_000 },
  task: { lane: 'task', fillerAfterMs: 600, giveUpAfterMs: 10_000 },
};

/** Things we can answer without waking a model at all. */
export type InstantIntent =
  | { kind: 'stop' }
  | { kind: 'cancel_run' }
  | { kind: 'status' }
  | { kind: 'runs' }
  | { kind: 'cost' }
  | { kind: 'repeat' }
  | { kind: 'acknowledge' }
  | { kind: 'goodbye' }
  | { kind: 'time' };

const INSTANT_PATTERNS: Array<[RegExp, InstantIntent]> = [
  [/^(stop|quiet|shut up|be quiet|nevermind|never mind|cancel that)\b/i, { kind: 'stop' }],
  [/^(cancel|kill|abort)( the| that)?( run| task| job)?\b/i, { kind: 'cancel_run' }],
  [/\b(what'?s? (running|going on)|status|any runs)\b/i, { kind: 'status' }],
  [/\b(recent runs|last (few )?runs|what did you do)\b/i, { kind: 'runs' }],
  [/\b(how much (have (i|we) )?spent|what'?s the (spend|cost|budget))\b/i, { kind: 'cost' }],
  [/^(say that again|repeat( that)?|what( did you say)?\??)$/i, { kind: 'repeat' }],
  [/^(thanks|thank you|ok|okay|cool|got it|nice|great|perfect)\b/i, { kind: 'acknowledge' }],
  [/^(bye|goodbye|good ?night|that'?s all|we'?re done)\b/i, { kind: 'goodbye' }],
  [/\bwhat time is it\b/i, { kind: 'time' }],
];

const TASK_HINTS =
  /\b(fix|add|implement|refactor|write|create|update|remove|delete|rename|migrate|build|deploy|test|run|install|bump|ship|make|set up|clean up)\b/i;

const QUERY_HINTS = /^(what|where|when|who|why|how|is|are|does|do|did|can|could|should|show|list|tell me|explain|summar|remind)/i;

export function classifyInstant(text: string): InstantIntent | undefined {
  const t = text.trim();
  if (!t) return undefined;
  for (const [re, intent] of INSTANT_PATTERNS) if (re.test(t)) return intent;
  return undefined;
}

/**
 * Which lane an utterance belongs in.
 *
 * Deliberately biased towards `query` when it's ambiguous: answering a question
 * that turns out to need real work costs a second, whereas spawning a run for
 * something that was only a question costs a branch, a few cents, and the
 * user's trust.
 */
export function classifyLane(text: string): Lane {
  if (classifyInstant(text)) return 'instant';
  const t = text.trim();
  if (QUERY_HINTS.test(t)) return 'query';
  if (TASK_HINTS.test(t)) return 'task';
  return t.split(/\s+/).length <= 4 ? 'instant' : 'query';
}

/**
 * Filler speech.
 *
 * Silence while something is in flight reads as "it didn't hear me", and the
 * user repeats themselves — which is worse than a filler, because now there are
 * two utterances in the queue. Fillers are deliberately short, varied so they
 * don't sound like a loop, and never promise anything.
 */
const FILLERS: Record<Lane, string[]> = {
  instant: ['One sec.', 'Let me check.'],
  query: ['Let me look.', 'One moment.', 'Checking.', 'Hang on.', 'Looking that up.'],
  task: ['Starting on that.', 'On it.', 'Kicking that off.', 'Got it, starting now.'],
};

export class FillerPicker {
  private lastIndex = new Map<Lane, number>();

  /** Never the same filler twice in a row for the same lane. */
  pick(lane: Lane): string {
    const options = FILLERS[lane];
    if (options.length === 1) return options[0]!;
    const last = this.lastIndex.get(lane) ?? -1;
    let index = Math.floor(Math.random() * options.length);
    if (index === last) index = (index + 1) % options.length;
    this.lastIndex.set(lane, index);
    return options[index]!;
  }

  reset(): void {
    this.lastIndex.clear();
  }
}

/**
 * Runs a filler after `fillerAfterMs` unless the real answer beats it, and
 * gives up after `giveUpAfterMs`. `settle()` cancels both.
 */
export class TurnTimer {
  private fillerTimer: NodeJS.Timeout | null = null;
  private giveUpTimer: NodeJS.Timeout | null = null;
  private settled = false;
  readonly startedAt = Date.now();

  constructor(
    private readonly budget: LaneBudget,
    onFiller: () => void,
    onGiveUp: () => void,
  ) {
    this.fillerTimer = setTimeout(() => {
      if (!this.settled) onFiller();
    }, budget.fillerAfterMs);
    this.giveUpTimer = setTimeout(() => {
      if (!this.settled) {
        this.settle();
        onGiveUp();
      }
    }, budget.giveUpAfterMs);
    this.fillerTimer.unref();
    this.giveUpTimer.unref();
  }

  /** Call the moment the first real audio goes out. Returns time-to-first-word. */
  settle(): number {
    this.settled = true;
    if (this.fillerTimer) clearTimeout(this.fillerTimer);
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.fillerTimer = null;
    this.giveUpTimer = null;
    return Date.now() - this.startedAt;
  }

  get done(): boolean {
    return this.settled;
  }
}

/** Rolling latency stats, so `swb voice stats` can show whether it feels fast. */
export class LatencyTracker {
  private samples = new Map<Lane, number[]>();

  record(lane: Lane, ms: number): void {
    const list = this.samples.get(lane) ?? [];
    list.push(ms);
    if (list.length > 100) list.shift();
    this.samples.set(lane, list);
  }

  summary(): Array<{ lane: Lane; count: number; p50: number; p95: number }> {
    return [...this.samples.entries()].map(([lane, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        lane,
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    });
  }
}
