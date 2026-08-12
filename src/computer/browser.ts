import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const log = logger('browser');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function findChrome(): string | undefined {
  return CHROME_PATHS.find((p) => existsSync(p));
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Browser control over the Chrome DevTools Protocol.
 *
 * A dedicated Chrome instance with its own profile directory, so driving it
 * never touches the browser the owner is actually using — and never inherits
 * their logged-in sessions unless they deliberately point the profile at one.
 */
export class BrowserAdapter {
  private child: ChildProcess | null = null;
  private nextId = 1;

  constructor(
    private readonly profileDir: string,
    private readonly port = 9222,
    private readonly binary = findChrome(),
  ) {}

  get available(): boolean {
    return Boolean(this.binary);
  }

  async launch(headless = false): Promise<boolean> {
    if (!this.binary) {
      log.warn('no Chrome-family browser found', { searched: CHROME_PATHS });
      return false;
    }
    if (await this.isUp()) return true;
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ];
    this.child = spawn(this.binary, args, { stdio: 'ignore', detached: true });
    this.child.unref();
    for (let i = 0; i < 40; i++) {
      if (await this.isUp()) return true;
      await sleep(250);
    }
    return false;
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close`, { signal: AbortSignal.timeout(1000) });
    } catch {
      /* best effort */
    }
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  async targets(): Promise<CdpTarget[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await res.json()) as CdpTarget[];
  }

  async newTab(url = 'about:blank'): Promise<CdpTarget> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    return (await res.json()) as CdpTarget;
  }

  /** One CDP command against a target, over a short-lived socket. */
  async send<T = unknown>(target: CdpTarget, method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!target.webSocketDebuggerUrl) throw new Error(`target ${target.id} has no debugger socket`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: T; error?: { message: string } };
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
        else resolve(msg.result as T);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP socket error on ${method}`));
      });
    });
  }

  async navigate(target: CdpTarget, url: string): Promise<void> {
    await this.send(target, 'Page.navigate', { url });
    await sleep(1200);
  }

  async text(target: CdpTarget): Promise<string> {
    const res = await this.send<{ result: { value?: string } }>(target, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    return res.result?.value ?? '';
  }

  async screenshot(target: CdpTarget, path: string): Promise<string> {
    const res = await this.send<{ data: string }>(target, 'Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    return path;
  }

  profilePathFor(name: string): string {
    return join(this.profileDir, name);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
