import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, ChevronRight, Building2, Landmark, DoorOpen, Camera, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Select from './Select';
import CompanyDocs from './CompanyDocs';
import ServiceList from './ServiceList';
import { Cover, Logo, CardCover, UnitPhotos } from './PropertyPhoto';

// Companies → buildings → units. Everyone can look; only the master adds, edits or removes.
// The server is server/properties.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const UNIT_TYPES = ['Studio', '1BR', '2BR', '3BR', '4BR', 'Villa', 'Shop', 'Office', 'Warehouse', 'Parking'];

// What the form asks for, per kind, in sections. [field, label, input type, example, wide]
const FORMS = {
  company: [
    ['', [['name', 'Company name', 'text', 'e.g. ACE Real Estate L.L.C', true]]],
    ['Licence & tax', [['trade_license_no', 'Trade licence no.', 'text', 'e.g. 1234567'], ['trn', 'TRN (VAT no.)', 'text', '15 digits']]],
    ['Contact', [['phone', 'Phone', 'tel', '+971 4 …'], ['email', 'Email', 'email', 'info@…'], ['address', 'Address', 'text', 'Office, area, emirate', true]]],
    ['Notes', [['notes', 'Notes', 'area', 'Anything worth remembering', true]]],
  ],
  building: [
    ['Building', [['name', 'Building name', 'text', 'e.g. Park Place Tower', true], ['emirate', 'Emirate', 'emirate'], ['area', 'Area / community', 'text', 'e.g. Al Barsha']]],
    ['Location', [['address', 'Address', 'text', '', true], ['plot_no', 'Plot no.'], ['makani_no', 'Makani no.']]],
    ['Notes', [['notes', 'Notes', 'area', '', true]]],
  ],
  unit: [
    ['Unit', [['unit_no', 'Unit no.', 'text', 'e.g. 101'], ['floor', 'Floor', 'text', 'G, 1, 2…'], ['type', 'Type', 'unittype'], ['size_sqft', 'Size (sq ft)', 'number'], ['dewa_no', 'DEWA premise no.', 'text', '', true]]],
    ['Status', [['furnished', 'Furnished', 'bool', '', true], ['blocked', 'Blocked (not for rent, e.g. maintenance)', 'bool', '', true], ['notes', 'Notes', 'area', '', true]]],
  ],
};
const REQUIRED = new Set(['name', 'unit_no']);
const EMIRATES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
const fieldsOf = (kind) => FORMS[kind].flatMap(([, fs]) => fs);
// The picture chosen on a form: what it is called, where it is sent once the row is saved, and whether there can be several.
const PHOTO = {
  company: ['Logo', 'Add the company logo', (id) => `/properties/companies/${id}/photo`, false],
  building: ['Photo', 'Add a photo of the building', (id) => `/properties/buildings/${id}/photo`, false],
  unit: ['Photos', 'Add photos of the unit', (id) => `/properties/units/${id}/photos`, true],
};
/** Send the pictures chosen on a form, once the row they belong to has an id. */
async function sendPhotos(kind, id, files = []) {
  for (const file of files) {
    const form = new FormData();
    form.append('photo', file);
    await api.upload(PHOTO[kind][2](id), form);
  }
}

/**
 * Choosing pictures on a form: drop them on the box or tap it to pick. They are shown
 * small underneath, and sent when the form is saved.
 */
