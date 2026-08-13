import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import type { GatewayConfig } from '../config/schema.js';

const exec = promisify(execFile);

export interface ReachabilityReport {
  /** URLs that should work, best first. */
  urls: string[];
  tailscale: { installed: boolean; running: boolean; hostname?: string; ip?: string; magicDns?: boolean; serving?: boolean };
  lan: { ip?: string; url?: string };
  loopback: string;
  /** Things that will stop a phone connecting. */
  problems: string[];
  advice: string[];
}

const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];

function dnsNameOf(status: TailscaleStatus): string | undefined {
  return status.Self?.DNSName?.replace(/\.$/, '');
}

function tailscaleBin(): string | undefined {
  return TAILSCALE_PATHS.find((p) => existsSync(p));
}

/**
 * The tailnet's own address on this machine, read from the interface list.
 *
 * The CLI is not a reliable witness here: the App Store build of Tailscale ships
 * a shim that tries to talk to the GUI, and from a launchd daemon that fails and
 * prints prose to stdout. Believing it means reporting "Tailscale is not running"
 * to someone whose phone is connected over it right now. An address in the CGNAT
 * range 100.64.0.0/10 on a utun interface is the tailnet, with nothing to ask.
 */
function tailnetAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4') continue;
      const [a, b] = addr.address.split('.').map(Number) as [number, number];
      if (a === 100 && b >= 64 && b <= 127) return addr.address;
    }
  }
  return undefined;
}

/**
 * When a request last arrived through a proxy rather than from this machine.
 *
 * Under `tailscale serve` the proxy is Tailscale, so this is direct evidence
 * that something outside the Mac Mini reached the gateway — the one thing the
 * CLI cannot tell us from inside a launchd daemon. A week is deliberately
 * generous: the claim is "this path works", not "someone used it recently".
 */
let lastForwardedAt: number | undefined;
const FORWARDED_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

export function noteForwardedRequest(at = Date.now()): void {
  lastForwardedAt = at;
}

function reachedFromOutside(): boolean {
  return lastForwardedAt !== undefined && Date.now() - lastForwardedAt < FORWARDED_MEMORY_MS;
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
  CurrentTailnet?: { MagicDNSEnabled?: boolean };
}

/**
 * How a phone actually reaches this thing.
 *
 * The gateway binds to loopback on purpose, so "it works on the Mac Mini" tells
 * you nothing about whether the phone in your pocket can talk to it. Tailscale
 * is the intended path: it gives the daemon a stable hostname, encrypts the hop,
 * and requires no port forwarding, no dynamic DNS and no certificate.
 *
 * This reports what's actually available rather than assuming, because the
 * failure — "the dashboard just spins on my phone" — is otherwise very hard to
 * tell apart from the daemon being down.
 */
export async function checkReachability(gateway: GatewayConfig): Promise<ReachabilityReport> {
  const problems: string[] = [];
  const advice: string[] = [];
  const port = gateway.port;
  const loopback = `http://127.0.0.1:${port}`;
  const urls: string[] = [];

  // --- Tailscale ------------------------------------------------------
  const bin = tailscaleBin();
  const tailscale: ReachabilityReport['tailscale'] = { installed: Boolean(bin), running: false };
  if (bin) {
    try {
      const { stdout } = await exec(bin, ['status', '--json'], { timeout: 8000 });
      const status = JSON.parse(stdout) as TailscaleStatus;
      tailscale.running = status.BackendState === 'Running';
      tailscale.magicDns = status.CurrentTailnet?.MagicDNSEnabled;
      const dnsName = dnsNameOf(status);
      tailscale.hostname = dnsName;
      tailscale.ip = status.Self?.TailscaleIPs?.find((ip) => ip.includes('.'));

      // `tailscale serve` proxying to our port is the recommended setup, not a
      // gap: the daemon stays on loopback and Tailscale does the forwarding,
      // inside the encrypted mesh, with a real certificate.
      try {
        const { stdout: serve } = await exec(bin, ['serve', 'status'], { timeout: 8000 });
        tailscale.serving = serve.includes(`:${port}`) || serve.includes(`127.0.0.1:${port}`);
        if (tailscale.serving && dnsNameOf(status)) urls.unshift(`https://${dnsNameOf(status)}`);
      } catch {
        tailscale.serving = false;
      }

      if (!tailscale.running) problems.push(`Tailscale is installed but ${status.BackendState ?? 'not running'}`);
      if (tailscale.running && dnsName) urls.push(`http://${dnsName}:${port}`);
      if (tailscale.running && tailscale.ip) urls.push(`http://${tailscale.ip}:${port}`);
      if (tailscale.running && !tailscale.magicDns) {
        advice.push('MagicDNS is off — use the 100.x address, or turn MagicDNS on for a stable hostname');
      }
    } catch (err) {
      // `status --json` is not always available to us: run from launchd, the
      // App Store build answers with a plain-English refusal on stdout rather
      // than JSON, and a parser error names the wrong culprit entirely — it
      // reads as "Tailscale is off" while the tailnet is up and serving.
      // `serve status` is the question that actually matters (can the phone
      // reach this?), so ask that directly before concluding anything.
      await describeServeOnly(bin, port, tailscale, urls, problems, advice, err as Error);
    }
  } else {
    problems.push('Tailscale is not installed — the phone has no path to the gateway');
    advice.push('Install Tailscale on the Mac Mini and the phone, sign both into the same tailnet');
  }

  // --- LAN ------------------------------------------------------------
  const lan: ReachabilityReport['lan'] = {};
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !name.startsWith('utun')) {
        lan.ip = addr.address;
        lan.url = `http://${addr.address}:${port}`;
        break;
      }
    }
    if (lan.ip) break;
  }
  if (lan.url) urls.push(lan.url);
  urls.push(loopback);

  // --- binding --------------------------------------------------------
  const boundToLoopback = gateway.host === '127.0.0.1' || gateway.host === 'localhost';
  // Something already came through a proxy to get here, so "only this machine
  // can connect" would be a claim contradicted by the request that asked.
  if (!tailscale.serving && reachedFromOutside()) tailscale.serving = true;
  if (boundToLoopback && tailscale.serving) {
    advice.push('Loopback + `tailscale serve` is the right setup: encrypted, certificate-backed, and invisible to the LAN.');
  } else if (boundToLoopback && (tailscale.running || lan.ip)) {
    problems.push(`gateway is bound to ${gateway.host}, so only this machine can connect`);
    advice.push(
      tailscale.running
        ? 'Either bind to the Tailscale IP, or leave it on loopback and run `tailscale serve` to expose it inside the tailnet only'
        : 'Bind to 0.0.0.0 only if you understand the LAN exposure; the tailnet is the safer path',
    );
  }

  // --- host allowlist -------------------------------------------------
  if (tailscale.hostname && !(gateway.trustedHosts ?? []).includes(tailscale.hostname) && !tailscale.hostname.endsWith('.ts.net')) {
    problems.push(`"${tailscale.hostname}" is not in gateway.trustedHosts, so requests using it will be refused`);
  }

  return { urls: [...new Set(urls)], tailscale, lan, loopback, problems, advice };
}

