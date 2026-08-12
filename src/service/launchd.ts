import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

export const LABEL = 'com.switchboard.daemon';

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export interface ServiceOptions {
  /** Absolute path to dist/index.js. */
  entry: string;
  nodeBin?: string;
  dataDir: string;
  configPath?: string;
  /** Keep the Mac awake while the daemon is up — a sleeping Mini answers no texts. */
  caffeinate?: boolean;
  env?: Record<string, string>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * launchd agent: start at login, restart on crash, keep the machine awake, and
 * write rotating logs. `caffeinate -s` wraps the daemon so the Mini stays
 * responsive without disabling sleep system-wide.
 */
export function renderPlist(opts: ServiceOptions): string {
  const node = opts.nodeBin ?? process.execPath;
  const args = opts.caffeinate === false ? [node, opts.entry] : ['/usr/bin/caffeinate', '-s', node, opts.entry];
  const env: Record<string, string> = {
    PATH: `${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    HOME: homedir(),
    SWB_DATA_DIR: opts.dataDir,
    ...(opts.configPath ? { SWB_CONFIG: opts.configPath } : {}),
    ...(opts.env ?? {}),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${esc(opts.dataDir)}</string>
  <key>StandardOutPath</key>
  <string>${esc(join(opts.dataDir, 'logs', 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(opts.dataDir, 'logs', 'daemon.err.log'))}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
  .join('\n')}
  </dict>
</dict>
</plist>
`;
}

export async function installService(opts: ServiceOptions): Promise<string> {
  const path = plistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(opts.dataDir, 'logs'), { recursive: true });
  writeFileSync(path, renderPlist(opts));
  await exec('launchctl', ['unload', path]).catch(() => undefined);
  await exec('launchctl', ['load', '-w', path]);
  return path;
}

export async function uninstallService(): Promise<boolean> {
  const path = plistPath();
  if (!existsSync(path)) return false;
  await exec('launchctl', ['unload', '-w', path]).catch(() => undefined);
  unlinkSync(path);
  return true;
}

export async function serviceStatus(): Promise<{ installed: boolean; running: boolean; pid?: number; lastExit?: number }> {
  const installed = existsSync(plistPath());
  try {
    const { stdout } = await exec('launchctl', ['list']);
    const line = stdout.split('\n').find((l) => l.endsWith(LABEL));
    if (!line) return { installed, running: false };
    const [pid, status] = line.split(/\s+/);
    return {
      installed,
      running: pid !== '-',
      pid: pid === '-' ? undefined : Number(pid),
      lastExit: Number(status),
    };
  } catch {
    return { installed, running: false };
  }
}

export async function restartService(): Promise<void> {
  await exec('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
}
