// Switchboard voice client.
//
// Captures mic audio, downsamples to 16 kHz mono PCM16, and streams it over a
// WebSocket as binary frames. Text frames on the same socket are JSON control
// messages. Playback is a scheduled queue on a single AudioContext so sentences
// butt up against each other with no gap and can be cut off instantly.

const $ = (sel) => document.querySelector(sel);
const SAMPLE_RATE = 16000;

const ui = {
  state: $('#state'),
  transcript: $('#transcript'),
  talk: $('#talk'),
  level: $('#level'),
  engines: $('#engines'),
  openmic: $('#openmic'),
};

let ws = null;
let audioCtx = null;
let micStream = null;
let micNode = null;
let playbackAt = 0;
let playing = [];
let openMic = false;
let holding = false;
let rejections = 0;

// ------------------------------------------------------------------- UI

function setState(text, cls = '') {
  ui.state.textContent = text;
  ui.state.className = `state ${cls}`;
}

function bubble(text, who) {
  const el = document.createElement('div');
  el.className = `bubble ${who}`;
  el.textContent = text;
  ui.transcript.append(el);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return el;
}

// -------------------------------------------------------------- transport

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // A paired phone authenticates with its own token. It goes in the query
  // string because a WebSocket handshake cannot carry custom headers, and it
  // is required over the tailnet — only a genuinely local request skips it.
  const params = new URLSearchParams({ thread: `voice:${deviceId()}` });
  const token = localStorage.getItem('swb-token');
  if (token) params.set('token', token);
  ws = new WebSocket(`${proto}://${location.host}/voice?${params}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', sampleRate: SAMPLE_RATE }));
    setState('connected');
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return void enqueueAudio(new Int16Array(ev.data));
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'ready':
        ws.hadSession = true;
        ui.engines.textContent = `stt ${msg.sttReady ? 'ready' : 'MISSING'} · tts ${msg.ttsReady ? 'ready' : 'MISSING'}`;
        ui.talk.disabled = false;
        setState('ready');
        break;
      case 'listening':
        setState('listening…', 'live');
        break;
      case 'final':
        bubble(msg.text, 'you');
        break;
      case 'thinking':
        setState(`thinking (${msg.lane})`, 'live');
        break;
      case 'say':
        bubble(msg.text, 'swb');
        setState('speaking', 'speaking');
        break;
      case 'audio_end':
        setState(openMic ? 'listening…' : 'ready', openMic ? 'live' : '');
        break;
      case 'interrupted':
        stopPlayback();
        bubble(msg.reason === 'barge-in' ? '(you interrupted)' : '(stopped)', 'note');
        setState('ready');
        break;
      case 'run_started':
        bubble(`started ${msg.runId}`, 'note');
        break;
      case 'run_finished':
        bubble(`${msg.runId} finished`, 'note');
        break;
      case 'confirm_escalated':
        bubble(`needs approval — sent to ${msg.via}`, 'note');
        break;
      case 'error':
        bubble(msg.message, 'note');
        break;
    }
  };

  ws.onclose = () => {
    ui.talk.disabled = true;
    // A socket that closed without ever reaching `ready` was refused at the
    // handshake — almost always a rejected token. Retrying forever would just
    // hide that, so say so and send the phone back to pairing.
    if (!ws.hadSession) {
      rejections++;
      if (rejections >= 3) {
        setState('not authorised — re-pair this device');
        ui.engines.innerHTML = '<a href="/pair.html">pair this device</a>';
        return;
      }
    } else {
      rejections = 0;
    }
    setState('disconnected — retrying');
    setTimeout(connect, 2000);
  };
}

function deviceId() {
  let id = localStorage.getItem('swb-voice-device');
  if (!id) {
    id = Math.random().toString(36).slice(2, 8);
    localStorage.setItem('swb-voice-device', id);
  }
  return id;
}

// ---------------------------------------------------------------- capture

// The AudioWorklet runs on the audio thread, so downsampling never competes
// with rendering. Inlined as a blob so the page stays two files.
const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${SAMPLE_RATE};
    this.carry = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    // Linear-interpolated decimation. Good enough for speech, and far cheaper
    // than a proper polyphase filter on a phone.
    const outLength = Math.floor((input.length - this.carry) / this.ratio);
    const out = new Int16Array(outLength);
    let pos = this.carry;
    let peak = 0;
    for (let i = 0; i < outLength; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
      const sample = a + (b - a) * frac;
      if (Math.abs(sample) > peak) peak = Math.abs(sample);
      out[i] = Math.max(-32768, Math.min(32767, sample * 32767));
      pos += this.ratio;
    }
    this.carry = pos - input.length;
    if (this.carry < 0) this.carry = 0;
    this.port.postMessage({ pcm: out, peak }, [out.buffer]);
    return true;
  }
}
registerProcessor('capture', Capture);
`;

async function startMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Hardware AEC where the device has it — the single most effective thing
      // we can do about the speaker feeding back into the mic.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  audioCtx = audioCtx ?? new AudioContext();
  await audioCtx.resume();

  const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' });
  await audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));

  const source = audioCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(audioCtx, 'capture');
  micNode.port.onmessage = (ev) => {
    const { pcm, peak } = ev.data;
    ui.level.style.width = `${Math.min(100, peak * 220)}%`;
    if (!ws || ws.readyState !== 1) return;
    if (!openMic && !holding) return;
    ws.send(pcm.buffer);
  };
  source.connect(micNode);
  // A worklet with no downstream connection gets suspended in some browsers;
  // a zero-gain sink keeps it scheduled without making noise.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  micNode.connect(sink).connect(audioCtx.destination);
}

