import type { EventLog } from '../store/eventlog.js';
import type { RunStore, RunRecord } from '../store/runs.js';
import type { ArtifactStore } from '../store/artifacts.js';
import { readCredentialClock } from './credentials.js';

export type FailureKind =
  | 'credit_exhausted'
  | 'rate_limited'
  | 'auth_expired'
  | 'mcp_auth_expired'
  | 'mcp_unreachable'
  | 'context_overflow'
  | 'max_turns'
  | 'stuck'
  | 'killed'
  | 'crashed'
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  /** What a person should be told, in one line. */
  message: string;
  /** What to do about it. */
  remedy: string;
  /** Whether retrying without human action could plausibly work. */
  retryable: boolean;
  /** Whether the whole daemon should stop accepting new runs. */
  halt: boolean;
}

const SIGNATURES: Array<{ re: RegExp; kind: FailureKind }> = [
  { re: /credit balance is too low|insufficient credits|billing/i, kind: 'credit_exhausted' },
  { re: /rate.?limit|429|too many requests/i, kind: 'rate_limited' },
  { re: /invalid.?api.?key|authentication_error|401|unauthorized|please run .?claude login/i, kind: 'auth_expired' },
  { re: /mcp.*(auth|token).*(expired|invalid)|oauth.*expired/i, kind: 'mcp_auth_expired' },
  { re: /mcp server.*(failed|unreachable|not found)|failed to connect to mcp/i, kind: 'mcp_unreachable' },
  { re: /prompt is too long|context.*(exceeded|too large)|maximum context/i, kind: 'context_overflow' },
  { re: /max.?turns|error_max_turns/i, kind: 'max_turns' },
];

const REMEDIES: Record<FailureKind, { message: string; remedy: string; retryable: boolean; halt: boolean }> = {
  credit_exhausted: {
    message: 'Anthropic credit is exhausted — nothing will run until it is topped up.',
    remedy: 'Top up at console.anthropic.com, then `swb resume`.',
    retryable: false,
    halt: true,
  },
  rate_limited: {
    message: 'Rate limited.',
    remedy: 'Backing off; the run will be retried once.',
    retryable: true,
    halt: false,
  },
  auth_expired: {
    message: 'Claude auth is no longer valid.',
    remedy: 'Run `claude` on the Mac Mini and log in again, or refresh ANTHROPIC_API_KEY.',
    retryable: false,
    halt: true,
  },
  mcp_auth_expired: {
    message: 'An MCP server rejected our token.',
    remedy: 'Re-authenticate that MCP, then `swb doctor` to confirm.',
    retryable: false,
    halt: false,
  },
  mcp_unreachable: {
    message: 'An MCP server could not be reached.',
    remedy: 'Check the server is running; `swb doctor` probes them all.',
    retryable: true,
    halt: false,
  },
  context_overflow: {
    message: 'The session grew past the context window.',
    remedy: 'Start a fresh session (`reset`) and give a narrower task.',
    retryable: false,
    halt: false,
  },
  max_turns: {
    message: 'Hit the turn cap before finishing.',
    remedy: 'Raise caps.maxTurns, or split the task.',
    retryable: false,
    halt: false,
  },
  stuck: {
    message: 'The run stopped producing output and was killed.',
    remedy: 'Check the transcript for what it was doing when it stalled.',
    retryable: true,
    halt: false,
  },
  killed: { message: 'Killed.', remedy: '', retryable: false, halt: false },
  crashed: {
    message: 'The claude process exited unexpectedly.',
    remedy: 'Check stderr.log in the run directory.',
    retryable: true,
    halt: false,
  },
  unknown: {
    message: 'Failed for a reason we do not recognise.',
    remedy: 'Read the transcript; if it recurs, add a signature to failures.ts.',
    retryable: true,
    halt: false,
  },
};

export function classify(text: string): FailureKind {
  for (const s of SIGNATURES) if (s.re.test(text)) return s.kind;
  return 'unknown';
}

/**
 * Diagnose a failure from output the model could not have influenced.
 *
 * stderr and our own error field are always safe. The run's result is not: it
 * is written by the model in response to whatever someone texted in, so
 * classifying on it means a message containing "unauthorized" is diagnosed as
 * expired credentials — and `auth_expired` halts the daemon. Any inbound
 * message would become a denial of service.
 *
 * The exception is a run that produced no assistant turns at all. The CLI
 * failing to authenticate prints its error and exits before the model is ever
 * reached, so with zero turns the output cannot be model-authored and is the
 * only place that diagnosis exists.
 */
