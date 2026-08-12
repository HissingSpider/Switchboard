import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { listDisplays, checkPermissions, type Screen } from './gui.js';

const exec = promisify(execFile);
const log = logger('headed');

export interface HeadedSession {
  runId: string;
  display: number;
  startedAt: string;
  /** True when a human is watching over screen sharing right now. */
  observed: boolean;
}

/**
 * Headed sessions — a computer-use run drives the real desktop, so exactly one
 * may hold the screen at a time, and the owner needs a way to watch it happen.
 *
 * Watching is macOS Screen Sharing (`vnc://`) rather than anything we build:
 * it is already there, already authenticated, and already works over Tailscale.
 */
export class HeadedSessionManager {
  private current: HeadedSession | null = null;
  private displays: Screen[] = [];

  async init(): Promise<void> {
    this.displays = await listDisplays();
    const perms = await checkPermissions();
    if (!perms.screenRecording || !perms.accessibility) {
      log.warn('GUI permissions incomplete — computer-use runs will fail', perms);
    }
  }

  /** Claim the screen. Returns null if another run already has it. */
  claim(runId: string, display = 1): HeadedSession | null {
    if (this.current) return null;
    this.current = { runId, display, startedAt: new Date().toISOString(), observed: false };
    return this.current;
  }

  release(runId: string): void {
    if (this.current?.runId === runId) this.current = null;
  }

  active(): HeadedSession | null {
    return this.current;
  }

  availableDisplays(): Screen[] {
    return this.displays;
  }

  /** Is macOS Screen Sharing turned on, so the owner can actually watch? */
  async screenSharingEnabled(): Promise<boolean> {
    try {
      const { stdout } = await exec('launchctl', ['list']);
      return stdout.includes('com.apple.screensharing');
    } catch {
      return false;
    }
  }

  /** The URL to hand the owner so they can watch a live run. */
  async watchUrl(): Promise<string | undefined> {
    if (!(await this.screenSharingEnabled())) return undefined;
    try {
      const { stdout } = await exec('scutil', ['--get', 'LocalHostName']);
      return `vnc://${stdout.trim()}.local`;
    } catch {
      return 'vnc://localhost';
    }
  }

  markObserved(observed: boolean): void {
    if (this.current) this.current.observed = observed;
  }
}

export const SCREEN_SHARING_HELP = [
  'To watch a computer-use run live:',
  '  System Settings → General → Sharing → Screen Sharing (on)',
  'Then open the vnc:// URL from `swb computer watch` on any device on the tailnet.',
].join('\n');
