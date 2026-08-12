import { watch, existsSync, statSync, type FSWatcher } from 'node:fs';
import type { LoadedConfig } from '../config/load.js';
import { expandPath } from '../config/load.js';
import type { HeartbeatJob, TriggerConfig } from '../config/schema.js';
import type { RunRegistry } from '../runner/registry.js';
import type { EventLog } from '../store/eventlog.js';
import { parseCron, cronMatches, nextRun, type CronFields } from './cron.js';
import { logger } from '../core/logger.js';

const log = logger('scheduler');

interface CompiledJob {
  job: HeartbeatJob;
  fields: CronFields;
  lastFiredMinute: string;
}

export interface JobStatus {
  name: string;
  kind: 'cron' | 'file' | 'webhook' | 'poll';
  spec: string;
  enabled: boolean;
  next?: string;
  lastFired?: string;
  error?: string;
}

/**
 * Proactive runs: cron heartbeats plus non-cron wake triggers (a file changed,
 * a webhook arrived, a polled URL came back different). All of them funnel into
 * the same run registry, so a scheduled run is auditable and budgeted exactly
 * like a texted one.
 */
export class Scheduler {
  private compiled: CompiledJob[] = [];
  private tick: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private pollers: NodeJS.Timeout[] = [];
  private lastFired = new Map<string, string>();
  private errors = new Map<string, string>();
  private pollState = new Map<string, string>();

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly registry: RunRegistry,
    private readonly events: EventLog,
  ) {}

  start(): void {
    this.compile();
    // Align to the top of the minute so a job configured for 09:00 fires at 09:00.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    setTimeout(() => {
      this.check();
      this.tick = setInterval(() => this.check(), 60_000);
      this.tick.unref();
    }, msToNextMinute).unref();

    for (const t of this.cfg.triggers) {
      if (t.enabled === false) continue;
      if (t.kind === 'file') this.watchFile(t);
      if (t.kind === 'poll') this.startPoll(t);
      // webhook triggers are passive — the gateway calls fireWebhook().
    }
    log.info('scheduler started', { heartbeats: this.compiled.length, triggers: this.cfg.triggers.length });
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    for (const w of this.watchers) w.close();
    for (const p of this.pollers) clearInterval(p);
    this.watchers = [];
    this.pollers = [];
  }

  private compile(): void {
    this.compiled = [];
    for (const job of this.cfg.heartbeats) {
      if (job.enabled === false) continue;
      try {
        this.compiled.push({ job, fields: parseCron(job.cron), lastFiredMinute: '' });
      } catch (err) {
        this.errors.set(job.name, (err as Error).message);
        log.warn('bad cron expression', { job: job.name, err: (err as Error).message });
      }
    }
  }

  private check(now = new Date()): void {
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    for (const c of this.compiled) {
      if (c.lastFiredMinute === minuteKey) continue;
      if (!cronMatches(c.fields, now)) continue;
      c.lastFiredMinute = minuteKey;
      this.fire('cron', c.job.name, c.job.prompt, c.job.project, c.job.agent);
    }
  }

  private watchFile(t: TriggerConfig): void {
    const target = expandPath(t.target);
    if (!existsSync(target)) {
      this.errors.set(t.name, `watch target does not exist: ${target}`);
      return;
    }
    let debounce: NodeJS.Timeout | null = null;
    const watcher = watch(target, { recursive: statSync(target).isDirectory() }, (_evt, filename) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.fire('file', t.name, `${t.prompt}\n\nChanged: ${filename ?? target}`, t.project, t.agent);
      }, 1000);
    });
    watcher.unref?.();
    this.watchers.push(watcher);
  }

  private startPoll(t: TriggerConfig): void {
    const interval = Math.max(30_000, t.intervalMs ?? 300_000);
    const timer = setInterval(() => void this.poll(t), interval);
    timer.unref();
    this.pollers.push(timer);
  }

  private async poll(t: TriggerConfig): Promise<void> {
    try {
      const res = await fetch(t.target, { signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      // Fire only when the response actually changed, or the inbox check would
      // wake someone every five minutes forever.
      const fingerprint = `${res.status}:${body.length}:${body.slice(0, 200)}`;
      const previous = this.pollState.get(t.name);
      this.pollState.set(t.name, fingerprint);
      if (previous === undefined || previous === fingerprint) return;
      this.fire('poll', t.name, `${t.prompt}\n\nPolled ${t.target} and it changed.`, t.project, t.agent);
    } catch (err) {
      this.errors.set(t.name, (err as Error).message);
    }
  }

  /** Called by the gateway when POST /hooks/trigger/<name> arrives. */
  fireWebhook(name: string, payload: Record<string, unknown>): boolean {
    const t = this.cfg.triggers.find((x) => x.name === name && x.kind === 'webhook' && x.enabled !== false);
    if (!t) return false;
    const body = JSON.stringify(payload).slice(0, 4000);
    this.fire('webhook', name, `${t.prompt}\n\nWebhook payload:\n${body}`, t.project, t.agent);
    return true;
  }

  private fire(kind: string, name: string, prompt: string, project?: string, agent?: string): void {
    this.lastFired.set(name, new Date().toISOString());
    this.events.append({
      runId: null,
      kind: kind === 'cron' ? 'schedule.fired' : 'trigger.fired',
      source: 'scheduler',
      summary: `${kind} "${name}" fired`,
      data: { name, kind, project, agent },
    });
    try {
      this.registry.submit({
        prompt,
        project,
        agent,
        intent: 'task',
        channel: kind === 'cron' ? 'schedule' : 'trigger',
        threadId: `schedule:${name}`,
        continueSession: false,
      });
    } catch (err) {
      this.errors.set(name, (err as Error).message);
      this.events.append({
        runId: null,
        kind: 'system.error',
        source: 'scheduler',
        summary: `"${name}" could not start: ${(err as Error).message}`,
        data: { name },
      });
    }
  }

  list(): JobStatus[] {
    const jobs: JobStatus[] = this.cfg.heartbeats.map((j) => {
      let next: string | undefined;
      try {
        next = nextRun(parseCron(j.cron))?.toISOString();
      } catch {
        next = undefined;
      }
      return {
        name: j.name,
        kind: 'cron',
        spec: j.cron,
        enabled: j.enabled !== false,
        next,
        lastFired: this.lastFired.get(j.name),
        error: this.errors.get(j.name),
      };
    });
    for (const t of this.cfg.triggers) {
      jobs.push({
        name: t.name,
        kind: t.kind,
        spec: t.target,
        enabled: t.enabled !== false,
        lastFired: this.lastFired.get(t.name),
        error: this.errors.get(t.name),
      });
    }
    return jobs;
  }
}
