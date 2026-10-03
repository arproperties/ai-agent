import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronRight, Loader2, Package, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Picker from './Picker';

// Inventory: the things kept in each unit and area of a building - the AC, the fridge,
// the furniture, the keys. The master keeps every building's, an administrator their own.
// Units come from saifsys; areas (lobby, store room) are added here. The server is
// server/inventory.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const CONDITION = { good: 'Good', damaged: 'Damaged', missing: 'Missing' };
const TONE = { good: 'bg-ok/20 text-ok', damaged: 'bg-warn/20 text-warn', missing: 'bg-bad/20 text-bad' };
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const amount = (i) => [i.quantity, i.counted_in].filter((x) => x !== null && x !== '').join(' ');
const photoUrl = (buildingId, i) => `/api/inventory/${buildingId}/items/${i.id}/photo?v=${i.updated_at}`;

/** "12 items · 1 damaged · 2 missing", with what needs someone in colour. */
function Counts({ items, damaged, missing }) {
  if (!items) return <span className="text-mute">Nothing listed yet</span>;
  return (
    <span className="text-mute">
      {items} {items === 1 ? 'item' : 'items'}
      {damaged > 0 && <> · <span className="text-warn">{damaged} damaged</span></>}
      {missing > 0 && <> · <span className="text-bad">{missing} missing</span></>}
    </span>
  );
}

// A phone photo is several megabytes; nobody needs that to recognise a fridge.
const MAX_SIDE = 1600;
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('That picture could not be read'))), 'image/jpeg', 0.82));
}

// ---------- adding or changing one item ----------

