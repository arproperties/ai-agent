import { useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

// The picture of a company (its logo) or a building (a photo of it), and a unit's photos
// (several, at the bottom of this file). The first two are one each, kept by the
// server (the photo part of server/properties.js); the master puts it up, changes it or
// takes it down, and everyone sees it. `photo_at` on a row is when its picture last
// changed, or null when it has none, and goes in the address so a new one shows at once.

/** Where a row's picture is, or null when it has none. `kind` is 'companies' or 'buildings'. */
export const photoUrl = (kind, r) => (r?.photo_at ? `/api/properties/${kind}/${r.id}/photo?v=${r.photo_at}` : null);

const CHIP = 'flex cursor-pointer items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs text-white backdrop-blur hover:bg-black/70';

/** Choose a picture and send it. Draws as whatever is put inside it. */
function Pick({ kind, id, onDone, onError, className, title, children }) {
  const send = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append('photo', file);
    try { await api.upload(`/properties/${kind}/${id}/photo`, form); onDone(); } catch (e) { onError(e.message); }
  };
  return (
    <label className={className} title={title}>
      {children}
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { send(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
}

/**
 * A building's photo across the top of its page. With none, the master sees a place to add
 * one and everyone else sees nothing.
 */
export function Cover({ row, master, onChanged }) {
  const [error, setError] = useState('');
  const url = photoUrl('buildings', row);
  const remove = async () => {
    if (!confirm('Remove this photo?')) return;
    try { await api.del(`/properties/buildings/${row.id}/photo`); onChanged(); } catch (e) { setError(e.message); }
  };
  if (!url && !master) return null;
  return (
    <div className="mb-4">
      {url ? (
        <div className="relative overflow-hidden rounded-2xl border border-stroke">
          <img src={url} alt={`${row.name}`} className="h-44 w-full object-cover md:h-64" />
          {master && (
            <div className="absolute right-3 top-3 flex gap-2">
              <Pick kind="buildings" id={row.id} onDone={onChanged} onError={setError} className={CHIP}><Camera size={13} /> Change photo</Pick>
              <button onClick={remove} className={CHIP}><Trash2 size={13} /> Remove</button>
            </div>
          )}
        </div>
      ) : (
        <Pick kind="buildings" id={row.id} onDone={onChanged} onError={setError}
          className="flex h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-stroke text-sm text-mute hover:bg-white/5 hover:text-txt">
          <Camera size={20} /> Add a photo of the building
        </Pick>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}

/**
 * A company's logo as a rounded square, with its initials when it has none. The master
 * taps it to put one up or change it, and gets a small button to take it down.
 */
export function Logo({ row, master, onChanged, size = 'size-16', text = 'text-lg' }) {
  const [error, setError] = useState('');
  const url = photoUrl('companies', row);
  const face = url
    ? <img src={url} alt={`${row.name} logo`} className="size-full object-cover" />
    : <span className={`font-semibold text-p1 ${text}`}>{row.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}</span>;
  const box = `relative grid ${size} shrink-0 place-items-center overflow-hidden rounded-xl bg-p1/15`;
  if (!master) return <span className={box}>{face}</span>;
  const remove = async () => {
    if (!confirm('Remove this logo?')) return;
    try { await api.del(`/properties/companies/${row.id}/photo`); onChanged(); } catch (e) { setError(e.message); }
  };
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <Pick kind="companies" id={row.id} onDone={onChanged} onError={setError} title={url ? 'Change the logo' : 'Add a logo'} className={`group cursor-pointer ${box}`}>
        {face}
        <span className="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition group-hover:opacity-100"><Camera size={18} /></span>
      </Pick>
      {url ? <button onClick={remove} className="text-[11px] text-mute hover:text-bad">Remove</button> : <span className="text-[11px] text-mute">Add logo</span>}
      {error && <p className="max-w-[8rem] text-center text-[11px] text-bad">{error}</p>}
    </div>
  );
}

/** For a card in a grid: a building's photo as the card's top, with a camera for the master to add or change it. */
export function CardCover({ row, master, onOpen, onChanged }) {
  const [error, setError] = useState('');
  const url = photoUrl('buildings', row);
  if (!url) return null;
  return (
    <div className="relative">
      <button onClick={onOpen} aria-label={`Open ${row.name}`} className="block w-full">
        <img src={url} alt={row.name} loading="lazy" className="h-36 w-full rounded-t-2xl object-cover" />
      </button>
      {master && <Pick kind="buildings" id={row.id} onDone={onChanged} onError={setError} title="Change photo"
        className="absolute right-2 top-2 grid size-8 cursor-pointer place-items-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/70"><Camera size={14} /></Pick>}
      {error && <p className="px-4 pt-2 text-xs text-bad">{error}</p>}
    </div>
  );
}

/**
 * A unit's photos across the top of its card: one at a time, with arrows to go through
 * them. The master adds more (several at once), or removes the one showing. With none, the
 * master sees a place to add them and everyone else sees nothing.
 */
export function UnitPhotos({ unit, master, onChanged }) {
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = unit.photos || [];
  const i = Math.min(at, ids.length - 1);
  const add = async (files) => {
    setError(''); setBusy(true);
    for (const file of files) {
      const form = new FormData();
      form.append('photo', file);
      try { await api.upload(`/properties/units/${unit.id}/photos`, form); } catch (e) { setError(e.message); break; }
    }
    setBusy(false);
    onChanged();
  };
  const remove = async () => {
    if (!confirm('Remove this photo?')) return;
    try { await api.del(`/properties/unit-photos/${ids[i]}`); onChanged(); } catch (e) { setError(e.message); }
  };
  const input = <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />;
  const ROUND = 'grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/70';

  if (!ids.length) return master ? (
    <>
      <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-t-2xl border-b border-dashed border-stroke text-xs text-mute hover:bg-white/5 hover:text-txt">
        <Camera size={18} /> {busy ? 'Adding…' : 'Add photos of this unit'}{input}
      </label>
      {error && <p className="px-4 pt-2 text-xs text-bad">{error}</p>}
    </>
  ) : null;

  const url = `/api/properties/unit-photos/${ids[i]}`;
  return (
    <div className="relative">
      <a href={url} target="_blank" rel="noreferrer" title="Open the photo full size">
        <img src={url} alt={`Unit ${unit.unit_no}, photo ${i + 1} of ${ids.length}`} loading="lazy" className="h-44 w-full rounded-t-2xl object-cover" />
      </a>
      {ids.length > 1 && (
        <>
          <button onClick={() => setAt((i + ids.length - 1) % ids.length)} aria-label="Previous photo" className={`absolute left-2 top-1/2 -translate-y-1/2 ${ROUND}`}><ChevronLeft size={16} /></button>
          <button onClick={() => setAt((i + 1) % ids.length)} aria-label="Next photo" className={`absolute right-2 top-1/2 -translate-y-1/2 ${ROUND}`}><ChevronRight size={16} /></button>
          <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white backdrop-blur">{i + 1} / {ids.length}</span>
        </>
      )}
      {master && (
        <div className="absolute right-2 top-2 flex gap-1.5">
          <label title="Add more photos" className={`cursor-pointer ${ROUND}`}><Camera size={14} />{input}</label>
          <button onClick={remove} title="Remove this photo" aria-label="Remove this photo" className={ROUND}><Trash2 size={14} /></button>
        </div>
      )}
      {(error || busy) && <p className={`px-4 pt-2 text-xs ${error ? 'text-bad' : 'text-mute'}`}>{error || 'Adding…'}</p>}
    </div>
  );
}
