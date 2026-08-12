import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, accessSync, constants, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { LoadedConfig } from '../config/load.js';
import { resolveMcpSet, serverNames } from '../runner/mcp.js';
import { resolveRef, looksLikeRawSecret } from '../secrets/keychain.js';
import { checkPolicyIntegrity } from '../policy/policy.js';
import { isRepo } from '../runner/git.js';
import { SkillRegistry } from '../skills/loader.js';
import { parseCron } from '../scheduler/cron.js';
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
export async function runDoctor(cfg: LoadedConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);

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
      add({
        name: 'claude auth',
        status: 'ok',
        detail: hasApiKey ? 'ANTHROPIC_API_KEY set' : hasCreds ? 'logged in (~/.claude/.credentials.json)' : 'logged in (Keychain)',
      });
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
    name: 'gateway port',
    status: free ? 'ok' : 'warn',
    detail: `${cfg.gateway.host}:${cfg.gateway.port} ${free ? 'is free' : 'is already in use (Switchboard may already be running)'}`,
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
  if (cfg.imessage.enabled) {
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
