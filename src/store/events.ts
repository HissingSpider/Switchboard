/** Every kind of thing that can land in the event log. One vocabulary for the
 *  dashboard stream, the iMessage downsample and the audit trail. */
export type EventKind =
  // run lifecycle
  | 'run.queued'
  | 'run.started'
  | 'run.progress'
  | 'run.finished'
  | 'run.failed'
  | 'run.killed'
  | 'run.stuck'
  // model traffic
  | 'agent.text'
  | 'agent.thinking'
  | 'tool.use'
  | 'tool.result'
  | 'agent.question'
  | 'usage.update'
  // gating
  | 'action.gated'
  | 'action.confirm_requested'
  | 'action.confirm_answered'
  | 'action.denied'
  // side effects
  | 'git.branch'
  | 'git.diff'
  | 'artifact.saved'
  | 'screenshot.captured'
  // channels
  | 'message.in'
  | 'message.out'
  | 'notify.sent'
  | 'notify.suppressed'
  // system
  | 'system.start'
  | 'system.stop'
  | 'system.error'
  | 'schedule.fired'
  | 'trigger.fired';

export interface SwbEvent {
  id: number;
  ts: string;
  runId: string | null;
  kind: EventKind;
  /** Human-readable one-liner. Safe to text. */
  summary: string;
  /** Structured payload; shape depends on `kind`. */
  data: Record<string, unknown>;
  /** Where this came from: 'runner', 'gateway', 'imessage', 'telegram', 'scheduler'. */
  source: string;
}

export type NewEvent = Omit<SwbEvent, 'id' | 'ts'> & { ts?: string };

/** Kinds that are high-volume and should never be pushed to a phone. */
export const NOISY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'agent.thinking',
  'tool.result',
  'usage.update',
  'run.progress',
]);

/** Kinds that always matter to a human, regardless of notification rules. */
export const CRITICAL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'action.confirm_requested',
  'agent.question',
  'run.failed',
  'run.stuck',
  'system.error',
]);
