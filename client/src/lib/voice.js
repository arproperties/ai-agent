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

export function stopSpeaking() {
  if (!audio) return;
  audio.pause();
  audio.onended?.();
}

export async function speakText(text, agentId, onState) {
  if (!audio) return;
  stopSpeaking();
  onState('loading');
  try {
    const blob = await api.blob('/voice/speak', { text, agentId });
    audio.src = URL.createObjectURL(blob);
    audio.onended = audio.onpause = () => { audio.onended = audio.onpause = null; onState('idle'); };
    await audio.play();
    onState('speaking');
  } catch (e) {
    onState('idle');
    throw e;
  }
}

// ---------- microphone ----------
let recorder, chunks = [];

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = ['audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
}

export function cancelRecording() {
  if (!recorder) return;
  recorder.onstop = null;
  if (recorder.state !== 'inactive') recorder.stop();
  recorder.stream.getTracks().forEach((t) => t.stop());
  recorder = null;
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recorder) return reject(new Error('Not recording'));
    const rec = recorder;
    rec.onstop = async () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1200) return resolve(''); // too short to be speech
      const form = new FormData();
      form.append('audio', blob, `voice.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      try {
        const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
        const data = await res.json();
        if (res.status === 401) window.dispatchEvent(new Event('jarvis:signedout'));
        if (!res.ok) throw new Error(data.error || 'Transcription failed');
        resolve(data.text.trim());
      } catch (e) { reject(e); }
    };
    rec.stop();
  });
}
