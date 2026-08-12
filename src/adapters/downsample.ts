import type { SwbEvent } from '../store/events.js';
import { NOISY_KINDS, CRITICAL_KINDS } from '../store/events.js';

export interface DownsampleOptions {
  /** Never send more than one update per this many ms, except for critical events. */
  minIntervalMs: number;
  /** Hard cap on a single text. */
  maxChars: number;
}

export const DEFAULT_DOWNSAMPLE: DownsampleOptions = { minIntervalMs: 90_000, maxChars: 600 };

/**
 * The event stream is written for a screen; a phone needs perhaps five messages
 * out of five hundred events. This collapses a run's stream into the handful of
 * lines a person actually wants: it started, it's still going and here's what
 * it's doing, it needs you, it finished.
 */
export class Downsampler {
  private lastSentAt = new Map<string, number>();
  private pendingTools = new Map<string, string[]>();

  constructor(private readonly opts: DownsampleOptions = DEFAULT_DOWNSAMPLE) {}

  /** Returns the text to send, or undefined to stay quiet. */
  consider(ev: SwbEvent, now = Date.now()): string | undefined {
    const key = ev.runId ?? '_global';

    if (CRITICAL_KINDS.has(ev.kind)) {
      this.lastSentAt.set(key, now);
      this.pendingTools.delete(key);
      return this.clip(ev.summary);
    }

    if (ev.kind === 'tool.use') {
      const list = this.pendingTools.get(key) ?? [];
      const label = String(ev.data.tool ?? 'tool');
      if (list[list.length - 1] !== label) list.push(label);
      this.pendingTools.set(key, list);
    }

    switch (ev.kind) {
      case 'run.started': {
        this.lastSentAt.set(key, now);
        return this.clip(ev.summary);
      }
      case 'run.finished':
      case 'run.failed':
      case 'run.killed': {
        this.lastSentAt.set(key, now);
        this.pendingTools.delete(key);
        const result = typeof ev.data.result === 'string' && ev.data.result.trim() ? `\n${ev.data.result.trim()}` : '';
        return this.clip(`${ev.summary}${result}`);
      }
      case 'agent.text': {
        // The model talking mid-run is worth relaying, but not every sentence.
        if (!this.due(key, now)) return undefined;
        this.lastSentAt.set(key, now);
        return this.clip(ev.summary);
      }
      default:
        break;
    }

    if (NOISY_KINDS.has(ev.kind)) {
      // Roll noise up into a periodic "still working" line.
      if (!this.due(key, now)) return undefined;
      const tools = this.pendingTools.get(key) ?? [];
      if (!tools.length) return undefined;
      this.lastSentAt.set(key, now);
      this.pendingTools.set(key, []);
      const uniq = [...new Set(tools)].slice(0, 5);
      return this.clip(`${ev.runId ?? ''} still working — ${uniq.join(', ')}`.trim());
    }

    return undefined;
  }

  private due(key: string, now: number): boolean {
    const last = this.lastSentAt.get(key) ?? 0;
    return now - last >= this.opts.minIntervalMs;
  }

  private clip(text: string): string {
    const t = text.trim();
    return t.length <= this.opts.maxChars ? t : `${t.slice(0, this.opts.maxChars - 1)}…`;
  }

  forget(runId: string): void {
    this.lastSentAt.delete(runId);
    this.pendingTools.delete(runId);
  }
}

/** Strip markdown that reads badly in a text bubble. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').trim())
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
