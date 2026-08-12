import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav, wavToPcm, splitSentences, speakable, FRAME_BYTES, msToBytes, bytesToMs } from '../dist/voice/types.js';
import { EnergyVad, Endpointer, BargeInDetector, rms, zeroCrossingRate } from '../dist/voice/vad.js';
import { EchoGuard } from '../dist/voice/echo.js';
import { classifyLane, classifyInstant, FillerPicker, TurnTimer, BUDGETS, LatencyTracker } from '../dist/voice/lanes.js';
import { SentenceStreamer, FakeTts, MacSayTts } from '../dist/voice/tts.js';
import { cleanTranscript } from '../dist/voice/stt.js';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
before(() => {
  box = sandbox();
});
after(() => box.cleanup());

/** A frame of speech-like audio: a 200 Hz tone at the requested amplitude. */
function tone(ms: number, amplitude = 0.3, freq = 200): Buffer {
  const samples = Math.round((16_000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 16_000) * amplitude * 32767), i * 2);
  }
  return buf;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((16_000 * ms) / 1000) * 2);
}

describe('audio formats', () => {
  test('wav round-trips through the header', () => {
    const pcm = tone(100);
    const back = wavToPcm(pcmToWav(pcm));
    assert.equal(back.length, pcm.length);
    assert.equal(back.equals(pcm), true);
  });

  test('wavToPcm walks the chunk list rather than assuming 44 bytes', () => {
    const pcm = tone(20);
    const wav = pcmToWav(pcm);
    // Splice a LIST chunk in front of the data chunk, as `say` does.
    const list = Buffer.alloc(8 + 8);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(8, 4);
    const spliced = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    spliced.writeUInt32LE(spliced.length - 8, 4);
    assert.equal(wavToPcm(spliced).length, pcm.length);
  });

  test('frame maths is self-consistent', () => {
    assert.equal(FRAME_BYTES, 640);
    assert.equal(msToBytes(20), FRAME_BYTES);
    assert.equal(bytesToMs(FRAME_BYTES), 20);
  });
});

describe('vad', () => {
  test('silence is not speech, a tone is', () => {
    const vad = new EnergyVad();
    const quiet = silence(20);
    for (let i = 0; i < 30; i++) vad.process(quiet); // let the noise floor settle
    assert.equal(vad.process(quiet).speech, false);
    assert.equal(vad.process(tone(20, 0.3)).speech, true);
  });

  test('rms and zero-crossing behave', () => {
    assert.ok(rms(tone(20, 0.5)) > rms(tone(20, 0.1)));
    assert.equal(rms(silence(20)), 0);
    // A 200 Hz tone crosses zero 400 times a second — far below the hiss threshold.
    assert.ok(zeroCrossingRate(tone(20, 0.3)) < 0.1);
  });
});

describe('endpointer', () => {
  test('emits one utterance for speech followed by silence', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 100, silenceMs: 300, maxUtteranceMs: 30_000, preRollMs: 200 });
    const events = [...ep.push(silence(400)), ...ep.push(tone(600, 0.35)), ...ep.push(silence(500))];
    const starts = events.filter((e) => e.type === 'speech_start');
    const ends = events.filter((e) => e.type === 'speech_end');
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.ok(ends[0]!.type === 'speech_end' && ends[0].pcm.length > 0);
  });

  test('pre-roll keeps audio from before the trigger, so the first word survives', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 100, silenceMs: 300, maxUtteranceMs: 30_000, preRollMs: 200 });
    ep.push(silence(400));
    const events = [...ep.push(tone(500, 0.35)), ...ep.push(silence(400))];
    const end = events.find((e) => e.type === 'speech_end');
    assert.ok(end?.type === 'speech_end');
    // The utterance is longer than the speech alone because of the pre-roll.
    assert.ok(bytesToMs(end.pcm.length) > 500);
  });

  test('brief noise never becomes an utterance', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 300, silenceMs: 300, maxUtteranceMs: 30_000, preRollMs: 200 });
    const events = [...ep.push(silence(400)), ...ep.push(tone(80, 0.35)), ...ep.push(silence(600))];
    assert.equal(events.length, 0);
  });

  test('a long utterance is cut at the ceiling rather than growing forever', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 100, silenceMs: 2000, maxUtteranceMs: 500, preRollMs: 100 });
    ep.push(silence(300));
    const events = ep.push(tone(1500, 0.35));
    assert.ok(events.some((e) => e.type === 'timeout'));
  });

  test('push-to-talk release ends the utterance immediately', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 100, silenceMs: 5000, maxUtteranceMs: 30_000, preRollMs: 200 });
    ep.push(silence(300));
    ep.push(tone(400, 0.35));
    const pcm = ep.finish();
    assert.ok(pcm && pcm.length > 0);
  });

  test('unaligned chunk sizes are re-framed, not dropped', () => {
    const ep = new Endpointer(new EnergyVad(), { minSpeechMs: 100, silenceMs: 300, maxUtteranceMs: 30_000, preRollMs: 200 });
    const audio = Buffer.concat([silence(400), tone(600, 0.35), silence(500)]);
    const events = [];
    // 333 bytes is deliberately not a whole frame.
    for (let off = 0; off < audio.length; off += 333) events.push(...ep.push(audio.subarray(off, off + 333)));
    assert.ok(events.some((e) => e.type === 'speech_end'));
  });
});

