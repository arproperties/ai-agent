import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Paperclip, Pencil, Plus, Search, Trash2, Archive as ArchiveIcon } from 'lucide-react';
import { canDo } from '../lib/actions';
import { api } from '../lib/api';
import { money as aed } from '../lib/region';
import { usDate as fmt } from '../lib/usFormat';
import Select from './Select';
import DateField from './DateField';
import Sheet from './Sheet';
import Pager, { usePaged } from './Pager';

// The Rent Manager archive: old leases kept as history, typed in by staff (server/leaseArchive.js).
// A record only: it never touches a balance, a schedule, a report or what is sent to anyone.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const TOOL = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt';
const CANCEL = 'rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10';
export const ARCHIVE_BADGE = 'Archived · from Rent Manager — history only, no billing';
const NOT_IN_APP = '__typed__';
const BATCH = 10; // files the server takes in one go
const ENDED = { renewed: 'Renewed', moved_out: 'Moved out', evicted: 'Evicted', transferred: 'Transferred to another unit' };
const money = (n) => (n == null || n === '' ? '—' : aed(n));
const payUrl = (p) => `/api/leasing/archive/payments/${p.id}/file`;
const fileUrl = (f) => `/api/leasing/archive/files/${f.id}/file`;

const Label = ({ text, need, children, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
    {children}
  </label>
);

/** Files chosen on this screen and not yet saved, with a way to take one off. */
function Picker({ picked, setPicked, label = 'Attach files' }) {
  return (
    <div className="sm:col-span-2">
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        <Paperclip size={15} className="shrink-0" /> <span>{label}</span>
        <input type="file" multiple className="hidden" onChange={(e) => { setPicked([...picked, ...e.target.files]); e.target.value = ''; }} />
      </label>
      {picked.length > 0 && (
        <ul className="mt-2 divide-y divide-stroke/60 rounded-xl border border-stroke text-sm">
          {picked.map((f, n) => (
            <li key={`${f.name}-${n}`} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <button type="button" onClick={() => setPicked(picked.filter((_, i) => i !== n))} aria-label={`Take off ${f.name}`} className={`${TOOL} hover:text-bad`}><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Send files to an archived lease a batch at a time (to a work order when `woId` is given). */
async function sendFiles(archiveId, picked, { title = '', category = '', woId = '' } = {}) {
  for (let left = picked; left.length; left = left.slice(BATCH)) {
    const form = new FormData();
    left.slice(0, BATCH).forEach((f) => form.append('files', f));
    form.append('title', title); form.append('category', category); form.append('work_order_id', woId);
    await api.upload(`/leasing/archive/${archiveId}/files`, form);
  }
}

/** A little form under a heading: the fields, an error line and Cancel / Save. */
function Mini({ onSubmit, onCancel, busy, error, children }) {
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-2xl border border-p1/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onCancel} className={CANCEL}>Cancel</button><button disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

/** Run a save with a busy flag and an error line; `done` runs if it worked. */
function useSave(done) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn) => async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await fn(); done(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return { busy, error, run };
}

function PaymentForm({ archiveId, start, methods, onDone, onCancel }) {
  const [v, setV] = useState({ received_on: '', amount: '', method: 'cash', reference: '', notes: '', ...start });
  const [picked, setPicked] = useState([]);
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const { busy, error, run } = useSave(onDone);
  const save = run(async () => {
    const body = { received_on: v.received_on, amount: v.amount, method: v.method, reference: v.reference || '', notes: v.notes || '' };
    if (start) return api.put(`/leasing/archive/payments/${start.id}`, body);
    const form = new FormData();
    Object.entries(body).forEach(([k, x]) => form.append(k, x));
    if (picked[0]) form.append('file', picked[0]);
    return api.upload(`/leasing/archive/${archiveId}/payments`, form);
  });
  return (
    <Mini onSubmit={save} onCancel={onCancel} busy={busy} error={error}>
      <Label text="Date" need><DateField value={v.received_on || ''} onChange={set('received_on')} required className={FIELD} /></Label>
      <Label text="Amount" need><input type="number" step="0.01" min="0.01" value={v.amount ?? ''} onChange={set('amount')} required className={FIELD} /></Label>
      <Label text="Method" need><Select value={v.method} onChange={set('method')} className={FIELD} options={methods} /></Label>
      <Label text="Reference"><input value={v.reference || ''} onChange={set('reference')} maxLength={200} placeholder="Check number, slip number…" className={FIELD} /></Label>
      <Label text="Notes" wide><input value={v.notes || ''} onChange={set('notes')} maxLength={1000} className={FIELD} /></Label>
      {!start && (
        <div className="sm:col-span-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
            <Paperclip size={15} className="shrink-0" /> <span className="truncate">{picked[0] ? picked[0].name : 'Attach a receipt or check image (optional)'}</span>
            <input type="file" className="hidden" onChange={(e) => setPicked(e.target.files[0] ? [e.target.files[0]] : [])} />
          </label>
        </div>
      )}
    </Mini>
  );
}

function WorkOrderForm({ archiveId, start, onDone, onCancel }) {
  const [v, setV] = useState({ reported_on: '', detail: '', resolution: '', done_on: '', cost: '', ...start });
  const [picked, setPicked] = useState([]);
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const { busy, error, run } = useSave(onDone);
  const save = run(async () => {
    const body = { reported_on: v.reported_on, detail: v.detail, resolution: v.resolution || '', done_on: v.done_on || '', cost: v.cost ?? '' };
    const saved = await (start ? api.put(`/leasing/archive/work-orders/${start.id}`, body) : api.post(`/leasing/archive/${archiveId}/work-orders`, body));
    if (picked.length) await sendFiles(archiveId, picked, { woId: saved.id });
  });
  return (
    <Mini onSubmit={save} onCancel={onCancel} busy={busy} error={error}>
      <Label text="Reported" need><DateField value={v.reported_on || ''} onChange={set('reported_on')} required className={FIELD} /></Label>
      <Label text="Done on"><DateField value={v.done_on || ''} onChange={set('done_on')} className={FIELD} /></Label>
      <Label text="What was wrong" need wide><textarea value={v.detail || ''} onChange={set('detail')} required rows={2} maxLength={2000} className={`${FIELD} resize-none`} /></Label>
      <Label text="What was done" wide><textarea value={v.resolution || ''} onChange={set('resolution')} rows={2} maxLength={2000} className={`${FIELD} resize-none`} /></Label>
      <Label text="Cost"><input type="number" step="0.01" min="0" value={v.cost ?? ''} onChange={set('cost')} className={FIELD} /></Label>
      <Picker picked={picked} setPicked={setPicked} label="Add photos or files (as many as you need)" />
    </Mini>
  );
}

function FilesForm({ archiveId, onDone, onCancel }) {
  const [v, setV] = useState({ title: '', category: '' });
  const [picked, setPicked] = useState([]);
  const { busy, error, run } = useSave(onDone);
  const save = run(async () => {
    if (!picked.length) throw new Error('Choose a file to attach.');
    await sendFiles(archiveId, picked, v);
  });
  return (
    <Mini onSubmit={save} onCancel={onCancel} busy={busy} error={error}>
      <Label text="Title"><input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} placeholder="Signed lease, notice…" className={FIELD} /></Label>
      <Label text="Category"><input value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} maxLength={60} placeholder="Lease, notice, photos…" className={FIELD} /></Label>
      <Picker picked={picked} setPicked={setPicked} label="Choose files (as many as you need)" />
    </Mini>
  );
}

function LeaseForm({ start, places, tenants, onDone, onCancel }) {
  const typed = !!start && !start.tenant_id;
  const [v, setV] = useState({ building_id: start ? String(start.building_id) : '', unit_id: start ? String(start.unit_id) : '', tenant: start ? (start.tenant_id ? String(start.tenant_id) : NOT_IN_APP) : '',
    tenant_name: typed ? start.tenant : '', start_date: start?.start_date || '', end_date: start?.end_date || '', rent_amount: start?.rent_amount ?? '', security_deposit: start?.security_deposit ?? '',
    ended_how: start?.ended_how || '', unpaid_at_end: start?.unpaid_at_end ?? '', notes: start?.notes || '' });
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const { busy, error, run } = useSave(() => onDone());
  const units = places.units.filter((u) => String(u.building_id) === String(v.building_id));
  const save = run(async () => {
    // Switching to a typed name sends tenant_id: null, or the server keeps the old tenant.
    const body = { unit_id: v.unit_id, start_date: v.start_date, end_date: v.end_date, rent_amount: v.rent_amount, security_deposit: v.security_deposit, ended_how: v.ended_how, unpaid_at_end: v.unpaid_at_end, notes: v.notes,
      ...(v.tenant === NOT_IN_APP ? { tenant_id: null, tenant_name: v.tenant_name } : { tenant_id: v.tenant }) };
    return start ? api.put(`/leasing/archive/${start.id}`, body) : api.post('/leasing/archive', body);
  });
  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-p1/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Building" need><Select value={v.building_id} onChange={(e) => setV({ ...v, building_id: e.target.value, unit_id: '' })} placeholder="Choose the building" className={FIELD} options={places.buildings.map((b) => [String(b.id), b.name])} /></Label>
        <Label text="Unit" need><Select value={v.unit_id} onChange={set('unit_id')} disabled={!v.building_id} placeholder={v.building_id ? 'Choose the unit' : 'Pick the building first'} className={FIELD} options={units.map((u) => [String(u.id), `Unit ${u.unit_no}`])} /></Label>
        <Label text="Tenant" need wide>
          <Select value={v.tenant} onChange={set('tenant')} placeholder="Choose the tenant" className={FIELD} options={[[NOT_IN_APP, 'Not in the app — type name'], ...tenants.map((t) => [String(t.id), t.full_name])]} />
        </Label>
        {v.tenant === NOT_IN_APP && <Label text="Tenant name" need wide><input value={v.tenant_name} onChange={set('tenant_name')} required maxLength={200} className={FIELD} /></Label>}
        <Label text="Start" need><DateField value={v.start_date} onChange={set('start_date')} required className={FIELD} /></Label>
        <Label text="End" need><DateField value={v.end_date} onChange={set('end_date')} required className={FIELD} /></Label>
        <Label text="Monthly rent"><input type="number" step="0.01" min="0" value={v.rent_amount} onChange={set('rent_amount')} className={FIELD} /></Label>
        <Label text="Deposit"><input type="number" step="0.01" min="0" value={v.security_deposit} onChange={set('security_deposit')} className={FIELD} /></Label>
        <Label text="How it ended" need><Select value={v.ended_how} onChange={set('ended_how')} placeholder="Choose" className={FIELD} options={Object.entries(ENDED)} /></Label>
        <Label text="Unpaid at end"><input type="number" step="0.01" min="0" value={v.unpaid_at_end} onChange={set('unpaid_at_end')} className={FIELD} /></Label>
        <Label text="Notes" wide><textarea value={v.notes} onChange={set('notes')} rows={2} maxLength={4000} className={`${FIELD} resize-none`} /></Label>
      </div>
      <p className="text-xs text-mute">A record only: it charges nothing, and nothing is sent to anyone. “Unpaid at end” is a figure to read.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onCancel} className={CANCEL}>Cancel</button><button disabled={busy || !v.unit_id || !v.tenant || !v.ended_how} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

/** A file link with, when allowed, a way to remove it. */
function FileLink({ f, onRemove }) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1">
      <a href={fileUrl(f)} target="_blank" rel="noreferrer" title={f.file_name} className={GHOST}><Paperclip size={13} className="shrink-0" /> <span className="truncate">{f.title || f.file_name}</span></a>
      {canDo('delete') && <button onClick={() => onRemove(f)} aria-label={`Remove ${f.file_name}`} title="Remove" className={`${TOOL} hover:text-bad`}><Trash2 size={14} /></button>}
    </span>
  );
}

/** A section heading with its Add button. */
const Head = ({ title, count, onAdd, adding }) => (
  <div className="flex items-center gap-2">
    <h3 className="flex-1 text-sm font-medium">{title} <span className="text-mute">{count}</span></h3>
    {canDo('add') && !adding && <button onClick={onAdd} className={GHOST}><Plus size={13} /> Add</button>}
  </div>
);

/** One archived lease: its terms, and its payments, work orders and files, each editable. `onChanged` runs after any change. */
export function ArchiveDetail({ id, places, tenants, methods: given, onChanged, onDeleted, onBack }) {
  const [a, setA] = useState(null);
  const [loaded, setLoaded] = useState([]); // the server's payment methods, when the caller did not pass them
  const methods = given || loaded;
  useEffect(() => { if (!given) api.get('/leasing/archive/meta').then((m) => setLoaded(m.methods)).catch(() => {}); }, [!!given]);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null); // 'lease', or { kind: 'pay' | 'wo' | 'files', row }
  const load = () => api.get(`/leasing/archive/${id}`).then((x) => { setA(x); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const changed = () => { setEdit(null); load(); onChanged?.(); };
  const act = async (fn) => { setError(''); try { await fn(); changed(); } catch (e) { setError(e.message); } };
  const del = (what, path) => confirm(`Delete ${what}?`) && act(() => api.del(path));
  const editing = (kind) => edit?.kind === kind;
  if (!a) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;

  return (
    <div className="space-y-5">
      {onBack && <button onClick={onBack} className={GHOST}><ArrowLeft size={13} /> Back to the list</button>}
      <p className="flex items-center gap-2 rounded-xl bg-warn/15 px-3.5 py-2 text-sm text-warn"><ArchiveIcon size={15} className="shrink-0" /> {ARCHIVE_BADGE}</p>
      {edit === 'lease' && places ? <LeaseForm start={a} places={places} tenants={tenants} onDone={changed} onCancel={() => setEdit(null)} /> : (
        <div className="rounded-2xl border border-stroke p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{a.tenant}</p>
              <p className="text-xs text-mute">Unit {a.unit_no} · {a.building}</p>
            </div>
            {places && canDo('edit') && <button onClick={() => setEdit('lease')} aria-label="Edit" title="Edit" className={TOOL}><Pencil size={15} /></button>}
            {onDeleted && canDo('delete') && <button onClick={() => confirm(`Delete this archived lease of ${a.tenant} with all its payments, work orders and files?`) && act(async () => { await api.del(`/leasing/archive/${a.id}`); onDeleted(); })} aria-label="Delete" title="Delete" className={`${TOOL} hover:text-bad`}><Trash2 size={15} /></button>}
          </div>
          <dl className="mt-3 divide-y divide-stroke/60 border-t border-stroke text-sm">
            {[['Lease', `${fmt(a.start_date)} → ${fmt(a.end_date)}`], ['Monthly rent', money(a.rent_amount)], ['Deposit', money(a.security_deposit)], ['How it ended', ENDED[a.ended_how]], ['Unpaid at end', money(a.unpaid_at_end)], ['Notes', a.notes]].map(([k, x]) => (
              <div key={k} className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-mute">{k}</dt><dd className="min-w-0 whitespace-pre-wrap text-right">{x || '—'}</dd></div>
            ))}
          </dl>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}

      <section className="space-y-2">
        <Head title="Payments" count={a.payments.length} onAdd={() => setEdit({ kind: 'pay' })} adding={editing('pay') && !edit.row} />
        {editing('pay') && !edit.row && <PaymentForm archiveId={a.id} methods={methods} onDone={changed} onCancel={() => setEdit(null)} />}
        {a.payments.length === 0 && !editing('pay') && <p className="text-sm text-mute">No payments entered.</p>}
        {a.payments.map((p) => (editing('pay') && edit.row?.id === p.id ? <PaymentForm key={p.id} archiveId={a.id} start={p} methods={methods} onDone={changed} onCancel={() => setEdit(null)} /> : (
          <div key={p.id} className="flex items-start gap-2 rounded-xl border border-stroke/70 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p>{fmt(p.received_on)} · <span className="font-medium">{money(p.amount)}</span> · {(methods.find(([k]) => k === p.method) || [])[1] || p.method}</p>
              {(p.reference || p.notes) && <p className="truncate text-xs text-mute">{[p.reference, p.notes].filter(Boolean).join(' · ')}</p>}
              {p.file_name && <a href={payUrl(p)} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-p3 hover:underline"><Paperclip size={12} /> {p.file_name}</a>}
            </div>
            {canDo('edit') && <button onClick={() => setEdit({ kind: 'pay', row: p })} aria-label="Edit payment" title="Edit" className={TOOL}><Pencil size={14} /></button>}
            {canDo('delete') && <button onClick={() => del(`the ${money(p.amount)} payment of ${fmt(p.received_on)}`, `/leasing/archive/payments/${p.id}`)} aria-label="Delete payment" title="Delete" className={`${TOOL} hover:text-bad`}><Trash2 size={14} /></button>}
          </div>
        )))}
      </section>

      <section className="space-y-2">
        <Head title="Work orders" count={a.work_orders.length} onAdd={() => setEdit({ kind: 'wo' })} adding={editing('wo') && !edit.row} />
        {editing('wo') && !edit.row && <WorkOrderForm archiveId={a.id} onDone={changed} onCancel={() => setEdit(null)} />}
        {a.work_orders.length === 0 && !editing('wo') && <p className="text-sm text-mute">No work orders entered.</p>}
        {a.work_orders.map((w) => (editing('wo') && edit.row?.id === w.id ? <WorkOrderForm key={w.id} archiveId={a.id} start={w} onDone={changed} onCancel={() => setEdit(null)} /> : (
          <div key={w.id} className="rounded-xl border border-stroke/70 px-3 py-2 text-sm">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap">{w.detail}</p>
                {w.resolution && <p className="mt-0.5 whitespace-pre-wrap text-txt/80">Done: {w.resolution}</p>}
                <p className="mt-0.5 text-xs text-mute">Reported {fmt(w.reported_on)}{w.done_on && ` · done ${fmt(w.done_on)}`}{w.cost != null && ` · ${money(w.cost)}`}</p>
              </div>
              {canDo('edit') && <button onClick={() => setEdit({ kind: 'wo', row: w })} aria-label="Edit work order" title="Edit" className={TOOL}><Pencil size={14} /></button>}
              {canDo('delete') && <button onClick={() => del('this work order and its files', `/leasing/archive/work-orders/${w.id}`)} aria-label="Delete work order" title="Delete" className={`${TOOL} hover:text-bad`}><Trash2 size={14} /></button>}
            </div>
            {w.files.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{w.files.map((f) => <FileLink key={f.id} f={f} onRemove={(x) => del(x.file_name, `/leasing/archive/files/${x.id}`)} />)}</div>}
          </div>
        )))}
      </section>

      <section className="space-y-2">
        <Head title="Files" count={a.files.length} onAdd={() => setEdit({ kind: 'files' })} adding={editing('files')} />
        {editing('files') && <FilesForm archiveId={a.id} onDone={changed} onCancel={() => setEdit(null)} />}
        {a.files.length === 0 && !editing('files') && <p className="text-sm text-mute">No files attached.</p>}
        <div className="flex flex-wrap gap-1.5">{a.files.map((f) => <FileLink key={f.id} f={f} onRemove={(x) => del(x.file_name, `/leasing/archive/files/${x.id}`)} />)}</div>
        {a.files.some((f) => f.category) && <p className="text-xs text-mute">{[...new Set(a.files.map((f) => f.category).filter(Boolean))].join(' · ')}</p>}
      </section>
    </div>
  );
}

/** An archived lease in a dialog, for the lease card and a tenant's history. */
export function ArchiveSheet({ id, onClose }) {
  return (
    <Sheet title="Archived lease" icon={<ArchiveIcon size={18} className="text-warn" />} onClose={onClose}>
      <ArchiveDetail id={id} />
    </Sheet>
  );
}

/** One archived lease as a short row; shared by the lease card and the tenant history. */
export const archiveLine = (r) => `${fmt(r.start_date)} → ${fmt(r.end_date)} · ${money(r.rent_amount)} · ${ENDED[r.ended_how] || ''}`;

export default function Archive() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [building, setBuilding] = useState('');
  const [unit, setUnit] = useState('');
  const [open, setOpen] = useState(null); // an id, or 'new'
  const [places, setPlaces] = useState({ buildings: [], units: [] });
  const [tenants, setTenants] = useState([]);
  const [methods, setMethods] = useState([]);
  const [error, setError] = useState('');
  const load = () => api.get(`/leasing/archive?q=${encodeURIComponent(q)}${building ? `&building_id=${building}` : ''}${unit ? `&unit_id=${unit}` : ''}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q, building, unit]);
  useEffect(() => {
    api.get('/properties/places').then(setPlaces).catch(() => {});
    api.get('/leasing/tenants').then(setTenants).catch(() => {});
    api.get('/leasing/archive/meta').then((m) => setMethods(m.methods)).catch(() => {});
  }, []);
  const paged = usePaged(rows, [q, building, unit].join('|'));
  const back = () => { setOpen(null); load(); };
  const units = places.units.filter((u) => String(u.building_id) === String(building));

  if (open && open !== 'new') return <ArchiveDetail id={open} places={places} tenants={tenants} methods={methods} onChanged={load} onDeleted={back} onBack={back} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative block min-w-[12rem] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by tenant, unit or year" className={`${FIELD} pl-10`} />
        </label>
        <Select value={building} onChange={(e) => { setBuilding(e.target.value); setUnit(''); }} className={FIELD} wrap="w-44" placeholder="All buildings" options={[['', 'All buildings'], ...places.buildings.map((b) => [String(b.id), b.name])]} />
        <Select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!building} className={FIELD} wrap="w-36" placeholder="All units" options={[['', 'All units'], ...units.map((u) => [String(u.id), `Unit ${u.unit_no}`])]} />
        {canDo('add') && <button onClick={() => setOpen('new')} className={PRIMARY}><Plus size={16} /> Add old lease</button>}
      </div>
      <p className="text-xs text-mute">Old leases from Rent Manager, kept as history. They bill nothing and change no balance or report.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {open === 'new' && <LeaseForm places={places} tenants={tenants} onDone={back} onCancel={() => setOpen(null)} />}
      {!rows ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : rows.length === 0 ? <p className="py-3 text-sm text-mute">{q || building ? 'No archived leases match.' : 'Nothing archived yet. Add the old Rent Manager leases here.'}</p> : (
          <>
            <div className="overflow-x-auto rounded-2xl border border-stroke">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-mute"><tr className="border-b border-stroke"><th className="px-3 py-2 font-normal">Unit</th><th className="px-3 py-2 font-normal">Tenant</th><th className="px-3 py-2 font-normal">Lease</th><th className="px-3 py-2 font-normal">Rent</th><th className="px-3 py-2 font-normal">Ended</th><th className="px-3 py-2 font-normal">Records</th></tr></thead>
                <tbody className="divide-y divide-stroke/60">
                  {paged.rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer align-top hover:bg-white/5">
                      <td className="px-3 py-2.5"><p>Unit {r.unit_no}</p><p className="text-xs text-mute">{r.building}</p></td>
                      <td className="px-3 py-2.5">{r.tenant}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{fmt(r.start_date)} → {fmt(r.end_date)}</td>
                      <td className="px-3 py-2.5">{money(r.rent_amount)}</td>
                      <td className="px-3 py-2.5">{ENDED[r.ended_how]}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-mute">{r.payments} payments · {r.work_orders} work orders · {r.files} files</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager {...paged.pager} />
          </>
        )}
    </div>
  );
}
