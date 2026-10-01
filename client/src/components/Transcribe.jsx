import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Mic, Square, Upload, Loader2, Trash2, Pencil, Copy, Check, AlertTriangle, X } from 'lucide-react';
import { api } from '../lib/api';
import { ParticleField } from './ParticleField';

// Transcribe: any audio in, the words out. Upload a file (a WhatsApp voice note, a phone
// memo) or record straight into Reem. The work happens on the server
// (server/transcripts.js); this page sends the audio and shows the text.

// Anything a phone might hand over. iOS greys out files that match nothing here, and it
// does not count .opus as audio/*, so the extensions are listed as well.
const ACCEPT = 'audio/*,video/*,.opus,.ogg,.oga,.m4a,.aac,.amr,.caf,.mp3,.wav,.webm,.mp4,.mov,.3gp';

const clock = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const dated = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const titleOf = (t) => t.title || `${t.source === 'recording' ? 'Recording' : 'Audio'}, ${dated(t.created_at)}`;

async function send(blob, name, source) {
  const form = new FormData();
  form.append('source', source);
  form.append('audio', blob, name);
  return api.upload('/transcripts', form);
}

// ---------- recording ----------
async function startRecording(onTick) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }).catch(() => { throw new Error('Microphone not available. Allow mic access in your browser settings.'); });
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start(1000);
  const startedAt = Date.now();
  const timer = setInterval(() => onTick((Date.now() - startedAt) / 1000), 250);
  const end = () => new Promise((resolve) => {
    clearInterval(timer);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
    };
    rec.state === 'inactive' ? rec.onstop() : rec.stop();
  });
  return { stop: end, cancel: () => end() };
}

function Recording({ recorder, elapsed, onDone, onCancel }) {
  const [sending, setSending] = useState(false);
  const stop = async () => {
    setSending(true);
    await onDone(await recorder.stop());
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="relative grid size-40 place-items-center">
        <span className="absolute inset-0 animate-pulse rounded-full bg-bad/20" />
        <span className="relative grid size-28 place-items-center rounded-full bg-bad/30 text-bad"><Mic size={42} /></span>
      </div>
      <p className="font-mono text-5xl font-light tabular-nums">{clock(elapsed)}</p>
      <p className="max-w-xs text-sm text-mute">Speak normally. Keep Reem open until you tap Stop.</p>
      <div className="flex gap-3">
        <button onClick={onCancel} disabled={sending}
          className="flex items-center gap-2 rounded-full border border-stroke px-6 py-3.5 text-mute hover:text-txt disabled:opacity-40">
          <X size={16} /> Cancel
        </button>
        <button onClick={stop} disabled={sending}
          className="flex items-center gap-2 rounded-full bg-bad px-8 py-3.5 font-medium text-white shadow-lg shadow-bad/25 transition active:scale-[0.98] disabled:opacity-60">
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Square size={16} fill="currentColor" />} Stop
        </button>
      </div>
    </div>
  );
}

