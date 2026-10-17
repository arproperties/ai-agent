import { useEffect, useState } from 'react';
import { ArrowRight, Banknote, Copy, FileText, Loader2, Mail, MessageCircle, Paperclip, Plus, Trash2, Undo2 } from 'lucide-react';
import { api } from '../lib/api';
import { money as aed, currency, today, region } from '../lib/region';
import { usDate as fmt, usPhone } from '../lib/usFormat';
import DateField from './DateField';

// One booking's money: each payment due (rent, the security deposit, other charges) and what
// has been received against it. Money arrives outside the app (bank transfer, cash, card, money
// order or online card) and is recorded here by hand; a payment can be part of what is due, and
// each has a receipt. A charge can be added on a date of its own (a key deposit, a court cost),
// and Transactions lists it all by date with a running balance, as Rent Manager's tab does.
// From here the tenant can be reminded, the deposit settled at check-out, and the booking's
// history read. The server is the payments part of server/leasing.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt disabled:opacity-50';
const PRIMARY = 'flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-60';
const HEAD = 'text-[11px] font-medium uppercase tracking-widest text-mute';
const METHODS = [['transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['money_order', 'Money order'], ['online', 'Online card']];
const REF = { cash: 'Receipt no.', card: 'Card slip no.', money_order: 'Money order no.', online: 'e.g. ePay VISA, auth no.', transfer: 'Transfer ref.' };
const STATUS = {
  paid: ['Paid', 'bg-ok/15 text-ok'], partly_paid: ['Part paid', 'bg-warn/15 text-warn'], overdue: ['Overdue', 'bg-bad/15 text-bad'],
  due: ['Due today', 'bg-p1/20 text-p1'], upcoming: ['Upcoming', 'bg-white/10 text-txt/80'], waived: ['Cancelled', 'bg-white/5 text-mute'],
};
const DEPOSIT = { unpaid: 'Not received yet', held: 'Held', refunded: 'Given back in full', partly_refunded: 'Partly given back', kept: 'Kept, nothing given back', passed_on: 'Passed on to the renewal', none: 'None on this lease' };
const EVENT = {
  created: 'Lease made', confirmed: 'Confirmed', changed: 'Changed', cancelled: 'Cancelled', payment: 'Payment recorded', payment_deleted: 'Payment deleted',
  document: 'Document added', document_removed: 'Document removed', renewed: 'Renewed', deposit: 'Deposit settled', reminder: 'Reminder',
  deposit_passed: 'Deposit passed on', deposit_carried: 'Deposit carried over', deposit_back: 'Deposit pass-on undone',
  charge: 'Charge added', charge_removed: 'Charge taken off',
};

/** A charge on a date of its own, added to the lease: a mailbox key deposit, a court cost, a late charge from before. */
function ChargeForm({ bookingId, onDone, onCancel }) {
  const [v, setV] = useState({ label: '', due_date: today(), amount: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await api.post(`/leasing/bookings/${bookingId}/charges`, v); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border border-p1/40 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_11rem_9rem]">
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Charge</span>
          <input value={v.label} onChange={set('label')} required autoFocus placeholder="e.g. Court Cost, Mail Box Key Deposit, Late Charge" className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Date</span>
          <DateField value={v.due_date} onChange={set('due_date')} required className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Amount ({currency()})</span>
          <input type="number" min="0" step="any" value={v.amount} onChange={set('amount')} required className={FIELD} /></label>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}><Plus size={16} /> {busy ? 'Adding…' : 'Add charge'}</button>
      </div>
    </form>
  );
}

/** Every charge and payment by date, with the balance after each, as Rent Manager's Transactions tab lists them. */
function Transactions({ bookingId, stamp: version }) {
  const [l, setL] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/leasing/bookings/${bookingId}/ledger`).then(setL).catch((e) => setError(e.message)); }, [bookingId, version]);
  if (!l) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const signed = (n) => (n < 0 ? `(${aed(-n)})` : aed(n)); // money in, in brackets, as Rent Manager shows it
  return (
    <div className="rounded-2xl border border-stroke">
      {l.rows.length === 0 ? <p className="px-4 py-4 text-sm text-mute">Nothing has fallen due or been paid yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={`border-b border-stroke text-left ${HEAD}`}>
              <th className="px-4 py-2.5 font-medium">Date</th><th className="px-3 py-2.5 font-medium">Description</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th><th className="px-4 py-2.5 text-right font-medium">Balance</th>
            </tr></thead>
            <tbody className="divide-y divide-stroke/60">
              {l.rows.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{fmt(r.date)}</td>
                  <td className={`px-3 py-2 ${r.kind === 'payment' ? 'text-ok' : ''}`}>{r.description}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${r.kind === 'payment' ? 'text-ok' : ''}`}>{signed(r.amount)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{signed(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-stroke px-4 py-3 font-medium">
        <span>Balance due today</span><span className={`tabular-nums ${l.balance > 0 ? 'text-bad' : ''}`}>{signed(l.balance)}</span>
      </div>
    </div>
  );
}

const stamp = (secs) => new Date(Number(secs) * 1000).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Recording money against one payment due, or (with `url`) against the booking as a whole,
    where it is spread over what is owed oldest first. The amount starts at what is still owed. */
function PayForm({ row, url = `/leasing/installments/${row.id}/payments`, onDone, onCancel }) {
  const [v, setV] = useState({ amount: row.left, method: 'transfer', received_on: today(), reference: '' });
  const [file, setFile] = useState(null); // the proof: transfer slip, card slip, a photo of the cash receipt
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData();
    for (const [k, x] of Object.entries(v)) form.append(k, x);
    if (file) form.append('file', file);
    try { await api.upload(url, form); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-xl border border-p1/40 p-3">
      <div className="flex flex-wrap gap-1.5 text-xs">
        {METHODS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setV({ ...v, method: k })}
            className={`rounded-full px-3 py-1.5 ${v.method === k ? 'bg-p1/20 text-p1' : 'border border-stroke/70 text-mute hover:text-txt'}`}>{l}</button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Amount received ({currency()})</span>
          <input type="number" min="0" max={row.left} step="any" value={v.amount} onChange={set('amount')} required className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Received on</span>
          <DateField value={v.received_on} onChange={set('received_on')} max={today()} required className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-txt/80">Reference</span>
          <input value={v.reference} onChange={set('reference')} placeholder={REF[v.method]} className={FIELD} /></label>
      </div>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        <Paperclip size={15} className="shrink-0" /> <span className="truncate">{file ? file.name : 'Attach the slip (PDF or photo)'}</span>
        <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}><Banknote size={16} /> {busy ? 'Saving…' : 'Save payment'}</button>
      </div>
    </form>
  );
}

/** The reminder to the tenant: the words can be changed, then it opens in WhatsApp or email for a person to send. */
function Remind({ row, onDone, onCancel }) {
  const [r, setR] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/leasing/alerts/reminder/${row.id}`).then((x) => { setR(x); setText(x.message); }).catch((e) => setError(e.message)); }, [row.id]);
  const sent = (channel) => api.post(`/leasing/alerts/reminder/${row.id}`, { channel }).then(onDone).catch(() => onDone());
  const copy = async () => { try { await navigator.clipboard.writeText(text); sent('copy'); } catch { setError('Could not copy. Select the text and copy it yourself.'); } };

  if (!r) return <p className="mt-3 text-sm text-mute">{error || 'Writing the reminder…'}</p>;
  const wa = r.whatsapp && `${r.whatsapp.split('?')[0]}?text=${encodeURIComponent(text)}`;
  const mail = r.email && `mailto:${r.email}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(text)}`;
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-p1/40 p-3">
      <p className="text-xs text-mute">To {r.tenant}{r.phone && ` · ${usPhone(r.phone)}`}{r.email && ` · ${r.email}`}. Nothing is sent until you press send in WhatsApp or your email.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className={`${FIELD} resize-none text-sm`} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="mr-auto rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button type="button" onClick={copy} className={GHOST}><Copy size={13} /> Copy</button>
        {mail ? <a href={mail} onClick={() => sent('email')} className={GHOST}><Mail size={13} /> Email</a> : <span className={`${GHOST} opacity-50`} title="No email on file for this tenant"><Mail size={13} /> No email</span>}
        {wa ? <a href={wa} target="_blank" rel="noreferrer" onClick={() => sent('whatsapp')} className={PRIMARY}><MessageCircle size={16} /> WhatsApp</a>
          : <span className={`${GHOST} opacity-50`} title="No phone number on file for this tenant"><MessageCircle size={13} /> No phone</span>}
      </div>
    </div>
  );
}

/** The security deposit, apart from the rent: it is the tenant's money, received (`children` is
    its line on the schedule), held, and at check-out given back, less what was kept and why.
    At a renewal it can be passed on to the new booking instead, which then holds it; the
    booking it came from keeps a line saying where it went. */
function Deposit({ bookingId, d, onDone, children }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ refunded: d.held, note: '' });
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try { await api.post(`/leasing/bookings/${bookingId}/deposit`, v); setOpen(false); onDone(); } catch (err) { setError(err.message); }
  };
  // Passing on is always done to the booking the deposit is held on: this one, or the one this renews.
  const pass = async (from, undo) => {
    setError('');
    try { await (undo ? api.del(`/leasing/bookings/${from}/deposit/pass`) : api.post(`/leasing/bookings/${from}/deposit/pass`)); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <div className="rounded-2xl border border-stroke">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className={HEAD}>Security deposit</p>
          <p className="mt-1 text-sm">{aed(Math.max(d.amount, d.from ? d.held : 0))} · {DEPOSIT[d.status]}{d.status === 'held' && d.held < d.amount && ` (${aed(d.held)} received)`}</p>
          {d.from?.map((f) => <p key={f.id} className="text-xs text-mute">{aed(f.amount)} carried over from {f.ref} on {fmt(f.on)}.</p>)}
          {d.waiting && <p className="text-xs text-mute">{aed(d.waiting.amount)} is held on {d.waiting.ref}, the lease this one renews.</p>}
          {d.passed_to ? <p className="text-xs text-mute">Passed on to {d.passed_to.ref} on {fmt(d.passed_to.on)}. It is held and given back from that lease.</p>
            : d.status === 'none' ? null
            : d.refunded == null ? <p className="text-xs text-mute">Held for the tenant, not income. Given back at check-out.</p>
            : <p className="text-xs text-mute">{aed(d.refunded)} given back of {aed(d.held)} on {fmt(d.settled_on)}{d.held > d.refunded && ` · ${aed(d.held - d.refunded)} kept`}{d.note && ` · ${d.note}`}</p>}
        </div>
        {d.waiting && <button onClick={() => pass(d.waiting.id)} className={GHOST}><ArrowRight size={13} /> Bring it over to this lease</button>}
        {d.can_pass && !open && <button onClick={() => pass(bookingId)} className={GHOST}><ArrowRight size={13} /> Pass on to {d.can_pass.ref}</button>}
        {d.passed_to && <button onClick={() => pass(bookingId, true)} className={GHOST}><Undo2 size={13} /> Undo</button>}
        {d.held > 0 && !d.passed_to && !open && <button onClick={() => setOpen(true)} className={GHOST}><Undo2 size={13} /> {d.refunded == null ? 'Give back deposit' : 'Change'}</button>}
      </div>
      {error && !open && <p className="px-4 pb-3 text-sm text-bad">{error}</p>}
      {open && (
        <form onSubmit={save} className="grid gap-2 px-4 pb-3 sm:grid-cols-[10rem_1fr]">
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Given back to tenant ({currency()})</span>
            <input type="number" min="0" max={d.held} step="any" value={v.refunded} onChange={(e) => setV({ ...v, refunded: e.target.value })} required className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-xs text-txt/80">What was deducted, and why</span>
            <input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. repainting 800, final utility bill 200" className={FIELD} /></label>
          {error && <p className="text-sm text-bad sm:col-span-2">{error}</p>}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
            <button className={PRIMARY}>Save</button>
          </div>
        </form>
      )}
      {children.length > 0 && <div className="divide-y divide-stroke/60 border-t border-stroke/60">{children}</div>}
    </div>
  );
}

export default function BookingPayments({ booking }) {
  const [rows, setRows] = useState(null);
  const [deposit, setDeposit] = useState(null);
  const [history, setHistory] = useState([]);
  const [open, setOpen] = useState(null); // { id, as: 'pay' | 'remind' }: the row something is being done to; { as: 'all' | 'charge' } for the lease as a whole
  const [view, setView] = useState('schedule'); // the schedule row by row, or Transactions
  const [version, setVersion] = useState(0); // bumped on each load, so Transactions reads again
  const [error, setError] = useState('');
  const at = `/leasing/bookings/${booking.id}`;
  const load = () => {
    setVersion((n) => n + 1);
    api.get(`${at}/payments`).then(setRows).catch((e) => setError(e.message));
    api.get(`${at}/deposit`).then(setDeposit).catch((e) => setError(e.message));
    api.get(`${at}/history`).then(setHistory).catch(() => {});
  };
  useEffect(() => { load(); }, [booking.id]);
  const done = () => { setOpen(null); load(); };

  // The slip for a payment already recorded: added, or put in place of the one it has.
  const attach = async (p, file) => {
    if (!file) return;
    setError('');
    const form = new FormData();
    form.append('file', file);
    try { await api.upload(`/leasing/payments/${p.id}/file`, form); load(); } catch (e) { setError(e.message); }
  };
  const remove = async (p) => {
    if (!confirm(`Delete this payment of ${aed(p.amount)}?`)) return;
    setError('');
    try { await api.del(`/leasing/payments/${p.id}`); load(); } catch (e) { setError(e.message); }
  };
  const unCharge = async (r) => {
    if (!confirm(`Take off ${r.name} of ${aed(r.amount)}?`)) return;
    setError('');
    try { await api.del(`/leasing/charges/${r.id}`); load(); } catch (e) { setError(e.message); }
  };
  const takes = !booking.no_payments; // ticked "Don't accept payments" on the lease: none can be recorded

  if (!rows || !deposit) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  // The deposit is not income: its line sits in its own card, and the figures on top are rent and charges only.
  const dues = rows.filter((r) => r.kind !== 'deposit');
  const held = rows.filter((r) => r.kind === 'deposit');
  const sum = (f, list = dues) => list.reduce((t, r) => t + f(r), 0);
  const overdue = sum((r) => (r.status === 'overdue' ? r.left : 0));
  const owedInAll = Math.round(sum((r) => r.left, rows) * 100) / 100;
  const tax = Math.round(sum((r) => r.tax || 0) * 100) / 100;
  const is = (r, as) => open?.id === r.id && open.as === as;

  // One payment due, with the money received against it and what can be done to it.
  const line = (r) => {
    const [label, tone] = STATUS[r.status];
    const owing = r.left > 0 && r.status !== 'waived';
    return (
      <div key={r.id} className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <div className="min-w-0 flex-1 basis-48">
            <p className="font-medium">{aed(r.amount)}<span className={`ml-2 rounded-full px-2.5 py-0.5 text-xs font-normal ${tone}`}>{label}</span></p>
            <p className="text-xs text-mute">{r.name} · due {fmt(r.due_date)}{r.tax > 0 && ` · includes ${region().tax_name} ${aed(r.tax)}`}{r.paid > 0 && r.left > 0 && ` · ${aed(r.paid)} received, ${aed(r.left)} still owed`}</p>
          </div>
          {owing && !is(r, 'remind') && <button onClick={() => setOpen({ id: r.id, as: 'remind' })} className={GHOST}><MessageCircle size={13} /> Remind tenant</button>}
          {owing && takes && !is(r, 'pay') && <button onClick={() => setOpen({ id: r.id, as: 'pay' })} className={GHOST}><Plus size={13} /> Record payment</button>}
          {r.kind === 'charge' && r.paid === 0 && <button onClick={() => unCharge(r)} aria-label={`Take off ${r.name}`} title="Take off this charge" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>}
        </div>
        {r.payments.map((p) => (
          <div key={p.id} className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
            <Banknote size={15} className="shrink-0 text-ok" />
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate">{aed(p.amount)} · {METHODS.find(([k]) => k === p.method)?.[1]}{p.reference && ` · ${p.reference}`}</p>
              <p className="truncate text-xs text-mute">Received {fmt(p.received_on)}{p.recorded_by && ` · recorded by ${p.recorded_by}`}</p>
            </div>
            {p.has_file && <a href={`/api/leasing/payments/${p.id}/file`} target="_blank" rel="noreferrer" title={p.file_name} className={GHOST}><Paperclip size={13} /> Slip</a>}
            <label title={p.has_file ? 'Replace the attached slip' : 'Attach the slip (PDF or photo)'} className={`${GHOST} cursor-pointer`}>
              <Paperclip size={13} /> {p.has_file ? 'Replace' : 'Attach'}
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { attach(p, e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <a href={`/api/leasing/payments/${p.id}/receipt`} target="_blank" rel="noreferrer" title={`Receipt ${p.receipt_no}`} className={GHOST}><FileText size={13} /> Receipt</a>
            <button onClick={() => remove(p)} aria-label="Delete payment" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
          </div>
        ))}
        {is(r, 'pay') && <PayForm row={r} onDone={done} onCancel={() => setOpen(null)} />}
        {is(r, 'remind') && <Remind row={r} onDone={done} onCancel={() => setOpen(null)} />}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[['Rent and charges', sum((r) => r.amount), '', tax > 0 && `includes ${region().tax_name} ${aed(tax)}`], ['Received', sum((r) => r.paid), 'text-ok'], ['Overdue', overdue, overdue ? 'text-bad' : '']].map(([l, n, tone, note]) => (
          <div key={l} className="rounded-2xl border border-stroke p-3 md:p-4">
            <p className="text-xs text-mute">{l}</p>
            <p className={`mt-1 text-lg font-light tracking-tight md:text-2xl ${tone}`}>{aed(n)}</p>
            {note && <p className="text-[11px] text-mute">{note}</p>}
          </div>
        ))}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!takes && <p className="rounded-xl bg-warn/15 px-3.5 py-2.5 text-sm text-warn">This lease is ticked “Don’t accept payments”. Untick it on the lease (Edit) to record one.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex shrink-0 rounded-full border border-stroke p-0.5">
          {[['schedule', 'Schedule'], ['transactions', 'Transactions']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k}
              className={`rounded-full px-3 py-1.5 text-xs ${view === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </span>
        <span className="flex-1" />
        {booking.status === 'confirmed' && open?.as !== 'charge' && <button onClick={() => setOpen({ as: 'charge' })} className={GHOST}><Plus size={13} /> Add a charge</button>}
        {/* Several months paid together: one amount, spread over what is owed, oldest first. */}
        {owedInAll > 0 && takes && open?.as !== 'all' && <button onClick={() => setOpen({ as: 'all' })} title="Paid for more than one at once? It goes against what is owed, oldest first." className={GHOST}><Banknote size={13} /> Record a payment</button>}
      </div>
      {open?.as === 'charge' && <ChargeForm bookingId={booking.id} onDone={done} onCancel={() => setOpen(null)} />}
      {open?.as === 'all' && <PayForm row={{ left: owedInAll }} url={`${at}/payments`} onDone={done} onCancel={() => setOpen(null)} />}
      {view === 'transactions' ? <Transactions bookingId={booking.id} stamp={version} /> : (
        <div className="rounded-2xl border border-stroke">
          {dues.length === 0 ? <p className="px-4 py-4 text-sm text-mute">No rent or charges are due on this lease.</p>
            : <div className="divide-y divide-stroke/60">{dues.map(line)}</div>}
        </div>
      )}

      {(deposit.status !== 'none' || held.length > 0 || deposit.waiting) && <Deposit key={`${deposit.held}-${deposit.refunded}-${deposit.status}`} bookingId={booking.id} d={deposit} onDone={load}>{held.map(line)}</Deposit>}

      {history.length > 0 && (
        <div className="rounded-2xl border border-stroke p-4">
          <p className={HEAD}>History</p>
          <ul className="mt-2 divide-y divide-stroke/60 text-sm">
            {history.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="min-w-0 flex-1 basis-56">{EVENT[e.kind] || e.kind}{e.detail && <span className="text-mute"> · {e.detail}</span>}</span>
                <span className="shrink-0 text-xs text-mute">{stamp(e.created_at)}{e.by && ` · ${e.by}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
