import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, ChevronRight, Building2, Landmark, DoorOpen } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import CompanyDocs from './CompanyDocs';

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

function Form({ kind, start, onSave, onCancel, bare }) {
  const [v, setV] = useState(() => Object.fromEntries(fieldsOf(kind).map(([f, , t]) => [f, start?.[f] ?? (t === 'bool' ? false : '')])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onSave(v); } catch (err) { setError(err.message); setBusy(false); }
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
                  <input type="checkbox" checked={!!v[f]} onChange={set(f)} className="size-4 accent-[#a78bfa]" /> {label}
                </label>
              );
              let input;
              if (t === 'area') input = <textarea value={v[f] ?? ''} onChange={set(f)} rows={3} placeholder={example} className={`${FIELD} resize-none`} />;
              else if (t === 'emirate' || t === 'unittype') input = (
                <select value={v[f] ?? ''} onChange={set(f)} className={`${FIELD} bg-[#141128]`}>
                  <option value="">Choose…</option>
                  {(t === 'emirate' ? EMIRATES : UNIT_TYPES).map((o) => <option key={o}>{o}</option>)}
                </select>
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
function Level({ kind, rows, master, onOpen, onAdd, onSave, onRemove, addLabel, empty, line, details, stat, addOpen, onAddClose }) {
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
      {addOpen && <Form kind={kind} onSave={async (v) => { await onAdd(v); onAddClose(); }} onCancel={onAddClose} />}
      {rows.find((r) => r.id === editing) && (
        <Form kind={kind} start={rows.find((r) => r.id === editing)} onSave={async (v) => { await onSave(rows.find((r) => r.id === editing), v); setEditing(null); }} onCancel={() => setEditing(null)} />
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col rounded-2xl border border-stroke">
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
        ? <Form key={r.id} kind={kind} start={r} onSave={async (v) => { await onSave(r, v); setEditing(null); }} onCancel={() => setEditing(null)} />
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
        ? <Form kind={kind} onSave={async (v) => { await onAdd(v); setEditing(null); }} onCancel={() => setEditing(null)} />
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

export default function PropertiesPage({ me, onBack }) {
  const master = me?.role === 'master';
  const [at, setAt] = useState({ level: 'companies' }); // or { level: 'company', id } / { level: 'building', id }
  const [got, setGot] = useState({ url: null, data: null });
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false); // the company form: a new one on the home, an edit on a company's page
  const [newBuilding, setNewBuilding] = useState(false); // the add-building form on a company's page
  const [newUnit, setNewUnit] = useState(false); // the add-unit form on a building's page
  useEffect(() => { setAdding(false); setNewBuilding(false); setNewUnit(false); }, [at]);

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
  const edit = (path) => async (r, v) => { await api.put(`/properties/${path}/${r.id}`, v); load(); };
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
          <div className="mb-3 flex items-start gap-2">
            <p className="flex-1 text-sm text-mute">{join(data.trade_license_no && `Trade licence ${data.trade_license_no}`, data.trn && `TRN ${data.trn}`, data.phone, data.email, data.address) || 'No details yet.'}</p>
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
        onOpen={(b) => setAt({ level: 'building', id: b.id })}
        onAdd={async (v) => { await api.post(`/properties/companies/${data.id}/buildings`, v); load(); }} onSave={edit('buildings')} onRemove={del('buildings')} />
    </>
  );
  else body = (
    <>
      <p className="mb-3 text-sm text-mute">{join(data.company?.name, data.area, data.emirate, data.makani_no && `Makani ${data.makani_no}`)}</p>
      <Level kind="unit" rows={data.list} master={master} addLabel="Add a unit" empty="No units in this building yet."
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
        addOpen={newUnit} onAddClose={() => setNewUnit(false)}
        onAdd={async (v) => { await api.post(`/properties/buildings/${data.id}/units`, v); load(); }} onSave={edit('units')} onRemove={del('units')} />
    </>
  );

  // Registering or editing a company takes the whole page; back cancels.
  if (adding && data && at.level !== 'building') {
    const editing = at.level === 'company' ? data : null;
    const save = editing
      ? async (v) => { await api.put(`/properties/companies/${data.id}`, v); setAdding(false); load(); }
      : async (v) => { const c = await api.post('/properties/companies', v); setAdding(false); setAt({ level: 'company', id: c.id }); };
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
        : at.level === 'building' && data && !newUnit ? <button onClick={() => setNewUnit(true)} className={PRIMARY}><Plus size={16} /> Add unit</button>
          : null;
  return <Page title={title} action={action} onBack={back}>{body}</Page>;
}
