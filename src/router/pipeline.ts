import { basename } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { routeMessage, HELP_TEXT, type Command } from './intent.js';
import { listProjects } from './projects.js';
import type { RunRegistry } from '../runner/registry.js';
import { BudgetExceededError, HaltedError } from '../runner/registry.js';
import type { RunStore } from '../store/runs.js';
import type { SessionStore } from '../store/sessions.js';
import type { EventLog } from '../store/eventlog.js';
import type { ArtifactStore } from '../store/artifacts.js';
import type { ConfirmService } from '../policy/confirm.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { InboundMessage } from '../adapters/types.js';
import { formatDiffStat } from '../runner/git.js';

export interface PipelineDeps {
  cfg: LoadedConfig;
  registry: RunRegistry;
  runs: RunStore;
  sessions: SessionStore;
  events: EventLog;
  artifacts: ArtifactStore;
  confirms: ConfirmService;
  agents: AgentRegistry;
  reply: (threadId: string, text: string, attachments?: string[]) => Promise<unknown>;
}

/**
 * A thread may only produce this many runs in this window before it is assumed
 * to be a loop rather than an enthusiastic human. Deliberately low: nobody
 * legitimately sends six tasks in a minute, and the cost of being wrong is a
 * five-minute pause, while the cost of not tripping is unbounded.
 */
const LOOP_MAX_RUNS = 5;
const LOOP_WINDOW_MS = 60_000;
const LOOP_COOLDOWN_MS = 5 * 60_000;

/**
 * One inbound message, start to finish.
 *
 * Order matters: a confirmation reply must be checked before anything else, or
 * "no" gets routed as a task. Control commands come next so `status` never
 * costs a model call. Everything left is a run.
 */
export class MessagePipeline {
  /** Last project used per thread, so "and fix the test too" lands in the right repo. */
  private stickyProject = new Map<string, string>();
  /** Run submissions per thread, for the loop breaker. */
  private readonly recentRuns = new Map<string, number[]>();
  private readonly trippedUntil = new Map<string, number>();

  constructor(private readonly d: PipelineDeps) {}

  async handle(msg: InboundMessage): Promise<void> {
    const { events, confirms, registry, agents } = this.d;

    events.append({
      runId: null,
      kind: 'message.in',
      source: msg.channel,
      summary: `${msg.sender}: ${truncate(msg.text, 160)}`,
      data: { channel: msg.channel, threadId: msg.threadId, sender: msg.sender, attachments: msg.attachments?.map((a) => a.name) },
    });

    // 1. Is this an answer to a pending confirmation?
    const answered = confirms.handleReply(msg.text, msg.sender);
    if (answered) {
      await this.say(msg.threadId, answered.approved ? `ok — ${answered.confirmation.tool} approved` : `blocked — ${answered.confirmation.tool} denied`);
      return;
    }

    // 2. Control commands.
    const sticky = this.stickyProject.get(msg.threadId);
    const routed = routeMessage(this.d.cfg, msg.text, {
      stickyProject: sticky,
      stickyAgent: agents.threadAgent(msg.threadId, msg.channel)?.name,
    });
    if (routed.command) {
      await this.runCommand(routed.command, msg);
      return;
    }

    // 3. Attachments become inputs the run can read.
    let prompt = routed.prompt;
    if (msg.attachments?.length) {
      const list = msg.attachments.map((a) => `- ${a.path} (${a.mime ?? 'unknown type'}, sent as "${basename(a.name)}")`).join('\n');
      prompt = `${prompt || 'Look at the attached file(s) and tell me what to do with them.'}\n\nFiles the sender attached:\n${list}`;
    }
    if (!prompt.trim()) return;

    if (routed.project) this.stickyProject.set(msg.threadId, routed.project.project.name);

    // Last line of defence. Echo suppression handles the known loop; this
    // catches every loop we have not thought of, including ones created by a
    // channel we do not control.
    if (!this.allowRun(msg.threadId)) return;

    try {
      const run = registry.submit({
        prompt,
        project: routed.project?.project.name,
        agent: routed.agent,
        taskClass: routed.taskClass,
        intent: routed.intent,
        channel: msg.channel,
        threadId: msg.threadId,
        continueSession: routed.continueSession,
      });
      // Tasks get an ack because they take minutes; chat and query just answer.
      if (routed.intent === 'task') {
        const where = routed.project ? ` in ${routed.project.project.name}` : '';
        await this.say(msg.threadId, `on it${where} — ${run.id}`);
      }
    } catch (err) {
      if (err instanceof HaltedError) {
        // The remedy is the whole message. Repeating "couldn't start that"
        // in front of it just delays the sentence that helps.
        await this.say(msg.threadId, err.message);
        return;
      }
      if (err instanceof BudgetExceededError) {
        await this.say(msg.threadId, `can't start: ${err.message}. Raise caps.monthlyBudgetUsd to continue.`);
        return;
      }
      await this.say(msg.threadId, `couldn't start that: ${(err as Error).message}`);
    }
  }

