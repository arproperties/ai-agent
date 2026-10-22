import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, CheckCircle2, Clock, Download, KeyRound, Loader2, Paperclip, Pause, Pencil, Play, Plus, Power, RefreshCw, Receipt, RotateCcw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/region';
import { usDate as fmt } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateField from './DateField';

// Accounts: money going out, recorded here and sent to QuickBooks by itself, and the
// QuickBooks connection (the master's). What goes to QuickBooks and how is in
// server/qbSync.js; expenses and monthly bills in server/expenses.js; the Web Connector's
// side in server/quickbooks.js.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const OUTLINE = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-60';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const ROUND = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
const CHIP = (on) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;
const CARD = 'rounded-2xl border border-stroke bg-surface p-4';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sum = (lines) => Math.round(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0) * 100) / 100;

const Label = ({ text, need, children, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
    {children}
  </label>
);

/** Where an entry stands with QuickBooks. */
const QB = {
  sent: ['In QuickBooks', 'bg-ok/15 text-ok', CheckCircle2],
  waiting: ['Waiting to go to QuickBooks', 'bg-warn/15 text-warn', Clock],
  failed: ['QuickBooks refused it', 'bg-bad/15 text-bad', AlertTriangle],
  not_sent: ['Before the QuickBooks start date', 'bg-white/10 text-mute', Clock],
};
function QbPill({ q }) {
  if (!q) return null;
  const [label, tone, Ico] = QB[q.state] || QB.waiting;
  return <span title={q.error || label} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tone}`}><Ico size={11} /> {label}</span>;
}

// ---------- an expense ----------

const NEW_LINE = () => ({ account_list_id: '', amount: '', memo: '' });
/** A vendor not in QuickBooks yet is picked as `new:<name>`, and listed so. */
const withPending = (vendors, start) => (start?.vendor_name && !start.vendor_list_id ? [...vendors, { id: `new:${start.vendor_name}`, name: `${start.vendor_name} (new)` }] : vendors);
const pendingId = (start) => (start?.vendor_name && !start.vendor_list_id ? { vendor_list_id: `new:${start.vendor_name}` } : {});

function ExpenseForm({ start, c, master, onDone, onCancel }) {
  const [v, setV] = useState(() => ({
    paid_on: today(), vendor_list_id: '', vendor_name: '', pay_from: c.pay_from[0]?.id || '', ref_no: '', memo: '', building_id: '', unit_id: '',
    ...start, ...pendingId(start), lines: start?.lines?.length ? start.lines.map((l) => ({ account_list_id: l.account_list_id, amount: String(l.amount), memo: l.memo || '' })) : [NEW_LINE()],
  }));
  const [vendors, setVendors] = useState(() => withPending(c.vendors, start));
  const [file, setFile] = useState(null);
  const [read, setRead] = useState(null); // what the AI read off the receipt
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const setLine = (n, f) => (e) => setV({ ...v, lines: v.lines.map((l, i) => (i === n ? { ...l, [f]: e.target.value } : l)) });
  const total = sum(v.lines);

  const pick = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setFile(f); setReading(true); setError('');
    try {
      const form = new FormData();
      form.append('file', f);
      const r = await api.upload('/accounts/receipts/read', form);
      setRead(r);
      if (r.vendor_name && !r.vendor_list_id) setVendors((list) => (list.some((x) => x.name === r.vendor_name) ? list : [...list, { id: `new:${r.vendor_name}`, name: `${r.vendor_name} (new)` }]));
      setV((x) => ({
        ...x,
        paid_on: r.paid_on || x.paid_on,
        vendor_list_id: r.vendor_list_id || (r.vendor_name ? `new:${r.vendor_name}` : x.vendor_list_id),
        vendor_name: r.vendor_name || x.vendor_name,
        memo: r.memo || x.memo,
        lines: r.lines?.length ? r.lines.map((l) => ({ ...l, amount: String(l.amount) })) : r.total ? [{ account_list_id: '', amount: String(r.total), memo: '' }] : x.lines,
      }));
    } catch (err) { setError(err.message); } finally { setReading(false); }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const isNew = String(v.vendor_list_id).startsWith('new:');
    const form = new FormData();
    const body = {
      paid_on: v.paid_on, vendor_list_id: isNew ? '' : v.vendor_list_id, vendor_name: isNew ? v.vendor_list_id.slice(4) : v.vendor_name,
      pay_from: v.pay_from, ref_no: v.ref_no, memo: v.memo, building_id: v.building_id || '', unit_id: v.unit_id || '',
      lines: JSON.stringify(v.lines.filter((l) => l.account_list_id || Number(l.amount)).map((l) => ({ ...l, amount: Number(l.amount) }))),
    };
    Object.entries(body).forEach(([k, x]) => form.append(k, x ?? ''));
    if (file) form.append('file', file);
    try {
      const saved = await (start?.id ? api.uploadPut(`/accounts/expenses/${start.id}`, form) : api.upload('/accounts/expenses', form));
      onDone(saved);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const remove = async () => {
    if (!confirm('Delete this expense? It is taken out of QuickBooks too.')) return;
    try { await api.del(`/accounts/expenses/${start.id}`); onDone(null); } catch (err) { setError(err.message); }
  };

  const units = c.units.filter((u) => String(u.building_id) === String(v.building_id));
  return (
    <form onSubmit={save} className="max-w-3xl space-y-5">
      <div className={CARD}>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-p1/40 px-4 py-3 text-sm hover:bg-p1/5">
          {reading ? <Loader2 size={18} className="animate-spin text-p1" /> : <Sparkles size={18} className="shrink-0 text-p1" />}
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{file ? file.name : start?.file_name || 'Add the receipt or bill'}</span>
            <span className="block text-xs text-mute">{reading ? 'Reading it…' : 'A photo or PDF. The AI reads the vendor, date, amounts and accounts; you check them.'}</span>
          </span>
          {start?.has_file && !file && <a href={`/api/accounts/expenses/${start.id}/file`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={GHOST}><Paperclip size={13} /> Open</a>}
          <input type="file" accept="image/*,application/pdf" className="hidden" onChange={pick} />
        </label>
        {read && (Object.keys(read).length
          ? <p className="mt-2 text-xs text-mute">Read from it: {[read.vendor_name, read.paid_on && fmt(read.paid_on), read.total && money(read.total)].filter(Boolean).join(' · ')}. Check the accounts below.</p>
          : <p className="mt-2 text-xs text-warn">The receipt could not be read. Fill it in below; it is still kept with the expense.</p>)}
      </div>

      <div className={`${CARD} grid gap-3 sm:grid-cols-2`}>
        <Label text="Paid to" need wide>
          <Select value={v.vendor_list_id} onChange={(e) => setV({ ...v, vendor_list_id: e.target.value })} aria-label="Vendor" placeholder="Choose the vendor, or type a new one" className={FIELD}
            options={vendors.map((x) => ({ value: x.id, label: x.name }))}
            onCreate={(name) => { const id = `new:${name.slice(0, 41)}`; setVendors([...vendors, { id, name: `${name.slice(0, 41)} (new)` }]); setV({ ...v, vendor_list_id: id }); }} />
          {String(v.vendor_list_id).startsWith('new:') && <span className="mt-1 block text-xs text-mute">A new vendor: it is added to QuickBooks first.</span>}
        </Label>
        <Label text="Paid on" need><DateField value={v.paid_on} onChange={set('paid_on')} required className={FIELD} /></Label>
        <Label text="Paid from" need>
          <Select value={v.pay_from} onChange={set('pay_from')} aria-label="Paid from" className={FIELD} options={c.pay_from.map((p) => ({ value: p.id, label: p.card ? `${p.name} (card)` : p.name }))} />
        </Label>
        <Label text="Check no., ACH or DD">
          <div className="flex gap-1.5">
            <input value={v.ref_no || ''} onChange={set('ref_no')} maxLength={11} placeholder="2365" className={FIELD} />
            {['ACH', 'DD'].map((k) => <button key={k} type="button" onClick={() => setV({ ...v, ref_no: k })} className={CHIP(v.ref_no === k)}>{k}</button>)}
          </div>
        </Label>
        <Label text="Memo"><input value={v.memo || ''} onChange={set('memo')} maxLength={500} placeholder="INV. # 1672, account number…" className={FIELD} /></Label>
        <Label text="Building">
          <Select value={v.building_id || ''} onChange={(e) => setV({ ...v, building_id: e.target.value, unit_id: '' })} aria-label="Building" className={FIELD}
            options={[{ value: '', label: 'None' }, ...c.buildings.map((b) => ({ value: b.id, label: b.name }))]} placeholder="None" />
        </Label>
        {units.length > 0 && (
          <Label text="Unit">
            <Select value={v.unit_id || ''} onChange={set('unit_id')} aria-label="Unit" className={FIELD} placeholder="The whole building"
              options={[{ value: '', label: 'The whole building' }, ...units.map((u) => ({ value: u.id, label: `Unit ${u.unit_no}` }))]} />
          </Label>
        )}
      </div>

      <div className={CARD}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium">What it was for</p>
          <p className="text-sm">Total <span className="font-medium tabular-nums">{money(total)}</span></p>
        </div>
        {read?.total && Math.abs(read.total - total) > 0.004 && <p className="mb-2 text-xs text-warn">The receipt says {money(read.total)}; the lines add up to {money(total)}.</p>}
        <ul className="space-y-2">
          {v.lines.map((l, n) => (
            <li key={n} className="grid grid-cols-[1fr_7rem_auto] gap-2 sm:grid-cols-[1fr_7rem_1fr_auto]">
              <Select value={l.account_list_id} onChange={setLine(n, 'account_list_id')} aria-label="Account" placeholder="Expense account" className={FIELD}
                options={c.accounts.map((a) => ({ value: a.id, label: a.name }))} />
              <input value={l.amount} onChange={setLine(n, 'amount')} inputMode="decimal" placeholder="0.00" aria-label="Amount" className={`${FIELD} text-right tabular-nums`} />
              <input value={l.memo} onChange={setLine(n, 'memo')} maxLength={200} placeholder="What for (optional)" aria-label="Line memo" className={`${FIELD} col-span-2 sm:col-span-1`} />
              <button type="button" disabled={v.lines.length === 1} onClick={() => setV({ ...v, lines: v.lines.filter((_, i) => i !== n) })} aria-label="Take off this line" className={`${ROUND} disabled:opacity-30 sm:row-auto`}><X size={15} /></button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setV({ ...v, lines: [...v.lines, NEW_LINE()] })} className={`${GHOST} mt-3`}><Plus size={13} /> Split over another account</button>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
          {start?.id && master && <button type="button" onClick={remove} className={`${GHOST} hover:text-bad`}><Trash2 size={14} /> Delete</button>}
        </div>
        <button disabled={busy || reading} className={PRIMARY}>{busy ? 'Saving…' : <><Check size={15} /> Save</>}</button>
      </div>
      <p className="text-xs text-mute">Saved here, it goes to QuickBooks on the next round of the Web Connector (every few minutes), as a check from the account it was paid from.</p>
    </form>
  );
}

function ExpensesTab({ c, master }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null); // {} new, or the expense being changed
  const load = () => api.get(`/accounts/expenses?${new URLSearchParams({ q: q.trim() })}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [q]);

  if (form) {
    const back = () => { setForm(null); load(); };
    return <ExpenseForm start={form.id ? form : null} c={c} master={master} onCancel={back} onDone={back} />;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor, account, memo, check no." aria-label="Search expenses" className={`${FIELD} pl-10`} />
        </div>
        <button onClick={() => setForm({})} className={PRIMARY}><Plus size={16} /> New expense</button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!rows ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : rows.length === 0 ? <p className="py-3 text-sm text-mute">No expenses yet. Add one with its receipt, and it goes to QuickBooks by itself.</p> : (
          <ul className="space-y-2">
            {rows.map((e) => (
              <li key={e.id}>
                <button onClick={() => setForm(e)} className={`${CARD} flex w-full items-start gap-3 text-left hover:border-p1/50`}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-white"><Receipt size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium">{e.vendor_name}</span>
                      <QbPill q={e.quickbooks} />
                      {e.repeat_id && <span className="rounded-full bg-p3/15 px-2 py-0.5 text-[11px] text-p3">Monthly bill</span>}
                    </span>
                    <span className="mt-0.5 block text-xs text-mute">{[fmt(e.paid_on), e.ref_no, e.pay_from_name, e.building && `${e.building}${e.unit_no ? ` · Unit ${e.unit_no}` : ''}`].filter(Boolean).join(' · ')}</span>
                    <span className="mt-1 block truncate text-sm text-txt/80">{e.lines.map((l) => l.account).join(', ')}{e.memo ? ` · ${e.memo}` : ''}</span>
                    {e.quickbooks?.state === 'failed' && <span className="mt-1 block text-xs text-bad">{e.quickbooks.error}</span>}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">{money(e.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

// ---------- monthly bills ----------

function RepeatForm({ start, c, onDone, onCancel }) {
  const [v, setV] = useState({ vendor_list_id: '', pay_from: c.pay_from[0]?.id || '', ref_no: 'ACH', account_list_id: '', amount: '', memo: '', day: '1', building_id: '', ...start, ...pendingId(start), ...(start && { amount: String(start.amount), day: String(start.day) }) });
  const [vendors, setVendors] = useState(() => withPending(c.vendors, start));
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    const isNew = String(v.vendor_list_id).startsWith('new:');
    const body = { ...v, vendor_list_id: isNew ? '' : v.vendor_list_id, vendor_name: isNew ? v.vendor_list_id.slice(4) : v.vendor_name, amount: Number(v.amount), day: Number(v.day) };
    try { await (start?.id ? api.put(`/accounts/repeats/${start.id}`, body) : api.post('/accounts/repeats', body)); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <form onSubmit={save} className={`${CARD} max-w-3xl space-y-4`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Paid to" need wide>
          <Select value={v.vendor_list_id} onChange={set('vendor_list_id')} aria-label="Vendor" placeholder="Choose the vendor, or type a new one" className={FIELD}
            options={vendors.map((x) => ({ value: x.id, label: x.name }))}
            onCreate={(name) => { const id = `new:${name.slice(0, 41)}`; setVendors([...vendors, { id, name: `${name.slice(0, 41)} (new)` }]); setV({ ...v, vendor_list_id: id }); }} />
        </Label>
        <Label text="Account" need><Select value={v.account_list_id} onChange={set('account_list_id')} aria-label="Account" placeholder="Expense account" className={FIELD} options={c.accounts.map((a) => ({ value: a.id, label: a.name }))} /></Label>
        <Label text="Amount each month" need><input value={v.amount} onChange={set('amount')} inputMode="decimal" required placeholder="0.00" className={`${FIELD} tabular-nums`} /></Label>
        <Label text="Day of the month" need>
          <Select value={v.day} onChange={set('day')} aria-label="Day of the month" className={FIELD} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
        </Label>
        <Label text="Paid from" need><Select value={v.pay_from} onChange={set('pay_from')} aria-label="Paid from" className={FIELD} options={c.pay_from.map((p) => ({ value: p.id, label: p.name }))} /></Label>
        <Label text="Check no., ACH or DD"><input value={v.ref_no || ''} onChange={set('ref_no')} maxLength={11} className={FIELD} /></Label>
        <Label text="Memo"><input value={v.memo || ''} onChange={set('memo')} maxLength={200} placeholder="Account number, what it covers" className={FIELD} /></Label>
        <Label text="Building">
          <Select value={v.building_id || ''} onChange={set('building_id')} aria-label="Building" className={FIELD} placeholder="None"
            options={[{ value: '', label: 'None' }, ...c.buildings.map((b) => ({ value: b.id, label: b.name }))]} />
        </Label>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-between gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button className={PRIMARY}><Check size={15} /> Save</button>
      </div>
      <p className="text-xs text-mute">On its day each month it becomes an expense by itself, and goes to QuickBooks like any other. A change applies from the next one.</p>
    </form>
  );
}

function MonthlyTab({ c }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const load = () => api.get('/accounts/repeats').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn) => { try { await fn(); load(); } catch (e) { setError(e.message); } };
  if (form) return <RepeatForm start={form.id ? form : null} c={c} onCancel={() => setForm(null)} onDone={() => { setForm(null); load(); }} />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-mute">Bills paid every month: insurance, a loan, utilities on autopay.</p>
        <button onClick={() => setForm({})} className={PRIMARY}><Plus size={16} /> New monthly bill</button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!rows ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
        : rows.length === 0 ? <p className="py-3 text-sm text-mute">None yet.</p> : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id} className={`${CARD} flex items-center gap-3 ${r.active ? '' : 'opacity-60'}`}>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-purple-600 text-white"><CalendarClock size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{r.vendor_name} · {money(r.amount)}</span>
                  <span className="block truncate text-xs text-mute">{[`Day ${r.day} of each month`, r.account, r.pay_from_name, r.building, !r.active && 'Paused'].filter(Boolean).join(' · ')}</span>
                </span>
                <button onClick={() => setForm(r)} aria-label="Change" title="Change" className={ROUND}><Pencil size={15} /></button>
                <button onClick={() => act(() => api.put(`/accounts/repeats/${r.id}`, { ...r, active: !r.active }))} aria-label={r.active ? 'Pause' : 'Start again'} title={r.active ? 'Pause' : 'Start again'} className={ROUND}>{r.active ? <Pause size={15} /> : <Play size={15} />}</button>
                <button onClick={() => confirm(`Delete the monthly bill from ${r.vendor_name}? The ones already made stay.`) && act(() => api.del(`/accounts/repeats/${r.id}`))} aria-label="Delete" title="Delete" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

// ---------- the QuickBooks connection (master) ----------

const MAPPING = [
  ['bank_account', 'Bank account money goes into', 'Rent is deposited here, and refunds are paid from here.', (a) => a.type === 'Bank'],
  ['rent_account', 'Rent goes to', 'Usually Rental Income.', (a) => /Income/.test(a.type)],
  ['deposit_account', 'Security deposits go to', 'A liability (money owed back to tenants) is the usual way; an income account if that is how your bookkeeper does it.', (a) => /Income|Liability/.test(a.type)],
  ['late_account', 'Late fees go to', 'Empty: the same as other charges.', (a) => /Income/.test(a.type)],
  ['charge_account', 'Other charges go to', 'Pet fees, keys, washer/dryer… Empty: with the rent.', (a) => /Income/.test(a.type)],
  ['kept_account', 'Deposit kept at move-out goes to', 'Only when deposits sit in a liability: what is kept is moved to this income account.', (a) => /Income/.test(a.type)],
];

function QuickBooksTab() {
  const [s, setS] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({});
  const [secret, setSecret] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => Promise.all([api.get('/quickbooks/status'), api.get('/quickbooks/settings')])
    .then(([st, c]) => { setS(st); setCfg(c); setForm(c.settings); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn, done) => { setError(''); setMsg(''); try { await fn(); if (done) setMsg(done); await load(); } catch (e) { setError(e.message); } };

  if (!s) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <div className="max-w-3xl space-y-4">
      {error && <p className="text-sm text-bad">{error}</p>}
      {msg && <p className="text-sm text-ok">{msg}</p>}

      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Connection</p>
            <p className="text-xs text-mute">{!s.set_up ? 'Not set up yet.' : s.company_file ? `Tied to ${s.company_file}` : 'Set up. Not tied to a company file yet: the first one to connect will be.'}</p>
            {s.set_up && <p className="text-xs text-mute">{s.enabled ? 'Sending is on: what is recorded here goes into QuickBooks.' : 'Sending is off: QuickBooks\' lists are read, but nothing is written into QuickBooks.'}</p>}
            {s.last_contact && <p className="text-xs text-mute">Last heard from the Web Connector {new Date(s.last_contact).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>}
          </div>
          {s.set_up && (
            <button onClick={() => act(() => api.post('/quickbooks/enabled', { on: !s.enabled }), s.enabled ? 'Sending switched off.' : 'Sending switched on.')}
              className={s.enabled ? `${OUTLINE} border-ok/50 text-ok` : OUTLINE}><Power size={15} /> {s.enabled ? 'On' : 'Off'}</button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {!s.set_up
            ? <button onClick={() => act(async () => setSecret(await api.post('/quickbooks/setup')))} className={PRIMARY}><KeyRound size={15} /> Set up</button>
            : <>
              <a href="/api/quickbooks/qwc" className={OUTLINE}><Download size={15} /> Download the Web Connector file (.qwc)</a>
              <button onClick={() => confirm('Make a new Web Connector password? The old one stops working, and the new one has to be typed into the Web Connector.') && act(async () => setSecret(await api.post('/quickbooks/setup')))} className={GHOST}><KeyRound size={13} /> New password</button>
              <button onClick={() => act(() => api.post('/quickbooks/read-lists'), 'QuickBooks\' lists will be read on the next round.')} className={GHOST}><RefreshCw size={13} /> Read QuickBooks' lists again</button>
              {s.company_file && <button onClick={() => confirm(`Untie ${s.company_file}? The next company file to connect becomes the one the app sends to. Only do this when moving from a test copy to the real books.`) && act(() => api.post('/quickbooks/forget-file'), 'Untied.')} className={`${GHOST} hover:text-bad`}><X size={13} /> Untie this company file</button>}
            </>}
        </div>
        {secret && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
            <p>Web Connector user name <b>{secret.username}</b>, password <b className="select-all font-mono">{secret.password}</b></p>
            <p className="mt-1 text-xs text-mute">Shown this once. Type it into the Web Connector's Password box for "Lease app".</p>
          </div>
        )}
      </div>

      {s.set_up && cfg && (
        <form onSubmit={(e) => { e.preventDefault(); act(() => api.put('/quickbooks/settings', form), 'Saved.'); }} className={`${CARD} space-y-3`}>
          <p className="text-sm font-medium">What goes where in QuickBooks</p>
          {!cfg.accounts.length && <p className="text-sm text-warn">QuickBooks' accounts have not been read yet. Read the lists, wait for the next round, then come back.</p>}
          <Label text="Send from this day on">
            <DateField value={form.start_date || ''} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className={FIELD} />
            <span className="mt-1 block text-xs text-mute">Rent and expenses before this day are left to the bookkeeper, as they are in QuickBooks already. From this day, nobody types them into QuickBooks.</span>
          </Label>
          {MAPPING.map(([key, label, hint, fits]) => (
            <Label key={key} text={label}>
              <Select value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} aria-label={label} className={FIELD} placeholder="Not chosen"
                options={[{ value: '', label: 'Not chosen' }, ...cfg.accounts.filter(fits).map((a) => ({ value: a.list_id, label: a.full_name }))]} />
              <span className="mt-1 block text-xs text-mute">{hint}</span>
            </Label>
          ))}
          <button className={PRIMARY}><Check size={15} /> Save</button>
        </form>
      )}

      {s.set_up && (
        <div className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Queue</p>
            <p className="text-xs text-mute">{s.queue.waiting} waiting · {s.queue.done} done · {s.queue.failed} refused</p>
          </div>
          {s.failed.length > 0 && (
            <>
              <ul className="mt-3 divide-y divide-stroke/60 text-sm">
                {s.failed.map((f) => <li key={f.id} className="py-2"><span className="font-medium">{f.what}</span> <span className="text-bad">{f.error}</span></li>)}
              </ul>
              <button onClick={() => act(() => api.post('/quickbooks/retry'), 'They will be tried again on the next round.')} className={`${OUTLINE} mt-3`}><RotateCcw size={15} /> Try again</button>
            </>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-mute">Log</summary>
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-xs">
              {s.log.map((l, i) => <li key={i}><span className="tabular-nums text-mute">{new Date(l.at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })}</span> {l.event} {l.detail}</li>)}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

// ---------- the page ----------

export default function AccountsPage({ me, onBack }) {
  const master = me?.role === 'master';
  const [tab, setTab] = useState('expenses');
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/accounts/choices').then(setC).catch((e) => setError(e.message)); }, [tab]);
  const TABS = [['expenses', 'Expenses'], ['monthly', 'Monthly bills'], master && ['quickbooks', 'QuickBooks']].filter(Boolean);
  return (
    <Page title="Accounts" onBack={onBack}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1">{TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} aria-pressed={tab === k} className={CHIP(tab === k)}>{l}</button>)}</div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {tab === 'quickbooks' ? <QuickBooksTab />
          : !c ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : !c.ready ? <p className="text-sm text-mute">QuickBooks' vendors and accounts are not here yet. {master ? 'Connect QuickBooks on the QuickBooks tab first.' : 'Ask the master to connect QuickBooks first.'}</p>
          : tab === 'expenses' ? <ExpensesTab c={c} master={master} /> : <MonthlyTab c={c} />}
      </div>
    </Page>
  );
}
