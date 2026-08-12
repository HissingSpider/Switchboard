import { FRAME_BYTES } from './types.js';
import { rms } from './vad.js';

/**
 * Echo control for the case the browser can't handle: one room, one speaker,
 * one microphone, both ours.
 *
 * Three layers, cheapest first:
 *
 *  1. The client asks for `echoCancellation: true` on getUserMedia. On a phone
 *     or a laptop this is a hardware AEC and it solves the problem outright.
 *  2. Half-duplex gating: while we are speaking, mic audio only feeds the
 *     barge-in detector, never the transcriber. Costs nothing, and removes the
 *     "assistant transcribes itself" failure entirely.
 *  3. This: a playback-aware threshold. When a speakerphone has no AEC, our own
 *     output arrives at the mic attenuated and delayed. We know exactly what we
 *     just played, so we know roughly how loud the echo can be — and we require
 *     barge-in speech to be louder than that.
 *
 * This is not acoustic echo *cancellation* — we do not subtract a filtered
 * reference from the input, because doing that properly needs an adaptive
 * filter and sample-accurate alignment between playback and capture, which a
 * browser will not give us. It is echo *suppression*, which is what actually
 * matters here: never mistake our own voice for the user's.
 */
export interface EchoGuardOptions {
  /** How much of our output level survives the round trip to the mic. */
  couplingFactor: number;
  /** Speaker-to-mic delay to allow for when correlating. */
  maxDelayMs: number;
  /** Absolute floor regardless of what we are playing. */
  minThreshold: number;
}

export const DEFAULT_ECHO_GUARD: EchoGuardOptions = {
  // Measured across a few rooms: a laptop speaker at conversational volume
  // reaches its own mic at roughly a third of the level it was played at.
  couplingFactor: 0.35,
  maxDelayMs: 400,
  minThreshold: 0.02,
};

export class EchoGuard {
  /** Recent output frame energies, newest last. */
  private playback: Array<{ at: number; energy: number }> = [];
  private tail = Buffer.alloc(0);

  constructor(private readonly opts: EchoGuardOptions = DEFAULT_ECHO_GUARD) {}

  /** Called with every chunk of PCM we send to the client. */
  observeOutput(pcm: Buffer, now = Date.now()): void {
    const data = this.tail.length ? Buffer.concat([this.tail, pcm]) : pcm;
    const usable = data.length - (data.length % FRAME_BYTES);
    this.tail = Buffer.from(data.subarray(usable));

    // Timestamp each frame at the point it will actually be heard, not the
    // point we handed it to the socket.
    let offsetMs = 0;
    for (let off = 0; off < usable; off += FRAME_BYTES) {
      this.playback.push({ at: now + offsetMs, energy: rms(data.subarray(off, off + FRAME_BYTES)) });
      offsetMs += 20;
    }
    const cutoff = now - 5_000;
    while (this.playback.length && this.playback[0]!.at < cutoff) this.playback.shift();
  }

  /** The energy an incoming frame must beat to count as the user talking. */
  threshold(now = Date.now()): number {
    const from = now - this.opts.maxDelayMs;
    let peak = 0;
    for (let i = this.playback.length - 1; i >= 0; i--) {
      const frame = this.playback[i]!;
      if (frame.at < from) break;
      if (frame.at > now) continue;
      if (frame.energy > peak) peak = frame.energy;
    }
    return Math.max(this.opts.minThreshold, peak * this.opts.couplingFactor);
  }

  /** True when this frame is loud enough that it cannot be our own echo. */
  isForeign(frame: Buffer, now = Date.now()): boolean {
    return rms(frame) > this.threshold(now);
  }

  /** How much audio we believe is still playing out on the far end. */
  pendingPlaybackMs(now = Date.now()): number {
    const last = this.playback[this.playback.length - 1];
    return last ? Math.max(0, last.at - now) : 0;
  }

  reset(): void {
    this.playback = [];
    this.tail = Buffer.alloc(0);
  }
}

/**
 * Constraints the client should pass to getUserMedia. Kept here rather than in
 * the page so server and client can't drift on what the pipeline assumes.
 */
export const CAPTURE_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

export function describeEchoSetup(hasHardwareAec: boolean): string {
  return hasHardwareAec
    ? 'Browser AEC is active; half-duplex gating and the playback-aware threshold are belt and braces.'
    : 'No browser AEC. Use a headset, or expect barge-in to need a raised voice.';
}
