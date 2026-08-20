import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, accessSync, constants, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { LoadedConfig } from '../config/load.js';
import { resolveMcpSet, serverNames } from '../runner/mcp.js';
import { resolveRef, looksLikeRawSecret } from '../secrets/keychain.js';
import { checkPolicyIntegrity } from '../policy/policy.js';
import { readCredentialClock } from '../runner/credentials.js';
import { isRepo } from '../runner/git.js';
import { SkillRegistry } from '../skills/loader.js';
import { parseCron } from '../scheduler/cron.js';
import { checkReachability } from '../net/reachability.js';
import { isValidVapidSubject } from '../gateway/push.js';
import { NativeImessageAdapter, FULL_DISK_ACCESS_HELP } from '../adapters/imessage-native.js';
import { join } from 'node:path';
import { WhisperCppStt, WHISPER_INSTALL_HELP } from '../voice/stt.js';
import { pickTts, TTS_INSTALL_HELP } from '../voice/tts.js';
import { WakeWordDetector, WAKE_WORD_HELP } from '../voice/wakeword.js';

const exec = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to actually do about it. */
  fix?: string;
}

async function which(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('which', [bin]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    sock.setTimeout(1000);
    sock.on('connect', () => {
      sock.destroy();
      resolve(false); // something is already listening
    });
    const free = (): void => {
      sock.destroy();
      resolve(true);
    };
    sock.on('error', free);
    sock.on('timeout', free);
  });
}

/**
 * Preflight. Everything that will bite you at 3am when a scheduled run fires
 * and nobody is watching, checked while you are sitting in front of it.
 */
/**
 * Ask the running daemon about itself.
 *
 * Anything permission-shaped has to be asked of the process that holds the
 * permission. macOS attributes a TCC grant to the responsible process, and the
 * doctor launched from a shell is attributed to the shell's app — so testing
 * from here reports "denied" while the daemon is working perfectly.
 */
