import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, Send, X, AlertTriangle, Search, Camera, CheckCircle2, RotateCw, Trash2, MailX, LayoutGrid, Box } from 'lucide-react';
import { api } from '../lib/api';

const NoticeTower = lazy(() => import('./NoticeTower')); // the 3D drawing is heavy: fetched only when asked for

// Tenant notices: what a watchman used to post in the WhatsApp group. Building, unit,
// photo, what he saw, Send - and Reem emails it to that unit's tenant (server/notices.js).
// The buildings and units are saifsys's. Whoever has the module may report on any of them.

const dated = (secs) => secs ? new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const LAST = 'reem:notice-building'; // the building picked last time, so a watchman picks his once

// A phone photo is several megabytes; an email carrying five of them would be refused.
const MAX_SIDE = 1600;
const MAX_PHOTOS = 5;
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('That picture could not be read'))), 'image/jpeg', 0.82));
}

const FIELD = 'w-full rounded-2xl border border-stroke bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-p1/60';
const Step = ({ n, children }) => (
  <p className="flex items-center gap-2 text-sm font-medium">
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px]">{n}</span> {children}
  </p>
);

/** A list to tap from, with a search box once it is long enough to need one. */
function Pick({ items, label, find, onFind, placeholder, children }) {
  return (
    <>
      {items > 8 && (
        <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-black/20 px-3 py-2 focus-within:border-p1/60">
          <Search size={15} className="shrink-0 text-mute" />
          <input value={find} onChange={(e) => onFind(e.target.value)} placeholder={placeholder} aria-label={label}
            className="w-full bg-transparent text-sm outline-none" />
          {find && <button type="button" onClick={() => onFind('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={15} /></button>}
        </label>
      )}
      {children}
    </>
  );
}

// ---------- writing one ----------

function NewNotice({ places, hasInbox, onSent }) {
  const remembered = (() => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } })();
  const [building, setBuilding] = useState(places.some((b) => b.name === remembered) ? remembered : places.length === 1 ? places[0].name : '');
  const [unit, setUnit] = useState('');
  const [find, setFind] = useState('');
  const [view, setView] = useState('list'); // how the units are shown to pick from: the list, or the building in 3D
  const [photos, setPhotos] = useState([]); // { blob, url }
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef(null);

  const b = places.find((x) => x.name === building);
  const u = b?.units.find((x) => x.number === unit);
  const q = find.trim().toLowerCase();

  const pickBuilding = (name) => {
    setBuilding(name); setUnit(''); setFind(''); setError('');
    try { localStorage.setItem(LAST, name); } catch { /* private mode: it is only a convenience */ }
  };

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

  const send = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('building', building);
      form.append('unit', unit);
      form.append('description', text);
      photos.forEach((p, i) => form.append('photos', p.blob, `photo-${i + 1}.jpg`));
      const made = await api.upload('/notices', form);
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]); setText(''); setUnit(''); setFind('');
      onSent(made);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <form onSubmit={send} className="space-y-4 rounded-3xl border border-stroke bg-white/[0.04] p-4">
      {/* 1. the building */}
      <div className="space-y-2">
        <Step n={1}>Building</Step>
        {b ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-2xl border border-p1/50 bg-p1/15 px-3 py-2.5 text-sm">{b.name}</span>
            {places.length > 1 && <button type="button" onClick={() => pickBuilding('')} className="shrink-0 text-sm text-mute underline hover:text-txt">Change</button>}
          </div>
        ) : (
          <Pick items={places.length} label="Search buildings" placeholder="Search buildings" find={find} onFind={setFind}>
            <div className="grid gap-2 sm:grid-cols-2">
              {places.filter((x) => !q || x.name.toLowerCase().includes(q)).map((x) => (
                <button type="button" key={x.name} onClick={() => pickBuilding(x.name)}
                  className="rounded-2xl border border-stroke bg-white/[0.035] px-3 py-3 text-left text-sm hover:border-white/25 hover:bg-white/[0.07]">
                  <span className="block truncate font-medium">{x.name}</span>
                  <span className="block text-xs text-mute">{x.units.length} {x.units.length === 1 ? 'unit' : 'units'}</span>
                </button>
              ))}
            </div>
          </Pick>
        )}
      </div>

      {/* 2. the unit */}
      {b && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Step n={2}>Unit</Step>
            {!u && b.units.length > 0 && (
              <span className="flex rounded-full border border-stroke p-0.5">
                {[['list', 'List', LayoutGrid], ['3d', '3D', Box]].map(([k, label, Icon]) => (
                  <button type="button" key={k} onClick={() => { setView(k); setFind(''); }} aria-pressed={view === k}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${view === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </span>
            )}
          </div>
          {u ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-2xl border border-p1/50 bg-p1/15 px-3 py-2.5 text-sm">Unit {u.number}</span>
              <button type="button" onClick={() => { setUnit(''); setFind(''); }} className="shrink-0 text-sm text-mute underline hover:text-txt">Change</button>
            </div>
          ) : b.units.length === 0 ? (
            <p className="text-sm text-mute">saifsys has no units for this building yet.</p>
          ) : view === '3d' ? (
            <Suspense fallback={<div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}>
              <NoticeTower key={b.name} units={b.units} onPick={setUnit} />
            </Suspense>
          ) : (
            <Pick items={b.units.length} label="Search units" placeholder="Type the unit number" find={find} onFind={setFind}>
              <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
                {b.units.filter((x) => !q || x.number.toLowerCase().includes(q)).map((x) => (
                  <button type="button" key={x.number} onClick={() => { setUnit(x.number); setFind(''); }}
                    title={x.tenant ? `Unit ${x.number}` : `Unit ${x.number}: no tenant email in saifsys`}
                    className={`truncate rounded-xl border px-1 py-2.5 text-sm hover:border-white/25 hover:bg-white/[0.07] ${x.tenant ? 'border-stroke bg-white/[0.035]' : 'border-dashed border-stroke text-mute'}`}>
                    {x.number}
                  </button>
                ))}
              </div>
              <p className="text-xs text-mute">A unit with a dashed edge has no tenant email in saifsys.</p>
            </Pick>
          )}
        </div>
      )}

      {/* 3. what he saw */}
      {u && (
        <div className="space-y-3">
          <Step n={3}>Photo and what you saw</Step>
          {!u.tenant && (
            <p className="flex items-start gap-1.5 rounded-2xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <MailX size={16} className="mt-0.5 shrink-0" /> saifsys has no tenant email for this unit. Your notice will be saved, but no email can go out until one is added there.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <span key={p.url} className="relative">
                <img src={p.url} alt={`Photo ${i + 1}`} className="size-20 rounded-2xl border border-stroke object-cover" />
                <button type="button" onClick={() => dropPhoto(i)} aria-label={`Remove photo ${i + 1}`}
                  className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-black/80 text-white"><X size={13} /></button>
              </span>
            ))}
            {photos.length < MAX_PHOTOS && (
              <button type="button" onClick={() => file.current.click()}
                className="grid size-20 place-items-center rounded-2xl border border-dashed border-white/25 text-mute hover:border-p1 hover:text-p1">
                <span className="flex flex-col items-center gap-1 text-xs"><Camera size={20} /> {photos.length ? 'Add' : 'Photo'}</span>
              </button>
            )}
            <input ref={file} type="file" accept="image/*" multiple hidden onChange={addPhotos} />
          </div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setError(''); }} rows={4} maxLength={2000} required
            placeholder="What did you see?" className={`${FIELD} resize-y`} />
          {!hasInbox && <p className="text-sm text-bad">The Tenant care inbox is not connected, so the email cannot go out yet. Your notice will be saved.</p>}
          {error && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</p>}
          <button disabled={busy || !text.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-3 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.99] disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {busy ? 'Sending…' : u.tenant ? `Send to the tenant of Unit ${u.number}` : `Save the notice for Unit ${u.number}`}
          </button>
        </div>
      )}
      {!u && error && <p className="text-sm text-bad">{error}</p>}
    </form>
  );
}