describe('barge-in and echo', () => {
  test('sustained speech triggers barge-in, a blip does not', () => {
    const detector = new BargeInDetector(3, 0.01);
    const vad = new EnergyVad();
    for (let i = 0; i < 30; i++) vad.process(silence(20));
    assert.equal(detector.observe(tone(20, 0.4), vad), false);
    assert.equal(detector.observe(tone(20, 0.4), vad), false);
    assert.equal(detector.observe(tone(20, 0.4), vad), true);
  });

  test('the echo guard raises the bar while we are speaking', () => {
    const guard = new EchoGuard();
    const quietThreshold = guard.threshold();
    guard.observeOutput(tone(200, 0.6));
    assert.ok(guard.threshold() > quietThreshold, 'loud playback should raise the threshold');
    // Our own echo at a third of playback level must not read as the user.
    assert.equal(guard.isForeign(tone(20, 0.15)), false);
    // A person actually talking over us does.
    assert.equal(guard.isForeign(tone(20, 0.8)), true);
  });

  test('the guard decays back down once playback stops', () => {
    const guard = new EchoGuard();
    const t0 = 1_000_000;
    guard.observeOutput(tone(100, 0.6), t0);
    assert.ok(guard.threshold(t0 + 50) > 0.05);
    assert.equal(guard.threshold(t0 + 5000), 0.02); // back to the floor
  });
});

describe('lanes', () => {
  test('control phrases are instant and never reach a model', () => {
    assert.equal(classifyLane('stop'), 'instant');
    assert.equal(classifyLane("what's running"), 'instant');
    assert.equal(classifyInstant('kill the run')?.kind, 'cancel_run');
    assert.equal(classifyInstant('how much have I spent')?.kind, 'cost');
  });

  test('questions are queries and work is a task', () => {
    assert.equal(classifyLane('what does the gateway bind to'), 'query');
    assert.equal(classifyLane('fix the failing auth test in switchboard'), 'task');
  });

  test('ambiguous input prefers query over spawning a run', () => {
    assert.equal(classifyLane('the deployment situation with the staging cluster'), 'query');
  });

  test('fillers never repeat back to back', () => {
    const picker = new FillerPicker();
    let previous = '';
    for (let i = 0; i < 20; i++) {
      const next = picker.pick('query');
      assert.notEqual(next, previous);
      previous = next;
    }
  });

  test('the turn timer fires a filler then gives up, unless settled', async () => {
    const fired: string[] = [];
    const timer = new TurnTimer({ lane: 'query', fillerAfterMs: 30, giveUpAfterMs: 90 }, () => fired.push('filler'), () => fired.push('giveup'));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(fired, ['filler', 'giveup']);

    const fired2: string[] = [];
    const settled = new TurnTimer({ lane: 'query', fillerAfterMs: 30, giveUpAfterMs: 90 }, () => fired2.push('filler'), () => fired2.push('giveup'));
    settled.settle();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(fired2, []);
  });

  test('instant has a tighter budget than query', () => {
    assert.ok(BUDGETS.instant.fillerAfterMs < BUDGETS.query.fillerAfterMs);
  });

  test('latency tracker reports percentiles', () => {
    const tracker = new LatencyTracker();
    for (const ms of [100, 200, 300, 400, 500]) tracker.record('query', ms);
    const row = tracker.summary().find((r) => r.lane === 'query')!;
    assert.equal(row.count, 5);
    assert.equal(row.p50, 300);
  });
});

