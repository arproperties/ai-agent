import { useEffect, useState } from 'react';
import { Banknote, BellRing, CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Coins, CreditCard, FileWarning, Loader2, Mail, MessageSquareText, Minus, Moon, Plus, SlidersHorizontal, TriangleAlert, X } from 'lucide-react';
import { api } from '../lib/api';
import { currency } from '../lib/region';

// Leasing alerts: what needs somebody today — rent overdue, due today or coming up, leases
// about to end, bookings with no contract, tenant IDs expiring. The list is worked out
// fresh by the server (server/leasingAlerts.js) each time, and a row opens the screen that
// deals with it. The master's rules sit behind Settings: which alerts are on, on which days
// each one buzzes a phone, the quiet hours and the reminder's wording.

const FIELD = 'glass rounded-xl px-3 py-2 text-sm outline-none focus:border-p1/70';
const CARD = 'rounded-2xl border border-stroke bg-surface p-4';
const HEAD = 'text-[11px] font-medium uppercase tracking-widest text-mute';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-60';
// The kinds of alert as the sidebar draws them, '' being all of them: key, a name short
// enough to sit under the disc, icon, colour, and the full name.
export const ALERT_KINDS = [
  ['', 'All', BellRing, 'from-orange-400 to-red-500 shadow-red-500/30', 'All alerts'], ['overdue', 'Overdue', TriangleAlert, 'rose', 'Rent overdue'],
  ['due', 'Due today', Banknote, 'amber', 'Rent due today'], ['upcoming', 'Coming up', CalendarClock, 'blue', 'Rent coming up'],
  ['ending', 'Ending', CalendarDays, 'violet', 'Leases ending'], ['contract', 'Contract', FileWarning, 'slate', 'No contract on file'],
  ['eid', 'ID expiry', CreditCard, 'teal', 'ID expiring'],
];
const RULE = {
  overdue: ['Overdue', TriangleAlert], due: ['Due today', Banknote], upcoming: ['Coming up', CalendarClock],
  ending: ['Leases ending', CalendarDays], contract: ['No contract', FileWarning], eid: ['ID expiry', CreditCard],
};
const LEVEL = { bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', info: 'bg-p3/15 text-p3' };
const DOES = { pay: 'Record payment', docs: 'Add the contract', booking: 'Open booking', tenants: 'Open tenants' };

function Switch({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition ${on ? 'bg-p1' : 'bg-white/15'}`}>
      <span className={`absolute top-1 size-4 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-1'}`} />
    </button>
  );
}

// The colour of each rule's disc, as the sidebar's own discs are coloured.
export const TINT = {
  overdue: 'from-rose-400 to-red-500', due: 'from-amber-400 to-orange-500', upcoming: 'from-sky-400 to-blue-500',
  ending: 'from-violet-400 to-purple-500', contract: 'from-slate-400 to-slate-600', eid: 'from-teal-400 to-emerald-500',
  summary: 'from-orange-400 to-pink-500', quiet: 'from-indigo-400 to-indigo-600',
  latefee: 'from-rose-400 to-pink-600', tenant: 'from-sky-400 to-indigo-500',
};
const ROUND = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-30';

/** A whole number to type, with − and + either side and what it counts after it. */
function Num({ value, onChange, min = 0, max, unit, label }) {
  const n = Number(value) || 0;
  const to = (x) => onChange(Math.min(max, Math.max(min, x)));
  return (
    <div className="flex shrink-0 items-center rounded-full border border-stroke p-0.5">
      <button type="button" aria-label={`${label}: less`} disabled={n <= min} onClick={() => to(n - 1)} className={ROUND}><Minus size={14} /></button>
      <input value={value} inputMode="numeric" aria-label={label} onBlur={() => to(n)}
        onChange={(e) => { const t = e.target.value.replace(/\D/g, ''); onChange(t === '' ? '' : Math.min(max, Number(t))); }}
        className={`${max > 999 ? 'w-16' : 'w-9'} bg-transparent text-right text-sm tabular-nums outline-none`} />
      <span className="pl-1 pr-2 text-sm text-mute">{unit}</span>
      <button type="button" aria-label={`${label}: more`} disabled={n >= max} onClick={() => to(n + 1)} className={ROUND}><Plus size={14} /></button>
    </div>
  );
}

/** A handful of days, each a chip that can be taken off, and a slot to add another. */
function Days({ value, onChange, label, desc }) {
  const [add, setAdd] = useState('');
  const commit = () => {
    const n = Number(add);
    if (add !== '' && n <= 365 && !value.includes(n)) onChange([...value, n].sort((x, y) => (desc ? y - x : x - y)));
    setAdd('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((n) => (
        <span key={n} className="flex items-center gap-1 rounded-full bg-p1/15 py-1 pl-3 pr-1.5 text-sm tabular-nums text-p1">
          {n} {n === 1 ? 'day' : 'days'}
          <button type="button" aria-label={`${label}: remove ${n}`} disabled={value.length === 1} onClick={() => onChange(value.filter((x) => x !== n))}
            className="grid size-5 place-items-center rounded-full hover:bg-p1/20 disabled:invisible"><X size={12} /></button>
        </span>
      ))}
      {value.length < 8 && (
        <input value={add} inputMode="numeric" placeholder="+ add" aria-label={`${label}: add a day`} onBlur={commit}
          onChange={(e) => setAdd(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
          className="w-16 rounded-full border border-dashed border-stroke bg-transparent px-3 py-1 text-sm outline-none placeholder:text-mute focus:border-p1/70" />
      )}
    </div>
  );
}

const Field = ({ label, children }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <span className="text-sm text-txt/80">{label}</span>
    {children}
  </div>
);

/** The master's rules: a card to each, its switch at the top and what it goes by underneath. */
function Rules({ start, onSaved }) {
  // The late fee is one or the other, a fixed amount or a share of the rent: rules saved with both keep the amount.
  const [feeBy, setFeeBy] = useState(start.latefee.percent > 0 && !(start.latefee.amount > 0) ? 'percent' : 'amount');
  const [v, setV] = useState(() => (start.latefee.amount > 0 && start.latefee.percent > 0 ? { ...start, latefee: { ...start.latefee, percent: 0 } } : start));
  const [saved, setSaved] = useState(start);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const put = (rule, field) => (x) => { setNote(''); setV({ ...v, [rule]: { ...v[rule], [field]: x } }); };
  const setFee = (by) => (x) => { setNote(''); setV({ ...v, latefee: { ...v.latefee, amount: 0, percent: 0, [by]: x } }); };
  const pickFee = (by) => { if (by !== feeBy) { setFeeBy(by); setFee(by)(0); } };
  const num = (rule, field, label, max, unit = 'days', min = 0) => <Num value={v[rule][field]} onChange={put(rule, field)} min={min} max={max} unit={unit} label={label} />;
  const days = (rule, field, label, desc) => <Days value={v[rule][field]} onChange={put(rule, field)} label={label} desc={desc} />;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(''); setNote('');
    try { await api.put('/leasing/alerts/settings', v); setSaved(v); setNote('Saved.'); onSaved(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  // In pairs of a like height, since they sit two to a row on a wide screen.
  const cards = [
    ['overdue', 'Rent overdue', TriangleAlert, 'Rent that has gone past its due date.', [
      ['Notify when rent is this late', days('overdue', 'days', 'Days late')],
      ['After the last one, again every', num('overdue', 'every', 'Repeat every', 90, 'days', 1)],
    ]],
    ['ending', 'Lease ending', CalendarDays, 'A lease or a short stay is about to end.', [
      ['Notify this long before a lease ends', days('ending', 'lease', 'Leases', true)],
      ['Notify this long before a short stay ends', days('ending', 'short', 'Short stays', true)],
    ]],
    ['upcoming', 'Rent coming up', CalendarClock, 'A heads-up before rent falls due.', [['Notify this long before', num('upcoming', 'days', 'Days before rent is due', 60)]]],
    ['eid', 'ID expiring', CreditCard, 'A tenant’s ID is about to run out.', [['Notify this long before', num('eid', 'days', 'Days before the ID expires', 180)]]],
    ['due', 'Rent due today', Banknote, 'A notification on the day rent is due.', []],
    ['summary', 'Morning summary', BellRing, 'One line to the master each morning: what is due today and what is overdue.', []],
    ['contract', 'No contract on file', FileWarning, 'A confirmed booking still has no contract attached.', [['Notify after', num('contract', 'days', 'Days without a contract', 60)]]],
    ['latefee', 'Late fee', Coins, 'Added to the booking when rent is still not paid after the days of grace. Only rent falling due from the day you switch this on.', [
      ['Days of grace after the due date', num('latefee', 'days', 'Days of grace', 60)],
      ['Charge', (
        <div className="flex gap-1 rounded-full border border-stroke p-0.5 text-sm">
          {[['amount', 'Fixed amount'], ['percent', '% of the rent']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => pickFee(k)} aria-pressed={feeBy === k}
              className={`rounded-full px-3 py-1.5 ${feeBy === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </div>
      )],
      feeBy === 'percent'
        ? ['Percent of the late rent', <Num value={v.latefee.percent} onChange={setFee('percent')} min={0} max={100} unit="%" label="Late fee percent of the rent" />]
        : ['Fee', <Num value={v.latefee.amount} onChange={setFee('amount')} min={0} max={1000000} unit={currency()} label="Late fee amount" />],
    ]],
    ['tenant', 'Email the tenant automatically', Mail, 'On the due date and on the overdue days above, the reminder is emailed to the tenant by itself, in your wording. Tenants with no email get nothing; WhatsApp still needs a person to press send.', []],
    ['quiet', 'Quiet hours', Moon, 'No phone notification between these hours, in the time zone set under Region. What is held back goes when they end.', [
      ['From', num('quiet', 'from', 'Quiet from', 23, ':00')],
      ['Until', num('quiet', 'to', 'Quiet until', 23, ':00')],
    ]],
  ];
  return (
    <form onSubmit={save} className="space-y-3">
      <p className={HEAD}>Alert rules</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {cards.map(([k, label, Ico, about, fields]) => {
          const on = k === 'quiet' || v[k].on; // quiet hours are always kept
          return (
            <div key={k} className={CARD}>
              <div className="flex items-center gap-3">
                <span className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white shadow-lg transition ${TINT[k]} ${on ? '' : 'opacity-40 grayscale'}`}><Ico size={18} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="mt-0.5 text-xs text-mute">{about}</p>
                </div>
                {k !== 'quiet' && <Switch on={on} onChange={put(k, 'on')} label={label} />}
              </div>
              {fields.length > 0 && (
                <div className={`mt-4 space-y-3 border-t border-stroke/60 pt-4 transition ${on ? '' : 'pointer-events-none opacity-40'}`}>
                  {fields.map(([l, control]) => <Field key={l} label={l}>{control}</Field>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Kept in view while the cards scroll, so a change is never left unsaved out of sight. */}
      <div className="sticky bottom-3 z-10 mr-16 flex items-center gap-3 rounded-2xl border border-stroke bg-surface px-4 py-3 shadow-lg">
        <p className={`min-w-0 flex-1 text-sm ${error ? 'text-bad' : note ? 'text-ok' : 'text-mute'}`}>{error || note || (dirty ? 'You have changes that are not saved.' : 'Everything is saved.')}</p>
        <button disabled={busy || !dirty} className={PRIMARY}>{busy ? 'Saving…' : 'Save rules'}</button>
      </div>
    </form>
  );
}

/** The words of the reminder a tenant gets, set by the master. A person still presses send. */
function Wording({ start }) {
  const [v, setV] = useState(start);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setError(''); setNote('');
    try { setV(await api.put('/leasing/alerts/wording', v)); setNote('Saved.'); } catch (err) { setError(err.message); }
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <p className={HEAD}>Reminder to the tenant</p>
      <p className="text-xs text-mute">Used by “Remind tenant” on a booking’s payments. These are filled in for you: {'{tenant} {what} {amount} {due_date} {days_late} {unit} {building} {company}'}.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {[['due', 'Before or on the due date'], ['overdue', 'When it is overdue']].map(([k, l]) => (
          <label key={k} className={`${CARD} block`}>
            <span className="mb-2 block text-sm">{l}</span>
            <textarea value={v[k]} onChange={(e) => { setNote(''); setV({ ...v, [k]: e.target.value }); }} rows={4} className={`${FIELD} w-full resize-none`} />
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3">
        {error && <p className="mr-auto text-sm text-bad">{error}</p>}
        {note && <p className="mr-auto text-sm text-ok">{note}</p>}
        <button className={PRIMARY}>Save wording</button>
      </div>
    </form>
  );
}

export default function LeasingAlerts({ rule = '', onRule: setRule, onOpen }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(''); // 'rules' or 'wording' while one of the master's settings is open
  const load = () => api.get('/leasing/alerts').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (!d) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const count = (k) => d.alerts.filter((a) => a.rule === k).length;
  const shown = rule ? d.alerts.filter((a) => a.rule === rule) : d.alerts;
  // Only the kinds that have something in them get a filter, and none at all when there is just one.
  const kinds = Object.entries(RULE).map(([k, [l]]) => [k, l, count(k)]).filter(([k, , n]) => n || k === rule);

  // The rules and the wording are the master's settings, kept off the list itself.
  if (settings) return (
    <div className="space-y-6">
      <button onClick={() => { setSettings(''); load(); }} className="flex items-center gap-1 text-sm text-mute hover:text-txt"><ChevronLeft size={16} /> Back to alerts</button>
      {settings === 'rules' ? <Rules start={d.settings} onSaved={load} /> : <Wording start={d.wording} />}
    </div>
  );

  return (
    <div className="space-y-4">
      {(kinds.length > 1 || d.master) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {kinds.length > 1 && [['', 'All', d.alerts.length], ...kinds].map(([k, l, n]) => (
            <button key={k} onClick={() => setRule(k)} className={`rounded-full px-3 py-1 ${rule === k ? 'bg-p1/20 text-p1' : 'text-mute hover:bg-white/5 hover:text-txt'}`}>{l} <span className="opacity-60">{n}</span></button>
          ))}
          {d.master && (
            <div className="ml-auto flex items-center gap-1.5">
              {[['rules', 'Alert rules', SlidersHorizontal], ['wording', 'Reminder wording', MessageSquareText]].map(([k, l, Ico]) => (
                <button key={k} onClick={() => setSettings(k)} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-mute hover:bg-white/5 hover:text-txt"><Ico size={14} /> {l}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-stroke">
        {shown.length === 0 ? <p className="px-4 py-6 text-center text-sm text-mute">{d.alerts.length ? 'None of this kind.' : 'Nothing needs attention today.'}</p> : (
          <div className="divide-y divide-stroke/60">
            {shown.map((a) => {
              const Ico = RULE[a.rule][1];
              return (
                <button key={a.key} onClick={() => onOpen(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04]">
                  <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${LEVEL[a.level]}`}><Ico size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{a.title}</span>
                    <span className="block truncate text-xs text-mute">{a.detail}</span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-mute sm:block">{DOES[a.open]}</span>
                  <ChevronRight size={16} className="shrink-0 text-mute" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