// --------------------------------------------------------------- playback

function enqueueAudio(int16) {
  if (!audioCtx) audioCtx = new AudioContext();
  const float = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;

  const buffer = audioCtx.createBuffer(1, float.length, SAMPLE_RATE);
  buffer.copyToChannel(float, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  // Schedule against a running cursor rather than "now" so consecutive
  // sentences play back-to-back without a click or a gap.
  const now = audioCtx.currentTime;
  playbackAt = Math.max(playbackAt, now + 0.02);
  source.start(playbackAt);
  playbackAt += buffer.duration;
  playing.push(source);
  source.onended = () => {
    playing = playing.filter((s) => s !== source);
  };
}

function stopPlayback() {
  for (const source of playing) {
    try {
      source.stop();
    } catch {
      /* already finished */
    }
  }
  playing = [];
  playbackAt = 0;
}

// --------------------------------------------------------------- controls

async function beginTalk(ev) {
  ev.preventDefault();
  if (ui.talk.disabled) return;
  await startMic();
  // Talking over playback is barge-in; cut ourselves off locally too so the
  // user hears the effect immediately rather than after the server round trip.
  if (playing.length) {
    stopPlayback();
    ws?.send(JSON.stringify({ type: 'interrupt' }));
  }
  holding = true;
  ui.talk.classList.add('held');
  setState('listening…', 'live');
  ws?.send(JSON.stringify({ type: 'start' }));
}

function endTalk(ev) {
  ev?.preventDefault();
  if (!holding) return;
  holding = false;
  ui.talk.classList.remove('held');
  setState('thinking', 'live');
  ws?.send(JSON.stringify({ type: 'stop' }));
}

ui.talk.addEventListener('pointerdown', beginTalk);
ui.talk.addEventListener('pointerup', endTalk);
ui.talk.addEventListener('pointercancel', endTalk);
ui.talk.addEventListener('pointerleave', endTalk);

ui.openmic.addEventListener('change', async () => {
  openMic = ui.openmic.checked;
  ui.talk.classList.toggle('openmic', openMic);
  ui.talk.textContent = openMic ? 'Open mic on' : 'Hold to talk';
  if (openMic) {
    await startMic();
    setState('listening…', 'live');
  } else {
    setState('ready');
  }
});

$('#stopbtn').addEventListener('click', () => {
  stopPlayback();
  ws?.send(JSON.stringify({ type: 'interrupt' }));
});

$('#typeform').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#typed');
  const text = input.value.trim();
  if (!text) return;
  bubble(text, 'you');
  ws?.send(JSON.stringify({ type: 'text', text }));
  input.value = '';
});

// Keep the space bar as push-to-talk on a desktop browser.
document.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !ev.repeat && document.activeElement?.tagName !== 'INPUT') beginTalk(ev);
});
document.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space' && document.activeElement?.tagName !== 'INPUT') endTalk(ev);
});

connect();
