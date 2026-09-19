import { api } from './api';

// One shared <audio>, unlocked on a user tap, so iOS lets us play replies that arrive later.
const audio = typeof Audio !== 'undefined' ? new Audio() : null;
let unlocked = false;

function silentWav() {
  const buf = new ArrayBuffer(44 + 800), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + 800, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, 800, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function unlockAudio() {
  if (unlocked || !audio) return;
  unlocked = true;
  audio.src = silentWav();
  audio.play().catch(() => { unlocked = false; });
}

// The reply being read right now. Held so a second tap can pause or cancel it
// instead of starting a rival request.
let current = null;

const tell = (job, state) => { if (current === job) job.onState(state); };

export function stopSpeaking() {
  if (!audio || !current) return;
  const job = current;
  current = null;          // before load(), so the abort doesn't report an error
  audio.pause();
  audio.removeAttribute('src');
  audio.load();            // drops whatever is still downloading
  job.onState('idle');
  job.onDone?.();          // lets anything awaiting this reply carry on
}

// Tap while it is playing: pause. Tap again: carry on where it left off.
export function togglePause() {
  if (!audio || !current) return;
  if (audio.paused) audio.play().then(() => tell(current, 'speaking')).catch(() => {});
  else { audio.pause(); tell(current, 'paused'); }
}

// One request can only carry so much text, so a long reply is read in pieces.
// The limit is deliberately close to the server's own cap: most replies stay a
// single piece and play without a seam, and only a very long one is split — at a
// sentence end, where a short pause sounds natural anyway.
const CHUNK = 3500;

export function splitForSpeech(text) {
  const out = [];
  let rest = text.trim();
  while (rest.length > CHUNK) {
    const window = rest.slice(0, CHUNK);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'));
    const space = window.lastIndexOf(' ');
    // A sentence end reads best, a word break will do — and failing both, cut at
    // the limit: text with no spaces at all (a long URL, or a language that does
    // not space its words) must still be split rather than silently truncated.
    const at = sentence > CHUNK / 2 ? sentence + 1 : space > CHUNK / 2 ? space : CHUNK;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Registering a piece returns the key its audio is served under. Doing this
// early is free — the speech itself is only generated when the audio is fetched.
async function keyFor(job, i) {
  const piece = job.chunks[i];
  if (!piece) return null;
  piece.key ??= (await api.post('/voice/speak', { text: piece.text, agentId: job.agentId })).key;
  return piece.key;
}

// Warm the next piece while this one plays, so they run together without a gap.
// Only ever one ahead, so at most one piece is generated that is never heard.
function warmNext(job, i) {
  if (!job.chunks[i] || job.chunks[i].warmed) return;
  job.chunks[i].warmed = true;
  keyFor(job, i)
    .then((key) => key && fetch(`/api/voice/speak/${key}`).catch(() => {}))
    .catch(() => {});
}

async function playFrom(job) {
  const key = await keyFor(job, job.at);
  if (current !== job || !key) return;
  job.playing = true;
  audio.src = `/api/voice/speak/${key}`;
  await audio.play();
  warmNext(job, job.at + 1);
}

function advance(job) {
  if (current !== job) return;
  job.at++;
  if (job.at < job.chunks.length) {
    playFrom(job).catch(() => { tell(job, 'error'); if (current === job) current = null; });
    return;
  }
  job.playing = false;
  if (job.streaming) return tell(job, 'loading'); // the reply is still being written
  tell(job, 'idle');
  current = null;
  job.onDone?.();
}

function attach(job) {
  audio.onplaying = () => tell(job, 'speaking');
  audio.onwaiting = () => tell(job, 'loading');
  audio.onerror = () => { tell(job, 'error'); if (current === job) { current = null; job.onDone?.(); } };
  audio.onended = () => advance(job);
}

export async function speakText(text, agentId, onState) {
  if (!audio) return;
  stopSpeaking();
  const chunks = splitForSpeech(String(text || '')).map((t) => ({ text: t }));
  if (!chunks.length) return;
  const job = { onState, agentId, chunks, at: 0, streaming: false };
  current = job;
  onState('loading');
  try {
    attach(job);
    await playFrom(job);
  } catch (e) {
    if (current !== job) return; // another reply took over; this one's state is already cleared
    current = null;
    onState('idle');
    throw e;
  }
}

// Enough text to be worth a request of its own. Each piece costs about a second
// of start-up, so very short fragments would stutter more than they save.
const MIN_SPEAK = 90;

// The longest run of finished sentences in `text`, or null if there isn't
// enough yet. Markdown lists rarely end in a full stop, so line breaks count too.
function completeSentences(text) {
  const limit = Math.min(text.length, CHUNK);
  let end = -1;
  for (let i = 0; i < limit; i++) {
    const c = text[i];
    if (c === '\n' || ((c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] || ' '))) end = i + 1;
  }
  return end >= MIN_SPEAK ? text.slice(0, end) : null;
}

/**
 * Speaks a reply while it is still being written. Feed it the text so far as it
 * streams: the opening sentences are read as soon as they exist instead of
 * waiting for the last word, which is most of the wait in a spoken reply.
 */
export function speakAsItArrives(agentId, onState) {
  stopSpeaking();
  const job = { onState, agentId, chunks: [], at: 0, streaming: true, playing: false };
  current = job;
  onState('loading');
  attach(job);

  let taken = 0; // how much of the reply has been handed over to be spoken
  const queue = (text) => {
    job.chunks.push({ text: text.trim() });
    // nothing is playing: either this is the first piece, or we ran out of text
    if (!job.playing && current === job) {
      job.at = job.chunks.length - 1;
      playFrom(job).catch(() => { tell(job, 'error'); if (current === job) current = null; });
    } else {
      warmNext(job, job.at + 1);
    }
  };

  return {
    done: new Promise((resolve) => { job.onDone = resolve; }),
    /** Call with the whole reply so far, each time it grows. */
    feed(replySoFar) {
      if (current !== job) return;
      const ready = completeSentences(replySoFar.slice(taken));
      if (!ready) return;
      taken += ready.length;
      queue(ready);
    },
    /** No more text is coming: speak whatever is left, then finish. */
    end(replySoFar) {
      if (current !== job) return;
      const rest = replySoFar.slice(taken).trim();
      taken = replySoFar.length;
      job.streaming = false;
      if (rest) splitForSpeech(rest).forEach(queue);
      else if (!job.playing) advance(job); // nothing left to say
    },
  };
}

/** speakText, but resolves only once the whole reply has finished playing. */
export function speakAndWait(text, agentId, onState = () => {}) {
  return new Promise((resolve, reject) => {
    speakText(text, agentId, (state) => {
      onState(state);
      if (state === 'idle' || state === 'error') resolve(state);
    }).catch(reject);
  });
}

// ---------- hands-free listening (live voice mode) ----------
// Ends the turn on its own, so nobody has to touch the phone: once speech has
// been heard, a short stretch of quiet means they have finished talking.
const SILENCE_MS = 1500;   // quiet after speech that ends the turn. Every extra
                           // moment here is dead air before the reply starts.
const MIN_SPEECH_MS = 350; // shorter than this is a cough, not a question
const MAX_TURN_MS = 60000; // hard stop, so a hot mic can never run forever

let listening = null;

/** Give up on the turn entirely — nothing is sent. */
export function stopListening() {
  listening?.abort();
}

/** Stop waiting for silence and send what has been said so far. */
export function finishListening() {
  listening?.finish();
}

/**
 * Records until the speaker stops, then transcribes.
 * Resolves with the text, or '' if nothing was actually said.
 */
export function listenUntilSilence({ onLevel, onCaptured } = {}) {
  stopListening();
  return new Promise((resolve, reject) => {
    let stream, ctx, rec, raf, done = false, spoke = false;
    const parts = [];

    const cleanup = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      if (listening?.abort === abort) listening = null;
    };
    const abort = () => {
      if (done) return;
      done = true;
      if (rec?.state !== 'inactive') { rec.onstop = null; rec?.stop(); }
      cleanup();
      resolve(''); // treated as "said nothing"
    };
    // Tapped to stop: send what was captured, even if it was quiet enough that
    // the level meter never counted it as speech.
    const finish = () => {
      if (done) return;
      if (!rec || rec.state === 'inactive') return abort(); // nothing recorded yet
      done = true;
      spoke = true;
      cancelAnimationFrame(raf);
      rec.stop(); // its onstop transcribes and resolves
    };
    listening = { abort, finish };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (done) return cleanup();

        const mimeType = ['audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
        rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
        rec.onstop = async () => {
          cleanup();
          onCaptured?.(); // recording is over; transcription is about to start
          const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
          if (!spoke || blob.size < 1200) return resolve(''); // nothing worth sending
          try {
            const form = new FormData();
            form.append('audio', blob, `voice.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
            const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
            const data = await res.json();
            if (res.status === 401) window.dispatchEvent(new Event('jarvis:signedout'));
            if (!res.ok) throw new Error(data.error || 'Transcription failed');
            resolve(data.text.trim());
          } catch (e) { reject(e); }
        };
        rec.start();

        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);

        const startedAt = Date.now();
        let floor = 0.008;   // adapts to the room's background noise
        let speechAt = null;
        let quietAt = null;

        const tick = () => {
          if (done) return;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const level = Math.sqrt(sum / buf.length);
          onLevel?.(level);

          const elapsed = Date.now() - startedAt;
          const loud = level > Math.max(floor * 2.5, 0.012);
          if (!loud) floor = floor * 0.95 + level * 0.05; // learn the quiet baseline

          if (loud) {
            speechAt ??= Date.now();
            quietAt = null;
            if (Date.now() - speechAt > MIN_SPEECH_MS) spoke = true;
          } else if (spoke) {
            quietAt ??= Date.now();
            if (Date.now() - quietAt > SILENCE_MS) { done = true; rec.stop(); return; }
          }
          if (elapsed > MAX_TURN_MS) { done = true; rec.stop(); return; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        done = true;
        cleanup();
        reject(new Error('Microphone not available. Allow mic access in your browser settings.'));
      }
    })();
  });
}
