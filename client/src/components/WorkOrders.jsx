import { useEffect, useState } from 'react';
import { Ban, Check, CheckCheck, Loader2, MessageSquarePlus, Paperclip, Pencil, Play, Plus, RotateCcw, Search, Trash2, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateField from './DateField';

// Work orders: a repair to a unit, from the report to the fix. Raised on a unit, it links
// itself to the tenant living there (the server works that out: server/workOrders.js), and
// everything done to it is kept in its timeline. The same page is the whole list (from the
// menu), or one unit's, one lease's or one tenant's (`scope`). Repairs are under the AMC, so
// there is no cost anywhere.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const OUTLINE = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const ROUND = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
const CHIP = (on) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;
const CARD = 'rounded-2xl border border-stroke bg-surface p-4';

export const WO_STATUS = {
  open: ['Open', 'bg-warn/15 text-warn'], assigned: ['Assigned', 'bg-p3/15 text-p3'], in_progress: ['In progress', 'bg-p1/15 text-p1'],
  done: ['Done', 'bg-ok/15 text-ok'], closed: ['Closed', 'bg-white/10 text-mute'], cancelled: ['Cancelled', 'bg-white/10 text-mute'],
};
const PRIORITY = [['low', 'Low'], ['normal', 'Normal'], ['urgent', 'Urgent']];
const FILTERS = [['active', 'Active'], ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['done', 'Done'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['', 'All']];
const CATEGORIES = ['AC', 'Plumbing', 'Electrical', 'Appliance', 'Pest control', 'Other']; // the usual ones, a tap each; anything else can be typed
const LIVE = ['open', 'assigned', 'in_progress'];
const BATCH = 10; // files the server takes in one go
const fileUrl = (f) => `/api/leasing/work-orders/files/${f.id}/file`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const when = (seconds) => new Date(Number(seconds) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const Label = ({ text, need, children, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
    {children}
  </label>
);

const Pill = ({ w }) => (
  <span className="flex flex-wrap items-center gap-1">
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${WO_STATUS[w.status][1]}`}>{WO_STATUS[w.status][0]}</span>
    {w.priority === 'urgent' && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] text-bad">Urgent</span>}
    {w.overdue && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] text-bad">Overdue</span>}
  </span>
);

/** Send picked files a batch at a time; what is left is handed back if one fails, to try again. */
async function sendFiles(id, picked, onLeft) {
  let left = picked;
  while (left.length) {
    const form = new FormData();
    left.slice(0, BATCH).forEach((f) => form.append('files', f));
    await api.upload(`/leasing/work-orders/${id}/files`, form);
    left = left.slice(BATCH);
    onLeft(left);
  }
}

/** A new work order, or one being changed. The unit is chosen once: a repair does not move. */
function WorkOrderForm({ start, preset, onDone, onCancel }) {
  const [v, setV] = useState({ unit_id: preset?.unit_id || '', category: '', priority: 'normal', detail: '', reported_by: '', reported_on: today(), assigned_to: '', scheduled_on: '', ...start });
  const [units, setUnits] = useState([]);
  const [link, setLink] = useState(null); // whose unit it is on the reported day
  const [id, setId] = useState(start?.id || null); // set once a new one is saved, so a failed upload is tried again on the same one
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  useEffect(() => { api.get('/leasing/work-orders/units').then(setUnits).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!v.unit_id) { setLink(null); return; }
    api.get(`/leasing/work-orders/link?unit_id=${v.unit_id}&on=${v.reported_on || ''}`).then(setLink).catch(() => setLink(null));
  }, [v.unit_id, v.reported_on]);

  const save = async (e) => {
    e.preventDefault();
    if (!v.unit_id) { setError('Choose the unit.'); return; }
    setBusy(true); setError('');
    const body = { unit_id: v.unit_id, category: v.category, priority: v.priority, detail: v.detail, reported_by: v.reported_by, reported_on: v.reported_on, assigned_to: v.assigned_to, scheduled_on: v.scheduled_on };
    try {
      const saved = await (id ? api.put(`/leasing/work-orders/${id}`, body) : api.post('/leasing/work-orders', body));
      setId(saved.id);
      await sendFiles(saved.id, picked, setPicked);
      onDone(saved);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={save} className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Unit" need wide>
          <Select value={v.unit_id} onChange={set('unit_id')} disabled={!!id} placeholder="Choose the unit" aria-label="Unit" className={FIELD}
            options={units.map((u) => ({ value: u.id, label: `Unit ${u.unit_no} · ${u.building}` }))} />
          {v.unit_id && link && <span className="mt-1 block text-xs text-mute">{link.tenant ? `For ${link.tenant} (${link.ref}), who has the unit on that day.` : 'The unit is vacant on that day: this work order will have no tenant.'}</span>}
        </Label>
        <Label text="Type" wide>
          <div className="mb-2 flex flex-wrap gap-1">
            {CATEGORIES.map((c) => <button key={c} type="button" onClick={() => setV({ ...v, category: c })} className={CHIP(v.category === c)}>{c}</button>)}
          </div>
          <input value={v.category || ''} onChange={set('category')} maxLength={60} placeholder="Or type your own" className={FIELD} />
        </Label>
        <Label text="What is wrong" need wide>
          <textarea value={v.detail || ''} onChange={set('detail')} required rows={4} maxLength={2000} className={`${FIELD} resize-none`} />
        </Label>
        <Label text="Priority">
          <div className="flex gap-1 rounded-full border border-stroke p-0.5 text-sm">
            {PRIORITY.map(([k, l]) => <button key={k} type="button" onClick={() => setV({ ...v, priority: k })} aria-pressed={v.priority === k} className={`flex-1 ${CHIP(v.priority === k)}`}>{l}</button>)}
          </div>
        </Label>
        <Label text="Reported on" need><DateField value={v.reported_on || ''} onChange={set('reported_on')} required className={FIELD} /></Label>
        <Label text="Reported by"><input value={v.reported_by || ''} onChange={set('reported_by')} maxLength={120} placeholder="The tenant, the watchman…" className={FIELD} /></Label>
        <Label text="Assigned to"><input value={v.assigned_to || ''} onChange={set('assigned_to')} maxLength={120} placeholder="The technician or the AMC vendor" className={FIELD} /></Label>
        <Label text="Scheduled for"><DateField value={v.scheduled_on || ''} onChange={set('scheduled_on')} className={FIELD} /></Label>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Photos and files</span>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
            <Paperclip size={15} className="shrink-0" /> <span>Add photos, videos or files (as many as you need)</span>
            <input type="file" multiple accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={(e) => { setPicked([...picked, ...e.target.files]); e.target.value = ''; }} />
          </label>
          {picked.length > 0 && (
            <ul className="mt-2 divide-y divide-stroke/60 rounded-xl border border-stroke text-sm">
              {picked.map((f, n) => (
                <li key={`${f.name}-${n}`} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <button type="button" onClick={() => setPicked(picked.filter((_, i) => i !== n))} aria-label={`Take off ${f.name}`} title="Take off" className={`${ROUND} hover:text-txt`}><X size={15} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-mute">Repairs are under the AMC: nothing is charged, and nothing is sent to the tenant.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** One work order: what it is, what can be done to it next, its files and its timeline. */
function WorkOrderView({ id, onBack, onEdit }) {
  const [w, setW] = useState(null);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState({ resolution: '', done_on: today() });
  const [note, setNote] = useState('');
  const load = () => api.get(`/leasing/work-orders/${id}`).then(setW).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const act = async (fn) => { setError(''); try { await fn(); setFinishing(false); await load(); } catch (e) { setError(e.message); } };
  const put = (body) => act(() => api.put(`/leasing/work-orders/${id}`, body));

  if (!w) return <Page title="Work order" onBack={onBack}>{error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}</Page>;

  const live = LIVE.includes(w.status);
  const frozen = ['closed', 'cancelled'].includes(w.status); // its files are kept as they are
  const attach = (e) => { const files = [...e.target.files]; e.target.value = ''; act(() => sendFiles(w.id, files, () => {})); };
  const facts = [
    ['Unit', `Unit ${w.unit_no} · ${w.building}`],
    ['Tenant', w.tenant ? `${w.tenant}${w.lease_ref ? ` · ${w.lease_ref}` : ''}` : 'None: the unit was vacant'],
    ['Reported', [fmt(w.reported_on), w.reported_by && `by ${w.reported_by}`].filter(Boolean).join(' ')],
    ['Assigned to', w.assigned_to || 'Nobody yet'],
    ['Scheduled for', w.scheduled_on ? fmt(w.scheduled_on) : 'Not scheduled'],
    w.done_on && ['Done', `${fmt(w.done_on)}${w.resolution ? `: ${w.resolution}` : ''}`],
    w.cancel_reason && ['Cancelled', w.cancel_reason],
    ['Raised by', w.raised_by || '—'],
  ].filter(Boolean);

  return (
    <Page title={`${w.ref}${w.category ? ` · ${w.category}` : ''}`} onBack={onBack}
      action={!['closed', 'cancelled'].includes(w.status) && <button onClick={() => onEdit(w)} className={OUTLINE}><Pencil size={15} /> Edit</button>}>
      <div className="max-w-3xl space-y-4">
        <div className={CARD}>
          <Pill w={w} />
          <p className="mt-3 whitespace-pre-wrap text-sm">{w.detail}</p>
          <dl className="mt-4 divide-y divide-stroke/60 border-t border-stroke text-sm">
            {facts.map(([k, val]) => (
              <div key={k} className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-mute">{k}</dt><dd className="text-right">{val}</dd></div>
            ))}
          </dl>
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
          {finishing ? (
            <form onSubmit={(e) => { e.preventDefault(); put({ status: 'done', ...done }); }} className="mt-4 space-y-2">
              <textarea autoFocus required value={done.resolution} onChange={(e) => setDone({ ...done, resolution: e.target.value })} rows={3} maxLength={2000} placeholder="What was done" className={`${FIELD} resize-none text-sm`} />
              <div className="flex flex-wrap items-center gap-2">
                <DateField value={done.done_on} onChange={(e) => setDone({ ...done, done_on: e.target.value })} required className={`${FIELD} max-w-[12rem] py-2 text-sm`} />
                <button className={PRIMARY}><Check size={15} /> Mark done</button>
                <button type="button" onClick={() => setFinishing(false)} className="rounded-full px-3 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
              </div>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {['open', 'assigned'].includes(w.status) && <button onClick={() => put({ status: 'in_progress' })} className={OUTLINE}><Play size={15} /> Start work</button>}
              {live && <button onClick={() => setFinishing(true)} className={PRIMARY}><Check size={15} /> Mark done</button>}
              {w.status === 'done' && <button onClick={() => put({ status: 'closed' })} className={PRIMARY}><CheckCheck size={15} /> Close</button>}
              {!live && <button onClick={() => { const why = prompt('Why is it reopened? (optional)'); if (why !== null) put({ reopen: true, note: why }); }} className={OUTLINE}><RotateCcw size={15} /> Reopen</button>}
              {live && <button onClick={() => { const why = prompt('Why is this work order cancelled?'); if (why) put({ status: 'cancelled', cancel_reason: why }); }} className={`${GHOST} hover:text-bad`}><Ban size={14} /> Cancel work order</button>}
              {w.master && w.status === 'open' && !w.assigned_to && (
                <button onClick={async () => { if (!confirm(`Delete ${w.ref}? It was raised by mistake.`)) return; try { await api.del(`/leasing/work-orders/${w.id}`); onBack(); } catch (e) { setError(e.message); } }} className={`${GHOST} hover:text-bad`}><Trash2 size={14} /> Delete</button>
              )}
            </div>
          )}
        </div>

        <div className={CARD}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Photos and files</p>
            {!frozen && (
              <label className={`${GHOST} cursor-pointer`}><Paperclip size={13} /> Add
                <input type="file" multiple accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={attach} />
              </label>
            )}
          </div>
          {w.files.length === 0 ? <p className="mt-2 text-sm text-mute">None yet.</p> : (
            <ul className="mt-2 divide-y divide-stroke/60 text-sm">
              {w.files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-p3 hover:underline">{f.file_name}</a>
                  {!frozen && <button onClick={() => confirm(`Remove ${f.file_name}?`) && act(() => api.del(`/leasing/work-orders/files/${f.id}`))} aria-label={`Remove ${f.file_name}`} title="Remove" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={CARD}>
          <p className="text-sm font-medium">History</p>
          <form onSubmit={(e) => { e.preventDefault(); act(async () => { await api.post(`/leasing/work-orders/${w.id}/notes`, { note }); setNote(''); }); }} className="mt-2 flex gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note: tenant not home, coming back Thursday…" className={`${FIELD} min-w-0 flex-1 py-2 text-sm`} />
            <button disabled={!note.trim()} className={OUTLINE}><MessageSquarePlus size={15} /> Add</button>
          </form>
          <ol className="mt-3 space-y-3 border-l border-stroke pl-4">
            {w.events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-p1" />
                <p className="text-sm">{e.detail}</p>
                <p className="text-xs text-mute">{when(e.created_at)}{e.who && ` · ${e.who}`}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Page>
  );
}

export default function WorkOrders({ scope, title = 'Work orders', preset = null, openId = null, startNew = false, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(scope ? '' : 'active'); // one unit's or one tenant's list is its whole record
  const [building, setBuilding] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(openId); // the id being looked at
  const [form, setForm] = useState(startNew ? {} : null); // {} for a new one, or the work order being changed

  const load = () => {
    const p = new URLSearchParams({ status, ...(scope || {}) });
    if (building) p.set('building_id', building);
    if (urgent) p.set('priority', 'urgent');
    if (overdue) p.set('overdue', 'true');
    if (q.trim()) p.set('q', q.trim());
    return api.get(`/leasing/work-orders?${p}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [status, building, urgent, overdue, q]);

  if (form) {
    const back = () => { setForm(null); load(); };
    return (
      <Page title={form.id ? `Edit ${form.ref}` : 'New work order'} onBack={back}>
        <WorkOrderForm start={form.id ? form : null} preset={preset} onCancel={back} onDone={(saved) => { setForm(null); setOpen(saved.id); load(); }} />
      </Page>
    );
  }
  if (open) return <WorkOrderView id={open} onBack={() => { setOpen(null); load(); }} onEdit={setForm} />;

  const rows = data?.work_orders;
  const buildings = [...new Map((rows || []).map((w) => [w.building_id, w.building]))];
  return (
    <Page title={title} onBack={onBack} action={<button onClick={() => setForm({})} className={PRIMARY}><Plus size={16} /> New work order</button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reference, unit, tenant, words" aria-label="Search work orders" className={`${FIELD} pl-10`} />
          </div>
          {!scope && (building || buildings.length > 1) && (
            <Select value={building} onChange={(e) => setBuilding(e.target.value)} aria-label="Building" className={FIELD} wrap="w-56"
              options={[{ value: '', label: 'All buildings' }, ...buildings.map(([id, name]) => ({ value: id, label: name }))]} />
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([k, l]) => <button key={k} onClick={() => setStatus(k)} aria-pressed={status === k} className={CHIP(status === k)}>{l}</button>)}
          <span className="mx-1 w-px self-stretch bg-stroke" />
          <button onClick={() => setUrgent(!urgent)} aria-pressed={urgent} className={CHIP(urgent)}>Urgent</button>
          <button onClick={() => setOverdue(!overdue)} aria-pressed={overdue} className={CHIP(overdue)}>Overdue</button>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {!rows ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : rows.length === 0 ? <p className="py-3 text-sm text-mute">No work orders here.</p> : (
            <ul className="space-y-3">
              {rows.map((w) => (
                <li key={w.id}>
                  <button onClick={() => setOpen(w.id)} className={`${CARD} flex w-full items-start gap-3 text-left hover:border-p1/50`}>
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-400 to-blue-500 text-white"><Wrench size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">{w.ref}{w.category ? ` · ${w.category}` : ''}</span>
                        <Pill w={w} />
                      </span>
                      <span className="mt-0.5 block text-xs text-mute">Unit {w.unit_no} · {w.building} · {w.tenant || 'Vacant'} · reported {fmt(w.reported_on)}</span>
                      <span className="mt-1.5 block truncate text-sm text-txt/80">{w.detail}</span>
                      <span className="mt-1 block text-xs text-mute">{[w.assigned_to ? `Assigned to ${w.assigned_to}` : 'Nobody assigned', w.scheduled_on && `scheduled ${fmt(w.scheduled_on)}`, w.done_on && `done ${fmt(w.done_on)}`].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Page>
  );
}
