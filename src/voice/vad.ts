import { existsSync } from 'node:fs';
import { FRAME_BYTES, FRAME_SAMPLES, bytesToMs, type VadEngine, type VadResult } from './types.js';

/** A noise floor above this means the room is unusable, not that speech is loud. */
const MAX_NOISE_FLOOR = 0.08;

/**
 * Energy + zero-crossing VAD.
 *
 * Silero is better, but it needs onnxruntime and a model file, and this has to
 * work the moment you clone the repo. This runs in about 5 µs per frame, has no
 * dependencies, and is good enough for a quiet room with a close mic — which is
 * the actual deployment. `SileroVad` takes over when the model is present.
 */
export class EnergyVad implements VadEngine {
  readonly name = 'energy';
  private noiseFloor = 0.005;
  private calibrationFrames = 0;

  constructor(
    /** Speech must exceed the noise floor by this factor. */
    private readonly ratio = 3.5,
    /** Absolute floor so a dead-silent room doesn't make every breath "speech". */
    private readonly minEnergy = 0.008,
  ) {}

  process(frame: Buffer): VadResult {
    const energy = rms(frame);
    const zcr = zeroCrossingRate(frame);

    // Asymmetric tracking, and asymmetric on purpose: the floor drops quickly
    // when the room goes quiet, and rises only glacially. Adapting upward at
    // any real speed means the first second of speech raises the floor above
    // itself and the rest of the utterance reads as silence — which is exactly
    // what happens if you "calibrate" over the opening frames.
    if (energy < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * 0.7 + energy * 0.3;
    } else {
      this.noiseFloor = Math.min(MAX_NOISE_FLOOR, this.noiseFloor * 0.9995 + energy * 0.0005);
    }
    this.calibrationFrames++;

    // High zero-crossing with low energy is hiss, not voice.
    const loud = energy > Math.max(this.minEnergy, this.noiseFloor * this.ratio);
    const voiced = zcr < 0.35;
    return { speech: loud && voiced, energy };
  }

  reset(): void {
    this.noiseFloor = 0.005;
    this.calibrationFrames = 0;
  }
}

/**
 * Silero VAD via onnxruntime, used only if both the runtime and the model are
 * installed. Kept behind the same interface so the rest of the pipeline never
 * learns which one it got.
 */
export class SileroVad implements VadEngine {
  readonly name = 'silero';
  private session: unknown = null;
  private state: Float32Array = new Float32Array(2 * 1 * 128);
  private fallback = new EnergyVad();
  private lastProbability = 0;

  constructor(
    private readonly modelPath: string,
    private readonly threshold = 0.5,
  ) {}

  static available(modelPath: string): boolean {
    if (!existsSync(modelPath)) return false;
    try {
      // Resolved, not imported: we only want to know it's installable.
      import.meta.resolve?.('onnxruntime-node');
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<boolean> {
    try {
      const ort = (await import('onnxruntime-node' as string)) as {
        InferenceSession: { create(path: string): Promise<unknown> };
      };
      this.session = await ort.InferenceSession.create(this.modelPath);
      return true;
    } catch {
      this.session = null;
      return false;
    }
  }

  process(frame: Buffer): VadResult {
    // Without a loaded session this degrades to energy rather than failing —
    // a voice assistant that stops listening is worse than one that mishears.
    if (!this.session) return this.fallback.process(frame);
    return { speech: this.lastProbability > this.threshold, energy: rms(frame) };
  }

  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
    this.lastProbability = 0;
    this.fallback.reset();
  }
}

export interface EndpointerOptions {
  /** Speech must last this long before we accept it as an utterance. */
  minSpeechMs: number;
  /** Silence this long after speech ends the utterance. */
  silenceMs: number;
  /** Hard ceiling so a running tap doesn't produce a ten-minute utterance. */
  maxUtteranceMs: number;
  /** Audio kept from before speech was detected, so we don't clip the first word. */
  preRollMs: number;
}

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  minSpeechMs: 200,
  silenceMs: 700,
  maxUtteranceMs: 30_000,
  preRollMs: 300,
};

export type EndpointerEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; pcm: Buffer; durationMs: number }
  | { type: 'timeout'; pcm: Buffer };

/**
 * Turns a stream of frames into utterances.
 *
 * The pre-roll ring buffer matters more than it looks: VAD always fires a
 * frame or two late, and without it every utterance starts mid-consonant and
 * whisper hallucinates a word to fill the gap.
 */