/**
 * Fallback when `tailscale status --json` could not be read. Anything that
 * `serve status` prints is proof the CLI reached a running backend, and the
 * URL it prints is the one the phone should be using — so a working tailnet is
 * never reported as a missing one just because the JSON door was shut.
 */
async function describeServeOnly(
  bin: string,
  port: number,
  tailscale: ReachabilityReport['tailscale'],
  urls: string[],
  problems: string[],
  advice: string[],
  parseError: Error,
): Promise<void> {
  try {
    const { stdout } = await exec(bin, ['serve', 'status'], { timeout: 8000 });
    const host = /https:\/\/([^\s/]+)/.exec(stdout)?.[1];
    tailscale.serving = stdout.includes(`:${port}`);
    if (tailscale.serving && host) {
      tailscale.running = true;
      tailscale.hostname = host;
      urls.unshift(`https://${host}`);
      return;
    }
  } catch {
    // Fall through to the interface check, below.
  }

  const ip = tailnetAddress();
  if (ip) {
    // The tailnet is up; only the CLI is unreachable. Say which, because the
    // two have completely different fixes and only one of them is a problem.
    tailscale.running = true;
    tailscale.ip = ip;
    urls.push(`http://${ip}:${port}`);
    advice.push(
      'Tailscale is up (this machine holds ' +
        ip +
        ') but its CLI could not be queried from the daemon — the App Store build needs a logged-in GUI session. ' +
        'Run `tailscale serve status` yourself to confirm the https:// name.',
    );
    return;
  }

  problems.push(`could not read Tailscale status: ${parseError.message}`);
}

/**
 * The command that exposes a loopback-bound gateway to the tailnet without
 * opening it to the LAN. This is the recommended setup: the daemon keeps
 * listening on 127.0.0.1 and Tailscale does the forwarding, inside the
 * encrypted mesh, with device identity attached.
 */
export function serveCommand(port: number): string {
  return `tailscale serve --bg ${port}`;
}

export function formatReachability(r: ReachabilityReport): string {
  const lines: string[] = [];
  lines.push(`tailscale: ${r.tailscale.installed ? (r.tailscale.running ? `running as ${r.tailscale.hostname ?? r.tailscale.ip}` : 'installed, not running') : 'not installed'}`);
  if (r.lan.url) lines.push(`lan:       ${r.lan.url}`);
  lines.push(`loopback:  ${r.loopback}`);
  lines.push('');
  lines.push('try, in order:');
  for (const u of r.urls) lines.push(`  ${u}`);
  if (r.problems.length) {
    lines.push('');
    for (const p of r.problems) lines.push(`  ! ${p}`);
  }
  if (r.advice.length) {
    lines.push('');
    for (const a of r.advice) lines.push(`  → ${a}`);
  }
  return lines.join('\n');
}