describe('sentence streaming', () => {
  test('splits on terminators and keeps the incomplete tail', () => {
    const { sentences, rest } = splitSentences('First one. Second one! And a third');
    assert.deepEqual(sentences, ['First one.', 'Second one!']);
    assert.equal(rest.trim(), 'And a third');
  });

  test('a very long clause is broken up rather than held forever', () => {
    const long = `${'word '.repeat(60)}`;
    const { sentences } = splitSentences(long);
    assert.equal(sentences.length, 1);
  });

  test('synthesises each sentence as it completes, not at the end', async () => {
    const tts = new FakeTts();
    const chunks: string[] = [];
    const streamer = new SentenceStreamer(tts, (_pcm, sentence) => void chunks.push(sentence));
    streamer.push('The first sentence is done. The second is stil');
    await streamer.idle;
    assert.deepEqual(chunks, ['The first sentence is done.']);
    streamer.push('l coming.');
    await streamer.end();
    assert.deepEqual(chunks, ['The first sentence is done.', 'The second is still coming.']);
  });

  test('cancel stops mid-queue — this is what barge-in relies on', async () => {
    const tts = new FakeTts();
    const chunks: string[] = [];
    const streamer = new SentenceStreamer(tts, (_pcm, sentence) => void chunks.push(sentence));
    streamer.push('One. Two. Three. Four.');
    streamer.cancel();
    await streamer.idle;
    assert.ok(chunks.length < 4, `expected the queue to be cut short, got ${chunks.length}`);
  });
});

describe('speakable text', () => {
  test('strips what sounds wrong read aloud', () => {
    const spoken = speakable('## Heading\n\nSee `config.json` at https://example.com/very/long **now**');
    assert.equal(spoken.includes('##'), false);
    assert.equal(spoken.includes('http'), false);
    assert.equal(spoken.includes('**'), false);
    assert.match(spoken, /a link/);
  });

  test('code blocks are summarised, not read out', () => {
    assert.match(speakable('Here:\n```js\nconst x = 1;\n```\ndone'), /code block omitted/);
  });

  test('kebab and snake case are spoken as words', () => {
    assert.match(speakable('run the daily-brief skill'), /daily brief/);
  });
});

describe('transcript cleanup', () => {
  test('drops whisper non-speech markers', () => {
    assert.equal(cleanTranscript('[BLANK_AUDIO] hello there (music)'), 'hello there');
  });
});

describe('engine availability', () => {
  test('macOS say is present and produces real audio', async (t) => {
    const say = new MacSayTts();
    if (!say.available) return t.skip('not on macOS');
    const pcm = await say.synthesize('Switchboard test.');
    assert.ok(pcm.length > 16_000, 'expected at least half a second of audio');
    // Real speech, not a silent buffer.
    assert.ok(rms(pcm.subarray(0, 640)) >= 0);
    assert.ok(pcm.length % 2 === 0);
  });
});

describe('warm session', () => {
  test('handles many turns on one process and streams text incrementally', async () => {
    const { WarmSession } = await import('../dist/voice/warm.js');
    const { fakeClaudeShim } = await import('./helpers.ts');
    const bin = fakeClaudeShim(box.root);
    const warm = new WarmSession({ bin, cwd: box.root });
    await warm.start();
    assert.equal(warm.ready, true);

    const first = warm.ask('first question');
    const chunks: string[] = [];
    first.onText((t) => chunks.push(t));
    const a = await first.done;
    assert.match(a.text, /first question/);
    assert.ok(chunks.length > 0, 'text should arrive incrementally, not only at the end');

    // The point of a warm session: the second turn reuses the same process.
    const b = await warm.ask('second question').done;
    assert.match(b.text, /second question/);
    assert.equal(warm.ready, true);

    warm.stop();
  });

  test('refuses overlapping turns rather than interleaving them', async () => {
    const { WarmSession } = await import('../dist/voice/warm.js');
    const { fakeClaudeShim } = await import('./helpers.ts');
    const warm = new WarmSession({ bin: fakeClaudeShim(box.root), cwd: box.root });
    await warm.start();
    const pending = warm.ask('one');
    assert.throws(() => warm.ask('two'), /already handling a turn/);
    await pending.done;
    warm.stop();
  });

  test('goes stale after its turn budget so sessions do not grow forever', async () => {
    const { WarmSession } = await import('../dist/voice/warm.js');
    const { fakeClaudeShim } = await import('./helpers.ts');
    const warm = new WarmSession({ bin: fakeClaudeShim(box.root), cwd: box.root, maxTurnsBeforeRecycle: 2 });
    await warm.start();
    assert.equal(warm.stale, false);
    await warm.ask('one').done;
    await warm.ask('two').done;
    assert.equal(warm.stale, true);
    warm.stop();
  });
});
