import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import type { LoadedConfig } from '../config/load.js';
import { findProject, profileFor, expandPath } from '../config/load.js';
import type { AgentConfig, TaskClass } from '../config/schema.js';
import { ClaudeProcess, type ClaudeEvent } from './claude.js';
import { GitWrapper, isRepo, formatDiffStat } from './git.js';
import { executionProfile, effectiveCaps } from './profiles.js';
import { resolveMcpSet, writeMcpConfig, setNameFor } from './mcp.js';
import { installHook, HOOK_PATH } from './hook.js';
import type { EventLog } from '../store/eventlog.js';
import type { RunStore, RunRecord, Intent, Channel } from '../store/runs.js';
import type { SessionStore } from '../store/sessions.js';
import type { ArtifactStore } from '../store/artifacts.js';
import { runId as newRunId } from '../core/ids.js';
import { logger } from '../core/logger.js';

const log = logger('runner');

export interface SubmitRunInput {
  prompt: string;
  project?: string;
  agent?: string;
  taskClass?: TaskClass;
  intent?: Intent;
  channel?: Channel;
  threadId?: string;
  model?: string;
  /** Resume the session bound to (threadId, agent, project). */
  continueSession?: boolean;
  parentRunId?: string;
  /** Pin the run to one skill's capability manifest. */
  skill?: string;
  /** Override the permission profile — how investigation runs become read-only. */
  permissionProfile?: string;
}

export interface ActiveRun {
  record: RunRecord;
  proc: ClaudeProcess;
  startedAt: number;
  caps: ReturnType<typeof effectiveCaps>;
  workdir: string;
  branch?: string;
  base?: string;
  baseSha?: string;
  permissionProfile: string;
  /** The operator had uncommitted work, set aside for the duration of the run. */
  stashed?: boolean;
  /** Set when the model asked a question and we are waiting on a human. */
  questionTimer?: NodeJS.Timeout;
  awaitingAnswerSince?: number;
}

export class BudgetExceededError extends Error {}
export class ProjectBusyError extends Error {}

/**
 * The thing that actually runs work.
 *
 * Responsibilities: short IDs, a queue with a global concurrency cap and a
 * per-project lock (two agents editing the same repo at once is how you get a
 * mess), cap enforcement, git branch-per-run, artifact capture, and turning the
 * claude stream into event-log entries.
 */
