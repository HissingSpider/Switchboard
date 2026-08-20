import './core/warnings.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, ConfigError, type LoadedConfig } from './config/load.js';
import { configureLogger, logger } from './core/logger.js';
import { openDb, kvSet, kvGet } from './store/db.js';
import { EventLog } from './store/eventlog.js';
import { RunStore } from './store/runs.js';
import { SessionStore } from './store/sessions.js';
import { ArtifactStore } from './store/artifacts.js';
import { ConfirmService } from './policy/confirm.js';
import { checkPolicyIntegrity } from './policy/policy.js';
import { RunRegistry } from './runner/registry.js';
import { FailureMonitor } from './runner/failures.js';
import { AgentRegistry } from './agents/registry.js';
import { SkillRegistry } from './skills/loader.js';
import { MessagePipeline } from './router/pipeline.js';
import { Gateway } from './gateway/server.js';
import { gatewayToken, hookToken } from './gateway/auth.js';
import { ImessageAdapter } from './adapters/imessage.js';
import { NativeImessageAdapter } from './adapters/imessage-native.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { NotificationService } from './adapters/notify.js';
import { Scheduler } from './scheduler/heartbeat.js';
import { VoiceServer } from './voice/transport.js';
import { DeviceStore } from './gateway/devices.js';
import { PushService } from './gateway/push.js';
import { SkillStore } from './store/skills.js';
import { detectGap, shouldAuthor, authorAndRetry, reconcileManifest } from './skills/authoring.js';
import { considerPromotion } from './skills/trust.js';
import { parseManifest } from './skills/manifest.js';
import { EntityRegistry } from './investigate/entities.js';
import { InvestigationService } from './investigate/loop.js';
import { Vault } from './vault/vault.js';
import { McpBridgeClient, NullDeerDawnClient } from './queue/deerdawn.js';
import { QueueWorker } from './queue/worker.js';
import type { ChannelAdapter } from './adapters/types.js';

const log = logger('switchboard');

export interface Daemon {
  cfg: LoadedConfig;
  stop: () => Promise<void>;
}