// ---------- the ones already written ----------

const STATUS = {
  sent: { text: 'Sent to tenant', tone: 'bg-emerald-400/15 text-emerald-300' },
  sending: { text: 'Sending…', tone: 'bg-white/10 text-mute' },
  failed: { text: 'Not sent', tone: 'bg-bad/15 text-bad' },
  no_email: { text: 'No tenant email', tone: 'bg-warn/15 text-warn' },
};

function Notice({ n, master, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const s = STATUS[n.status];
  const act = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(e.message); onChanged(); }
    setBusy('');
  };
  return (
    <div className="space-y-2 rounded-3xl border border-stroke bg-white/[0.03] p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{n.building} · Unit {n.unit}</p>
          <p className="truncate text-xs text-mute">{dated(n.createdAt)}{master && n.by ? ` · ${n.by}` : ''}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${s.tone}`}>{s.text}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{n.description}</p>
      {n.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {n.photos.map((p) => (
            <a key={p} href={`/api/notices/${n.id}/photos/${p}`} target="_blank" rel="noreferrer">
              <img src={`/api/notices/${n.id}/photos/${p}`} alt="" loading="lazy" className="size-16 rounded-xl border border-stroke object-cover" />
            </a>
          ))}
        </div>
      )}
      {master && n.to?.length > 0 && <p className="truncate text-xs text-mute">To {n.to.join(', ')}</p>}
      {(n.error || error) && <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error || n.error}</p>}
      {(master || n.status === 'failed' || n.status === 'no_email') && (
        <div className="flex justify-end gap-2">
          {master && (
            <button onClick={() => confirm('Delete this notice? If it was sent, the tenant keeps the email.') && act('delete', () => api.del(`/notices/${n.id}`))} disabled={!!busy}
              className="flex items-center gap-1.5 rounded-full border border-stroke px-3.5 py-1.5 text-sm text-mute hover:text-bad disabled:opacity-40">
              {busy === 'delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
            </button>
          )}
          {(n.status === 'failed' || n.status === 'no_email') && (
            <button onClick={() => act('send', () => api.post(`/notices/${n.id}/send`, {}))} disabled={!!busy}
              className="flex items-center gap-1.5 rounded-full border border-p1/50 bg-p1/15 px-3.5 py-1.5 text-sm disabled:opacity-40">
              {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />} Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function NoticesPage({ me, onBack }) {
  const master = me.role === 'master';
  const [places, setPlaces] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [last, setLast] = useState(null); // the notice just written, to say what became of it
  const load = useCallback(() => api.get('/notices').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    api.get('/notices/places').then(setPlaces).catch((e) => setError(e.message));
    load();
  }, [load]);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">Tenant notices</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-4 pb-8">
          {error && <p className="flex items-start gap-1.5 text-bad"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}</p>}
          {!places && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-mute" /></div>}
          {last && (
            <p className={`flex items-start gap-1.5 rounded-2xl border px-3 py-2.5 text-sm ${last.status === 'sent' ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-warn/40 bg-warn/10 text-warn'}`}>
              {last.status === 'sent' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              {last.status === 'sent' && `Sent to the tenant of ${last.building}, Unit ${last.unit}.`}
              {last.status === 'no_email' && `Saved. No email went out: saifsys has no tenant email for ${last.building}, Unit ${last.unit}.`}
              {last.status === 'failed' && `Saved, but the email could not be sent: ${last.error} It is in the list below to try again.`}
            </p>
          )}
          {places && places.length === 0 && <p className="text-mute">saifsys has no buildings to pick from.</p>}
          {places && places.length > 0 && (
            <NewNotice places={places} hasInbox={data ? data.inbox : true} onSent={(n) => { setLast(n); load(); }} />
          )}
          {data?.notices.length > 0 && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-mute">{master ? 'Everyone’s notices' : 'Your notices'}</p>
              {data.notices.map((n) => <Notice key={`${n.id}-${n.status}`} n={n} master={master} onChanged={load} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
