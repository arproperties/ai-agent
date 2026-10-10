import { useEffect, useState } from 'react';
import { Banknote, Check, ChevronRight, Clock, Coins, Loader2, MessageSquareWarning, Paperclip, Pencil, Plus, RotateCcw, Trash2, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { money as aed } from '../lib/region';
import { usDate as fmt, usPhone } from '../lib/usFormat';
import Page from './Page';
import DateField from './DateField';
import { WO_STATUS } from './WorkOrders';

// One tenant's history: rent that came in late, complaints made about them and maintenance
// done for them, in one list with the figures on top. Late rent is worked out by the server
// (server/leasingHistory.js); complaints are typed in here, each with as many attachments as it needs; maintenance is the
// tenant's work orders, opened from here and changed on their own page.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const OUTLINE = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const ROUND = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10';
const CHIP = (on) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;
const KIND = {
  late: ['Late rent', Clock, 'from-rose-400 to-red-500'],
  complaint: ['Complaint', MessageSquareWarning, 'from-amber-400 to-orange-500'],
  maintenance: ['Maintenance', Wrench, 'from-sky-400 to-blue-500'],
};
const FILTERS = [['', 'All'], ['late', 'Late rent'], ['complaint', 'Complaints'], ['maintenance', 'Maintenance']];
// The usual ones, a tap each; anything else can be typed.
const CATEGORIES = { complaint: ['Noise', 'Parking', 'Pets', 'Damage', 'Trash', 'Other'], maintenance: ['AC', 'Plumbing', 'Electrical', 'Appliance', 'Pest control', 'Other'] };
const BATCH = 10; // files the server takes in one go
const fileUrl = (f) => `/api/leasing/log/files/${f.id}/file`;
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const Label = ({ text, need, children, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
    {children}
  </label>
);

const Tile = ({ icon: Ico, label, value, sub, tint }) => (
  <div className="flex items-center gap-3 rounded-2xl border border-stroke bg-surface p-4">
    <span className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white ${tint}`}><Ico size={18} /></span>
    <div className="min-w-0">
      <p className="text-xs text-mute">{label}</p>
      <p className="text-xl font-light tabular-nums">{value}</p>
      {sub && <p className="truncate text-xs text-mute">{sub}</p>}
    </div>
  </div>
);

/** A complaint or a piece of maintenance, new (`start.kind` only) or being changed. */
function EntryForm({ tenant, start, onDone, onCancel }) {
  const [v, setV] = useState({ category: '', detail: '', reported_by: '', happened_on: today(), ...start, ...(start.id ? { happened_on: start.date } : {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState(start.id || null); // set once a new entry is saved, so a failed upload is tried again on the same entry
  const [kept, setKept] = useState(start.files || []); // already attached
  const [picked, setPicked] = useState([]); // chosen here, sent on Save
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const complaint = v.kind === 'complaint';
  const pick = (e) => { setPicked([...picked, ...e.target.files]); e.target.value = ''; };
  const unattach = async (f) => {
    if (!confirm(`Remove ${f.file_name}?`)) return;
    try { await api.del(`/leasing/log/files/${f.id}`); setKept(kept.filter((k) => k.id !== f.id)); } catch (err) { setError(err.message); }
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const body = { kind: v.kind, category: v.category, detail: v.detail, reported_by: v.reported_by, happened_on: v.happened_on };
    let left = picked;
    try {
      const saved = await (id ? api.put(`/leasing/log/${id}`, body) : api.post(`/leasing/tenants/${tenant.id}/log`, body));
      setId(saved.id);
      while (left.length) {
        const form = new FormData();
        left.slice(0, BATCH).forEach((f) => form.append('files', f));
        setKept((await api.upload(`/leasing/log/${saved.id}/files`, form)).files);
        left = left.slice(BATCH);
        setPicked(left);
      }
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Type" wide>
          <div className="mb-2 flex flex-wrap gap-1">
            {CATEGORIES[v.kind].map((c) => <button key={c} type="button" onClick={() => setV({ ...v, category: c })} className={CHIP(v.category === c)}>{c}</button>)}
          </div>
          <input value={v.category || ''} onChange={set('category')} maxLength={60} placeholder="Or type your own" className={FIELD} />
        </Label>
        <Label text="Date" need><DateField value={v.happened_on || ''} onChange={set('happened_on')} required className={FIELD} /></Label>
        {complaint && <Label text="Who complained"><input value={v.reported_by || ''} onChange={set('reported_by')} maxLength={120} placeholder="A neighbor, unit 102, security…" className={FIELD} /></Label>}
        <Label text={complaint ? 'What happened' : 'What was wrong, and what was done'} need wide>
          <textarea value={v.detail || ''} onChange={set('detail')} required rows={4} maxLength={2000} className={`${FIELD} resize-none`} />
        </Label>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Attachments</span>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
            <Paperclip size={15} className="shrink-0" /> <span>Add photos, videos or files (as many as you need)</span>
            <input type="file" multiple accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={pick} />
          </label>
          {(kept.length > 0 || picked.length > 0) && (
            <ul className="mt-2 divide-y divide-stroke/60 rounded-xl border border-stroke text-sm">
              {kept.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-p3 hover:underline">{f.file_name}</a>
                  <button type="button" onClick={() => unattach(f)} aria-label={`Remove ${f.file_name}`} title="Remove" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>
                </li>
              ))}
              {picked.map((f, n) => (
                <li key={`${f.name}-${n}`} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-mute">Not saved yet</span>
                  <button type="button" onClick={() => setPicked(picked.filter((_, i) => i !== n))} aria-label={`Take off ${f.name}`} title="Take off" className={`${ROUND} hover:text-txt`}><X size={15} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-mute">This is a record only: it charges nothing and nothing is sent to the tenant.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** One row of the list: late rent as the server worked it out, or an entry with what can be done to it. */
function Item({ i, onPay, onEdit, onChanged, onWork }) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [name, Ico, tint] = KIND[i.type];
  const act = async (fn) => { setError(''); try { await fn(); onChanged(); } catch (e) { setError(e.message); } };
  const where = i.ref && `${i.ref} · Unit ${i.unit_no}, ${i.building}`;
  const late = i.type === 'late';
  const order = !!i.wo; // a work order: shown here, changed on its own page
  const open = late ? !i.paid_on : !i.resolved_on;
  const pill = late ? (open ? [`${aed(i.left)} still owed`, 'bg-bad/15 text-bad'] : ['Paid late', 'bg-warn/15 text-warn'])
    : order ? [WO_STATUS[i.status][0], WO_STATUS[i.status][1]]
      : open ? ['Open', 'bg-warn/15 text-warn'] : ['Resolved', 'bg-ok/15 text-ok'];
  return (
    <li className="rounded-2xl border border-stroke bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white ${tint}`}><Ico size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium">{late ? `Rent ${days(i.days_late)} late` : `${order ? `${i.wo} · ` : ''}${name}${i.category ? ` · ${i.category}` : ''}`}</p>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${pill[1]}`}>{pill[0]}</span>
          </div>
          <p className="mt-0.5 text-xs text-mute">{late ? `Due ${fmt(i.date)}` : fmt(i.date)}{where && ` · ${where}`}</p>
          {late ? (
            <p className="mt-2 text-sm text-txt/80">
              {aed(i.amount)} rent, {i.paid_on ? `all in on ${fmt(i.paid_on)}` : `${days(i.days_late)} late so far`}.
              {i.fee != null && ` Late fee charged: ${aed(i.fee)}.`}
            </p>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm text-txt/80">{i.detail}</p>
              <p className="mt-1.5 text-xs text-mute">
                {[i.reported_by && `Reported by ${i.reported_by}`, i.assigned_to && `Assigned to ${i.assigned_to}`, i.logged_by && `Logged by ${i.logged_by}`, i.resolved_on && `${order ? 'Done' : 'Resolved'} ${fmt(i.resolved_on)}${i.resolution ? `: ${i.resolution}` : ''}`].filter(Boolean).join(' · ')}
              </p>
              {i.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {i.files.map((f) => (
                    <a key={f.id} href={fileUrl(f)} target="_blank" rel="noreferrer" title={f.file_name} className={`${GHOST} max-w-[14rem]`}><Paperclip size={13} className="shrink-0" /> <span className="truncate">{f.file_name}</span></a>
                  ))}
                </div>
              )}
            </>
          )}
          {resolving && (
            <form onSubmit={(e) => { e.preventDefault(); act(() => api.put(`/leasing/log/${i.id}`, { resolved: true, resolution: note })); }} className="mt-3 flex flex-wrap gap-2">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What was done (optional)" className={`${FIELD} min-w-0 flex-1 py-2 text-sm`} />
              <button className={PRIMARY}><Check size={15} /> Resolve</button>
              <button type="button" onClick={() => setResolving(false)} className="rounded-full px-3 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
            </form>
          )}
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        </div>
        <div className="-mr-1.5 flex shrink-0 items-center gap-1">
          {late ? open && <button onClick={() => onPay(i.booking_id)} className={GHOST}><Banknote size={14} /> Payments</button>
            : order ? <button onClick={() => onWork(i)} className={GHOST}>Open <ChevronRight size={14} /></button> : (
            <>
              {open ? !resolving && <button onClick={() => setResolving(true)} className={GHOST}><Check size={14} /> Resolve</button>
                : <button onClick={() => act(() => api.put(`/leasing/log/${i.id}`, { resolved: false, resolution: '' }))} aria-label="Open again" title="Open again" className={`${ROUND} hover:text-txt`}><RotateCcw size={15} /></button>}
              <button onClick={() => onEdit(i)} aria-label="Edit" title="Edit" className={`${ROUND} hover:text-txt`}><Pencil size={15} /></button>
              <button onClick={() => confirm(`Delete this ${name.toLowerCase()} entry?`) && act(() => api.del(`/leasing/log/${i.id}`))} aria-label="Delete" title="Delete" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export default function TenantHistory({ tenant, onBack, onPay, onWorkOrder }) {
  const [h, setH] = useState(null);
  const [error, setError] = useState('');
  const [show, setShow] = useState('');
  const [entry, setEntry] = useState(null); // { kind } for a new one, or the entry being changed
  const load = () => api.get(`/leasing/tenants/${tenant.id}/history`).then(setH).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [tenant.id]);
  const mine = { scope: { tenant_id: tenant.id }, title: `Work orders · ${tenant.full_name}`, preset: h?.current ? { unit_id: h.current.unit_id } : null };

  if (entry) {
    const name = KIND[entry.kind || entry.type][0].toLowerCase();
    const back = () => { setEntry(null); load(); }; // reloaded even on Cancel: a file may have been removed, or an entry saved before its upload failed
    return (
      <Page title={`${entry.id ? 'Edit' : 'Add'} ${name} · ${tenant.full_name}`} onBack={back}>
        <EntryForm tenant={tenant} start={entry.id ? { ...entry, kind: entry.type } : entry} onDone={back} onCancel={back} />
      </Page>
    );
  }

  const s = h?.summary;
  const items = h?.items.filter((i) => !show || i.type === show);
  const count = (k) => (!h ? '' : k ? h.items.filter((i) => i.type === k).length : h.items.length);
  return (
    <Page title={`History · ${tenant.full_name}`} onBack={onBack} action={(
      <div className="flex gap-2">
        <button onClick={() => onWorkOrder({ ...mine, startNew: true })} className={OUTLINE} title={h?.current ? `A work order for unit ${h.current.unit_no}, ${h.current.building}` : 'A work order'}><Plus size={16} /> <span className="hidden sm:inline">Add </span>maintenance</button>
        <button onClick={() => setEntry({ kind: 'complaint' })} className={PRIMARY}><Plus size={16} /> <span className="hidden sm:inline">Add </span>complaint</button>
      </div>
    )}>
      <p className="mb-4 text-sm text-mute">{[usPhone(tenant.phone), tenant.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      {!h ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile icon={Clock} tint={KIND.late[2]} label="Late rent payments" value={s.late} sub={s.late ? `${s.late_unpaid} still unpaid · ${days(s.late_days)} late on average` : 'Always on time'} />
            <Tile icon={Coins} tint="from-rose-400 to-pink-600" label="Late fees charged" value={aed(s.late_fees)} />
            <Tile icon={MessageSquareWarning} tint={KIND.complaint[2]} label="Complaints" value={s.complaints} sub={s.complaints ? `${s.complaints_open} open` : 'None'} />
            <Tile icon={Wrench} tint={KIND.maintenance[2]} label="Maintenance" value={s.maintenance} sub={s.maintenance ? `${s.maintenance_open} open` : 'None'} />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([k, l]) => <button key={k} onClick={() => setShow(k)} aria-pressed={show === k} className={CHIP(show === k)}>{l} <span className="tabular-nums opacity-70">{count(k)}</span></button>)}
          </div>
          {items.length === 0
            ? <p className="py-3 text-sm text-mute">{h.items.length ? 'Nothing of this kind.' : 'Nothing on record: no late rent, no complaints, no maintenance.'}</p>
            : <ul className="space-y-3">{items.map((i) => <Item key={i.wo || `${i.type}-${i.id || `${i.booking_id}-${i.date}`}`} i={i} onPay={onPay} onEdit={setEntry} onChanged={load} onWork={(o) => onWorkOrder({ ...mine, openId: o.id })} />)}</ul>}
        </div>
      )}
    </Page>
  );
}