export async function boot(cfgOverride?: LoadedConfig): Promise<Daemon> {
  const cfg = cfgOverride ?? loadConfig();
  configureLogger({ level: cfg.logLevel, file: join(cfg.resolved.logsDir, 'switchboard.log') });

  // --- storage ---------------------------------------------------------
  const db = openDb(cfg.resolved.dbPath);
  const events = new EventLog(db);
  const runs = new RunStore(db);
  const sessions = new SessionStore(db);
  const artifacts = new ArtifactStore(cfg.resolved.artifactsDir);
  const confirms = new ConfirmService(db, events, cfg.confirmTimeoutSec);

  // --- integrity -------------------------------------------------------
  const expected = kvGet(db, 'policy.hash');
  const integrity = checkPolicyIntegrity(
    cfg.resolved.configFile,
    [cfg.resolved.scratchDir, ...cfg.projects.map((p) => p.path)],
    expected,
  );
  if (!integrity.ok) {
    // A changed hash is expected after a deliberate edit; a config living inside
    // a worker-writable directory is not, and that one is fatal.
    const fatal = integrity.problems.filter((p) => p.includes('worker-writable') || p.includes('missing'));
    for (const p of integrity.problems) log.warn('policy integrity', { problem: p });
    if (fatal.length) throw new Error(`refusing to start: ${fatal.join('; ')}`);
  }
  kvSet(db, 'policy.hash', integrity.hash);

  // --- crash recovery --------------------------------------------------
  const orphans = runs.reconcileOrphans();
  const expiredConfirms = confirms.expireOrphans();
  if (orphans.length || expiredConfirms) {
    events.append({
      runId: null,
      kind: 'system.start',
      source: 'system',
      summary: `recovered from restart: ${orphans.length} orphaned runs, ${expiredConfirms} confirmations failed closed`,
      data: { orphans },
    });
  }

  // --- retention -------------------------------------------------------
  const prunedEvents = events.prune(cfg.artifactRetentionDays * 2);
  const prunedRuns = artifacts.prune(cfg.artifactRetentionDays);
  sessions.prune(14);
  if (prunedEvents || prunedRuns.length) {
    log.info('retention', { prunedEvents, prunedRunDirs: prunedRuns.length });
  }

  // --- registries ------------------------------------------------------
  const token = gatewayToken(cfg.gateway);
  const hookTok = hookToken();
  const registry = new RunRegistry(cfg, events, runs, sessions, artifacts, hookTok);
  const failures = new FailureMonitor(events, runs, artifacts);
  registry.on('finished', (rec) => failures.inspect(rec));
  // The monitor knows the daemon is broken; the registry is what has to act on
  // it. Wired here rather than imported, so neither has to know about the other.
  registry.haltGate = () => failures.haltReason;
  registry.haltRecheck = () => failures.recheck();
  registry.start();

  const agents = new AgentRegistry(cfg, join(cfg.resolved.dataDir, 'agents'));
  agents.watchForChanges();
  const skills = new SkillRegistry(cfg.resolved.skillsDir);
  const skillStore = new SkillStore(db);
  const devices = new DeviceStore(db);
  const push = new PushService(db, events, cfg.gateway.pushSubject);

  // Every skill on disk gets a row, so manifests and trust are tracked even for
  // the ones a human wrote by hand.
  for (const skill of skills.all()) {
    const existing = skillStore.get(skill.name);
    const manifest = parseManifest(readFileSync(skill.file, 'utf8'));
    if (!existing) skillStore.register({ name: skill.name, manifest, trust: 'restricted' });
    else reconcileManifest(skillStore, cfg.resolved.skillsDir, skill.name, null);
  }

  /**
   * When a run finishes, three things happen that the run itself can't do:
   * its skill's record is updated, a capability gap it hit becomes a new skill,
   * and a skill that has earned it moves up a trust tier.
   */
  registry.on('finished', (rec) => {
    if (rec.skill) {
      skillStore.recordUse(rec.skill, rec.status === 'done', { runId: rec.id, error: rec.error ?? undefined });
      const outcome = considerPromotion(skillStore, rec.skill);
      if (outcome.kind !== 'held') {
        events.append({
          runId: rec.id,
          kind: 'system.start',
          source: 'skills',
          summary:
            outcome.kind === 'promoted'
              ? `"${rec.skill}" promoted to ${outcome.to} — ${outcome.reason}`
              : `"${rec.skill}" is ready for ${outcome.to} — needs your approval (${outcome.reason})`,
          data: { skill: rec.skill, outcome },
        });
      }
    }

    // Only real work is worth writing a tool for; an authoring run that hits a
    // gap must not recurse into authoring another skill.
    if (rec.status !== 'done' || rec.skill || rec.threadId?.startsWith('skill-authoring:')) return;
    const gap = detectGap(rec.result ?? '', rec.prompt);
    if (!gap || !shouldAuthor(gap)) return;
    void authorAndRetry({ cfg, registry, runs, events, skills, store: skillStore }, gap, rec).catch((err: Error) =>
      log.warn('skill authoring failed', { err: err.message }),
    );
  });

  // --- channels --------------------------------------------------------
  const attachmentDir = join(cfg.resolved.dataDir, 'attachments');
  // Native drives Messages.app directly; BlueBubbles is there for anyone who
  // wants typing indicators and reactions and is willing to run the server.
  const useNativeImessage = (cfg.imessage.mode ?? 'native') === 'native';
  const bluebubbles = new ImessageAdapter(cfg.imessage, attachmentDir);
  const nativeImessage = new NativeImessageAdapter(cfg.imessage, {
    pollMs: cfg.imessage.pollMs,
    workDir: join(cfg.resolved.dataDir, 'imessage'),
    // Survives a restart, so a text sent while the daemon was down still lands.
    cursor: {
      read: () => {
        const v = kvGet(db, 'imessage.lastRowId');
        return v ? Number(v) : undefined;
      },
      write: (rowId) => kvSet(db, 'imessage.lastRowId', String(rowId)),
    },
  });
  const imessage = useNativeImessage ? nativeImessage : bluebubbles;
  const telegram = new TelegramAdapter(cfg.telegram, attachmentDir);
  const adapters: ChannelAdapter[] = [imessage, telegram];

  const notifications = new NotificationService(db, events, runs, cfg.notifications);
  for (const a of adapters) notifications.register(a);
  notifications.start();

  const pipeline = new MessagePipeline({
    cfg,
    registry,
    runs,
    sessions,
    events,
    artifacts,
    confirms,
    agents,
    reply: async (threadId, text, attachmentPaths) => {
      // Reply on whichever adapter owns the thread; iMessage guids and Telegram
      // chat ids don't collide, so trying both is safe and keeps this simple.
      for (const a of adapters) {
        if (!a.enabled) continue;
        const ok = await a.send({ threadId, text, attachments: attachmentPaths });
        if (ok) return true;
      }
      return false;
    },
  });
  for (const a of adapters) a.onMessage = (msg) => pipeline.handle(msg);

  // --- investigation, vault and the DeerDawn queue ----------------------
  const entities = new EntityRegistry(cfg.entityMapPath ?? join(cfg.resolved.dataDir, 'entities.json'));
  const vault = new Vault(cfg.vault);
  const investigations = new InvestigationService(db, cfg, registry, runs, events, entities);
  const queueClient = cfg.deerdawn.enabled ? new McpBridgeClient(cfg, cfg.deerdawn.mcpServer) : new NullDeerDawnClient();
  const queue = new QueueWorker(cfg, queueClient, registry, runs, events, artifacts, db);

  registry.on('finished', (rec) => {
    // An investigation step feeding the next one, a fix being held to the check
    // that found the problem, and the narrative note — in that order, because
    // the note wants the verification result in it.
    const inv = investigations.onRunFinished(rec);
    void investigations
      .verifyFix(rec)
      .then((verification) => writeNarrative(rec, verification))
      .then(() => (inv && inv.status !== 'open' ? writeInvestigationNote(inv.id) : undefined))
      .catch((err: Error) => log.debug('post-run bookkeeping failed', { err: err.message }));
    if (inv) log.info('investigation advanced', { id: inv.id, status: inv.status });
  });

  /** One prose note per substantive run, pointed at from the structured record. */
  async function writeNarrative(rec: import('./store/runs.js').RunRecord, verification?: { verified: boolean; detail: string }): Promise<void> {
    if (!vault.enabled || rec.status === 'queued') return;
    // Chat and query runs are conversation, not history worth keeping.
    if (rec.intent !== 'task') return;

    const diff = artifacts.read(rec.id, 'changes.diff');
    const body = [
      `**${rec.status}** · ${rec.project ?? 'scratch'} · $${rec.costUsd.toFixed(3)} · ${rec.turns} turns`,
      rec.branch ? `Branch: \`${rec.branch}\`` : '',
      '',
      '## Asked',
      rec.prompt,
      '',
      '## What happened',
      (rec.result ?? rec.error ?? 'No summary was produced.').trim(),
      verification ? `
## Verification
The originating check ${verification.verified ? 'passes again' : 'still fails'}.

\`\`\`
${verification.detail}
\`\`\`` : '',
      diff ? `
## Diff
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const ref = vault.refForRun(rec.id, rec.prompt);
    const note = await vault.write(ref, `${rec.id}: ${rec.prompt.slice(0, 80)}`, body);
    // The pointer is what makes this note findable later; without it the vault
    // is write-only.
    kvSet(db, `vault.run.${rec.id}`, `vault:${note.ref}`);
    events.append({
      runId: rec.id,
      kind: 'artifact.saved',
      source: 'vault',
      summary: `wrote ${note.ref}`,
      data: { vaultPath: `vault:${note.ref}` },
    });
  }

  /**
   * A finished investigation is the case where prose is worth more than the
   * structured record: the answer only means anything alongside what was ruled
   * out on the way to it.
   */
  async function writeInvestigationNote(id: string): Promise<void> {
    if (!vault.enabled) return;
    const inv = investigations.get(id);
    if (!inv) return;
    const findings = investigations.findings(id);
    const body = [
      `**${inv.status}** · ${inv.project ?? 'no project'}${inv.originCheck ? ` · check: \`${inv.originCheck}\`` : ''}`,
      '',
      '## Question',
      inv.question,
      '',
      '## Answer',
      inv.answer ?? '(none)',
      '',
      '## How it got there',
      findings.length ? findings.map((f) => `- **${f.kind}** — ${f.text}${f.evidence ? `\n  \`${f.evidence.split('\n')[0]}\`` : ''}`).join('\n') : '_no checkpoints recorded_',
    ].join('\n');

    const note = await vault.write(vault.refForInvestigation(id, inv.question), `${id}: ${inv.question.slice(0, 80)}`, body);
    kvSet(db, `vault.investigation.${id}`, `vault:${note.ref}`);
    events.append({
      runId: inv.runId,
      kind: 'artifact.saved',
      source: 'vault',
      summary: `wrote ${note.ref}`,
      data: { vaultPath: `vault:${note.ref}`, investigation: id },
    });
  }

  const scheduler = new Scheduler(cfg, registry, events);

  // Voice shares the run registry, the event log and the thread/session map
  // with the text surfaces — a spoken task and a texted one are the same run.
  const voice = new VoiceServer(cfg, cfg.voice, {
    cfg,
    registry,
    runs,
    sessions,
    events,
    confirms,
    agents,
    // A gated action can never be approved by voice, so it is pushed to
    // whichever text channel is live instead.
    escalate: async (text) => {
      for (const a of adapters) {
        if (!a.enabled) continue;
        const target = notifications.defaultTarget();
        if (!target || target.channel !== a.name) continue;
        if (await a.send({ threadId: target.threadId, text })) return a.name;
      }
      return undefined;
    },
  });

  // --- gateway ---------------------------------------------------------
  const gateway = new Gateway({
    cfg,
    events,
    runs,
    sessions,
    artifacts,
    registry,
    confirms,
    agents,
    skills,
    pipeline,
    // The webhook route only means anything for the BlueBubbles path.
    imessage: useNativeImessage ? undefined : bluebubbles,
    imessageNative: useNativeImessage ? nativeImessage : undefined,
    scheduler,
    voice,
    devices,
    push,
    skillStore,
    investigations,
    entities,
    vault,
    queue,
    token,
    hookToken: hookTok,
  });

  await gateway.start();
  for (const a of adapters) await a.start();
  scheduler.start();
  await queue.reconcile().then((n) => n && log.info('released orphaned queue cards', { n }));
  queue.start();
  // Deliberately not awaited: warming the model and the STT weights takes a
  // few seconds and nothing else needs to wait for it.
  void voice.prewarm();
  // Same bargain as voice: pay the CLI cold start once, at boot, rather than on
  // the first message. Not awaited — a failed warm-up only means chat spawns
  // per message, which is what it did before.
  void registry.chat.prewarm();

  events.append({
    runId: null,
    kind: 'system.start',
    source: 'system',
    summary: `Switchboard up on http://${cfg.gateway.host}:${cfg.gateway.port} — ${cfg.projects.length} projects, ${agents.all().length} agents, ${skills.all().length} skills, voice ${cfg.voice.enabled ? 'on' : 'off'}`,
    data: { projects: cfg.projects.map((p) => p.name), imessage: cfg.imessage.enabled, telegram: cfg.telegram.enabled },
  });
  log.info('ready', { url: `http://${cfg.gateway.host}:${cfg.gateway.port}`, token: token.slice(0, 6) + '…' });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    events.append({ runId: null, kind: 'system.stop', source: 'system', summary: 'Switchboard shutting down', data: {} });
    scheduler.stop();
    queue.stop();
    await voice.stop();
    notifications.stop();
    agents.stopWatching();
    for (const a of adapters) await a.stop();
    await registry.stop();
    await gateway.stop();
    db.close();
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void stop().then(() => process.exit(0));
    });
  }
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err: err.message, stack: err.stack });
    events.append({ runId: null, kind: 'system.error', source: 'system', summary: `uncaught: ${err.message}`, data: { stack: err.stack } });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });

  return { cfg, stop };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  boot().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`failed to start: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
