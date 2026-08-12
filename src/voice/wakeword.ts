import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { expandPath } from '../config/load.js';
import { logger } from '../core/logger.js';

const log = logger('voice:wake');

/**
 * Wake word, optional and off by default.
 *
 * Push-to-talk is more reliable, costs nothing, and never fires at the TV. But
 * hands-free is the whole point of voice for some jobs, so openWakeWord is
 * wired in when it's installed: a small Python process holds the mic, and we
 * only see a line on stdout when it fires.
 *
 * The detector runs client-side too — `public/voice.js` can gate on it — but
 * this server-side path is what a mic plugged into the Mac Mini uses.
 */
export interface WakeWordOptions {
  /** Model name openWakeWord knows, e.g. "hey_jarvis", or a path to a .onnx/.tflite. */
  model: string;
  /** Detection threshold; higher means fewer false fires and more missed ones. */
  threshold?: number;
  /** Path to the python that has openwakeword installed. */
  python?: string;
  /** Seconds to keep listening after a fire before requiring the word again. */
  followUpWindowSec?: number;
}

/** The shim we hand to python. Kept inline so there's no file to lose. */
const DETECTOR_SOURCE = `
import sys, json, numpy as np
try:
    from openwakeword.model import Model
except Exception as e:
    print(json.dumps({"error": "openwakeword not installed: %s" % e}), flush=True)
    sys.exit(2)

model_name = sys.argv[1]
threshold = float(sys.argv[2])
model = Model(wakeword_models=[model_name], inference_framework="onnx")
print(json.dumps({"ready": True, "model": model_name}), flush=True)

CHUNK = 1280  # 80ms at 16kHz, what openWakeWord expects
while True:
    raw = sys.stdin.buffer.read(CHUNK * 2)
    if not raw or len(raw) < CHUNK * 2:
        break
    audio = np.frombuffer(raw, dtype=np.int16)
    scores = model.predict(audio)
    for name, score in scores.items():
        if score >= threshold:
            print(json.dumps({"wake": name, "score": float(score)}), flush=True)
            model.reset()
            break
`;

export class WakeWordDetector extends EventEmitter {
  private child: ChildProcess | null = null;
  private ready = false;
  private lastFiredAt = 0;

  constructor(private readonly opts: WakeWordOptions) {
    super();
  }

  static pythonAvailable(python = 'python3'): boolean {
    const candidates = [python, '/opt/homebrew/bin/python3', '/usr/bin/python3'].map(expandPath);
    return candidates.some((p) => existsSync(p));
  }

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  /** Returns false (rather than throwing) when openWakeWord isn't installed. */
  async start(): Promise<boolean> {
    if (this.running) return true;
    const python = this.opts.python ?? 'python3';
    const child = spawn(python, ['-u', '-c', DETECTOR_SOURCE, this.opts.model, String(this.opts.threshold ?? 0.5)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(this.ready), 15_000);
      child.stdout!.setEncoding('utf8');
      let buffered = '';
      child.stdout!.on('data', (chunk: string) => {
        buffered += chunk;
        let nl: number;
        while ((nl = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { ready?: boolean; wake?: string; score?: number; error?: string };
            if (msg.ready) {
              this.ready = true;
              clearTimeout(timeout);
              resolve(true);
            } else if (msg.error) {
              log.warn('wake word unavailable', { error: msg.error });
              clearTimeout(timeout);
              resolve(false);
            } else if (msg.wake) {
              this.fire(msg.wake, msg.score ?? 0);
            }
          } catch {
            /* non-JSON chatter from the model loader */
          }
        }
      });
      child.stderr?.on('data', () => undefined); // openWakeWord is chatty on stderr
      child.on('exit', (code) => {
        this.ready = false;
        this.child = null;
        clearTimeout(timeout);
        this.emit('exit', code);
        resolve(false);
      });
      child.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /** Feed the same PCM16 the VAD sees. */
  push(pcm: Buffer): void {
    const stdin = this.child?.stdin;
    if (!this.ready || !stdin?.writable) return;
    stdin.write(pcm);
  }

  private fire(word: string, score: number): void {
    // One fire per second at most; the model can trigger on consecutive windows.
    if (Date.now() - this.lastFiredAt < 1000) return;
    this.lastFiredAt = Date.now();
    this.emit('wake', { word, score });
  }

  /** True while we're inside the window where follow-ups don't need the word. */
  inFollowUpWindow(): boolean {
    const window = (this.opts.followUpWindowSec ?? 8) * 1000;
    return Date.now() - this.lastFiredAt < window;
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.ready = false;
  }
}

export const WAKE_WORD_HELP = [
  'Wake word is optional — push-to-talk works without it.',
  '  pipx install openwakeword   # or: pip install openwakeword onnxruntime',
  'Then set voice.wakeWord in config.json to a model name, e.g. "hey_jarvis".',
  'Pre-trained models: alexa, hey_mycroft, hey_jarvis. A custom phrase needs training.',
].join('\n');