export class RunRegistry extends EventEmitter {
  private readonly active = new Map<string, ActiveRun>();
  private readonly queue: string[] = [];
  private readonly projectLocks = new Set<string>();
  /** Per-run permission profile overrides, set at submit time. */
  private readonly profileOverrides = new Map<string, string>();
  private readonly hook: { scriptPath: string; settingsPath: string };
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly events: EventLog,
    private readonly runs: RunStore,
    private readonly sessions: SessionStore,
    private readonly artifacts: ArtifactStore,
    private readonly hookToken: string,
  ) {
    super();
    this.hook = installHook(cfg.resolved.dataDir);
  }

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const id of [...this.active.keys()]) this.kill(id, 'daemon shutting down');
    // Give children a beat to die before the process exits.
    await new Promise((r) => setTimeout(r, 500));
  }

  agentByName(name?: string): AgentConfig | undefined {
    if (!name) return undefined;
    return this.cfg.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  }

  defaultAgentFor(channel: string): AgentConfig | undefined {
    return this.cfg.agents.find((a) => (a.defaultFor ?? []).includes(channel)) ?? this.cfg.agents[0];
  }

  submit(input: SubmitRunInput): RunRecord {
    const spent = this.runs.monthSpend();
    if (spent >= this.cfg.caps.monthlyBudgetUsd) {
      throw new BudgetExceededError(
        `monthly budget exhausted: $${spent.toFixed(2)} of $${this.cfg.caps.monthlyBudgetUsd.toFixed(2)}`,
      );
    }

    const agent = this.agentByName(input.agent) ?? (input.channel ? this.defaultAgentFor(input.channel) : undefined);
    const projectKey = input.project ?? agent?.defaultProject;
    const project = projectKey ? findProject(this.cfg, projectKey) : undefined;
    const taskClass = input.taskClass ?? agent?.taskClass ?? 'coding';
    const exec = executionProfile(taskClass);
    const workdir = project?.path ?? (exec.workdir === 'scratch' ? this.cfg.resolved.scratchDir : this.cfg.resolved.scratchDir);

    const id = newRunId();
    const sessionId =
      input.continueSession && input.threadId
        ? (this.sessions.get({ threadId: input.threadId, agent: agent?.name, project: project?.name }) ?? null)
        : null;

    const record = this.runs.create({
      id,
      prompt: input.prompt,
      project: project?.name ?? null,
      projectPath: workdir,
      agent: agent?.name ?? null,
      taskClass,
      intent: input.intent ?? 'task',
      channel: input.channel ?? null,
      threadId: input.threadId ?? null,
      sessionId,
      parentRunId: input.parentRunId ?? null,
      skill: input.skill ?? null,
    });

    this.events.append({
      runId: id,
      kind: 'run.queued',
      source: 'runner',
      summary: `${id} queued${project ? ` in ${project.name}` : ''}${agent ? ` as ${agent.name}` : ''}: ${truncate(input.prompt, 120)}`,
      data: { project: project?.name, agent: agent?.name, taskClass, intent: record.intent, channel: record.channel },
    });

    if (input.permissionProfile) this.profileOverrides.set(id, input.permissionProfile);

    this.queue.push(id);
    queueMicrotask(() => void this.drain());
    return record;
  }

  private canStart(record: RunRecord): boolean {
    if (this.active.size >= this.cfg.maxConcurrentRuns) return false;
    if (record.project && this.projectLocks.has(record.project)) return false;
    return true;
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < this.queue.length; ) {
      const id = this.queue[i]!;
      const record = this.runs.get(id);
      if (!record || record.status !== 'queued') {
        this.queue.splice(i, 1);
        continue;
      }
      if (!this.canStart(record)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      await this.launch(record).catch((err: unknown) => {
        this.fail(record.id, (err as Error).message);
      });
    }
  }

  private async launch(record: RunRecord): Promise<void> {
    const agent = this.agentByName(record.agent ?? undefined);
    const project = record.project ? findProject(this.cfg, record.project) : undefined;
    const exec = executionProfile(record.taskClass);
    const caps = effectiveCaps(this.cfg, record.taskClass);
    const workdir = record.projectPath ?? this.cfg.resolved.scratchDir;
    mkdirSync(workdir, { recursive: true });

    const permissionProfileName =
      this.profileOverrides.get(record.id) ?? agent?.permissionProfile ?? project?.permissionProfile ?? exec.defaultPermissionProfile;
    const permProfile = profileFor(this.cfg, permissionProfileName);

    if (record.project) this.projectLocks.add(record.project);

    // Branch per run, but only for real repos that opted in.
    let branch: string | undefined;
    let base: string | undefined;
    let baseSha: string | undefined;
    let stashed = false;
    const wantsGit = exec.git && project?.git !== false && isRepo(workdir);
    const git = wantsGit ? new GitWrapper(workdir) : null;
    if (git) {
      try {
        const started = await git.startRun(record.id);
        branch = started.branch;
        base = started.base;
        baseSha = started.baseSha;
        stashed = started.stashed;
        this.runs.update(record.id, { branch });
        this.events.append({
          runId: record.id,
          kind: 'git.branch',
          source: 'runner',
          summary: `${record.id} on branch ${branch} (from ${base})${stashed ? ' — your uncommitted work was stashed and will be restored' : ''}`,
          data: { branch, base, baseSha, stashed },
        });
      } catch (err) {
        this.events.append({
          runId: record.id,
          kind: 'system.error',
          source: 'runner',
          summary: `${record.id} could not create a git branch: ${(err as Error).message}`,
          data: {},
        });
      }
    }

    const runDir = this.artifacts.dirFor(record.id);
    const mcpServers = resolveMcpSet(
      this.cfg,
      setNameFor(this.cfg, { role: 'worker', projectMcpSet: project?.mcpSet, agentMcpSet: agent?.mcpSet }),
    );
    const mcpConfigPath = writeMcpConfig(runDir, mcpServers);

    const systemPrompt = [exec.systemNote, agent?.persona, personaFile(agent)].filter(Boolean).join('\n\n');

    const proc = new ClaudeProcess({
      bin: this.cfg.claudeBin,
      cwd: workdir,
      prompt: record.prompt,
      model: agent?.model,
      resumeSessionId: record.sessionId ?? undefined,
      maxTurns: caps.maxTurns,
      appendSystemPrompt: systemPrompt || undefined,
      allowedTools: agent?.tools ?? (exec.allowedTools.length ? exec.allowedTools : undefined),
      mcpConfigPath,
      settingsPath: this.hook.settingsPath,
      permissionMode: permProfile.permissionMode ?? 'bypassPermissions',
      interactive: true,
      env: {
        SWB_RUN_ID: record.id,
        SWB_HOOK_URL: `http://${this.cfg.gateway.host}:${this.cfg.gateway.port}${HOOK_PATH}`,
        SWB_HOOK_TOKEN: this.hookToken,
        SWB_PROJECT: record.project ?? '',
        SWB_SCRATCH: this.cfg.resolved.scratchDir,
      },
    });

    const activeRun: ActiveRun = {
      record,
      proc,
      startedAt: Date.now(),
      caps,
      workdir,
      branch,
      base,
      baseSha,
      permissionProfile: permissionProfileName,
      stashed,
    };
    this.active.set(record.id, activeRun);

    this.runs.update(record.id, { status: 'running', startedAt: new Date().toISOString() });
    this.events.append({
      runId: record.id,
      kind: 'run.started',
      source: 'runner',
      summary: `${record.id} started${record.project ? ` in ${record.project}` : ''}`,
      data: {
        workdir,
        caps,
        permissionProfile: permissionProfileName,
        mcpServers: Object.keys(mcpServers),
        resumed: Boolean(record.sessionId),
      },
    });

    proc.on('event', (ev: ClaudeEvent) => this.onProcEvent(activeRun, ev, git));
    proc.start();
    // We are not going to send anything else unless a follow-up is injected, but
    // stdin stays open so `followUp()` works while the run is alive.
  }

  private onProcEvent(run: ActiveRun, ev: ClaudeEvent, git: GitWrapper | null): void {
    const id = run.record.id;
    switch (ev.type) {
      case 'raw':
        this.artifacts.append(id, 'transcript.jsonl', ev.line);
        return;
      case 'stderr':
        this.artifacts.append(id, 'stderr.log', ev.line);
        return;
      case 'init':
        if (ev.sessionId) {
          this.runs.update(id, { sessionId: ev.sessionId });
          run.record.sessionId = ev.sessionId;
          if (run.record.threadId) {
            this.sessions.set(
              { threadId: run.record.threadId, agent: run.record.agent ?? undefined, project: run.record.project ?? undefined },
              ev.sessionId,
            );
          }
        }
        this.events.append({
          runId: id,
          kind: 'run.progress',
          source: 'runner',
          summary: `${id} session ${ev.sessionId.slice(0, 8)} on ${ev.model ?? 'default model'}`,
          data: { sessionId: ev.sessionId, model: ev.model, mcp: ev.mcp },
        });
        return;
      case 'text': {
        const isQuestion = looksLikeQuestion(ev.text);
        this.events.append({
          runId: id,
          kind: isQuestion ? 'agent.question' : 'agent.text',
          source: 'runner',
          summary: truncate(ev.text.trim(), 400),
          data: { text: ev.text },
        });
        if (isQuestion) this.armQuestionTimeout(run, ev.text);
        return;
      }
      case 'thinking':
        this.events.append({ runId: id, kind: 'agent.thinking', source: 'runner', summary: truncate(ev.text, 200), data: {} });
        return;
      case 'tool_use':
        this.events.append({
          runId: id,
          kind: 'tool.use',
          source: 'runner',
          summary: `${ev.name}: ${truncate(describeTool(ev.name, ev.input), 200)}`,
          data: { tool: ev.name, input: ev.input, toolUseId: ev.id },
        });
        return;
      case 'tool_result':
        this.events.append({
          runId: id,
          kind: 'tool.result',
          source: 'runner',
          summary: ev.isError ? `tool error: ${truncate(ev.preview, 200)}` : truncate(ev.preview, 200),
          data: { toolUseId: ev.id, isError: ev.isError },
        });
        return;
      case 'usage':
        this.runs.update(id, { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
        this.events.append({
          runId: id,
          kind: 'usage.update',
          source: 'runner',
          summary: `${ev.inputTokens} in / ${ev.outputTokens} out`,
          data: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens },
        });
        return;
      case 'result':
        this.runs.update(id, { costUsd: ev.costUsd, turns: ev.turns, result: ev.text });
        run.record.costUsd = ev.costUsd;
        this.artifacts.write(id, 'result.txt', ev.text ?? '');
        // stdin is still open in interactive mode; close it so the process exits.
        run.proc.finishInput();
        return;
      case 'exit':
        void this.finalize(run, ev.code, git);
        return;
    }
  }

  private async finalize(run: ActiveRun, code: number | null, git: GitWrapper | null): Promise<void> {
    const id = run.record.id;
    if (!this.active.has(id)) return;
    if (run.questionTimer) clearTimeout(run.questionTimer);
    this.active.delete(id);
    this.profileOverrides.delete(id);
    if (run.record.project) this.projectLocks.delete(run.record.project);

    const current = this.runs.get(id);
    const killed = code === 143 || current?.status === 'killed';
    let diffSummary = '';

    if (git && run.baseSha) {
      try {
        const diff = await git.finishRun(run.baseSha);
        diffSummary = formatDiffStat(diff);
        if (diff.filesChanged > 0) {
          this.artifacts.write(id, 'changes.diff', diff.patch);
          await git.commit(`switchboard ${id}: ${truncate(run.record.prompt, 60)}`);
          this.events.append({
            runId: id,
            kind: 'git.diff',
            source: 'runner',
            summary: `${id} changed ${diffSummary}`,
            data: { filesChanged: diff.filesChanged, insertions: diff.insertions, deletions: diff.deletions, files: diff.files },
          });
        }
        if (run.base) {
          const restored = await git.restore(run.base, Boolean(run.stashed));
          if (!restored.restored) {
            this.events.append({
              runId: id,
              kind: 'system.error',
              source: 'runner',
              summary: `${id}: could not restore your stashed work — ${restored.problem}`,
              data: { problem: restored.problem },
            });
          }
        }
      } catch (err) {
        log.warn('git finalize failed', { id, err: (err as Error).message });
      }
    }

    const status = killed ? 'killed' : code === 0 ? 'done' : 'failed';
    const finishedAt = new Date().toISOString();
    this.runs.update(id, {
      status,
      finishedAt,
      exitCode: code,
      error: status === 'failed' ? `claude exited with code ${code}` : null,
    });

    const final = this.runs.get(id)!;
    const durationSec = Math.round((Date.now() - run.startedAt) / 1000);
    this.events.append({
      runId: id,
      kind: status === 'done' ? 'run.finished' : status === 'killed' ? 'run.killed' : 'run.failed',
      source: 'runner',
      summary:
        status === 'done'
          ? `${id} done in ${durationSec}s — ${diffSummary || 'no file changes'} — $${final.costUsd.toFixed(3)}`
          : `${id} ${status} after ${durationSec}s (exit ${code})`,
      data: {
        status,
        exitCode: code,
        durationSec,
        costUsd: final.costUsd,
        turns: final.turns,
        diff: diffSummary,
        branch: run.branch,
        result: final.result,
        project: final.project,
      },
    });

    this.emit('finished', final);
    void this.drain();
  }

  private fail(id: string, message: string): void {
    this.runs.update(id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    this.events.append({ runId: id, kind: 'run.failed', source: 'runner', summary: `${id} failed: ${message}`, data: { error: message } });
    const rec = this.runs.get(id);
    if (rec?.project) this.projectLocks.delete(rec.project);
    this.active.delete(id);
    if (rec) this.emit('finished', rec);
  }

  /**
   * A full-auto run that stops to ask a question has nobody in the room. We
   * relay the question (the event is in CRITICAL_KINDS, so it gets pushed) and
   * give the human the confirm window to answer with `tell <id> …`. Silence
   * aborts — a run parked forever on an unanswered question is worse than a
   * run that stopped and said why.
   */
  private armQuestionTimeout(run: ActiveRun, question: string): void {
    if (run.questionTimer) clearTimeout(run.questionTimer);
    run.awaitingAnswerSince = Date.now();
    run.questionTimer = setTimeout(() => {
      if (!this.active.has(run.record.id)) return;
      this.events.append({
        runId: run.record.id,
        kind: 'run.stuck',
        source: 'runner',
        summary: `${run.record.id} asked "${truncate(question.trim(), 100)}" and got no answer in ${this.cfg.confirmTimeoutSec}s — aborting`,
        data: { question },
      });
      this.kill(run.record.id, 'unanswered question under full auto');
    }, this.cfg.confirmTimeoutSec * 1000);
    run.questionTimer.unref();
  }

  /** Cost, wall-clock and idleness caps, checked out-of-band from the stream. */
  private sweep(): void {
    for (const run of [...this.active.values()]) {
      const id = run.record.id;
      const rec = this.runs.get(id);
      if (!rec) continue;
      const elapsed = Date.now() - run.startedAt;
      if (rec.costUsd > run.caps.maxCostUsd) {
        this.kill(id, `cost cap hit ($${rec.costUsd.toFixed(2)} > $${run.caps.maxCostUsd.toFixed(2)})`);
        continue;
      }
      if (elapsed > run.caps.maxWallMs) {
        this.kill(id, `wall-clock cap hit (${Math.round(elapsed / 1000)}s)`);
        continue;
      }
      const idle = Date.now() - run.proc.lastOutputAt;
      if (idle > run.caps.idleTimeoutMs) {
        this.events.append({
          runId: id,
          kind: 'run.stuck',
          source: 'runner',
          summary: `${id} produced nothing for ${Math.round(idle / 1000)}s — killing`,
          data: { idleMs: idle },
        });
        this.kill(id, `stuck: no output for ${Math.round(idle / 1000)}s`);
      }
    }
    void this.drain();
  }

  kill(idOrPrefix: string, reason = 'killed by operator'): boolean {
    const rec = this.runs.resolve(idOrPrefix);
    if (!rec) return false;
    const run = this.active.get(rec.id);
    if (!run) {
      // Queued but not started — just drop it.
      if (rec.status === 'queued') {
        this.runs.update(rec.id, { status: 'killed', finishedAt: new Date().toISOString(), error: reason });
        this.events.append({ runId: rec.id, kind: 'run.killed', source: 'runner', summary: `${rec.id} cancelled before start — ${reason}`, data: { reason } });
        return true;
      }
      return false;
    }
    this.runs.update(rec.id, { status: 'killed', error: reason });
    this.events.append({ runId: rec.id, kind: 'run.killed', source: 'runner', summary: `${rec.id} killing — ${reason}`, data: { reason, pid: run.proc.pid } });
    run.proc.kill('SIGTERM');
    return true;
  }

  /** Queue a message into a run that is already going. */
  followUp(idOrPrefix: string, text: string): boolean {
    const rec = this.runs.resolve(idOrPrefix);
    if (!rec || rec.status !== 'running') return false;
    const run = this.active.get(rec.id);
    if (!run || !run.proc.running) return false;
    const sent = run.proc.send(text);
    if (sent) {
      // The human answered — stand down the abort timer.
      if (run.questionTimer) clearTimeout(run.questionTimer);
      run.questionTimer = undefined;
      run.awaitingAnswerSince = undefined;
      this.events.append({
        runId: rec.id,
        kind: 'message.in',
        source: 'runner',
        summary: `follow-up injected into ${rec.id}: ${truncate(text, 120)}`,
        data: { text },
      });
    }
    return sent;
  }

  getActive(id: string): ActiveRun | undefined {
    return this.active.get(id);
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  queuedIds(): string[] {
    return [...this.queue];
  }

  status(): { active: number; queued: number; capacity: number; lockedProjects: string[]; monthSpendUsd: number; monthBudgetUsd: number } {
    return {
      active: this.active.size,
      queued: this.queue.length,
      capacity: this.cfg.maxConcurrentRuns,
      lockedProjects: [...this.projectLocks],
      monthSpendUsd: this.runs.monthSpend(),
      monthBudgetUsd: this.cfg.caps.monthlyBudgetUsd,
    };
  }
}

function personaFile(agent?: AgentConfig): string | undefined {
  if (!agent?.personaFile) return undefined;
  try {
    return readFileSync(expandPath(agent.personaFile), 'utf8');
  } catch {
    return undefined;
  }
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Read' || name === 'Write' || name === 'Edit') return String(input.file_path ?? '');
  if (name === 'WebFetch') return String(input.url ?? '');
  return JSON.stringify(input);
}

/** A trailing question mark from the model under full-auto means it wants a human. */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t.endsWith('?')) return false;
  return /\b(should i|do you want|would you like|which|confirm|shall i|is it ok|prefer)\b/i.test(t);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