  private async runCommand(cmd: Command, msg: InboundMessage): Promise<void> {
    const { registry, runs, sessions, agents, artifacts, cfg } = this.d;
    switch (cmd.kind) {
      case 'help':
        return void (await this.say(msg.threadId, HELP_TEXT));

      case 'status': {
        const s = registry.status();
        const active = runs.active();
        const lines = active.length
          ? active.map((r) => `${r.id} ${r.status} ${r.project ?? 'scratch'} — ${truncate(r.prompt, 60)}`)
          : ['nothing running'];
        lines.push(`${s.active}/${s.capacity} slots, ${s.queued} queued, $${s.monthSpendUsd.toFixed(2)}/$${s.monthBudgetUsd} this month`);
        return void (await this.say(msg.threadId, lines.join('\n')));
      }

      case 'runs': {
        const list = runs.list({ limit: cmd.limit });
        const lines = list.length
          ? list.map((r) => `${r.id} ${r.status} ${r.project ?? '-'} $${r.costUsd.toFixed(2)} — ${truncate(r.prompt, 50)}`)
          : ['no runs yet'];
        return void (await this.say(msg.threadId, lines.join('\n')));
      }

      case 'kill': {
        const ok = registry.kill(cmd.runId, `killed from ${msg.channel}`);
        return void (await this.say(msg.threadId, ok ? `killing ${cmd.runId}` : `no live run matching "${cmd.runId}"`));
      }

      case 'follow': {
        const ok = registry.followUp(cmd.runId, cmd.text);
        return void (await this.say(msg.threadId, ok ? `passed that to ${cmd.runId}` : `${cmd.runId} isn't accepting input`));
      }

      case 'reset': {
        const n = sessions.clearThread(msg.threadId);
        this.stickyProject.delete(msg.threadId);
        agents.clearThread(msg.threadId);
        return void (await this.say(msg.threadId, `reset — ${n} session${n === 1 ? '' : 's'} forgotten`));
      }

      case 'projects': {
        const lines = listProjects(cfg).map((p) => `${p.name}${p.aliases?.length ? ` (${p.aliases.join(', ')})` : ''} — ${p.exists ? p.path : `MISSING: ${p.path}`}`);
        return void (await this.say(msg.threadId, lines.join('\n') || 'no projects configured'));
      }

      case 'agents': {
        const current = agents.threadAgent(msg.threadId, msg.channel);
        const lines = agents.all().map((a) => `${a.name === current?.name ? '*' : ' '} ${a.name} — ${a.description ?? a.taskClass ?? 'agent'}`);
        return void (await this.say(msg.threadId, lines.join('\n') || 'no agents configured'));
      }

      case 'switchAgent': {
        const ok = agents.setThreadAgent(msg.threadId, cmd.agent);
        return void (await this.say(msg.threadId, ok ? `talking to ${cmd.agent} now` : `no agent called "${cmd.agent}"`));
      }

      case 'cost': {
        const spend = runs.monthSpend();
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const byProject = runs.spendByProject(since).slice(0, 6);
        const lines = [
          `$${spend.toFixed(2)} of $${cfg.caps.monthlyBudgetUsd} this month`,
          ...byProject.map((p) => `  ${p.project}: $${Number(p.costUsd).toFixed(2)} (${p.runs} runs)`),
        ];
        return void (await this.say(msg.threadId, lines.join('\n')));
      }

      case 'diff': {
        const rec = cmd.runId ? runs.resolve(cmd.runId) : runs.list({ limit: 1 })[0];
        if (!rec) return void (await this.say(msg.threadId, 'no run to diff'));
        const patch = artifacts.read(rec.id, 'changes.diff');
        if (!patch) return void (await this.say(msg.threadId, `${rec.id} changed nothing`));
        const stat = summarizePatch(patch);
        return void (await this.say(msg.threadId, `${rec.id} on ${rec.branch ?? '-'}: ${stat}`, [
          artifacts.list(rec.id).find((a) => a.name === 'changes.diff')?.path ?? '',
        ].filter(Boolean)));
      }
    }
  }

  /**
   * Returns false when this thread has tripped the loop breaker. Trips once,
   * says so once, and then stays quiet — a breaker that keeps announcing itself
   * on every message is itself a way to spam someone.
   */
  private allowRun(threadId: string): boolean {
    const now = Date.now();
    const cooling = this.trippedUntil.get(threadId);
    if (cooling && now < cooling) return false;
    if (cooling && now >= cooling) {
      this.trippedUntil.delete(threadId);
      this.recentRuns.delete(threadId);
    }

    const times = (this.recentRuns.get(threadId) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    times.push(now);
    this.recentRuns.set(threadId, times);
    if (times.length <= LOOP_MAX_RUNS) return true;

    this.trippedUntil.set(threadId, now + LOOP_COOLDOWN_MS);
    this.d.events.append({
      runId: null,
      kind: 'system.error',
      source: 'gateway',
      summary: `loop breaker tripped on ${threadId}: ${times.length} runs in under a minute — pausing that thread for 5 minutes`,
      data: { threadId, runsInWindow: times.length, cooldownMs: LOOP_COOLDOWN_MS },
    });
    void this.say(threadId, "That thread just tried to start six runs in a minute, so I've paused it for five minutes. If that wasn't you, something is echoing.");
    return false;
  }

  private async say(threadId: string, text: string, attachments?: string[]): Promise<void> {
    this.d.events.append({
      runId: null,
      kind: 'message.out',
      source: 'gateway',
      summary: truncate(text, 200),
      data: { threadId, text },
    });
    await this.d.reply(threadId, text, attachments);
  }
}

function summarizePatch(patch: string): string {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return formatDiffStat({ filesChanged: files.size, insertions: added, deletions: removed, files: [], patch: '', truncated: false });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
