import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, X, AlertTriangle, Camera, ImagePlus, Mic, Square, Check, CheckCircle2, Trash2, ArrowUpRight, ArrowDownLeft, Search } from 'lucide-react';
import { api } from '../lib/api';
import DateRange, { rangeLabel } from './DateRange';

// Sales & purchase: the book a member of staff keeps without typing anything. Sale or
// Purchase, a photo of the bill, a few spoken words in any language, Save - and Reem
// reads who, how much and when (server/trade.js). What it read is shown, never typed
// over: a wrong reading is put right by saying so.

const dated = (secs) => secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const billDay = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const money = (n, currency) => `${currency} ${Number(n).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const KIND = {
  sale: { label: 'Sale', hint: 'We sold something', Icon: ArrowUpRight, tone: 'text-emerald-300', chip: 'bg-emerald-400/15 text-emerald-300' },
  purchase: { label: 'Purchase', hint: 'We bought something', Icon: ArrowDownLeft, tone: 'text-warn', chip: 'bg-warn/15 text-warn' },
};

// A phone photo is several megabytes, and a bill only has to be readable.
const MAX_SIDE = 2000;
const MAX_PHOTOS = 5;
const MAX_VOICE = 120; // seconds: a note, not a meeting
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('That picture could not be read'))), 'image/jpeg', 0.85));
}

// ---------- the voice note ----------

/** Tap to start, tap to stop. onDone gets the recording; it stops by itself at MAX_VOICE. */
function useRecorder(onDone) {
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
      s >= MAX_VOICE ? stop() : setSecs(s);
    }, 250);
    live.current = { rec, stream, parts, timer };
    setSecs(0);
  }, [stop]);

  useEffect(() => () => stop(false), [stop]); // leaving the page lets go of the microphone
  return { secs, recording: secs !== null, start, stop };
}

function MicButton({ rec, onError, idle, disabled }) {
  const tap = () => (rec.recording ? rec.stop() : rec.start().catch((e) => onError(e.message)));
  return (
    <button type="button" onClick={tap} disabled={disabled}
      className={`flex w-full items-center justify-center gap-2 rounded-2xl border py-3.5 text-sm disabled:opacity-50 ${
        rec.recording ? 'border-bad/60 bg-bad/15 text-bad' : 'border-stroke bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.07]'}`}>
      {rec.recording
        ? <><Square size={15} fill="currentColor" /> <span className="font-mono tabular-nums">{clock(rec.secs)}</span> Tap to stop</>
        : <><Mic size={17} /> {idle}</>}
    </button>
  );
}

// ---------- what Reem read ----------

/** One entry as Reem read it. Nothing in it can be typed over. */
function Reading({ e, master }) {
  const k = KIND[e.kind];
  const src = (id) => `/api/trade/${e.id}/files/${id}`;
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{e.party || 'No name read'}</p>
          <p className="truncate text-xs text-mute">
            {dated(e.createdAt)}{master && e.by ? ` · ${e.by}` : ''}{e.date ? ` · bill dated ${billDay(e.date)}` : ''}
          </p>
        </div>
        <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${k.chip}`}><k.Icon size={12} /> {k.label}</span>
      </div>
      <p className={`text-2xl font-light tabular-nums ${e.amount == null ? 'text-mute' : ''}`}>
        {e.amount == null ? 'Amount not read' : money(e.amount, e.currency)}
      </p>
      {e.about && <p className="text-sm">{e.about}</p>}
      {e.said && <p dir="auto" className="whitespace-pre-wrap rounded-2xl bg-white/[0.04] px-3 py-2 text-sm text-mute">“{e.said}”</p>}
      {e.status === 'check' && (
        <p className="flex items-start gap-1.5 text-sm text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> Reem could not read the amount. It is saved and needs a look.</p>
      )}
      {e.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {e.photos.map((p) => (
            <a key={p} href={src(p)} target="_blank" rel="noreferrer">
              <img src={src(p)} alt="Bill" loading="lazy" className="size-16 rounded-xl border border-stroke object-cover" />
            </a>
          ))}
        </div>
      )}
      {e.voices.map((v) => <audio key={v} controls preload="none" src={src(v)} className="h-9 w-full" />)}
    </>
  );
}

// ---------- recording one ----------

