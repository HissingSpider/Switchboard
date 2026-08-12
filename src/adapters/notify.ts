import type { Db } from '../store/db.js';
import type { EventLog } from '../store/eventlog.js';
import type { SwbEvent } from '../store/events.js';
import { CRITICAL_KINDS } from '../store/events.js';
import type { NotificationRule } from '../config/schema.js';
import type { RunStore } from '../store/runs.js';
import { Downsampler, plainText } from './downsample.js';
import type { ChannelAdapter } from './types.js';
import { logger } from '../core/logger.js';

const log = logger('notify');

export interface NotifyTarget {
  channel: string;
  threadId: string;
}

/**
 * Decides what earns a text and what stays on the dashboard.
 *
 * Rules are matched in order; the first match wins. Critical events (a question,
 * a confirmation, a failure) bypass rules and throttles entirely — those are the
 * only things worth interrupting someone for.
 */
export class NotificationService {
  private readonly downsampler = new Downsampler();
  private readonly adapters = new Map<string, ChannelAdapter>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventLog,
    private readonly runs: RunStore,
    private readonly rules: NotificationRule[],
  ) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  start(): void {
    this.unsubscribe = this.events.subscribe((ev) => void this.handle(ev));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ruleFor(ev: SwbEvent): NotificationRule | undefined {
    const taskClass = ev.runId ? this.runs.get(ev.runId)?.taskClass : undefined;
    return this.rules.find((r) => r.on.includes(ev.kind) && (!r.taskClass || r.taskClass === taskClass));
  }

  private throttled(rule: NotificationRule, key: string): boolean {
    if (!rule.throttleSec) return false;
    const since = new Date(Date.now() - rule.throttleSec * 1000).toISOString();
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM notify_log WHERE rule = ? AND ts > ?').get(key, since) as { n: number };
    return Number(row.n) > 0;
  }

  private async handle(ev: SwbEvent): Promise<void> {
    // Never notify about notifications.
    if (ev.kind === 'notify.sent' || ev.kind === 'notify.suppressed' || ev.kind === 'message.out') return;

    const critical = CRITICAL_KINDS.has(ev.kind);
    const rule = this.ruleFor(ev);
    if (!critical && (!rule || rule.action !== 'push')) {
      if (rule?.action === 'dashboard') return; // dashboard-only, by design — no event needed
      return;
    }

    const target = this.targetFor(ev);
    if (!target) return;

    const ruleKey = `${rule?.on.join('|') ?? 'critical'}:${ev.runId ?? '_'}`;
    if (!critical && rule && this.throttled(rule, ruleKey)) {
      this.events.append({
        runId: ev.runId,
        kind: 'notify.suppressed',
        source: 'notify',
        summary: `suppressed ${ev.kind} (throttled)`,
        data: { rule: ruleKey },
      });
      return;
    }

    const body = critical ? ev.summary : this.downsampler.consider(ev);
    if (!body) return;

    await this.push(target, plainText(body), ev, ruleKey);
  }

  /** Where a given event's notification should go. */
  private targetFor(ev: SwbEvent): NotifyTarget | undefined {
    if (!ev.runId) return this.fallbackTarget();
    const run = this.runs.get(ev.runId);
    if (!run?.threadId || !run.channel) return this.fallbackTarget();
    if (run.channel === 'dashboard' || run.channel === 'cli') return this.fallbackTarget();
    return { channel: run.channel, threadId: run.threadId };
  }

  /** Scheduled and trigger runs have no thread; send them to the owner's default. */
  private fallbackTarget(): NotifyTarget | undefined {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = 'notify.default_target'`).get() as { value?: string } | undefined;
    if (!row?.value) return undefined;
    const [channel, threadId] = row.value.split('|');
    return channel && threadId ? { channel, threadId } : undefined;
  }

  setDefaultTarget(channel: string, threadId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('notify.default_target', ?, ?)`)
      .run(`${channel}|${threadId}`, new Date().toISOString());
  }

  async push(target: NotifyTarget, body: string, ev?: SwbEvent, ruleKey = 'manual'): Promise<boolean> {
    const adapter = this.adapters.get(target.channel);
    if (!adapter?.enabled) return false;
    const ok = await adapter.send({ threadId: target.threadId, text: body });
    this.db
      .prepare('INSERT INTO notify_log (ts, rule, channel, target, run_id, body) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), ruleKey, target.channel, target.threadId, ev?.runId ?? null, body);
    this.events.append({
      runId: ev?.runId ?? null,
      kind: ok ? 'notify.sent' : 'system.error',
      source: 'notify',
      summary: ok ? `texted ${target.channel}: ${body.slice(0, 120)}` : `failed to text ${target.channel}`,
      data: { target, body },
    });
    if (!ok) log.warn('push failed', { target });
    return ok;
  }

  forget(runId: string): void {
    this.downsampler.forget(runId);
  }
}