export function diagnose(run: RunRecord, stderr = '', result = ''): Diagnosis {
  if (run.status === 'killed') {
    const kind: FailureKind = /stuck/i.test(run.error ?? '') ? 'stuck' : 'killed';
    return { kind, ...REMEDIES[kind] };
  }
  const neverReachedTheModel = (run.turns ?? 0) === 0;
  const evidence = [stderr, run.error ?? '', neverReachedTheModel ? result : ''].join('\n');
  const kind = classify(evidence);
  const base = REMEDIES[kind] ?? REMEDIES.unknown;
  return { kind: kind === 'unknown' && run.exitCode !== 0 ? 'crashed' : kind, ...base };
}

/**
 * A halting failure — no credit, no auth — is different in kind from one bad
 * run: every queued run will hit it too. We record it once, loudly, and stop
 * accepting work until a human clears it.
 */
export class FailureMonitor {
  private halted: Diagnosis | null = null;
  /**
   * The credential's expiry as it stood when we gave up.
   *
   * A halt on expired auth is the one that fixes itself: someone logs in on the
   * Mac Mini and the stored token's expiry moves forward. Watching for that is
   * free and exact, so the daemon does not need a human to tell it the thing it
   * can see for itself — and does not need to spend a run finding out.
   */
  private authExpiryAtHalt: number | null = null;

  constructor(
    private readonly events: EventLog,
    private readonly runs: RunStore,
    private readonly artifacts: ArtifactStore,
  ) {}

  inspect(run: RunRecord): Diagnosis | undefined {
    if (run.status === 'done') return undefined;
    const stderr = this.artifacts.read(run.id, 'stderr.log') ?? '';
    const diagnosis = diagnose(run, stderr, run.result ?? '');

    this.events.append({
      runId: run.id,
      kind: 'system.error',
      source: 'runner',
      summary: `${run.id}: ${diagnosis.message}${diagnosis.remedy ? ` ${diagnosis.remedy}` : ''}`,
      data: { kind: diagnosis.kind, retryable: diagnosis.retryable, halt: diagnosis.halt },
    });

    if (diagnosis.halt && !this.halted) {
      this.halted = diagnosis;
      this.authExpiryAtHalt = diagnosis.kind === 'auth_expired' ? (readCredentialClock().expiresAt ?? 0) : null;
      this.events.append({
        runId: null,
        kind: 'system.error',
        source: 'runner',
        summary: `Switchboard halted: ${diagnosis.message} ${diagnosis.remedy}`,
        data: { kind: diagnosis.kind },
      });
    }
    return diagnosis;
  }

  get haltReason(): Diagnosis | null {
    return this.halted;
  }

  /**
   * Has the thing we halted on been fixed? Called on the sweeper.
   *
   * Only expired auth is checked, because it is the only halt with a signal we
   * can read for nothing. Exhausted credit has no local evidence at all, so it
   * stays a human's job rather than a guess dressed up as recovery.
   */
  recheck(): boolean {
    if (this.halted?.kind !== 'auth_expired') return false;
    const clock = readCredentialClock();

    // An explicit API key is not something we can watch expire; if one has
    // appeared since the halt, that is a deliberate act and reason enough.
    const fixed =
      clock.source === 'env' ||
      (clock.expiresAt !== undefined && clock.expiresAt > (this.authExpiryAtHalt ?? 0) && clock.expiresAt > Date.now());
    if (!fixed) return false;

    this.halted = null;
    this.authExpiryAtHalt = null;
    this.events.append({
      runId: null,
      kind: 'system.start',
      source: 'runner',
      summary: 'Claude auth works again — accepting runs',
      data: { recovered: true, source: clock.source },
    });
    return true;
  }

  clear(): void {
    this.halted = null;
    this.authExpiryAtHalt = null;
    this.events.append({ runId: null, kind: 'system.start', source: 'runner', summary: 'halt cleared — accepting runs again', data: {} });
  }

  /** Runs that claim to be running but whose process is gone. */
  deadRuns(activeIds: Set<string>): RunRecord[] {
    return this.runs.active().filter((r) => r.status === 'running' && !activeIds.has(r.id));
  }

  reapDead(activeIds: Set<string>): number {
    const dead = this.deadRuns(activeIds);
    for (const r of dead) {
      this.runs.update(r.id, { status: 'failed', error: 'process vanished', finishedAt: new Date().toISOString() });
      this.events.append({ runId: r.id, kind: 'run.failed', source: 'runner', summary: `${r.id} process vanished — marked failed`, data: {} });
    }
    return dead.length;
  }
}