function ItemForm({ inv, start, place: firstPlace, onSaved, onCancel }) {
  const b = inv.building;
  const [place, setPlace] = useState(start?.place.key || firstPlace || '');
  const [name, setName] = useState(start?.name || '');
  const [countedIn, setCountedIn] = useState(start?.counted_in || '');
  const [quantity, setQuantity] = useState(start ? String(start.quantity) : '1');
  const [condition, setCondition] = useState(start?.condition || 'good');
  const [notes, setNotes] = useState(start?.notes || '');
  const [photo, setPhoto] = useState(null); // a new picture, 'remove', or null for as it is
  const [areas, setAreas] = useState(inv.areas);
  const [newArea, setNewArea] = useState(null); // the name being typed, or null when not adding one
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const file = useRef(null);

  useEffect(() => { if (start) api.get(`/inventory/${b.id}/items/${start.id}/history`).then(setLog).catch(() => {}); }, [b.id, start]);
  const preview = useMemo(() => (photo && photo !== 'remove' ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const shown = preview || (start?.photo && photo !== 'remove' ? photoUrl(b.id, start) : null);

  const places = useMemo(() => [
    ...areas.map((a) => ({ value: `a:${a.id}`, label: a.name, group: 'Areas' })),
    ...inv.units.map((u) => ({ value: `u:${u}`, label: `Unit ${u}`, group: 'Units' })),
    // A unit saifsys no longer lists (or could not be asked about) is still where this item is.
    ...(start && !start.place.key.startsWith('a:') && !inv.units.includes(start.place.key.slice(2)) ? [{ value: start.place.key, label: start.place.label, group: 'Units' }] : []),
  ], [areas, inv.units, start]);

  const act = async (what, fn) => {
    if (busy) return;
    setBusy(what); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const addArea = () => act('area', async () => {
    const a = await api.post(`/inventory/${b.id}/areas`, { name: newArea });
    setAreas((list) => [...list, a].sort((x, y) => x.name.localeCompare(y.name)));
    setPlace(`a:${a.id}`);
    setNewArea(null);
  });
  const pickPhoto = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) act('photo', async () => setPhoto(await shrink(f)));
  };
  const save = (e) => {
    e.preventDefault();
    act('save', async () => {
      const body = { place, name, counted_in: countedIn || null, quantity, condition, notes };
      const saved = await (start ? api.put(`/inventory/${b.id}/items/${start.id}`, body) : api.post(`/inventory/${b.id}/items`, body));
      if (photo === 'remove') await api.del(`/inventory/${b.id}/items/${saved.id}/photo`);
      else if (photo) {
        const form = new FormData();
        form.append('photo', photo, 'photo.jpg');
        await api.upload(`/inventory/${b.id}/items/${saved.id}/photo`, form);
      }
      await onSaved(place);
    });
  };
  const remove = () => confirm(`Remove "${start.name}" from the inventory?`)
    && act('delete', async () => { await api.del(`/inventory/${b.id}/items/${start.id}`); await onSaved(place); });

  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <div className="space-y-1">
        <span className={LABEL}>WHERE IS IT?</span>
        <Picker value={place} onChange={setPlace} options={places} placeholder="Pick a unit or an area" searchPlaceholder="Search units and areas" />
        {inv.units_error && <p className="text-xs text-warn">The unit list could not be read from saifsys just now. Areas still work.</p>}
        {newArea === null ? (
          <button type="button" onClick={() => setNewArea('')} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> New area, like Lobby or Store room</button>
        ) : (
          <div className="flex gap-2">
            <input value={newArea} onChange={(e) => setNewArea(e.target.value)} maxLength={80} placeholder="Area name" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (newArea.trim()) addArea(); } }}
              className="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-p1/70" />
            <button type="button" onClick={addArea} disabled={!newArea.trim() || !!busy} className="rounded-full border border-stroke px-3 text-sm text-mute hover:text-txt disabled:opacity-50">Add</button>
            <button type="button" onClick={() => setNewArea(null)} aria-label="Cancel" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={14} /></button>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <span className={LABEL}>WHAT IS IT?</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Split AC" className={FIELD} autoFocus={!start && !!place} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className={LABEL}>COUNTED IN <span className="tracking-normal">(optional)</span></span>
          <Picker value={countedIn} onChange={setCountedIn} options={inv.counted_in} none="No unit" searchPlaceholder="Search" />
        </div>
        <div className="space-y-1">
          <span className={LABEL}>HOW MANY?</span>
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} type="number" inputMode="decimal" min="0" step="any" className={FIELD} />
        </div>
      </div>

      <div className="space-y-1">
        <span className={LABEL}>CONDITION</span>
        <div className="flex rounded-full bg-white/5 p-0.5 text-sm">
          {Object.entries(CONDITION).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setCondition(k)} aria-pressed={condition === k}
              className={`flex-1 rounded-full px-3 py-1.5 transition ${condition === k ? TONE[k] : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <span className={LABEL}>PHOTO <span className="tracking-normal">(optional)</span></span>
        <input ref={file} type="file" accept="image/*" onChange={pickPhoto} className="hidden" />
        <div className="flex items-center gap-2">
          {shown && <a href={shown} target="_blank" rel="noreferrer"><img src={shown} alt="" className="size-16 rounded-lg object-cover" /></a>}
          <button type="button" onClick={() => file.current?.click()} disabled={!!busy} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-sm text-mute hover:text-txt disabled:opacity-50">
            {busy === 'photo' ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />} {shown ? 'Change' : 'Add a photo'}
          </button>
          {shown && <button type="button" onClick={() => setPhoto(start?.photo ? 'remove' : null)} className="rounded-full px-3 py-1.5 text-sm text-mute hover:bg-white/10 hover:text-bad">Remove</button>}
        </div>
      </div>

      <div className="space-y-1">
        <span className={LABEL}>NOTES <span className="tracking-normal">(optional)</span></span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} placeholder="Brand, serial number, what is wrong with it" className={`${FIELD} resize-none`} />
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {start && (
          <button type="button" onClick={remove} disabled={!!busy} aria-label="Remove" title="Remove"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50"><Trash2 size={16} /></button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={!!busy || !name.trim() || !place} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy === 'save' ? 'Saving…' : start ? 'Save' : 'Add item'}
        </button>
      </div>

      {log?.length > 0 && (
        <div className="space-y-1 border-t border-stroke/50 pt-3">
          <p className={LABEL}>CHANGES</p>
          {log.map((l, n) => (
            <p key={n} className="text-xs text-mute"><span className="text-txt/80">{l.what}</span> · {l.by || 'Someone'} · {when(l.at)}</p>
          ))}
        </div>
      )}
    </form>
  );
}

// ---------- one building ----------

function ItemRow({ buildingId, item, onOpen }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl bg-white/5 px-4 py-2.5 text-left transition hover:bg-white/[0.08]">
      {item.photo
        ? <img src={photoUrl(buildingId, item)} alt="" loading="lazy" className="size-10 shrink-0 rounded-lg object-cover" />
        : <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/5 text-mute"><Package size={17} strokeWidth={1.6} /></span>}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-snug">{item.name}</p>
        {item.notes && <p className="truncate text-xs text-mute">{item.notes}</p>}
      </div>
      <span className="shrink-0 text-sm text-txt/80">{amount(item)}</span>
      {item.condition !== 'good' && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[item.condition]}`}>{CONDITION[item.condition]}</span>}
    </button>
  );
}

