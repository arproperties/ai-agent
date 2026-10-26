import { useRuntime } from './heybuddy/onnx.js';

// "Hey Buddy": the pet listens for its name on this device. Nothing is sent anywhere until the
// wake word is heard; then what was said with it comes back as a WAV clip for Reem to transcribe.
// The models (about 5 MB) and the speech engine are fetched only when someone switches it on.

const BASE = '/heybuddy/';
const MAX_TURN_MS = 30000; // a noisy room can keep the "still talking" detector going for ever

let runtime = null;
function loadRuntime() {
  // Served from public paths (vite.config.js copies the engine there), not bundled: it is big,
  // and most people never switch this on.
  runtime ??= import(/* @vite-ignore */ `${BASE}ort/ort.wasm.min.mjs`).then((ort) => {
    ort.env.wasm.wasmPaths = `${BASE}ort/`;
    ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the app does not have
    useRuntime(ort);
  }).catch((e) => { runtime = null; throw e; });
  return runtime;
}

/**
 * Starts listening. onWake fires the moment "Hey Buddy" is heard; onHeard gets the clip
 * (wake word included) once the speaker goes quiet. Resolves with a function that stops it all.
 */
export async function startWakeWord({ onWake, onHeard, onError }) {
  // Asked up front so a refusal is reported here rather than lost inside the library.
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
    throw new Error('Microphone not available. Allow mic access in your browser settings.');
  });
  probe.getTracks().forEach((t) => t.stop());
  await loadRuntime();
  const { HeyBuddy } = await import('./heybuddy/hey-buddy.js');
  const hb = new HeyBuddy({
    modelPath: `${BASE}hey-buddy.onnx`,
    vadModelPath: `${BASE}silero-vad.onnx`,
    spectrogramModelPath: `${BASE}mel-spectrogram.onnx`,
    embeddingModelPath: `${BASE}speech-embedding.onnx`,
    // Above the library's 0.5: in an office, missing a "Hey Buddy" now and then is better
    // than waking up to every conversation.
    wakeWordThreshold: 0.6,
  });
  hb.batcher.ready.catch((e) => onError?.(e));
  let cap;
  hb.onDetected('hey-buddy', () => {
    onWake?.();
    clearTimeout(cap);
    cap = setTimeout(() => { if (hb.recording) { hb.recording = false; hb.dispatchRecording(); } }, MAX_TURN_MS);
  });
  hb.onRecording((samples) => { clearTimeout(cap); onHeard?.(toWav(samples)); });
  return () => { clearTimeout(cap); hb.stop(); };
}

// "Hey Buddy, what's due today?" comes back from transcription with the wake word in front.
export const withoutWakeWord = (text) =>
  text.replace(/^\W*(?:(?:hey|hi|hay|a|okay|ok)\W+)?(?:buddy|budd?y|body|bodie|birdie)\b\W*/i, '').trim();

// 16 kHz mono floats to a 16-bit WAV, which the transcriber takes as it is.
function toWav(samples, rate = 16000) {
  const v = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => { const x = Math.max(-1, Math.min(1, s)); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); });
  return new Blob([v], { type: 'audio/wav' });
}
