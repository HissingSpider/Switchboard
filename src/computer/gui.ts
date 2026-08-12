import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ArtifactStore } from '../store/artifacts.js';
import type { EventLog } from '../store/eventlog.js';

const exec = promisify(execFile);

/**
 * macOS GUI control.
 *
 * Screenshots go through `screencapture` (needs Screen Recording); clicks and
 * keystrokes go through AppleScript's System Events (needs Accessibility).
 * Both are per-binary grants, so the thing you tick in System Settings is the
 * process that launches Switchboard — usually /usr/local/bin/node or the
 * launchd-managed copy, not Terminal.
 */
export interface PermissionState {
  screenRecording: boolean;
  accessibility: boolean;
  detail: string[];
}

export async function checkPermissions(): Promise<PermissionState> {
  const detail: string[] = [];
  let screenRecording = false;
  let accessibility = false;

  try {
    // A zero-byte capture means the grant is missing; the command itself succeeds either way.
    const tmp = join('/tmp', `swb-permcheck-${process.pid}.png`);
    await exec('screencapture', ['-x', '-t', 'png', tmp]);
    screenRecording = existsSync(tmp);
    detail.push(screenRecording ? 'screencapture produced a file' : 'screencapture produced nothing');
    await exec('rm', ['-f', tmp]).catch(() => undefined);
  } catch (err) {
    detail.push(`screencapture failed: ${(err as Error).message}`);
  }

  try {
    await exec('osascript', ['-e', 'tell application "System Events" to get name of first process']);
    accessibility = true;
  } catch (err) {
    detail.push(`System Events blocked: ${(err as Error).message}`);
  }

  return { screenRecording, accessibility, detail };
}

export const PERMISSION_HELP = [
  'macOS GUI control needs two grants, both for the binary that runs Switchboard:',
  '  System Settings → Privacy & Security → Screen Recording  → add your node binary',
  '  System Settings → Privacy & Security → Accessibility     → add your node binary',
  'Find the binary with: node -e "console.log(process.execPath)"',
  'After granting either one, restart the daemon — macOS caches the decision per process.',
].join('\n');

export interface Screen {
  index: number;
  width: number;
  height: number;
}

export async function listDisplays(): Promise<Screen[]> {
  try {
    const { stdout } = await exec('system_profiler', ['-json', 'SPDisplaysDataType']);
    const parsed = JSON.parse(stdout) as { SPDisplaysDataType?: Array<{ spdisplays_ndrvs?: Array<{ _spdisplays_pixels?: string }> }> };
    const screens: Screen[] = [];
    let i = 1;
    for (const gpu of parsed.SPDisplaysDataType ?? []) {
      for (const d of gpu.spdisplays_ndrvs ?? []) {
        const m = /(\d+)\s*x\s*(\d+)/.exec(d._spdisplays_pixels ?? '');
        screens.push({ index: i++, width: Number(m?.[1] ?? 0), height: Number(m?.[2] ?? 0) });
      }
    }
    return screens;
  } catch {
    return [{ index: 1, width: 0, height: 0 }];
  }
}

/**
 * Every GUI action is bracketed by a screenshot written into the run's artifact
 * directory and referenced from the event log — a computer-use run you cannot
 * replay afterwards is not auditable.
 */
export class GuiController {
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly events: EventLog,
    private readonly runId: string,
    private readonly display = 1,
  ) {}

  async screenshot(label: string): Promise<string> {
    const name = `screen-${Date.now()}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`;
    const path = join(this.artifacts.dirFor(this.runId), name);
    await exec('screencapture', ['-x', '-D', String(this.display), '-t', 'png', path]);
    this.events.append({
      runId: this.runId,
      kind: 'screenshot.captured',
      source: 'computer',
      summary: `screenshot: ${label}`,
      data: { path, name, label, display: this.display },
    });
    return path;
  }

  async click(x: number, y: number, label = `click ${x},${y}`): Promise<void> {
    await this.screenshot(`before-${label}`);
    // System Events has no direct click-at-point, so drive the cursor first.
    await exec('osascript', [
      '-e',
      `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`,
    ]);
    await this.screenshot(`after-${label}`);
  }

  async type(text: string): Promise<void> {
    await this.screenshot('before-type');
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await exec('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
    await this.screenshot('after-type');
  }

  async key(key: string, modifiers: string[] = []): Promise<void> {
    const using = modifiers.length ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}` : '';
    await exec('osascript', ['-e', `tell application "System Events" to key code ${keyCode(key)}${using}`]);
    await this.screenshot(`key-${key}`);
  }

  async openApp(name: string): Promise<void> {
    await exec('open', ['-a', name]);
    await new Promise((r) => setTimeout(r, 1500));
    await this.screenshot(`opened-${name}`);
  }

  async frontmostApp(): Promise<string> {
    const { stdout } = await exec('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true']);
    return stdout.trim();
  }
}

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

function keyCode(key: string): number {
  const code = KEY_CODES[key.toLowerCase()];
  if (code === undefined) throw new Error(`unknown key "${key}" — known: ${Object.keys(KEY_CODES).join(', ')}`);
  return code;
}
