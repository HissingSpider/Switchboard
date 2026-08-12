import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import type { GatewayConfig } from '../config/schema.js';

const exec = promisify(execFile);

export interface ReachabilityReport {
  /** URLs that should work, best first. */
  urls: string[];
  tailscale: { installed: boolean; running: boolean; hostname?: string; ip?: string; magicDns?: boolean };
  lan: { ip?: string; url?: string };
  loopback: string;
  /** Things that will stop a phone connecting. */
  problems: string[];
  advice: string[];
}

const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];

function tailscaleBin(): string | undefined {
  return TAILSCALE_PATHS.find((p) => existsSync(p));
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
      const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
      tailscale.hostname = dnsName;
      tailscale.ip = status.Self?.TailscaleIPs?.find((ip) => ip.includes('.'));

      if (!tailscale.running) problems.push(`Tailscale is installed but ${status.BackendState ?? 'not running'}`);
      if (tailscale.running && dnsName) urls.push(`http://${dnsName}:${port}`);
      if (tailscale.running && tailscale.ip) urls.push(`http://${tailscale.ip}:${port}`);
      if (tailscale.running && !tailscale.magicDns) {
        advice.push('MagicDNS is off — use the 100.x address, or turn MagicDNS on for a stable hostname');
      }
    } catch (err) {
      problems.push(`could not read Tailscale status: ${(err as Error).message}`);
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
  if (boundToLoopback && (tailscale.running || lan.ip)) {
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
