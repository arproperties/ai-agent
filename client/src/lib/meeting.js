// Recording a meeting.
//
// The microphone stays open for the whole meeting, but the recording is cut into
// ten-minute pieces, each a complete file of its own, and every piece is uploaded the
// moment it ends. So the server starts turning speech into text while the meeting is
// still going, and a phone that dies at 1h50 has already sent 1h40 of it.

const PIECE_MS = 10 * 60 * 1000;
const RETRY_MS = [3000, 10000, 30000, 60000];

const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';

async function send(path, form) {
  const res = await fetch(`/api${path}`, { method: 'POST', body: form });
  if (res.status === 401) window.dispatchEvent(new Event('jarvis:signedout'));
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Starts recording meeting `meetingId`. onChange({ elapsed, waiting, failed, level }) is
 * called as things move. Resolves once the microphone is open, with { stop }.
 */
export async function recordMeeting(meetingId, onChange) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }).catch(() => { throw new Error('Microphone not available. Allow mic access in your browser settings.'); });

  const mimeType = pickType();
  const startedAt = Date.now();
  const queue = [];
  let seq = 0;
  let rec = null;
  let timer = null;
  let uploading = false;
  let failed = 0;
  let stopped = false;
  let level = 0;
  let wake = null;

  const report = () => onChange?.({ elapsed: (Date.now() - startedAt) / 1000, waiting: queue.length, failed, level });

  // ---------- uploads, one at a time and in order, retrying until they get through ----------
  let drained = null;
  const pump = async () => {
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      const piece = queue[0];
      const form = new FormData();
      form.append('seq', piece.seq);
      form.append('offset', piece.offset);
      form.append('audio', piece.blob, `part-${piece.seq}.${piece.blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      try {
        await send(`/meetings/${meetingId}/parts`, form);
        queue.shift();
      } catch (e) {
        // A 4xx other than a timeout will never succeed: drop it rather than block the rest.
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) { queue.shift(); failed++; } else {
          await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(piece.tries, RETRY_MS.length - 1)]));
          piece.tries++;
        }
      }
      report();
    }
    uploading = false;
    drained?.();
  };

  // ---------- recording, in pieces ----------
  const startPiece = () => {
    const parts = [];
    const offset = (Date.now() - startedAt) / 1000;
    const r = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    const n = seq++;
    r.ondataavailable = (e) => e.data.size && parts.push(e.data);
    r.onstop = () => {
      const blob = new Blob(parts, { type: r.mimeType || 'audio/webm' });
      if (blob.size > 2000) { queue.push({ seq: n, offset, blob, tries: 0 }); pump(); }
      report();
    };
    r.start(15000); // hand over data every 15 s, so a stop never waits on one huge buffer
    rec = r;
    timer = setTimeout(() => { if (!stopped) { rec.stop(); startPiece(); } }, PIECE_MS);
  };

  // ---------- keep the screen on: a locked phone stops the microphone ----------
  const holdScreen = async () => {
    try { if (!stopped && document.visibilityState === 'visible') wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  };
  document.addEventListener('visibilitychange', holdScreen);
  holdScreen();

  // ---------- a live level, so it is obvious the microphone hears the room ----------
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    level = Math.sqrt(sum / buf.length);
    report();
  }, 250);

  startPiece();
  report();

  return {
    /** Ends the recording and waits for every piece to reach the server. Returns seconds recorded. */
    async stop() {
      if (stopped) return 0;
      stopped = true;
      clearTimeout(timer);
      clearInterval(meter);
      const last = new Promise((r) => { const prev = rec.onstop; rec.onstop = () => { prev(); r(); }; });
      rec.stop();
      await last;
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      document.removeEventListener('visibilitychange', holdScreen);
      wake?.release().catch(() => {});
      if (queue.length || uploading) await new Promise((r) => { drained = r; pump(); });
      return (Date.now() - startedAt) / 1000;
    },
  };
}

/** A few seconds of one person talking, as a data URL — the form the server keeps it in. */
export async function recordSample(seconds, onTick) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .catch(() => { throw new Error('Microphone not available. Allow mic access in your browser settings.'); });
  const mimeType = pickType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start();
  for (let left = seconds; left > 0; left--) {
    onTick?.(left);
    await new Promise((r) => setTimeout(r, 1000));
  }
  rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(parts, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read the recording'));
    fr.readAsDataURL(blob);
  });
}
