#!/usr/bin/env node
import './core/warnings.js';
import { existsSync, writeFileSync, mkdirSync, readdirSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, writeExampleConfig, configPath, ConfigError, type LoadedConfig } from './config/load.js';
import { runDoctor, formatChecks, doctorExitCode } from './doctor/doctor.js';
import { gatewayToken, newToken } from './gateway/auth.js';
import { setSecret, getSecret, deleteSecret, listSecrets, keychainRef } from './secrets/keychain.js';
import { SkillRegistry } from './skills/loader.js';
import { scaffoldSkill, testSkill } from './skills/scaffold.js';
import { installService, uninstallService, serviceStatus, restartService, renderPlist, plistPath } from './service/launchd.js';
import { isolationStatus, setupScript, sudoersSnippet } from './service/isolation.js';
import { backup, restore, planRestore, pruneBackups } from './backup/backup.js';
import { checkPermissions, PERMISSION_HELP, listDisplays } from './computer/gui.js';
import { HeadedSessionManager, SCREEN_SHARING_HELP } from './computer/session.js';
import { describeCron } from './scheduler/cron.js';
import { WorkspaceMemory } from './memory/workspace.js';
import { WhisperCppStt, WHISPER_INSTALL_HELP } from './voice/stt.js';
import { pickTts, MacSayTts, TTS_INSTALL_HELP } from './voice/tts.js';
import { WAKE_WORD_HELP } from './voice/wakeword.js';
import { pcmToWav } from './voice/types.js';
import { checkReachability, formatReachability, serveCommand } from './net/reachability.js';
import { EntityRegistry } from './investigate/entities.js';
import { Vault } from './vault/vault.js';
import { NativeImessageAdapter, FULL_DISK_ACCESS_HELP } from './adapters/imessage-native.js';
import { boot } from './index.js';

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const die = (s: string, code = 1): never => {
  process.stderr.write(`${s}\n`);
  process.exit(code);
};

function cfgOrDie(): LoadedConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) return die(`${err.message}\n\nRun \`swb init\` to write a starter config.`, 2);
    throw err;
  }
}

async function api(cfg: LoadedConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `http://${cfg.gateway.host}:${cfg.gateway.port}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayToken(cfg.gateway)}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => die(`gateway not reachable at ${url} (${err.message}) — is the daemon running? \`swb start\``));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const HELP = `swb — Switchboard

  init                        write a starter config
  doctor                      preflight every dependency
  start                       run the daemon in the foreground
  status                      what is running right now
  run <text>                  submit a run (--project, --agent, --class)
  runs [n]                    recent runs (--project, --status, --search)
  show <id>                   one run in detail
  kill <id>                   stop a run
  tell <id> <text>            inject a follow-up into a live run
  diff <id>                   the diff a run produced
  cost                        spend this month, by project

  agent list|reload|new <name>
  skill list|new <name> <description>|test <name> [phrases…]
  memory list|show <scope>|add <scope> <text>|forget <scope>
  schedule list

  secret set <name>|get <name>|list|rm <name>
  token show|rotate

  service install|uninstall|status|restart|plist
  isolation status|script|sudoers
  computer perms|displays|watch
  voice status|say <text>|voices|latency|install
  device list|pair|revoke <id>
  push key|list|test
  reach                       how a phone can actually reach this
  skills review|trust <name>|retire <name>|restore <name>
  investigate <question>       read-only diagnosis (--project, --check)
  investigations [n]           recent investigations
  fix <id>                     turn an answered investigation into a fix
  health [project]             run a project's check sequence
  entities list|seed|gaps      the spoken-concept map
  vault status|notes|read <ref>
  queue status|poll
  imessage status|chats|allow <handle>
  backup [dir] [--artifacts]  |  restore <archive>
`;