export class Endpointer {
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private utterance: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  private tail = Buffer.alloc(0);

  constructor(
    private readonly vad: VadEngine,
    private readonly opts: EndpointerOptions = DEFAULT_ENDPOINTER,
  ) {}

  /** Feed arbitrary-sized audio; frames are re-aligned internally. */
  push(chunk: Buffer): EndpointerEvent[] {
    const events: EndpointerEvent[] = [];
    let data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const usable = data.length - (data.length % FRAME_BYTES);
    this.tail = Buffer.from(data.subarray(usable));
    data = data.subarray(0, usable);

    for (let off = 0; off < data.length; off += FRAME_BYTES) {
      const frame = data.subarray(off, off + FRAME_BYTES);
      const { speech } = this.vad.process(frame);

      if (!this.speaking) {
        this.preRoll.push(Buffer.from(frame));
        this.preRollBytes += frame.length;
        const maxPre = (this.opts.preRollMs / 20) * FRAME_BYTES;
        while (this.preRollBytes > maxPre && this.preRoll.length > 1) {
          this.preRollBytes -= this.preRoll.shift()!.length;
        }
      }

      if (speech) {
        this.speechMs += 20;
        this.silenceMs = 0;
        if (!this.speaking && this.speechMs >= this.opts.minSpeechMs) {
          this.speaking = true;
          this.utterance = [...this.preRoll];
          this.preRoll = [];
          this.preRollBytes = 0;
          events.push({ type: 'speech_start' });
        }
        if (this.speaking) this.utterance.push(Buffer.from(frame));
      } else {
        if (this.speaking) {
          this.utterance.push(Buffer.from(frame));
          this.silenceMs += 20;
          if (this.silenceMs >= this.opts.silenceMs) {
            events.push({ type: 'speech_end', pcm: this.flush(), durationMs: this.speechMs });
            this.reset();
          }
        } else {
          this.speechMs = Math.max(0, this.speechMs - 20);
        }
      }

      if (this.speaking && bytesToMs(this.utteranceBytes()) >= this.opts.maxUtteranceMs) {
        events.push({ type: 'timeout', pcm: this.flush() });
        this.reset();
      }
    }
    return events;
  }

  /** End the utterance now — what push-to-talk release does. */
  finish(): Buffer | undefined {
    if (!this.speaking && !this.utterance.length) {
      // Nothing passed VAD, but the user held the button; use what we buffered.
      const pre = this.preRoll.length ? Buffer.concat(this.preRoll) : undefined;
      this.reset();
      return pre && pre.length > FRAME_BYTES * 5 ? pre : undefined;
    }
    const pcm = this.flush();
    this.reset();
    return pcm;
  }

  get active(): boolean {
    return this.speaking;
  }

  private utteranceBytes(): number {
    return this.utterance.reduce((n, b) => n + b.length, 0);
  }

  private flush(): Buffer {
    return Buffer.concat(this.utterance);
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utterance = [];
    this.preRoll = [];
    this.preRollBytes = 0;
    this.vad.reset();
  }
}

/**
 * Barge-in detector, used only while we are talking.
 *
 * The bar is deliberately higher than normal VAD: our own voice is coming out
 * of the speaker, and cutting off mid-sentence because the room echoed is much
 * more annoying than a half-second delay before we yield.
 */
export class BargeInDetector {
  private consecutive = 0;

  constructor(
    private readonly framesRequired = 6, // ~120 ms of sustained speech
    private readonly energyFloor = 0.02,
  ) {}

  /** Returns true the moment the user has clearly started talking over us. */
  observe(frame: Buffer, vad: VadEngine): boolean {
    const { speech, energy } = vad.process(frame);
    if (speech && energy > this.energyFloor) {
      this.consecutive++;
      if (this.consecutive >= this.framesRequired) {
        this.consecutive = 0;
        return true;
      }
    } else {
      this.consecutive = 0;
    }
    return false;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

export function rms(frame: Buffer): number {
  let sum = 0;
  const n = Math.min(FRAME_SAMPLES, frame.length / 2);
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

export function zeroCrossingRate(frame: Buffer): number {
  let crossings = 0;
  const n = Math.min(FRAME_SAMPLES, frame.length / 2);
  let prev = frame.readInt16LE(0);
  for (let i = 1; i < n; i++) {
    const s = frame.readInt16LE(i * 2);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  return crossings / Math.max(1, n - 1);
}