// ---------- one transcript ----------
function Detail({ id, onDeleted }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.get(`/transcripts/${id}`).then(setT).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (t?.status !== 'processing') return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [t, load]);

  if (error) return <p className="p-6 text-bad">{error}</p>;
  if (!t) return <div className="grid flex-1 place-items-center"><Loader2 className="animate-spin text-mute" /></div>;

  const rename = async () => {
    const title = prompt('Title', t.title);
    if (title === null) return;
    setT(await api.patch(`/transcripts/${t.id}`, { title }));
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(t.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const remove = async () => {
    if (!confirm('Delete this transcript?')) return;
    await api.del(`/transcripts/${t.id}`);
    onDeleted();
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
      <div className="mx-auto w-full space-y-4 pb-8">
        <div>
          <button onClick={rename} className="group flex items-start gap-2 text-left">
            <h2 className="text-xl font-light">{titleOf(t)}</h2>
            <Pencil size={14} className="mt-1.5 shrink-0 text-mute opacity-60 group-hover:opacity-100" />
          </button>
          <p className="text-sm text-mute">{dated(t.created_at)}{t.duration_s ? ` · ${clock(t.duration_s)}` : ''}</p>
        </div>

        {t.status === 'processing' && (
          <div className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-4 text-sm text-mute">
            <Loader2 size={18} className="shrink-0 animate-spin" />
            Turning it into text… A voice note takes a few seconds, an hour-long file a minute or two. You can leave this page.
          </div>
        )}
        {t.error && (
          <div className="flex gap-3 rounded-2xl bg-bad/10 p-4 text-sm">
            <AlertTriangle size={18} className="shrink-0 text-bad" /> <span>{t.error}</span>
          </div>
        )}
        {t.text && (
          <section className="rounded-3xl border border-stroke bg-white/[0.04] p-5">
            {/* dir="auto": an Arabic voice note reads right to left, an English one left to right. */}
            <p dir="auto" className="whitespace-pre-wrap leading-relaxed">{t.text}</p>
          </section>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          {t.text && (
            <button onClick={copy} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
              {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy text'}
            </button>
          )}
          <button onClick={remove} className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-bad">
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- the page ----------
export default function TranscribePage({ onBack }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null); // a transcript id
  const [recorder, setRecorder] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const recRef = useRef(null);
  recRef.current = recorder;

  const load = useCallback(() => api.get('/transcripts').then(setList).catch(() => setList((l) => l || [])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { recRef.current?.cancel(); }, []);
  useEffect(() => {
    if (!recorder) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recorder]);

  const submit = async (blob, name, source) => {
    setBusy(true); setError('');
    try { setOpen((await send(blob, name, source)).id); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const pick = (file) => file && submit(file, file.name, 'upload');
  const record = async () => {
    setError(''); setElapsed(0);
    try { setRecorder(await startRecording(setElapsed)); } catch (e) { setError(e.message); }
  };
  const recorded = async (blob) => {
    setRecorder(null);
    if (blob.size < 1000) return setError('Nothing was recorded. Try again.');
    await submit(blob, `recording.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, 'recording');
  };
  const cancel = async () => { await recorder.cancel(); setRecorder(null); };
  const back = () => {
    if (recorder) return;
    if (open) { setOpen(null); load(); } else onBack();
  };

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <ParticleField className="fx-canvas-panel" />
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={back} disabled={!!recorder} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-30">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Transcribe</h1>
        </div>
      </header>

      {recorder ? (
        <Recording recorder={recorder} elapsed={elapsed} onDone={recorded} onCancel={cancel} />
      ) : open ? (
        <Detail id={open} onDeleted={() => { setOpen(null); load(); }} />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
          <div className="mx-auto w-full space-y-6 pb-8">
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="flex flex-col items-center gap-2 rounded-3xl border border-stroke bg-white/[0.04] px-3 py-6 transition hover:bg-white/[0.07] active:scale-[0.98] disabled:opacity-50">
                {busy ? <Loader2 size={26} className="animate-spin text-p1" /> : <Upload size={26} className="text-p1" />}
                <span className="font-medium">Upload audio</span>
                <span className="text-xs text-mute">Voice note or any sound file</span>
              </button>
              <button onClick={record} disabled={busy}
                className="flex flex-col items-center gap-2 rounded-3xl border border-stroke bg-white/[0.04] px-3 py-6 transition hover:bg-white/[0.07] active:scale-[0.98] disabled:opacity-50">
                <Mic size={26} className="text-bad" />
                <span className="font-medium">Record</span>
                <span className="text-xs text-mute">Speak, then tap Stop</span>
              </button>
            </div>
            <input ref={fileRef} type="file" hidden accept={ACCEPT} onChange={(e) => { pick(e.target.files[0]); e.target.value = ''; }} />
            {error && <p className="text-sm text-bad">{error}</p>}
            <p className="px-1 text-xs text-mute">
              From WhatsApp: press and hold the voice note, tap Share (or Forward, then Share), and save it to Files. Then tap Upload audio here.
            </p>

            <section>
              <h2 className="px-1 pb-2 text-[11px] font-medium tracking-[0.14em] text-mute">PAST TRANSCRIPTS</h2>
              {list === null ? <Loader2 className="mx-auto animate-spin text-mute" />
                : list.length === 0 ? <p className="px-1 text-sm text-mute">Nothing yet.</p>
                : (
                  <ul className="space-y-1">
                    {list.map((t) => (
                      <li key={t.id}>
                        <button onClick={() => setOpen(t.id)} className="w-full rounded-2xl px-3 py-3 text-left transition hover:bg-white/5">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">{titleOf(t)}</span>
                            {t.status === 'processing' && <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Working…</span>}
                            {t.status === 'failed' && <span className="shrink-0 rounded-full bg-bad/20 px-2 py-0.5 text-[11px] text-bad">Failed</span>}
                          </span>
                          <span className="block text-xs text-mute">{dated(t.created_at)}{t.duration_s ? ` · ${clock(t.duration_s)}` : ''}</span>
                          {t.preview && <span dir="auto" className="mt-1 line-clamp-2 block text-sm text-mute">{t.preview}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