async function main(): Promise<void> {
  const [, , cmd = 'help', ...rest] = process.argv;
  const flags = parseFlags(rest);
  const args = flags._;

  switch (cmd) {
    // ---------------------------------------------------------------- setup
    case 'init': {
      const path = configPath();
      if (existsSync(path) && !flags.force) return void out(`${path} already exists (use --force to overwrite)`);
      writeExampleConfig(path);
      const cfg = loadConfig(path);
      mkdirSync(join(cfg.resolved.dataDir, 'agents'), { recursive: true });
      writeFileSync(
        join(cfg.resolved.dataDir, 'agents', 'dev.md'),
        `---\nname: dev\ndescription: writes code in real repos\ntaskClass: coding\npermissionProfile: coding\ndefaultFor: [imessage, dashboard]\n---\nYou are terse. Never push. End with the files you changed.\n`,
      );
      // Seed the skills directory from the starter skills that ship with the repo.
      const bundled = fileURLToPath(new URL('../skills', import.meta.url));
      let seeded = 0;
      if (existsSync(bundled)) {
        for (const name of readdirSync(bundled)) {
          const target = join(cfg.resolved.skillsDir, name);
          if (existsSync(target)) continue;
          cpSync(join(bundled, name), target, { recursive: true });
          seeded++;
        }
      }
      return void out(
        [`wrote ${path}`, `data dir ${cfg.resolved.dataDir}`, seeded ? `seeded ${seeded} starter skill(s)` : '', '', 'next: edit the config, then `swb doctor`']
          .filter(Boolean)
          .join('\n'),
      );
    }

    case 'doctor': {
      const checks = await runDoctor(cfgOrDie());
      out(formatChecks(checks));
      process.exit(doctorExitCode(checks));
      return;
    }

    case 'start': {
      await boot();
      return; // boot installs signal handlers and keeps the process alive
    }

    // ----------------------------------------------------------------- runs
    case 'status': {
      const cfg = cfgOrDie();
      const s = (await api(cfg, '/api/status')) as Record<string, unknown>;
      const { runs } = (await api(cfg, '/api/runs?limit=8')) as { runs: Array<Record<string, unknown>> };
      out(`${s.active}/${s.capacity} running, ${s.queued} queued — $${Number(s.monthSpendUsd).toFixed(2)}/$${s.monthBudgetUsd} this month`);
      if (s.pendingConfirmations) out(`${s.pendingConfirmations} confirmation(s) waiting on you`);
      for (const r of runs) out(`  ${r.id} ${String(r.status).padEnd(7)} ${String(r.project ?? '-').padEnd(12)} ${String(r.prompt).slice(0, 60)}`);
      return;
    }

    case 'run': {
      const cfg = cfgOrDie();
      const prompt = args.join(' ');
      if (!prompt) return void die('nothing to run');
      const body = (await api(cfg, '/api/runs', {
        method: 'POST',
        body: JSON.stringify({ prompt, project: flags.project, agent: flags.agent, taskClass: flags.class, threadId: 'cli' }),
      })) as { run: { id: string } };
      return void out(body.run.id);
    }

    case 'runs': {
      const cfg = cfgOrDie();
      const params = new URLSearchParams({ limit: String(args[0] ?? flags.limit ?? 20) });
      if (flags.project) params.set('project', String(flags.project));
      if (flags.status) params.set('status', String(flags.status));
      if (flags.search) params.set('q', String(flags.search));
      const { runs } = (await api(cfg, `/api/runs?${params}`)) as { runs: Array<Record<string, unknown>> };
      for (const r of runs) {
        out(
          `${r.id} ${String(r.status).padEnd(7)} ${String(r.createdAt).slice(0, 16).replace('T', ' ')} ${String(r.project ?? '-').padEnd(10)} $${Number(r.costUsd).toFixed(3).padStart(7)} ${String(r.prompt).slice(0, 50)}`,
        );
      }
      return;
    }

    case 'show': {
      const cfg = cfgOrDie();
      if (!args[0]) return void die('usage: swb show <run-id>');
      const body = (await api(cfg, `/api/runs/${args[0]}`)) as { run: Record<string, unknown>; artifacts: Array<{ name: string; bytes: number }> };
      out(JSON.stringify(body.run, null, 2));
      out(`artifacts: ${body.artifacts.map((a) => `${a.name} (${a.bytes}b)`).join(', ') || 'none'}`);
      return;
    }

    case 'kill': {
      const cfg = cfgOrDie();
      if (!args[0]) return void die('usage: swb kill <run-id>');
      const body = (await api(cfg, `/api/runs/${args[0]}`, { method: 'DELETE' })) as { killed: boolean };
      return void out(body.killed ? 'killed' : 'no live run matched');
    }

    case 'tell': {
      const cfg = cfgOrDie();
      const [id, ...text] = args;
      if (!id || !text.length) return void die('usage: swb tell <run-id> <text>');
      const body = (await api(cfg, `/api/runs/${id}/followup`, { method: 'POST', body: JSON.stringify({ text: text.join(' ') }) })) as {
        delivered: boolean;
      };
      return void out(body.delivered ? 'delivered' : 'run is not accepting input');
    }

    case 'diff': {
      const cfg = cfgOrDie();
      if (!args[0]) return void die('usage: swb diff <run-id>');
      const res = await fetch(`http://${cfg.gateway.host}:${cfg.gateway.port}/api/runs/${args[0]}/diff`, {
        headers: { authorization: `Bearer ${gatewayToken(cfg.gateway)}` },
      });
      return void out((await res.text()) || 'no diff');
    }

    case 'cost': {
      const cfg = cfgOrDie();
      const body = (await api(cfg, '/api/cost')) as { monthSpendUsd: number; monthBudgetUsd: number; byProject: Array<{ project: string; costUsd: number; runs: number }> };
      out(`$${body.monthSpendUsd.toFixed(2)} of $${body.monthBudgetUsd} this month`);
      for (const p of body.byProject) out(`  ${p.project.padEnd(16)} $${Number(p.costUsd).toFixed(2)} (${p.runs} runs)`);
      return;
    }

    // --------------------------------------------------------------- agents
    case 'agent': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'list';
      const dir = join(cfg.resolved.dataDir, 'agents');
      if (sub === 'new') {
        const name = args[1];
        if (!name) return void die('usage: swb agent new <name>');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${name}.md`);
        if (existsSync(file)) return void die(`${file} already exists`);
        writeFileSync(
          file,
          `---\nname: ${name}\ndescription: \nmodel: \ntaskClass: coding\npermissionProfile: coding\nmemoryProject: \ndefaultProject: \ndefaultFor: []\n---\nDescribe how this agent should behave. This body becomes the persona.\n`,
        );
        return void out(`wrote ${file} — edit it, then \`swb agent reload\``);
      }
      if (sub === 'reload') {
        const body = (await api(cfg, '/api/agents/reload', { method: 'POST' })) as { count: number; problems: string[] };
        out(`${body.count} agents`);
        for (const p of body.problems) out(`  ! ${p}`);
        return;
      }
      const body = (await api(cfg, '/api/agents')) as { agents: Array<Record<string, unknown>>; problems: string[] };
      for (const a of body.agents) out(`${String(a.name).padEnd(14)} ${a.taskClass ?? 'coding'}  ${a.description ?? ''}`);
      for (const p of body.problems) out(`  ! ${p}`);
      return;
    }

    // --------------------------------------------------------------- skills
    case 'skill': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'list';
      const registry = new SkillRegistry(cfg.resolved.skillsDir);
      if (sub === 'new') {
        const [, name, ...desc] = args;
        if (!name || !desc.length) return void die('usage: swb skill new <name> <description…>');
        const r = scaffoldSkill(cfg.resolved.skillsDir, name, desc.join(' '));
        return void out(`created ${r.dir}\n  ${r.files.join('\n  ')}`);
      }
      if (sub === 'test') {
        const [, name, ...phrases] = args;
        if (!name) return void die('usage: swb skill test <name> [phrases…]');
        const r = testSkill(cfg.resolved.skillsDir, name, phrases);
        out(`${r.ok ? 'ok' : 'problems'}: ${name}`);
        for (const p of r.problems) out(`  ! ${p}`);
        for (const s of r.selectedBy) out(`  ✓ selected by "${s}"`);
        return void (r.ok ? undefined : process.exit(1));
      }
      const all = registry.all();
      if (!all.length) return void out(`no skills in ${cfg.resolved.skillsDir} — \`swb skill new <name> <description>\``);
      for (const s of all) out(`${s.name.padEnd(20)} ${s.description.slice(0, 70)}`);
      for (const v of registry.validate()) out(`  ! ${v.skill}: ${v.problems.join(', ')}`);
      return;
    }

    // --------------------------------------------------------------- memory
    case 'memory': {
      const cfg = cfgOrDie();
      const mem = new WorkspaceMemory(join(cfg.resolved.dataDir, 'memory'));
      const sub = args[0] ?? 'list';
      if (sub === 'add') {
        const [, scope, ...text] = args;
        if (!scope || !text.length) return void die('usage: swb memory add <scope> <text…>');
        const e = mem.append(scope, text.join(' '));
        return void out(`${e.id} → ${scope}`);
      }
      if (sub === 'show') {
        if (!args[1]) return void die('usage: swb memory show <scope>');
        return void out(mem.read(args[1]) || '(empty)');
      }
      if (sub === 'forget') {
        if (!args[1]) return void die('usage: swb memory forget <scope>');
        return void out(mem.forget(args[1]) ? 'forgotten' : 'no such scope');
      }
      return void out(mem.scopes().join('\n') || '(no scopes yet)');
    }

    case 'schedule': {
      const cfg = cfgOrDie();
      for (const j of cfg.heartbeats) out(`${j.name.padEnd(20)} ${j.cron.padEnd(16)} ${describeCron(j.cron)}`);
      for (const t of cfg.triggers) out(`${t.name.padEnd(20)} ${t.kind.padEnd(16)} ${t.target}`);
      return;
    }

    // -------------------------------------------------------------- secrets
    case 'secret': {
      const sub = args[0];
      if (sub === 'set') {
        const [, name, ...value] = args;
        if (!name) return void die('usage: swb secret set <name> [value]  (omit value to read stdin)');
        const v = value.length ? value.join(' ') : (await readStdin()).trim();
        if (!v) return void die('no value given');
        setSecret(name, v);
        return void out(`stored. reference it as "${keychainRef(name)}"`);
      }
      if (sub === 'get') {
        if (!args[1]) return void die('usage: swb secret get <name>');
        const v = getSecret(args[1]);
        return void (v ? out(v) : die('not found'));
      }
      if (sub === 'rm') {
        if (!args[1]) return void die('usage: swb secret rm <name>');
        return void out(deleteSecret(args[1]) ? 'deleted' : 'not found');
      }
      const names = await listSecrets();
      return void out(names.join('\n') || '(none)');
    }

    case 'token': {
      const cfg = cfgOrDie();
      if (args[0] === 'rotate') return void out(newToken());
      return void out(gatewayToken(cfg.gateway));
    }

    // -------------------------------------------------------------- service
    case 'service': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'status';
      const entry = fileURLToPath(new URL('./index.js', import.meta.url));
      if (sub === 'install') {
        const path = await installService({ entry, dataDir: cfg.resolved.dataDir, configPath: cfg.resolved.configFile, caffeinate: flags.caffeinate !== false });
        return void out(`installed ${path}\nlogs: ${join(cfg.resolved.logsDir, 'daemon.out.log')}`);
      }
      if (sub === 'uninstall') return void out((await uninstallService()) ? 'uninstalled' : 'was not installed');
      if (sub === 'restart') {
        await restartService();
        return void out('restarted');
      }
      if (sub === 'plist') return void out(renderPlist({ entry, dataDir: cfg.resolved.dataDir, configPath: cfg.resolved.configFile }));
      const s = await serviceStatus();
      return void out(`plist: ${plistPath()}\ninstalled: ${s.installed}\nrunning: ${s.running}${s.pid ? ` (pid ${s.pid})` : ''}${s.lastExit ? ` last exit ${s.lastExit}` : ''}`);
    }

    case 'isolation': {
      const sub = args[0] ?? 'status';
      if (sub === 'script') return void out(setupScript());
      if (sub === 'sudoers') return void out(sudoersSnippet());
      const s = await isolationStatus();
      out(`worker user exists: ${s.userExists}${s.homeDir ? ` (${s.homeDir})` : ''}`);
      out(`admin: ${s.isAdmin}`);
      for (const p of s.problems) out(`  ! ${p}`);
      if (!s.userExists) out('\nrun `swb isolation script > setup.sh` and read it before `sudo bash setup.sh`');
      return;
    }

    // ------------------------------------------------------------- computer
    case 'computer': {
      const sub = args[0] ?? 'perms';
      if (sub === 'displays') {
        for (const d of await listDisplays()) out(`display ${d.index}: ${d.width}x${d.height}`);
        return;
      }
      if (sub === 'watch') {
        const mgr = new HeadedSessionManager();
        const url = await mgr.watchUrl();
        return void out(url ? `open ${url}` : SCREEN_SHARING_HELP);
      }
      const p = await checkPermissions();
      out(`screen recording: ${p.screenRecording ? 'ok' : 'MISSING'}`);
      out(`accessibility:    ${p.accessibility ? 'ok' : 'MISSING'}`);
      for (const d of p.detail) out(`  ${d}`);
      if (!p.screenRecording || !p.accessibility) out(`\n${PERMISSION_HELP}`);
      return;
    }

    // ---------------------------------------------------------------- voice
    case 'voice': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'status';

      if (sub === 'voices') return void out(MacSayTts.voices().join('\n') || '(none)');

      if (sub === 'install') {
        return void out([WHISPER_INSTALL_HELP, '', TTS_INSTALL_HELP, '', WAKE_WORD_HELP].join('\n'));
      }

      if (sub === 'say') {
        const text = args.slice(1).join(' ');
        if (!text) return void die('usage: swb voice say <text>');
        // Synthesise and play locally — the quickest way to hear the voice.
        const tts = pickTts({ engine: cfg.voice.ttsEngine, voice: cfg.voice.ttsVoice, piperModel: cfg.voice.piperModel });
        if (!tts.available) return void die(`${tts.name} is not available`);
        const pcm = await tts.synthesize(text);
        const wavPath = join(cfg.resolved.dataDir, 'voice-preview.wav');
        mkdirSync(cfg.resolved.dataDir, { recursive: true });
        writeFileSync(wavPath, pcmToWav(pcm));
        await new Promise<void>((resolve) => {
          const child = spawn('afplay', [wavPath], { stdio: 'ignore' });
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        });
        return void out(`${tts.name}: ${wavPath}`);
      }

      if (sub === 'latency') {
        const body = (await api(cfg, '/api/voice')) as { latency: Array<{ lane: string; count: number; p50: number; p95: number }> };
        if (!body.latency.length) return void out('no turns recorded yet');
        for (const row of body.latency) out(`${row.lane.padEnd(9)} n=${String(row.count).padStart(4)}  p50 ${row.p50}ms  p95 ${row.p95}ms`);
        return;
      }

      const stt = new WhisperCppStt({ binary: cfg.voice.whisperBinary, model: cfg.voice.whisperModel });
      const tts = pickTts({ engine: cfg.voice.ttsEngine, voice: cfg.voice.ttsVoice, piperModel: cfg.voice.piperModel });
      out(`enabled:  ${cfg.voice.enabled}`);
      out(`stt:      ${stt.available ? stt.detail : `UNAVAILABLE — ${stt.detail}`}`);
      out(`tts:      ${tts.name}${tts.available ? '' : ' UNAVAILABLE'}`);
      out(`mic mode: ${cfg.voice.openMic ? 'open mic' : 'push to talk'}`);
      out(`wake:     ${cfg.voice.wakeWord ?? 'off (push to talk)'}`);
      out(`client:   http://${cfg.gateway.host}:${cfg.gateway.port}/voice.html`);
      if (!stt.available) out(`\n${WHISPER_INSTALL_HELP}`);
      return;
    }

    // ---------------------------------------------------------- investigate
    case 'investigate': {
      const cfg = cfgOrDie();
      const question = args.join(' ');
      if (!question) return void die('usage: swb investigate <question>');
      const body = (await api(cfg, '/api/investigations', {
        method: 'POST',
        body: JSON.stringify({ question, project: flags.project, originCheck: flags.check }),
      })) as { investigation: { id: string } };
      return void out(`${body.investigation.id} — read-only, the answer comes back when it has one`);
    }

    case 'investigations': {
      const cfg = cfgOrDie();
      const body = (await api(cfg, `/api/investigations?limit=${args[0] ?? 15}`)) as {
        investigations: Array<{ id: string; status: string; question: string; answer: string | null; project: string | null }>;
      };
      for (const i of body.investigations) {
        out(`${i.id} ${i.status.padEnd(9)} ${String(i.project ?? '-').padEnd(10)} ${i.question.slice(0, 60)}`);
        if (i.answer) out(`         ${i.answer.split('\n')[0]?.slice(0, 90)}`);
      }
      return;
    }

    case 'fix': {
      const cfg = cfgOrDie();
      if (!args[0]) return void die('usage: swb fix <investigation-id>');
      const body = (await api(cfg, `/api/investigations/${args[0]}/fix`, { method: 'POST' })) as { run?: { id: string } };
      return void out(body.run ? `${body.run.id} — it must re-run the originating check before reporting success` : 'not an answered investigation');
    }

    case 'health': {
      const cfg = cfgOrDie();
      const project = args[0];
      if (!project) {
        for (const h of cfg.health) out(`${h.project.padEnd(14)} ${h.checks?.length ?? 0} checks  ${h.deployTarget ?? ''}`);
        if (!cfg.health.length) out('no health manifests configured — add them under "health" in config.json');
        return;
      }
      const body = (await api(cfg, `/api/health/${project}`, { method: 'POST' })) as { text: string };
      return void out(body.text);
    }

    case 'entities': {
      const cfg = cfgOrDie();
      const registry = new EntityRegistry(cfg.entityMapPath ?? join(cfg.resolved.dataDir, 'entities.json'));
      const sub = args[0] ?? 'list';
      if (sub === 'seed') return void out(`wrote ${registry.seed()} — edit it, then \`swb entities gaps\``);
      if (sub === 'gaps') {
        const gaps = registry.gaps();
        if (!gaps.length) return void out(`${registry.all().length} entities, none missing anything`);
        for (const g of gaps) out(`${g.name.padEnd(24)} missing: ${g.missing.join(', ')}`);
        return;
      }
      for (const e of registry.all()) out(`${e.name.padEnd(24)} ${e.aliases.slice(0, 3).join(', ')}`);
      if (!registry.all().length) out(`no entity map at ${registry.path} — \`swb entities seed\``);
      return;
    }

    case 'vault': {
      const cfg = cfgOrDie();
      const vault = new Vault(cfg.vault);
      const sub = args[0] ?? 'status';
      if (sub === 'notes') return void out(vault.ours().join('\n') || '(none yet)');
      if (sub === 'read') {
        if (!args[1]) return void die('usage: swb vault read <ref>');
        const note = vault.read(args[1]);
        return void (note ? out(note.body) : die('no such note'));
      }
      out(`enabled: ${vault.enabled}`);
      if (vault.root) out(`root:    ${vault.root}`);
      if (vault.writeRoot) out(`writes:  ${vault.writeRoot} (and nowhere else)`);
      out(`notes:   ${vault.ours().length}`);
      for (const p2 of vault.problems) out(`  ! ${p2}`);
      return;
    }

    case 'queue': {
      const cfg = cfgOrDie();
      if (args[0] === 'poll') {
        const body = (await api(cfg, '/api/queue/poll', { method: 'POST' })) as { claimed: number; skipped: string[] };
        out(`claimed ${body.claimed}`);
        for (const s2 of body.skipped) out(`  skipped: ${s2}`);
        return;
      }
      const body = (await api(cfg, '/api/queue')) as { enabled: boolean; project?: string; inFlight: Array<{ card: { title: string }; runId: string }> };
      out(`enabled: ${body.enabled}${body.project ? ` · queue project ${body.project}` : ''}`);
      for (const c of body.inFlight) out(`  ${c.runId} ${c.card.title}`);
      if (!body.inFlight.length) out('  nothing claimed');
      return;
    }

    // ------------------------------------------------------------- imessage
    case 'imessage': {
      const cfg = cfgOrDie();
      const adapter = new NativeImessageAdapter(cfg.imessage, { workDir: join(cfg.resolved.dataDir, 'imessage') });
      const sub = args[0] ?? 'status';

      if (sub === 'chats') {
        const chats = adapter.recentChats(15);
        if (!chats.length) return void out(adapter.problem ?? 'no conversations found');
        for (const c of chats) out(`${c.identifier.padEnd(24)} ${c.guid}`);
        await adapter.stop();
        return;
      }

      if (sub === 'allow') {
        const handle = args[1];
        if (!handle) return void die('usage: swb imessage allow <phone-or-email>');
        const path = cfg.resolved.configFile;
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { imessage: { allowlist: string[]; enabled: boolean; mode?: string } };
        if (!raw.imessage.allowlist.includes(handle)) raw.imessage.allowlist.push(handle);
        raw.imessage.enabled = true;
        raw.imessage.mode = raw.imessage.mode ?? 'native';
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
        return void out(`allowlisted ${handle} — restart the daemon for it to take effect`);
      }

      // Ask the daemon, not ourselves: a CLI launched from a shell is
      // attributed by macOS to the shell's app, so it reports no Full Disk
      // Access even when the launchd-spawned daemon has it.
      const live = (await api(cfg, '/api/imessage').catch(() => undefined)) as
        | { enabled: boolean; mode: string; allowlist: string[]; receiving: boolean; problem?: string; recentChats: Array<{ identifier: string; guid: string }> }
        | undefined;
      await adapter.stop();

      if (!live) {
        out('daemon not reachable — showing config only');
        out(`enabled:   ${cfg.imessage.enabled}`);
        out(`allowlist: ${cfg.imessage.allowlist.join(', ') || '(empty)'}`);
        return;
      }
      out(`enabled:   ${live.enabled}`);
      out(`mode:      ${live.mode}`);
      out(`allowlist: ${live.allowlist.join(', ') || '(empty — nobody can reach it)'}`);
      out(`receiving: ${live.receiving ? 'yes — watching for new messages' : `no — ${live.problem}`}`);
      if (live.recentChats.length) {
        out('\nrecent conversations:');
        for (const c of live.recentChats.slice(0, 5)) out(`  ${c.identifier.padEnd(26)} ${c.guid}`);
      }
      if (!live.receiving) out(`\n${FULL_DISK_ACCESS_HELP}`);
      return;
    }

    // --------------------------------------------------------------- device
    case 'device': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'list';
      if (sub === 'pair') {
        const body = (await api(cfg, '/api/devices/pair', { method: 'POST' })) as { code: string; expiresAt: string };
        return void out(
          [`pairing code: ${body.code}`, `expires ${new Date(body.expiresAt).toLocaleTimeString()}`, '', `open http://<this-machine>:${cfg.gateway.port}/pair.html on the new device`].join('\n'),
        );
      }
      if (sub === 'revoke') {
        if (!args[1]) return void die('usage: swb device revoke <id>');
        const body = (await api(cfg, `/api/devices/${args[1]}`, { method: 'DELETE' })) as { revoked: boolean };
        return void out(body.revoked ? 'revoked' : 'no such active device');
      }
      const body = (await api(cfg, '/api/devices')) as { devices: Array<Record<string, unknown>> };
      for (const d of body.devices) {
        out(`${String(d.id).padEnd(9)} ${String(d.name).padEnd(18)} ${d.revokedAt ? 'revoked' : `seen ${d.lastSeenAt ?? 'never'}`}`);
      }
      return;
    }

    // ----------------------------------------------------------------- push
    case 'push': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'list';
      if (sub === 'key') return void out(((await api(cfg, '/api/push/key')) as { publicKey: string }).publicKey);
      if (sub === 'test') {
        const r = (await api(cfg, '/api/push/test', { method: 'POST' })) as { sent: number; failed: number };
        return void out(`sent to ${r.sent} device(s), ${r.failed} failed`);
      }
      const body = (await api(cfg, '/api/push')) as { subscriptions: Array<Record<string, unknown>> };
      if (!body.subscriptions.length) return void out('no push subscriptions — enable notifications from the dashboard Setup tab');
      for (const s2 of body.subscriptions) out(`${String(s2.id).padEnd(9)} ${String(s2.host).padEnd(28)} ${s2.lastOkAt ?? 'never delivered'}`);
      return;
    }

    case 'reach': {
      const cfg = cfgOrDie();
      const report = await checkReachability(cfg.gateway);
      out(formatReachability(report));
      if (report.problems.length) out(`\nto expose it to the tailnet only:\n  ${serveCommand(cfg.gateway.port)}`);
      return;
    }

    // --------------------------------------------------------------- skills
    case 'skills': {
      const cfg = cfgOrDie();
      const sub = args[0] ?? 'review';
      if (sub === 'trust' || sub === 'retire' || sub === 'restore') {
        const name = args[1];
        if (!name) return void die(`usage: swb skills ${sub} <name>`);
        const path = sub === 'trust' ? `/api/skills/${name}/trust` : `/api/skills/${name}/${sub}`;
        await api(cfg, path, { method: 'POST', body: JSON.stringify(sub === 'trust' ? { trust: 'trusted' } : {}) });
        return void out(`${name}: ${sub === 'trust' ? 'granted trusted' : sub === 'retire' ? 'retired' : 'restored'}`);
      }
      const body = (await api(cfg, '/api/skills/review')) as {
        queue: Array<{ name: string; trust: string; runs: number; successes: number; flagged: boolean; flagReason?: string; proposal?: string }>;
      };
      if (!body.queue.length) return void out('nothing needs review');
      for (const s2 of body.queue) {
        out(`${s2.name.padEnd(22)} ${s2.trust.padEnd(11)} ${s2.successes}/${s2.runs}${s2.flagged ? `  FLAGGED: ${s2.flagReason}` : ''}`);
        if (s2.proposal) out(`  → ready for trusted: swb skills trust ${s2.name}`);
      }
      return;
    }

    // --------------------------------------------------------------- backup
    case 'backup': {
      const cfg = cfgOrDie();
      const dir = args[0] ?? join(cfg.resolved.dataDir, 'backups');
      const r = await backup(cfg, dir, { artifacts: Boolean(flags.artifacts) });
      const pruned = pruneBackups(dir, Number(flags.keep ?? 7));
      return void out(`${r.path} (${(r.bytes / 1e6).toFixed(1)} MB)${pruned.length ? `\npruned ${pruned.length} old archive(s)` : ''}`);
    }

    case 'restore': {
      const cfg = cfgOrDie();
      if (!args[0]) return void die('usage: swb restore <archive.tar.gz>');
      const plan = await planRestore(cfg, args[0]);
      if (plan.conflicts.length && !flags.force) {
        return void die(`would overwrite:\n  ${plan.conflicts.join('\n  ')}\nre-run with --force (the existing data dir is moved aside, not deleted)`);
      }
      const r = await restore(cfg, args[0]);
      return void out(`restored into ${r.restoredTo}${r.previousMovedTo ? `\nprevious data dir moved to ${r.previousMovedTo}` : ''}`);
    }

    default:
      return void out(HELP);
  }
}

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[] | undefined;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) flags[key!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[key!] = argv[++i]!;
      else flags[key!] = true;
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
}

main().catch((err: unknown) => die((err as Error).stack ?? String(err)));