async function askDaemon<T>(cfg: LoadedConfig, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`http://${cfg.gateway.host}:${cfg.gateway.port}${path}`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function runDoctor(cfg: LoadedConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);
  const daemonStatus = await askDaemon<{ version: string }>(cfg, '/api/status');
  const daemonRunning = Boolean(daemonStatus);

  // --- claude CLI -----------------------------------------------------
  const claudePath = cfg.claudeBin.includes('/') ? cfg.claudeBin : await which(cfg.claudeBin);
  if (!claudePath || !existsSync(claudePath)) {
    add({ name: 'claude CLI', status: 'fail', detail: `not found: ${cfg.claudeBin}`, fix: 'install Claude Code, or set claudeBin to its full path' });
  } else {
    try {
      const { stdout } = await exec(claudePath, ['--version'], { timeout: 15_000 });
      add({ name: 'claude CLI', status: 'ok', detail: `${claudePath} — ${stdout.trim()}` });
    } catch (err) {
      add({ name: 'claude CLI', status: 'fail', detail: `${claudePath} would not run: ${(err as Error).message}` });
    }
  }

  // --- auth -----------------------------------------------------------
  if (claudePath) {
    const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const credsPath = `${process.env.HOME}/.claude/.credentials.json`;
    const hasCreds = existsSync(credsPath);
    // On macOS the login usually lives in the Keychain rather than on disk.
    const hasKeychainLogin = await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials'])
      .then(() => true)
      .catch(() => false);
    if (hasApiKey || hasCreds || hasKeychainLogin) {
      const where = hasApiKey ? 'ANTHROPIC_API_KEY set' : hasCreds ? 'logged in (~/.claude/.credentials.json)' : 'logged in (Keychain)';
      // "A credential exists" is not the same as "a credential works", and the
      // difference is not academic: three scheduled runs died on an expired
      // login while this check stayed green. The refresh token is the one that
      // needs a human — the access token renews itself.
      const clock = readCredentialClock();
      const refreshDead = clock.refreshExpiresAt !== undefined && clock.refreshExpiresAt < Date.now();
      if (refreshDead) {
        add({
          name: 'claude auth',
          status: 'fail',
          detail: `stored login expired ${new Date(clock.refreshExpiresAt!).toLocaleString()} — runs will fail`,
          fix: 'run `claude` on this machine and log in again',
        });
      } else {
        const expiry = clock.refreshExpiresAt ? `, valid until ${new Date(clock.refreshExpiresAt).toLocaleDateString()}` : '';
        add({ name: 'claude auth', status: 'ok', detail: `${where}${expiry}` });
      }
    } else {
      add({
        name: 'claude auth',
        status: 'fail',
        detail: 'no API key and no stored login',
        fix: 'run `claude` once and log in, or export ANTHROPIC_API_KEY in the launchd plist',
      });
    }
  }

  // --- paths ----------------------------------------------------------
  for (const [label, dir] of [
    ['dataDir', cfg.resolved.dataDir],
    ['scratchDir', cfg.resolved.scratchDir],
    ['skillsDir', cfg.resolved.skillsDir],
  ] as const) {
    if (!existsSync(dir)) {
      add({ name: `path: ${label}`, status: 'warn', detail: `${dir} does not exist (will be created)` });
      continue;
    }
    try {
      accessSync(dir, constants.W_OK);
      add({ name: `path: ${label}`, status: 'ok', detail: dir });
    } catch {
      add({ name: `path: ${label}`, status: 'fail', detail: `${dir} is not writable` });
    }
  }

  // --- projects -------------------------------------------------------
  if (!cfg.projects.length) {
    add({ name: 'projects', status: 'warn', detail: 'no projects configured — every run lands in the scratch dir' });
  }
  for (const p of cfg.projects) {
    if (!existsSync(p.path)) {
      add({ name: `project: ${p.name}`, status: 'fail', detail: `${p.path} does not exist` });
    } else if (p.git !== false && !isRepo(p.path)) {
      add({ name: `project: ${p.name}`, status: 'warn', detail: `${p.path} is not a git repo — no branch-per-run safety net`, fix: 'git init, or set "git": false on the project' });
    } else {
      add({ name: `project: ${p.name}`, status: 'ok', detail: p.path });
    }
  }

  // --- gateway --------------------------------------------------------
  const free = await portFree(cfg.gateway.host, cfg.gateway.port);
  add({
    name: 'gateway',
    // A port in use by our own daemon is the healthy case, not a warning.
    status: free || daemonRunning ? 'ok' : 'warn',
    detail: daemonRunning
      ? `running at http://${cfg.gateway.host}:${cfg.gateway.port}`
      : free
        ? `${cfg.gateway.host}:${cfg.gateway.port} is free (daemon not running)`
        : `${cfg.gateway.host}:${cfg.gateway.port} is in use by something else`,
  });
  if (cfg.gateway.host !== '127.0.0.1' && cfg.gateway.host !== 'localhost') {
    add({
      name: 'gateway binding',
      status: 'warn',
      detail: `bound to ${cfg.gateway.host}, not loopback`,
      fix: 'bind 127.0.0.1 and reach it over Tailscale instead of exposing the port',
    });
  }

  // --- MCP ------------------------------------------------------------
  for (const setName of new Set([cfg.routerMcpSet, cfg.workerMcpSet])) {
    const servers = resolveMcpSet(cfg, setName);
    const names = serverNames(servers);
    if (!names.length) {
      add({ name: `mcp set: ${setName}`, status: 'warn', detail: 'resolves to no servers' });
      continue;
    }
    const unreachable: string[] = [];
    for (const [name, def] of Object.entries(servers)) {
      const d = def as { command?: string; url?: string; type?: string };
      if (d.command) {
        const bin = d.command.split(/\s+/)[0]!;
        if (!(await which(bin)) && !existsSync(bin)) unreachable.push(`${name} (missing ${bin})`);
      } else if (d.url) {
        try {
          await fetch(d.url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
        } catch {
          unreachable.push(`${name} (${d.url} unreachable)`);
        }
      }
    }
    add({
      name: `mcp set: ${setName}`,
      status: unreachable.length ? 'warn' : 'ok',
      detail: unreachable.length ? `${names.length} servers, problems: ${unreachable.join(', ')}` : `${names.length} servers: ${names.join(', ')}`,
    });
  }
  if (cfg.routerMcpSet === cfg.workerMcpSet) {
    add({
      name: 'mcp split',
      status: 'warn',
      detail: 'router and worker share one MCP set',
      fix: 'give the router a small read-only set — it runs on every inbound message',
    });
  }

  // --- secrets --------------------------------------------------------
  const secretRefs: Array<[string, string | undefined]> = [
    ['imessage.passwordRef', cfg.imessage.passwordRef],
    ['telegram.botTokenRef', cfg.telegram.botTokenRef],
    ['gateway.authTokenRef', cfg.gateway.authTokenRef],
  ];
  for (const [label, ref] of secretRefs) {
    if (!ref) continue;
    if (looksLikeRawSecret(ref)) {
      add({ name: `secret: ${label}`, status: 'fail', detail: 'looks like a raw secret sitting in config.json', fix: `swb secret set <name> && set ${label} to "keychain:switchboard/<name>"` });
    } else if (!resolveRef(ref)) {
      add({ name: `secret: ${label}`, status: 'fail', detail: `${ref} does not resolve`, fix: 'swb secret set <name>' });
    } else {
      add({ name: `secret: ${label}`, status: 'ok', detail: ref });
    }
  }

  // --- channels -------------------------------------------------------
  if (cfg.imessage.enabled && (cfg.imessage.mode ?? 'native') === 'native') {
    const live = await askDaemon<{ receiving: boolean; problem?: string; allowlist: string[] }>(cfg, '/api/imessage');
    if (live) {
      add({
        name: 'iMessage',
        status: live.receiving ? 'ok' : 'fail',
        detail: live.receiving
          ? `watching for messages, ${live.allowlist.length} allowlisted sender(s)`
          : (live.problem ?? 'not receiving'),
        fix: live.receiving ? undefined : FULL_DISK_ACCESS_HELP,
      });
    } else {
      // Without the daemon we can only test from here, and this process is not
      // the one holding the grant — so say what the answer is worth.
      const adapter = new NativeImessageAdapter(cfg.imessage, { workDir: join(cfg.resolved.dataDir, 'imessage') });
      const problem = adapter.problem;
      add({
        name: 'iMessage',
        status: 'warn',
        detail: problem
          ? `daemon not running; from this process it reads as "${problem}" — which says nothing about the daemon`
          : 'daemon not running; the database is readable from here',
        fix: 'start the daemon and re-run, so the check asks the process that holds the permission',
      });
      await adapter.stop();
    }
  } else if (cfg.imessage.enabled) {
    try {
      const u = new URL('/api/v1/server/info', cfg.imessage.serverUrl);
      u.searchParams.set('password', resolveRef(cfg.imessage.passwordRef) ?? '');
      const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
      add({ name: 'BlueBubbles', status: res.ok ? 'ok' : 'fail', detail: `${cfg.imessage.serverUrl} → HTTP ${res.status}` });
    } catch (err) {
      add({ name: 'BlueBubbles', status: 'fail', detail: `${cfg.imessage.serverUrl} unreachable: ${(err as Error).message}` });
    }
  } else {
    add({ name: 'BlueBubbles', status: 'warn', detail: 'iMessage adapter disabled' });
  }

  // --- policy ---------------------------------------------------------
  const integrity = checkPolicyIntegrity(cfg.resolved.configFile, [cfg.resolved.scratchDir, ...cfg.projects.map((p) => p.path)]);
  add({
    name: 'policy integrity',
    status: integrity.ok ? 'ok' : 'fail',
    detail: integrity.ok ? `config hash ${integrity.hash.slice(0, 12)}` : integrity.problems.join('; '),
    fix: integrity.ok ? undefined : 'move config.json outside every project path and chmod 600 it',
  });

  // --- skills ---------------------------------------------------------
  const skills = new SkillRegistry(cfg.resolved.skillsDir);
  const skillProblems = skills.validate();
  add({
    name: 'skills',
    status: skillProblems.length ? 'warn' : 'ok',
    detail: skillProblems.length
      ? `${skills.all().length} loaded, problems: ${skillProblems.map((p) => `${p.skill} (${p.problems.join(', ')})`).join('; ')}`
      : `${skills.all().length} loaded`,
  });

  // --- schedules ------------------------------------------------------
  for (const job of cfg.heartbeats) {
    try {
      parseCron(job.cron);
    } catch (err) {
      add({ name: `heartbeat: ${job.name}`, status: 'fail', detail: (err as Error).message });
    }
  }

  // --- push -----------------------------------------------------------
  if (!isValidVapidSubject(cfg.gateway.pushSubject)) {
    add({
      name: 'push contact',
      status: 'warn',
      detail: cfg.gateway.pushSubject ? `"${cfg.gateway.pushSubject}" is not a valid VAPID contact` : 'gateway.pushSubject is not set',
      fix: 'set gateway.pushSubject to "mailto:you@example.com" or an https URL — Apple returns BadJwtToken otherwise',
    });
  } else {
    add({ name: 'push contact', status: 'ok', detail: cfg.gateway.pushSubject! });
  }

  // --- voice ----------------------------------------------------------
  if (cfg.voice.enabled) {
    const stt = new WhisperCppStt({ binary: cfg.voice.whisperBinary, model: cfg.voice.whisperModel });
    add({
      name: 'voice: STT',
      status: stt.available ? 'ok' : 'warn',
      detail: stt.detail,
      fix: stt.available ? undefined : WHISPER_INSTALL_HELP,
    });

    const tts = pickTts({ engine: cfg.voice.ttsEngine, voice: cfg.voice.ttsVoice, piperModel: cfg.voice.piperModel });
    add({
      name: 'voice: TTS',
      status: tts.available ? 'ok' : 'fail',
      detail: `${tts.name}${tts.available ? '' : ' — unavailable'}`,
      fix: tts.name === 'macos-say' && tts.available ? TTS_INSTALL_HELP : undefined,
    });

    if (cfg.voice.wakeWord) {
      const pythonOk = WakeWordDetector.pythonAvailable();
      add({
        name: 'voice: wake word',
        status: pythonOk ? 'warn' : 'fail',
        detail: pythonOk ? `"${cfg.voice.wakeWord}" — python found, openwakeword not verified until first start` : 'no python3 found',
        fix: WAKE_WORD_HELP,
      });
    }
  } else {
    add({ name: 'voice', status: 'warn', detail: 'voice disabled in config' });
  }

  // --- reachability ---------------------------------------------------
  const reach = await checkReachability(cfg.gateway);
  add({
    name: 'reachability',
    status: reach.problems.length ? 'warn' : 'ok',
    detail: reach.urls.length ? `reachable at ${reach.urls[0]}` : 'loopback only',
    fix: reach.problems.length ? `${reach.problems.join('; ')}\n      ${reach.advice.join('\n      ')}` : undefined,
  });

  // --- caps -----------------------------------------------------------
  if (cfg.caps.maxCostUsd > 20) {
    add({ name: 'caps', status: 'warn', detail: `maxCostUsd is $${cfg.caps.maxCostUsd} per run — one runaway run can spend that` });
  }
  add({
    name: 'disk',
    status: 'ok',
    detail: `artifacts under ${cfg.resolved.artifactsDir}${existsSync(cfg.resolved.artifactsDir) ? ` (${statSync(cfg.resolved.artifactsDir).isDirectory() ? 'present' : 'not a directory'})` : ' (not created yet)'}`,
  });

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };
  const lines = checks.map((c) => `${icon[c.status]} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n    → ${c.fix}` : ''}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('', `${checks.length} checks — ${fails} failing, ${warns} warnings`);
  return lines.join('\n');
}

export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