function NewEntry({ onSaved }) {
  const [kind, setKind] = useState('');
  const [photos, setPhotos] = useState([]); // { blob, url }
  const [voice, setVoice] = useState(null); // { blob, url }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const camera = useRef(null);
  const gallery = useRef(null);
  const rec = useRecorder((blob) => setVoice((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; }));

  const addPhotos = async (e) => {
    const chosen = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
    e.target.value = ''; // so the same picture can be picked again after removing it
    setError('');
    try {
      const made = await Promise.all(chosen.map(async (f) => { const blob = await shrink(f); return { blob, url: URL.createObjectURL(blob) }; }));
      setPhotos((p) => [...p, ...made]);
    } catch (err) { setError(err.message); }
  };
  const dropPhoto = (i) => setPhotos((p) => { URL.revokeObjectURL(p[i].url); return p.filter((_, j) => j !== i); });
  const dropVoice = () => { URL.revokeObjectURL(voice.url); setVoice(null); };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('kind', kind);
      photos.forEach((p, i) => form.append('photos', p.blob, `bill-${i + 1}.jpg`));
      if (voice) form.append('voice', voice.blob, 'voice');
      const made = await api.upload('/trade', form);
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      if (voice) URL.revokeObjectURL(voice.url);
      setPhotos([]); setVoice(null); setKind('');
      onSaved(made);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const TILE = 'flex flex-1 flex-col items-center gap-1.5 rounded-2xl border border-dashed border-white/25 py-5 text-sm text-mute hover:border-p1 hover:text-p1 disabled:opacity-50';
  return (
    <div className="space-y-4 rounded-3xl border border-stroke bg-white/[0.04] p-4">
      {/* 1. which of the two */}
      <div className="grid grid-cols-2 gap-3">
        {Object.entries(KIND).map(([key, k]) => (
          <button type="button" key={key} onClick={() => { setKind(key); setError(''); }} aria-pressed={kind === key} disabled={busy}
            className={`flex flex-col items-center gap-1 rounded-3xl border px-2 py-5 transition ${
              kind === key ? 'border-p1/60 bg-p1/15' : 'border-stroke bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.07]'}`}>
            <k.Icon size={26} className={k.tone} />
            <span className="text-lg font-medium">{k.label}</span>
            <span className="text-xs text-mute">{k.hint}</span>
          </button>
        ))}
      </div>

      {kind && (
        <>
          {/* 2. the bill */}
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <span key={p.url} className="relative">
                  <img src={p.url} alt={`Photo ${i + 1}`} className="size-20 rounded-2xl border border-stroke object-cover" />
                  <button type="button" onClick={() => dropPhoto(i)} disabled={busy} aria-label={`Remove photo ${i + 1}`}
                    className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-black/80 text-white"><X size={13} /></button>
                </span>
              ))}
            </div>
          )}
          {photos.length < MAX_PHOTOS && (
            <div className="flex gap-3">
              <button type="button" onClick={() => camera.current.click()} disabled={busy} className={TILE}><Camera size={24} /> Take photo</button>
              <button type="button" onClick={() => gallery.current.click()} disabled={busy} className={TILE}><ImagePlus size={24} /> Upload</button>
            </div>
          )}
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={addPhotos} />
          <input ref={gallery} type="file" accept="image/*" multiple hidden onChange={addPhotos} />

          {/* 3. a few words, if they want */}
          {voice ? (
            <div className="flex items-center gap-2">
              <audio controls src={voice.url} className="h-9 min-w-0 flex-1" />
              <button type="button" onClick={dropVoice} disabled={busy} aria-label="Remove the voice note" className="grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={16} /></button>
            </div>
          ) : (
            <MicButton rec={rec} onError={setError} disabled={busy} idle="Say something about it, in any language (if you want)" />
          )}

          {error && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</p>}
          <button type="button" onClick={save} disabled={busy || rec.recording || (!photos.length && !voice)}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-3.5 font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.99] disabled:opacity-50">
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />}
            {busy ? 'Reem is reading it…' : `Save ${KIND[kind].label.toLowerCase()}`}
          </button>
        </>
      )}
    </div>
  );
}

// ---------- the one just saved ----------