function BuildingInventory({ id }) {
  const [inv, setInv] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // an item, 'new', or null
  const [lastPlace, setLastPlace] = useState(''); // adding several things to one unit should not mean picking it each time
  const [q, setQ] = useState('');
  const load = useCallback(() => api.get(`/inventory/${id}`).then((d) => { setInv(d); setError(''); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  const removeArea = async (a, count) => {
    if (!confirm(count ? `Remove "${a.name}" and the ${count} ${count === 1 ? 'item' : 'items'} in it?` : `Remove the area "${a.name}"?`)) return;
    try { await api.del(`/inventory/${id}/areas/${a.id}`); await load(); } catch (e) { setError(e.message); }
  };

  if (error && !inv) return <p className="text-sm text-bad">{error}</p>;
  if (!inv) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (editing) {
    return (
      <ItemForm inv={inv} start={editing === 'new' ? null : editing} place={lastPlace}
        onCancel={() => { setEditing(null); load(); }} onSaved={async (place) => { setLastPlace(place); await load(); setEditing(null); }} />
    );
  }

  const want = q.trim().toLowerCase();
  const items = want ? inv.items.filter((i) => `${i.name} ${i.place.label} ${i.notes || ''} ${CONDITION[i.condition]}`.toLowerCase().includes(want)) : inv.items;
  // Areas first, then units in counting order. An empty area is still a place, so it is shown.
  const places = [
    ...inv.areas.map((a) => ({ key: `a:${a.id}`, label: a.name, area: a })),
    ...[...new Map(inv.items.filter((i) => i.place.key.startsWith('u:')).map((i) => [i.place.key, i.place])).values()]
      .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true })),
  ].map((p) => ({ ...p, items: items.filter((i) => i.place.key === p.key) })).filter((p) => p.items.length > 0 || (!want && p.area));

  return (
    <div className="space-y-3">
      <button onClick={() => setEditing('new')}
        className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
        <Plus size={16} /> Add item
      </button>
      {error && <p className="text-sm text-bad">{error}</p>}
      {inv.items.length > 0 && (
        <div className="glass flex items-center gap-2 rounded-xl px-3.5 py-2">
          <Search size={15} className="shrink-0 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items, units, areas, damaged…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute/70" />
          {q && <button onClick={() => setQ('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={14} /></button>}
        </div>
      )}
      {inv.items.length === 0 && inv.areas.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-14 text-center">
          <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Package size={34} strokeWidth={1.4} /></span>
          <div>
            <p className="text-lg font-light">Nothing listed yet</p>
            <p className="max-w-xs text-sm text-mute">Add what is kept in each unit or area: the AC, the fridge, the furniture, the keys.</p>
          </div>
        </div>
      )}
      {want && places.length === 0 && <p className="py-8 text-center text-sm text-mute">Nothing matches "{q.trim()}"</p>}
      {places.map((p) => (
        <section key={p.key} className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <h2 className={`flex-1 ${LABEL}`}>{p.label.toUpperCase()} · {p.items.length}</h2>
            {p.area && !want && (
              <button onClick={() => removeArea(p.area, p.items.length)} aria-label={`Remove ${p.label}`} title="Remove this area"
                className="grid size-7 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={13} /></button>
            )}
          </div>
          {p.items.map((i) => <ItemRow key={i.id} buildingId={id} item={i} onOpen={() => setEditing(i)} />)}
          {p.items.length === 0 && <p className="px-1 text-xs text-mute">Nothing here yet.</p>}
        </section>
      ))}
    </div>
  );
}

// ---------- the list of buildings ----------

export default function InventoryPage({ me, onBack }) {
  const master = me.role === 'master';
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(() => api.get('/inventory').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);

  // Someone with a single building has nothing to choose between.
  const only = rows?.length === 1 && !master ? rows[0] : null;
  const open = only || rows?.find((b) => b.id === openId) || null;
  const back = open && !only ? () => { setOpenId(null); load(); } : onBack;

  return (
    <Page title={open ? `${open.name} inventory` : 'Inventory'} onBack={back}>
      {rows === null && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
      {open && <BuildingInventory key={open.id} id={open.id} />}
      {rows && !open && (
        <div className="space-y-2.5">
          {rows.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Package size={34} strokeWidth={1.4} /></span>
              <div>
                <p className="text-lg font-light">No buildings yet</p>
                <p className="max-w-xs text-sm text-mute">{master ? 'Add a building under Buildings first; its inventory is kept here.' : 'You have not been given a building yet.'}</p>
              </div>
            </div>
          )}
          {rows.map((b) => (
            <button key={b.id} onClick={() => setOpenId(b.id)} className="flex w-full items-center gap-3 rounded-2xl bg-white/5 px-4 py-3 text-left transition hover:bg-white/[0.08]">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Package size={19} strokeWidth={1.6} /></span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{b.name}</p>
                <p className="text-xs"><Counts {...b} /></p>
              </div>
              <ChevronRight size={18} className="shrink-0 text-mute" />
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}
