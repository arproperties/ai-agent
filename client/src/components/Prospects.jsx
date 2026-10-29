import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, Search, FileSignature, BellRing } from 'lucide-react';
import { canDo } from '../lib/actions';
import { api } from '../lib/api';
import { usDate as fmt, usPhone } from '../lib/usFormat';
import { STATUSES } from '../lib/prospects';
import Select from './Select';
import DateField from './DateField';
import PhoneField from './PhoneField';
import Pager, { usePaged } from './Pager';

// Prospects: people interested in a unit, before they are tenants (server/prospects.js).
// Make lease opens the lease form filled in from one; the lease saved there marks it leased.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const TOOL = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt';
const NAME = Object.fromEntries(STATUSES);
const TONE = { new: 'bg-p3/15 text-p3', viewing: 'bg-p1/15 text-p1', applied: 'bg-warn/15 text-warn', lost: 'bg-white/5 text-mute', leased: 'bg-ok/15 text-ok' };
const FILTERS = [['', 'All'], ...STATUSES.slice(0, 3), ['leased', 'Leased'], ['lost', 'Lost']];
const stage = (p) => (p.leased ? 'leased' : p.status);

function Label({ text, need, children, wide }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
      {children}
    </label>
  );
}

function ProspectForm({ start, places, sources, onDone, onCancel }) {
  const [v, setV] = useState({ full_name: '', phone: '', email: '', building_id: '', unit_id: '', move_in_date: '', source: '', status: 'new', lost_reason: '', follow_up: '', notes: '', ...start });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const units = places.units.filter((u) => String(u.building_id) === String(v.building_id));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = { ...v, lost_reason: v.status === 'lost' ? v.lost_reason : '' };
    try { await (start ? api.put(`/leasing/prospects/${start.id}`, body) : api.post('/leasing/prospects', body)); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-p1/40 p-4 md:col-span-2 xl:col-span-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Full name" need wide><input value={v.full_name || ''} onChange={set('full_name')} required className={FIELD} /></Label>
        <Label text="Phone"><PhoneField value={v.phone || ''} onChange={set('phone')} className={FIELD} /></Label>
        <Label text="Email"><input type="email" value={v.email || ''} onChange={set('email')} className={FIELD} /></Label>
        <Label text="Building wanted">
          <Select value={String(v.building_id || '')} onChange={(e) => setV({ ...v, building_id: e.target.value, unit_id: '' })} placeholder="Any building" className={FIELD}
            options={[['', 'Any building'], ...places.buildings.map((b) => [String(b.id), b.name])]} />
        </Label>
        <Label text="Unit wanted">
          <Select value={String(v.unit_id || '')} onChange={set('unit_id')} disabled={!v.building_id} placeholder={v.building_id ? 'Any unit' : 'Pick the building first'} className={FIELD}
            options={[['', 'Any unit'], ...units.map((u) => [String(u.id), `Unit ${u.unit_no}`])]} />
        </Label>
        <Label text="Move-in wanted"><DateField value={v.move_in_date || ''} onChange={set('move_in_date')} className={FIELD} /></Label>
        <Label text="Source">
          <Select value={v.source || ''} onChange={set('source')} placeholder="Where they came from" className={FIELD} options={[['', 'Not known'], ...sources.map((s) => [s.name, s.name])]} />
        </Label>
        <Label text="Status"><Select value={v.status} onChange={set('status')} className={FIELD} options={STATUSES} /></Label>
        <Label text="Follow up on"><DateField value={v.follow_up || ''} onChange={set('follow_up')} className={FIELD} /></Label>
        {v.status === 'lost' && <Label text="Why lost" need wide><input value={v.lost_reason || ''} onChange={set('lost_reason')} required className={FIELD} /></Label>}
        <Label text="Notes" wide><textarea value={v.notes || ''} onChange={set('notes')} rows={2} className={`${FIELD} resize-none`} /></Label>
      </div>
      <p className="text-xs text-mute">A phone number or an email is needed, so they can be reached.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}>Save</button>
      </div>
    </form>
  );
}