/** What Reem made of the entry just saved: right, said to be wrong, or taken back. */
function JustSaved({ e, onChanged, onDone }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const say = async (blob) => {
    setBusy('say'); setError('');
    try {
      const form = new FormData();
      form.append('voice', blob, 'voice');
      onChanged(await api.upload(`/trade/${e.id}/say`, form));
    } catch (err) { setError(err.message); }
    setBusy('');
  };
  const rec = useRecorder(say);
  const remove = async () => {
    setBusy('remove'); setError('');
    try { await api.del(`/trade/${e.id}`); onDone(true); } catch (err) { setError(err.message); setBusy(''); }
  };
  return (
    <div className="space-y-3 rounded-3xl border border-emerald-400/40 bg-emerald-400/[0.06] p-4">
      <p className="flex items-center gap-1.5 text-sm text-emerald-300"><CheckCircle2 size={16} /> Saved. This is what Reem read:</p>
      <Reading e={e} />
      {error && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</p>}
      {busy === 'say'
        ? <p className="flex items-center justify-center gap-2 py-3 text-sm text-mute"><Loader2 size={15} className="animate-spin" /> Reem is reading it again…</p>
        : <MicButton rec={rec} onError={setError} disabled={!!busy} idle="Something wrong? Say what is right" />}
      <div className="flex gap-3">
        <button type="button" onClick={remove} disabled={!!busy || rec.recording}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-stroke py-3 text-sm text-mute hover:text-bad disabled:opacity-40">
          {busy === 'remove' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove it
        </button>
        <button type="button" onClick={() => onDone(false)} disabled={!!busy || rec.recording}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-3 text-sm font-medium text-white disabled:opacity-50">
          <Check size={15} /> It is right
        </button>
      </div>
    </div>
  );
}

// ---------- the book ----------

function Totals({ totals }) {
  if (!totals.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3">
      {totals.map((t) => (
        <div key={`${t.kind}-${t.currency}`} className="rounded-3xl border border-stroke bg-white/[0.03] p-3">
          <p className={`text-xs ${KIND[t.kind].tone}`}>{KIND[t.kind].label}s this month</p>
          <p className="truncate text-lg font-light tabular-nums">{money(t.month, t.currency)}</p>
          <p className="truncate text-xs text-mute">Today {money(t.today, t.currency)}</p>
        </div>
      ))}
    </div>
  );
}

function Entry({ e, master, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (!confirm('Delete this entry? Its photos and voice notes go with it.')) return;
    setBusy(true); setError('');
    try { await api.del(`/trade/${e.id}`); } catch (err) { setError(err.message); }
    onChanged();
    setBusy(false);
  };
  return (
    <div className="space-y-2 rounded-3xl border border-stroke bg-white/[0.03] p-4">
      <Reading e={e} master={master} />
      {error && <p className="text-sm text-bad">{error}</p>}
      {e.canRemove && (
        <div className="flex justify-end">
          <button onClick={remove} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-bad disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default function TradePage({ me, onBack }) {
  const master = me.role === 'master';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [last, setLast] = useState(null); // the entry just saved, to show what Reem read
  const [show, setShow] = useState('all');
  const [find, setFind] = useState('');
  const [dates, setDates] = useState({ from: '', to: '' }); // the days recorded, both counted
  const asked = useRef(0); // only the latest search may fill the list: an earlier one can come back late
  const load = useCallback(() => {
    const mine = ++asked.current;
    const ask = new URLSearchParams({ ...(find.trim() ? { q: find.trim() } : {}), ...(dates.from ? dates : {}) }).toString();
    return api.get(ask ? `/trade?${ask}` : '/trade')
      .then((d) => { if (mine === asked.current) setData(d); }).catch((e) => setError(e.message));
  }, [find, dates]);
  // Straight away the first time and when the box is emptied; a moment after the last key otherwise.
  useEffect(() => { const t = setTimeout(load, find.trim() ? 300 : 0); return () => clearTimeout(t); }, [load, find]);

  const entries = (data?.entries || []).filter((e) => e.id !== last?.id && (show === 'all' || e.kind === show));
  const narrowed = !!(find.trim() || dates.from);
  const found = (data?.found || []).filter((f) => show === 'all' || f.kind === show);
  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Sales &amp; purchase</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-4 pb-8">
          {error && <p className="flex items-start gap-1.5 text-bad"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}</p>}
          {!data && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
          {last
            ? <JustSaved key={last.id} e={last} onChanged={(e) => { setLast(e); load(); }} onDone={() => { setLast(null); load(); }} />
            : <NewEntry onSaved={(e) => { setLast(e); load(); }} />}
          {data && <Totals totals={data.totals} />}
          {data && (data.entries.length > 0 || narrowed) && (
            <div className="space-y-3 pt-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-stroke bg-white/[0.04] px-4 py-2.5 focus-within:border-p1/60">
                  <Search size={15} className="shrink-0 text-mute" />
                  <input value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search entries"
                    placeholder={master ? 'Search a name, an amount, an item or a person' : 'Search a name, an amount or an item'}
                    className="w-full bg-transparent text-sm outline-none" />
                  {find && <button type="button" onClick={() => setFind('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={15} /></button>}
                </label>
                <DateRange value={dates} onChange={setDates} className="sm:w-56" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-mute">{master ? 'Everyone’s entries' : 'Your entries'}</p>
                <span className="flex rounded-full border border-stroke p-0.5">
                  {[['all', 'All'], ['sale', 'Sales'], ['purchase', 'Purchases']].map(([k, label]) => (
                    <button key={k} onClick={() => setShow(k)} aria-pressed={show === k}
                      className={`rounded-full px-3 py-1.5 text-xs ${show === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{label}</button>
                  ))}
                </span>
              </div>
              {/* What the search or the dates add up to: all of it, not only the entries listed below. */}
              {narrowed && found.length > 0 && (
                <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-2xl border border-stroke bg-white/[0.03] px-4 py-2.5 text-sm">
                  {found.map((f) => (
                    <span key={`${f.kind}-${f.currency}`}>
                      <span className={KIND[f.kind].tone}>{f.entries} {f.entries === 1 ? KIND[f.kind].label.toLowerCase() : `${KIND[f.kind].label.toLowerCase()}s`}</span>
                      <span className="ml-1.5 tabular-nums">{money(f.total, f.currency)}</span>
                    </span>
                  ))}
                </div>
              )}
              {entries.map((e) => <Entry key={e.id} e={e} master={master} onChanged={load} />)}
              {entries.length === 0 && (
                <p className="py-4 text-center text-sm text-mute">
                  {!narrowed ? 'Nothing here yet.' : `Nothing found${find.trim() ? ` for “${find.trim()}”` : ''}${dates.from ? ` ${dates.from === dates.to ? 'on' : 'from'} ${rangeLabel(dates)}` : ''}.`}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
