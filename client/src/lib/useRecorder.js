import { useCallback, useEffect, useRef, useState } from 'react';

// A voice note: Sales & purchase, and the Mail routing rules spoken instead of typed.

/** Tap to start, tap to stop. onDone gets the recording; it stops by itself after max seconds. */
export function useRecorder(onDone, max = 120) {
  const [secs, setSecs] = useState(null); // null when not recording
  const live = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;

  const stop = useCallback((keep = true) => {
    const r = live.current;
    if (!r) return;
    live.current = null;
    clearInterval(r.timer);
    r.rec.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(r.parts, { type: r.rec.mimeType || 'audio/webm' });
      if (keep && blob.size) done.current(blob);
    };
    r.rec.state === 'inactive' ? r.rec.onstop() : r.rec.stop();
    setSecs(null);
  }, []);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch(() => null);
    if (!stream) throw new Error('The microphone is not available. Allow it in your browser settings.');
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.start(1000);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      s >= max ? stop() : setSecs(s);
    }, 250);
    live.current = { rec, stream, parts, timer };
    setSecs(0);
  }, [stop, max]);

  useEffect(() => () => stop(false), [stop]); // leaving the page lets go of the microphone
  return { secs, recording: secs !== null, start, stop };
}