export default function Prospects({ canLease, onLease }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null); // an id, or 'new'
  const [places, setPlaces] = useState({ buildings: [], units: [] });
  const [sources, setSources] = useState([]);
  const [error, setError] = useState('');
  const load = () => api.get(`/leasing/prospects?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    api.get('/properties/places').then(setPlaces).catch(() => {});
    api.get('/leasing/sources').then(setSources).catch(() => {});
  }, []);
  const remove = async (p) => {
    if (!confirm(`Delete ${p.full_name}?`)) return;
    try { await api.del(`/leasing/prospects/${p.id}`); load(); } catch (e) { setError(e.message); }
  };

  const count = (k) => (rows || []).filter((p) => !k || stage(p) === k).length;
  const shown = rows && rows.filter((p) => !filter || stage(p) === filter);
  const paged = usePaged(shown, [q, filter].join('|'));
  const done = () => { setEditing(null); load(); };
  const form = (start) => <ProspectForm key={start?.id || 'new'} start={start} places={places} sources={sources} onDone={done} onCancel={() => setEditing(null)} />;
  const wanted = (p) => [p.building, p.unit_no && `Unit ${p.unit_no}`].filter(Boolean).join(' · ') || 'Any unit';

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prospects by name, phone, email or notes" className={`${FIELD} pl-10`} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${filter === k ? 'border-p1/60 bg-p1/15 text-txt' : 'border-stroke/70 text-mute hover:bg-white/5 hover:text-txt'}`}>
            {label} <span className="tabular-nums text-mute">{count(k)}</span>
          </button>
        ))}
        {canDo('add') && <button onClick={() => setEditing('new')} className={`${PRIMARY} ml-auto`}><Plus size={16} /> Add prospect</button>}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {editing === 'new' && <div className="grid">{form(null)}</div>}
      {!shown ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : shown.length === 0 ? <p className="py-3 text-sm text-mute">{rows.length ? 'No prospects match.' : 'No prospects yet. Add the people asking about a unit here.'}</p>
          : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {paged.rows.map((p) => (editing === p.id ? form(p) : (
                  <div key={p.id} className={`rounded-2xl border ${p.due ? 'border-warn/50' : 'border-stroke'}`}>
                    <div className="flex items-start gap-3 px-4 pt-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.full_name}</p>
                        <p className="truncate text-xs text-mute">{wanted(p)}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${TONE[stage(p)]}`}>{p.leased ? 'Leased' : NAME[p.status]}</span>
                      <div className="-mr-1.5 flex shrink-0">
                        {canDo('edit') && <button onClick={() => setEditing(p.id)} aria-label="Edit" title="Edit" className={TOOL}><Pencil size={15} /></button>}
                        {canDo('delete') && <button onClick={() => remove(p)} aria-label="Delete" title="Delete" className={`${TOOL} hover:text-bad`}><Trash2 size={15} /></button>}
                      </div>
                    </div>
                    {p.due && <p className="mx-4 mt-2 flex items-center gap-1.5 text-xs text-warn"><BellRing size={13} /> Follow up {p.follow_up < new Date().toISOString().slice(0, 10) ? `overdue (${fmt(p.follow_up)})` : 'today'}</p>}
                    <dl className="mx-4 my-3 divide-y divide-stroke/60 border-t border-stroke text-sm">
                      {[['Phone', usPhone(p.phone)], ['Email', p.email], ['Move-in wanted', p.move_in_date && fmt(p.move_in_date)], ['Source', p.source],
                        ...(p.due || !p.follow_up ? [] : [['Follow up', fmt(p.follow_up)]]), ...(p.leased ? [['Lease', p.lease_ref]] : []),
                        ...(p.status === 'lost' && !p.leased ? [['Why lost', p.lost_reason]] : [])].map(([l, x]) => (
                        <div key={l} className="flex gap-4 py-2"><dt className="shrink-0 text-mute">{l}</dt><dd className={`min-w-0 flex-1 truncate text-right ${x ? '' : 'text-mute/50'}`}>{x || '—'}</dd></div>
                      ))}
                      {p.notes && <div className="py-2"><dt className="text-mute">Notes</dt><dd className="mt-0.5 line-clamp-2 text-xs text-txt/80" title={p.notes}>{p.notes}</dd></div>}
                    </dl>
                    {/* The lease form asks for the documents; it is saved as a draft until the move-in inspection. */}
                    {canLease && canDo('add') && !p.leased && p.status !== 'lost' && (
                      <div className="px-4 pb-4"><button onClick={() => onLease(p)} className={`${PRIMARY} w-full justify-center`}><FileSignature size={16} /> Make lease</button></div>
                    )}
                  </div>
                )))}
              </div>
              <Pager {...paged.pager} />
            </>
          )}
    </div>
  );
}