function PhotoField({ kind, files, onChange, replacing }) {
  const [label, ask, , many] = PHOTO[kind];
  const [over, setOver] = useState(false); // something is being dragged over the box
  const [error, setError] = useState('');
  const take = (list) => {
    const pics = [...list].filter((f) => /^image\/(png|jpe?g|webp|gif)$/.test(f.type));
    setError(pics.length < list.length ? 'Only pictures can go here: JPG, PNG or WebP.' : '');
    if (pics.length) onChange(many ? [...files, ...pics] : pics.slice(0, 1));
  };
  return (
    <fieldset>
      <legend className="mb-2 text-[11px] font-medium uppercase tracking-widest text-mute">{label}</legend>
      <label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        className={`flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed px-4 py-7 text-center text-sm transition
          ${over ? 'border-p1 bg-p1/10 text-txt' : 'border-stroke text-mute hover:bg-white/5 hover:text-txt'}`}>
        <Camera size={22} />
        <span>{over ? 'Drop to add' : files.length && !many ? 'Drop another here, or tap to choose, to use it instead' : `${ask}: drop ${many ? 'them' : 'it'} here, or tap to choose`}</span>
        <span className="text-xs text-mute">JPG, PNG or WebP, up to 8 MB{many ? ' each, 12 at most' : ''}.{replacing && !many && ' It replaces the one it has now.'}{replacing && many && ' These are added to the ones it has.'}</span>
        <input type="file" multiple={many} accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      </label>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="relative">
              <img src={URL.createObjectURL(f)} alt={f.name} className="size-24 rounded-xl border border-stroke object-cover" />
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-bad text-white"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Form({ kind, start, onSave, onCancel, bare }) {
  const [v, setV] = useState(() => Object.fromEntries(fieldsOf(kind).map(([f, , t]) => [f, start?.[f] ?? (t === 'bool' ? false : '')])));
  const [files, setFiles] = useState([]); // pictures chosen here, sent once the row is saved
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onSave(v, files); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className={bare ? 'space-y-4' : 'space-y-4 rounded-2xl border border-stroke/60 bg-white/[0.03] p-4'}>
      {FORMS[kind].map(([section, fs], si) => (
        <fieldset key={section}>
          {section && <legend className="mb-2 text-[11px] font-medium uppercase tracking-widest text-mute">{section}</legend>}
          <div className="grid gap-3 sm:grid-cols-2">
            {fs.map(([f, label, t, example, wide], i) => {
              const span = wide ? 'sm:col-span-2' : '';
              if (t === 'bool') return (
                <label key={f} className={`flex cursor-pointer items-center gap-3 rounded-xl bg-white/5 px-3.5 py-2.5 text-sm ${span}`}>
                  <input type="checkbox" checked={!!v[f]} onChange={set(f)} className="size-4 accent-p1" /> {label}
                </label>
              );
              let input;
              if (t === 'area') input = <textarea value={v[f] ?? ''} onChange={set(f)} rows={3} placeholder={example} className={`${FIELD} resize-none`} />;
              else if (t === 'emirate' || t === 'unittype') input = (
                <Select value={v[f] ?? ''} onChange={set(f)} className={`${FIELD} bg-surface`} placeholder="Choose…"
                  options={[['', 'None'], ...(t === 'emirate' ? EMIRATES : UNIT_TYPES)]} />
              );
              else input = <input type={t === 'number' ? 'number' : t} step="any" min={t === 'number' ? 0 : undefined} required={REQUIRED.has(f)}
                value={v[f] ?? ''} onChange={set(f)} placeholder={example} autoFocus={si === 0 && i === 0} className={FIELD} />;
              return (
                <label key={f} className={`block ${span}`}>
                  <span className="mb-1 block text-xs text-txt/80">{label}{REQUIRED.has(f) && <span className="text-p2"> *</span>}</span>
                  {input}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <PhotoField kind={kind} files={files} onChange={setFiles} replacing={!!start} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-stroke/60 pt-3">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}


/** One level of the tree: a list of rows, each opening the next level, with master-only add/edit/delete. */
function Level({ kind, rows, master, onOpen, onAdd, onSave, onRemove, onChanged, addLabel, empty, line, details, stat, addOpen, onAddClose }) {
  const [editing, setEditing] = useState(null); // an id, 'new', or null
  const [error, setError] = useState('');
  const Ico = kind === 'company' ? Landmark : kind === 'building' ? Building2 : DoorOpen;

  const remove = async (r) => {
    if (!confirm(`Delete ${r.name || `unit ${r.unit_no}`}?`)) return;
    setError('');
    try { await onRemove(r); } catch (e) { setError(e.message); }
  };

  // With `details`, each row is a card in a grid (the same flat look as the company cards).
  if (details) return (
    <div className="space-y-4">
      {error && <p className="text-sm text-bad">{error}</p>}
      {rows.length === 0 && !addOpen && <p className="py-3 text-sm text-mute">{empty}</p>}
      {addOpen && <Form kind={kind} onSave={async (v, files) => { await onAdd(v, files); onAddClose(); }} onCancel={onAddClose} />}
      {rows.find((r) => r.id === editing) && (
        <Form kind={kind} start={rows.find((r) => r.id === editing)} onSave={async (v, files) => { await onSave(rows.find((r) => r.id === editing), v, files); setEditing(null); }} onCancel={() => setEditing(null)} />
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col rounded-2xl border border-stroke">
            {kind === 'building' && <CardCover row={r} master={master} onOpen={() => onOpen(r)} onChanged={onChanged} />}
            {kind === 'unit' && <UnitPhotos unit={r} master={master} onChanged={onChanged} />}
            <div className="flex items-start gap-3 px-4 pt-4">
              <button onClick={onOpen && (() => onOpen(r))} aria-label={`Open ${r.name || r.unit_no}`}
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-p1/15 text-p1"><Ico size={18} /></button>
              <div className="min-w-0 flex-1">
                <button onClick={onOpen && (() => onOpen(r))} className={`block max-w-full truncate text-left font-medium ${onOpen ? 'hover:text-p1' : 'cursor-default'}`}>{r.name || `Unit ${r.unit_no}`}</button>
                <p className="truncate text-xs text-mute">{line(r) || '—'}</p>
              </div>
              {master && <div className="-mr-1.5 flex shrink-0">
                <button onClick={() => setEditing(r.id)} aria-label="Edit" title="Edit"
                  className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
                <button onClick={() => remove(r)} aria-label="Delete" title="Delete"
                  className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
              </div>}
            </div>
            <dl className="mx-4 mt-3 flex-1 divide-y divide-stroke/60 border-t border-stroke text-sm">
              {details(r).map(([l, v]) => (
                <div key={l} className="flex gap-4 py-2">
                  <dt className="shrink-0 text-mute">{l}</dt>
                  <dd className={`min-w-0 flex-1 truncate text-right ${v ? '' : 'text-mute/50'}`}>{v || '—'}</dd>
                </div>
              ))}
            </dl>
            <div className="flex items-center justify-between border-t border-stroke px-4 py-2.5">
              {stat(r)}
              {onOpen && <button onClick={() => onOpen(r)} className="flex items-center gap-0.5 text-sm text-p3 hover:underline">Open <ChevronRight size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-2.5">
      {error && <p className="text-sm text-bad">{error}</p>}
      {rows.length === 0 && editing !== 'new' && <p className="py-3 text-sm text-mute">{empty}</p>}
      {rows.map((r) => (editing === r.id
        ? <Form key={r.id} kind={kind} start={r} onSave={async (v, files) => { await onSave(r, v, files); setEditing(null); }} onCancel={() => setEditing(null)} />
        : (
          <div key={r.id} className="flex items-center gap-2 rounded-2xl bg-white/5 px-3 py-2.5">
            <button onClick={onOpen ? () => onOpen(r) : undefined} disabled={!onOpen}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
              <Ico size={18} className="shrink-0 text-mute" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.name || `Unit ${r.unit_no}`}</p>
                <p className="truncate text-xs text-mute">{line(r)}</p>
              </div>
              {onOpen && <ChevronRight size={16} className="shrink-0 text-mute" />}
            </button>
            {master && <>
              <button onClick={() => setEditing(r.id)} aria-label="Edit" title="Edit"
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
              <button onClick={() => remove(r)} aria-label="Delete" title="Delete"
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
            </>}
          </div>
        )))}
      {master && (editing === 'new'
        ? <Form kind={kind} onSave={async (v, files) => { await onAdd(v, files); setEditing(null); }} onCancel={() => setEditing(null)} />
        : (
          <button onClick={() => setEditing('new')}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
            <Plus size={16} /> {addLabel}
          </button>
        ))}
    </div>
  );
}

const join = (...xs) => xs.filter(Boolean).join(' · ');
// What a building's page is split into.
const BUILDING_TABS = [['units', 'Units'], ['services', 'Services']];

/** A building's services (pet fee, parking, laundry…): what a booking in it can be charged besides the rent. The master keeps the list. */
function BuildingServices({ building, master }) {
  const [services, setServices] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setServices(null);
    api.get(`/leasing/services?building_id=${building.id}`).then((list) => setServices(list.filter((s) => s.building_id === building.id))).catch((e) => setError(e.message));
  }, [building.id]);
  if (!services) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (!master && !services.length) return <p className="py-3 text-sm text-mute">No extra services in this building yet.</p>;
  return (
    <div>
      <p className="mb-3 text-xs text-mute">What a tenant here can be charged on top of the rent. A booking picks from this list, and can still change the price.</p>
      <ServiceList services={services} buildingId={building.id} onChange={setServices} onError={setError} readOnly={!master} />
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}

/** Who looks after a building: they get its leasing alerts. Everyone sees the names; the master picks them. */
function BuildingStaff({ building, master, onChanged }) {
  const [users, setUsers] = useState(null); // everybody, once the master opens the picker
  const [error, setError] = useState('');
  const mine = new Set((building.staff || []).map((u) => u.id));
  const open = () => api.get('/admin/users').then((list) => setUsers(list.filter((u) => !u.disabled))).catch((e) => setError(e.message));
  const toggle = async (id) => {
    setError('');
    const next = mine.has(id) ? [...mine].filter((x) => x !== id) : [...mine, id];
    try { await api.put(`/properties/buildings/${building.id}/staff`, { user_ids: next }); onChanged(); } catch (e) { setError(e.message); }
  };
  if (!master && !mine.size) return null;
  return (
    <div className="mb-4 rounded-2xl border border-stroke p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-mute">Looked after by</span>
        {users
          ? users.map((u) => (
            <button key={u.id} onClick={() => toggle(u.id)} className={`rounded-full px-3 py-1 ${mine.has(u.id) ? 'bg-p1/20 text-p1' : 'border border-stroke/70 text-mute hover:text-txt'}`}>{u.name}</button>
          ))
          : mine.size ? building.staff.map((u) => <span key={u.id} className="rounded-full bg-p1/15 px-3 py-1 text-p1">{u.name}</span>) : <span className="text-mute">nobody yet</span>}
        {master && (users
          ? <button onClick={() => setUsers(null)} className="ml-auto rounded-full px-3 py-1 text-mute hover:bg-white/5 hover:text-txt">Done</button>
          : <button onClick={open} className="ml-auto rounded-full border border-stroke/70 px-3 py-1 text-mute hover:bg-white/5 hover:text-txt">Change</button>)}
      </div>
      <p className="mt-2 text-xs text-mute">They get this building’s leasing alerts on their phone, with whoever made the booking and the master.</p>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}

export default function PropertiesPage({ me, onBack }) {
  const master = me?.role === 'master';
  const [at, setAt] = useState({ level: 'companies' }); // or { level: 'company', id } / { level: 'building', id }
  const [got, setGot] = useState({ url: null, data: null });
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false); // the company form: a new one on the home, an edit on a company's page
  const [newBuilding, setNewBuilding] = useState(false); // the add-building form on a company's page
  const [newUnit, setNewUnit] = useState(false); // the add-unit form on a building's page
  const [tab, setTab] = useState('units'); // which part of a building's page is showing
  useEffect(() => { setAdding(false); setNewBuilding(false); setNewUnit(false); setTab('units'); }, [at]);

  const url =at.level === 'companies' ? '/properties/companies' : at.level === 'company' ? `/properties/companies/${at.id}` : `/properties/buildings/${at.id}`;
  // Data is kept with the address it came from: on the render right after a tap, the old
  // level's data must not be drawn as the new level's.
  const data = got.url === url ? got.data : null;
  const load = () => api.get(url).then((d) => setGot({ url, data: d })).catch((e) => setError(e.message));
  useEffect(() => { setError(''); load(); }, [url]);

  const back = () => {
    if (at.level === 'building' && data?.company) return setAt({ level: 'company', id: data.company.id });
    if (at.level !== 'companies') return setAt({ level: 'companies' });
    onBack();
  };
  const title = at.level === 'companies' ? 'Properties' : data?.name || '…';
  const edit = (path, kind) => async (r, v, files) => { await api.put(`/properties/${path}/${r.id}`, v); await sendPhotos(kind, r.id, files); load(); };
  const del = (path) => async (r) => { await api.del(`/properties/${path}/${r.id}`); load(); };

  let body;
  if (error) body = <p className="text-sm text-bad">{error}</p>;
  else if (!data) body = <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  else if (at.level === 'companies') body = (
    <>
      <CompanyDocs master={master} onOpen={(c) => setAt({ level: 'company', id: c.id })} />
    </>
  );
  else if (at.level === 'company') body = (
    <>
      {(
          <div className="mb-4 flex items-start gap-3">
            <Logo row={data} master={master} onChanged={load} />
            <p className="flex-1 self-center text-sm text-mute">{join(data.trade_license_no && `Trade licence ${data.trade_license_no}`, data.trn && `TRN ${data.trn}`, data.phone, data.email, data.address) || 'No details yet.'}</p>
            {master && <>
              <button onClick={() => setAdding(true)} aria-label="Edit company" title="Edit company"
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
              <button onClick={async () => {
                if (!confirm(`Delete ${data.name} and all its documents?`)) return;
                try { await api.del(`/properties/companies/${data.id}`); setAt({ level: 'companies' }); } catch (e) { alert(e.message); }
              }} aria-label="Delete company" title="Delete company"
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
            </>}
          </div>
        )}
      <Level kind="building" rows={data.list} master={master} addLabel="Add a building" empty="No buildings under this company yet."
        line={(b) => join(b.area, b.emirate)}
        details={(b) => [['Address', b.address], ['Plot no.', b.plot_no], ['Makani no.', b.makani_no]]}
        stat={(b) => <span className="text-sm"><span className="text-lg font-light">{b.units}</span> <span className="text-mute">{b.units === 1 ? 'unit' : 'units'}</span></span>}
        addOpen={newBuilding} onAddClose={() => setNewBuilding(false)}
        onOpen={(b) => setAt({ level: 'building', id: b.id })} onChanged={load}
        onAdd={async (v, files) => { const b = await api.post(`/properties/companies/${data.id}/buildings`, v); await sendPhotos('building', b.id, files); load(); }} onSave={edit('buildings', 'building')} onRemove={del('buildings')} />
    </>
  );
  else body = (
    <>
      <Cover row={data} master={master} onChanged={load} />
      <p className="mb-3 text-sm text-mute">{join(data.company?.name, data.area, data.emirate, data.makani_no && `Makani ${data.makani_no}`)}</p>
      <BuildingStaff building={data} master={master} onChanged={load} />
      <div className="mb-4 flex gap-5 border-b border-stroke text-sm">
        {BUILDING_TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>
            {l}{k === 'units' && data.list.length > 0 && <span className="text-xs text-mute">{data.list.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'services' && <BuildingServices building={data} master={master} />}
      {tab === 'units' && <Level kind="unit" rows={data.list} master={master} addLabel="Add a unit" empty="No units in this building yet."
        line={(u) => join(u.floor && `Floor ${u.floor}`, u.type)}
        details={(u) => [['Size', u.size_sqft && `${Number(u.size_sqft).toLocaleString()} sq ft`], ['DEWA no.', u.dewa_no]]}
        stat={(u) => (
          <div className="flex min-w-0 items-center gap-2">
            {u.current_tenant
              ? <span className="truncate rounded-full bg-p1/15 px-2 py-0.5 text-[11px] text-p1" title={`Booked until ${u.current_until}`}>{u.current_tenant} · until {u.current_until}</span>
              : !u.blocked && <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[11px] text-ok">Vacant today</span>}
            {u.furnished && <span className="rounded-full bg-p3/15 px-2 py-0.5 text-[11px] text-p3">Furnished</span>}
            {u.blocked && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] text-bad">Blocked</span>}
          </div>
        )}
        addOpen={newUnit} onAddClose={() => setNewUnit(false)} onChanged={load}
        onAdd={async (v, files) => { const u = await api.post(`/properties/buildings/${data.id}/units`, v); await sendPhotos('unit', u.id, files); load(); }} onSave={edit('units', 'unit')} onRemove={del('units')} />}
    </>
  );

  // Registering or editing a company takes the whole page; back cancels.
  if (adding && data && at.level !== 'building') {
    const editing = at.level === 'company' ? data : null;
    const save = editing
      ? async (v, files) => { await api.put(`/properties/companies/${data.id}`, v); await sendPhotos('company', data.id, files); setAdding(false); load(); }
      : async (v, files) => { const c = await api.post('/properties/companies', v); await sendPhotos('company', c.id, files); setAdding(false); setAt({ level: 'company', id: c.id }); };
    return (
      <Page title={editing ? `Edit ${editing.name}` : 'Register company'} onBack={() => setAdding(false)}>
        <div className="rounded-3xl border border-stroke p-5 md:p-7">
          <Form kind="company" start={editing} onSave={save} onCancel={() => setAdding(false)} bare />
        </div>
      </Page>
    );
  }

  const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white';
  const action = !master ? null
    : at.level === 'companies' ? <button onClick={() => setAdding(true)} className={PRIMARY}><Plus size={16} /> Register company</button>
      : at.level === 'company' && data && !newBuilding ? <button onClick={() => setNewBuilding(true)} className={PRIMARY}><Plus size={16} /> Add building</button>
        : at.level === 'building' && data && tab === 'units' && !newUnit ? <button onClick={() => setNewUnit(true)} className={PRIMARY}><Plus size={16} /> Add unit</button>
          : null;
  return <Page title={title} action={action} onBack={back}>{body}</Page>;
}
