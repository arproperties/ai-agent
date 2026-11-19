import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Copy, Check, X, RotateCw, FileText, History, Sparkles, Trash2, Settings as Gear, CalendarRange, Download } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import { createPortal } from 'react-dom';

// Settings → Report checks (server/reportChecks.js). Reem reads each work report as it comes
// in and lists what is missing against the report's own list. Built like Lease renewals: a
// few numbers, tabs with counts, and a card per day; tapping one slides up its gaps and the
// note, which the master copies into WhatsApp (nothing is sent from Reem). The list, days and
// due time sit behind the gear. Anyone else with the module only reads.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHOWN_DAYS = 30;
const niceDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hour = (h) => `${String(h).padStart(2, '0')}:00`;
const workDays = (s) => (String(s) === '0123456' ? 'every day' : [...String(s)].map((d) => DAYS[d]).join(', '));
// A list item is written "Short label — what exactly"; the cards show only the label.
const label = (item) => String(item).split(' — ')[0];
const dubaiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

// The same chips as Lease renewals.
const CHIP = { warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', bad: 'bg-bad/15 text-bad', ok: 'bg-ok/15 text-ok', mute: 'bg-white/10 text-mute' };
const Chip = ({ c: [text, tone] }) => <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${CHIP[tone]}`}>{text}</span>;

const Btn = ({ primary, busy, children, className = '', ...p }) => (
  <button {...p} disabled={busy || p.disabled}
    className={`${primary
      ? 'bg-gradient-to-br from-p1 to-p2 font-medium text-white shadow-lg shadow-p1/25'
      : 'border border-stroke text-mute hover:text-txt'} flex items-center gap-1.5 rounded-full px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-40 ${className}`}>
    {busy && <Loader2 size={14} className="animate-spin" />} {children}
  </button>
);

const needsYou = (d) => d.check?.note_state === 'waiting';
function chipOf(d) {
  if (d.missing) return d.late ? ['No report', 'bad'] : ['Not due yet', 'mute'];
  const n = d.check.gaps.length;
  if (!n) return ['Complete', 'ok'];
  if (needsYou(d)) return [`${n} missing · note to send`, 'warn'];
  if (d.check.note_state === 'sent') return [`${n} missing · note sent`, 'p1'];
  return [`${n} missing`, 'warn'];
}

function CheckDetail({ check, master, onChanged }) {
  const [note, setNote] = useState(check.note);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => setNote(check.note), [check.id, check.note]);

  const act = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); await onChanged(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  // Copying is the sending: the master pastes it into WhatsApp, so it is marked sent then.
  const copy = () => act('copy', async () => {
    try { await navigator.clipboard.writeText(note); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the text is on screen to copy by hand */ }
    await api.post(`/report-checks/checks/${check.id}/note`, { state: 'sent', note });
  });
  const dismiss = () => act('dismiss', () => api.post(`/report-checks/checks/${check.id}/note`, { state: 'dismissed', note }));
  const recheck = () => act('recheck', () => api.post(`/report-checks/checks/${check.id}/recheck`));
  const open = check.note_state === 'waiting';

  return (
    <div className="space-y-4 text-sm">
      {check.summary && <p className="text-mute">{check.summary}</p>}
      {check.gaps.length > 0 ? (
        <ul className="divide-y divide-stroke rounded-2xl border border-stroke">
          {check.gaps.map((g, i) => (
            <li key={i} className="flex gap-2.5 px-3.5 py-2.5"><X size={15} className="mt-0.5 shrink-0 text-warn" />
              <span><span className="font-medium">{label(g.item)}</span>{g.missing && <span className="block text-mute">{g.missing}</span>}</span></li>
          ))}
        </ul>
      ) : <p className="flex items-center gap-2 text-ok"><Check size={15} /> Everything on the list is there.</p>}

      {check.note && (
        <div>
          <p className="mb-1.5 text-xs text-mute">Message for the writer{check.note_state === 'sent' && ' · sent'}{check.note_state === 'dismissed' && ' · dismissed'}{check.note_state === 'replaced' && ' · a newer copy came in'}{check.note_state === 'past' && ' · from before Reem was watching'}</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} readOnly={!master || !open}
            rows={Math.min(16, note.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 70)), 0))}
            className={`${FIELD} resize-y text-sm`} />
        </div>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {master && check.note && <Btn primary busy={busy === 'copy'} onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />} Copy for WhatsApp</Btn>}
        {master && open && <Btn busy={busy === 'dismiss'} onClick={dismiss}>Dismiss</Btn>}
        {check.document_id && (
          <a href={`/api/documents/${check.document_id}/file`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt"><FileText size={14} /> Open the report</a>
        )}
        {master && check.document_id && <Btn busy={busy === 'recheck'} onClick={recheck} title="Read it again against the list as it is now"><RotateCw size={14} /> Check again</Btn>}
      </div>
    </div>
  );
}

function TypeForm({ type, onSaved, onCancel, onDeleted }) {
  const [t, setT] = useState(() => ({
    name: type?.name || '', writer: type?.writer || '',
    items: type?.items?.length ? type.items : [''], due_hour: type?.due_hour ?? 12, work_days: type?.work_days ?? '123456', active: type?.active ?? true,
  }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const set = (k, v) => setT((o) => ({ ...o, [k]: v }));
  const setItem = (i, v) => set('items', t.items.map((x, k) => (k === i ? v : x)));
  const flipDay = (d) => set('work_days', t.work_days.includes(d) ? t.work_days.replace(d, '') : [...t.work_days, d].sort().join(''));

  const draft = async () => {
    setBusy('draft'); setError('');
    try { set('items', (await api.post('/report-checks/draft-items', { name: t.name, about: t.writer ? `Written by ${t.writer}` : '' })).items); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy('save'); setError('');
    try {
      const body = { ...t, items: t.items.filter((i) => i.trim()), due_hour: Number(t.due_hour) };
      onSaved(type ? await api.patch(`/report-checks/types/${type.id}`, body) : await api.post('/report-checks/types', body));
    } catch (err) { setError(err.message); }
    setBusy('');
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${type.name}" and every check of it?`)) return;
    try { await api.del(`/report-checks/types/${type.id}`); onDeleted(); } catch (e) { setError(e.message); }
  };

  return (
    <form onSubmit={save} className="space-y-3 text-sm">
      <label className="block"><span className="mb-1 block text-xs text-mute">Report name</span>
        <input value={t.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Cleaning daily report" className={FIELD} /></label>
      <label className="block"><span className="mb-1 block text-xs text-mute">Who writes it</span>
        <input value={t.writer} onChange={(e) => set('writer', e.target.value)} placeholder="e.g. Faisal" className={FIELD} /></label>
            <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-xs text-mute">A complete report has</span>
          <button type="button" onClick={draft} disabled={!!busy || !t.name.trim()} className="flex items-center gap-1 text-xs text-p1 disabled:opacity-50">
            {busy === 'draft' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Let Reem write it
          </button>
        </div>
        <div className="space-y-1.5">
          {t.items.map((item, i) => (
            <div key={i} className="flex gap-1.5">
              <textarea value={item} onChange={(e) => setItem(i, e.target.value)} rows={Math.max(1, Math.ceil(item.length / 40))} className={`${FIELD} resize-none`} />
              <button type="button" aria-label="Remove" onClick={() => set('items', t.items.filter((_, k) => k !== i))}
                className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={15} /></button>
            </div>
          ))}
          <button type="button" onClick={() => set('items', [...t.items, ''])} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> Add a point</button>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs text-mute">A report is expected on</span>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <button type="button" key={d} onClick={() => flipDay(String(i))}
              className={`rounded-full border px-3 py-1 text-xs ${t.work_days.includes(String(i)) ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute'}`}>{d}</button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2"><span className="text-xs text-mute">Each day&apos;s report is due the next day by</span>
        <input type="number" min={0} max={23} value={t.due_hour} onChange={(e) => set('due_hour', e.target.value)} className="glass w-16 rounded-xl px-2 py-1.5 text-center outline-none" />
        <span className="text-xs text-mute">:00</span></label>
      <button type="button" role="switch" aria-checked={t.active} onClick={() => set('active', !t.active)}
        className="flex w-full items-center gap-3 rounded-2xl border border-stroke px-4 py-2.5 text-left">
        <span className="flex-1">Reem checks this report and buzzes about it</span>
        <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${t.active ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${t.active ? 'left-[22px]' : 'left-0.5'}`} />
        </span>
      </button>

      {error && <p className="text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Btn primary type="submit" busy={busy === 'save'} disabled={!!busy}>Save</Btn>
        <Btn type="button" onClick={onCancel}>Cancel</Btn>
        {type && <button type="button" onClick={remove} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:text-bad"><Trash2 size={13} /> Delete</button>}
      </div>
    </form>
  );
}

function Backfill({ type, onStarted }) {
  const [error, setError] = useState('');
  const b = type.backfill;
  const running = b?.state === 'running';
  const start = async () => {
    setError('');
    try { await api.post(`/report-checks/types/${type.id}/backfill`, { days: 30 }); onStarted(); } catch (e) { setError(e.message); }
  };
  return (
    <div className="text-xs text-mute">
      {running ? (
        <span className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" />
          Going through the last {b.days} days: {b.found ? `${b.checked} of ${b.found} reports checked` : `looking at ${b.files} files`}…</span>
      ) : (
        <button onClick={start} className="flex items-center gap-1.5 hover:text-txt"><History size={13} /> Check the reports of the last 30 days</button>
      )}
      {b?.state === 'done' && !running && <span className="mt-1 block">Last time: {b.checked} report{b.checked === 1 ? '' : 's'} found in {b.days} days.</span>}
      {b?.state === 'failed' && <span className="mt-1 block text-bad">That stopped: {b.error}</span>}
      {error && <span className="mt-1 block text-bad">{error}</span>}
    </div>
  );
}



/**
 * A panel that slides in from the right (full screen on a phone), for a day's report and for the
 * settings: the boss wanted these beside the page, not as a box over the middle of it.
 */
function SidePanel({ title, icon, onClose, children }) {
  const [shown, setShown] = useState(false);
  const closing = useRef(false);
  useEffect(() => { const f = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(f); }, []);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setShown(false);
    setTimeout(onClose, 220);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div onClick={close} className={`absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <aside className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-stroke bg-surface shadow-2xl shadow-black/40 transition-transform duration-200 ease-out sm:w-[560px] ${shown ? 'translate-x-0' : 'translate-x-full'}`}>
        <header className="flex items-center gap-2.5 border-b border-stroke px-5 pb-3 pt-safe">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 pt-3">{icon}<h2 className="truncate text-lg font-light">{title}</h2></div>
          <button onClick={close} aria-label="Close" className="mt-3 grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 pb-safe pt-4"><div className="pb-6">{children}</div></div>
      </aside>
    </div>,
    document.body,
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** The monthly progress reports of one type: a PDF per month, this one so far included. */
function Monthly({ type }) {
  const [months, setMonths] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/report-checks/types/${type.id}/months`).then((r) => setMonths(r.months)).catch((e) => setError(e.message)); }, [type.id]);
  const now = dubaiToday().slice(0, 7);
  const list = months ? [...new Set([now, ...months])].sort().reverse() : [];
  const url = (m, dl) => `/api/report-checks/types/${type.id}/monthly?month=${m}${dl ? '&download=1' : ''}`;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-mute">Each month in one PDF: how many reports came in, the days with none, what was missing most, the work and materials added up, and how it compares with the month before. The boss gets last month's on his phone on the 1st.</p>
      {error && <p className="text-bad">{error}</p>}
      {!months && !error && <Loader2 className="mx-auto animate-spin text-mute" />}
      <ul className="space-y-2">
        {list.map((m) => (
          <li key={m} className="flex items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] px-4 py-3">
            <span className="flex-1"><span className="font-medium">{monthName(m)}</span>{m === now && <span className="text-mute"> · so far</span>}</span>
            <a href={url(m)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25"><FileText size={14} /> Open</a>
            <a href={url(m, true)} aria-label="Download" title="Download" className="grid size-9 place-items-center rounded-full border border-stroke text-mute hover:text-txt"><Download size={15} /></a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-mute">Opening a month the first time takes a few seconds while Reem writes its summary.</p>
    </div>
  );
}

/** One day: its report's state, and what was missing at a glance. */
function DayCard({ d, onOpen }) {
  const gaps = d.check?.gaps || [];
  return (
    <li>
      <button onClick={onOpen} disabled={!d.check}
        className={`flex h-full w-full flex-col gap-2 rounded-2xl border bg-white/[0.04] p-4 text-left transition hover:bg-white/[0.07] disabled:cursor-default ${needsYou(d) ? 'border-warn/50' : 'border-stroke'}`}>
        <div className="flex w-full items-start gap-2">
          <p className="min-w-0 flex-1 font-medium">{niceDay(d.date)}</p>
          <Chip c={chipOf(d)} />
        </div>
        {d.check ? (
          <>
            {gaps.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {gaps.slice(0, 3).map((g) => <span key={g.item} className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-mute">{label(g.item)}</span>)}
                {gaps.length > 3 && <span className="rounded-full px-1 py-0.5 text-xs text-mute">+{gaps.length - 3}</span>}
              </div>
            )}
            {!gaps.length && d.check.summary && <p className="line-clamp-2 text-sm text-mute">{d.check.summary}</p>}
            <p className="mt-auto truncate border-t border-stroke pt-2 text-xs text-mute">{d.check.title}</p>
          </>
        ) : <p className="mt-auto border-t border-stroke pt-2 text-xs text-mute">{d.late ? 'Nothing came in for this day' : 'Due the next day'}</p>}
      </button>
    </li>
  );
}

/** The last 30 days as a strip of small squares: the month at a glance. */
function Strip({ days, onOpen }) {
  const byDay = new Map(days.map((d) => [d.date, d]));
  const cells = Array.from({ length: SHOWN_DAYS }, (_, i) => daysAgo(SHOWN_DAYS - 1 - i));
  const tone = { ok: 'bg-ok/70', warn: 'bg-warn/70', bad: 'bg-bad/70', mute: 'bg-white/15', p1: 'bg-p1/70' };
  return (
    <div className="rounded-2xl border border-stroke bg-white/[0.04] p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-mute">
        <span>Last 30 days</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-ok/70" />Complete</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-warn/70" />Gaps</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-bad/70" />No report</span>
        </span>
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${SHOWN_DAYS}, minmax(0, 1fr))` }}>
        {cells.map((day) => {
          const d = byDay.get(day);
          const t = d ? chipOf(d)[1] : null;
          return (
            <button key={day} title={`${niceDay(day)}${d ? ` · ${chipOf(d)[0]}` : ''}`} disabled={!d?.check} onClick={() => onOpen(d)}
              className={`h-7 rounded-[5px] transition ${t ? tone[t] : 'bg-white/[0.06]'} ${d?.check ? 'hover:brightness-125' : 'cursor-default'}`} />
          );
        })}
      </div>
    </div>
  );
}

const Stat = ({ value, text, tone = 'text-txt' }) => (
  <div className="rounded-2xl border border-stroke bg-white/[0.04] p-4">
    <p className={`text-2xl font-light tabular-nums ${tone}`}>{value}</p>
    <p className="text-xs text-mute">{text}</p>
  </div>
);

export default function ReportChecks({ onBack, focus = null }) {
  const [data, setData] = useState(null);
  const [typeId, setTypeId] = useState(null);
  const [days, setDays] = useState(null);
  const [tab, setTab] = useState(null);
  const [opened, setOpened] = useState(null); // a date
  const [settings, setSettings] = useState(null); // 'new' | type id
  const [monthly, setMonthly] = useState(false);
  const [error, setError] = useState('');
  const [focusCheck, setFocusCheck] = useState(typeof focus === 'number' ? focus : null);

  const loadTypes = useCallback(async () => { const d = await api.get('/report-checks'); setData(d); return d; }, []);
  const loadDays = useCallback(async (id) => { if (id) setDays(await api.get(`/report-checks/types/${id}/days?days=${SHOWN_DAYS}`)); }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await loadTypes();
        let pick = d.types[0]?.id ?? null;
        // A buzz about one report opens straight on it.
        if (typeof focus === 'number') pick = (await api.get(`/report-checks/checks/${focus}`).catch(() => null))?.type_id ?? pick;
        setTypeId(pick);
      } catch (e) { setError(e.message); }
    })();
  }, [focus, loadTypes]);
  useEffect(() => { setDays(null); setTab(null); loadDays(typeId).catch((e) => setError(e.message)); }, [typeId, loadDays]);

  const type = data?.types.find((t) => t.id === typeId);
  useEffect(() => {
    if (type?.backfill?.state !== 'running') return undefined;
    const t = setInterval(() => { loadTypes().catch(() => {}); loadDays(typeId).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [type?.backfill?.state, typeId, loadTypes, loadDays]);

  const list = (days?.days || []).filter((d) => d.date >= daysAgo(SHOWN_DAYS - 1) && d.date <= dubaiToday());
  const reports = list.filter((d) => d.check);
  const tabs = [
    ['you', 'Needs you', list.filter(needsYou)],
    ['gaps', 'Gaps', reports.filter((d) => d.check.gaps.length)],
    ['none', 'No report', list.filter((d) => d.missing && d.late)],
    ['ok', 'Complete', reports.filter((d) => !d.check.gaps.length)],
    ['all', 'All', list],
  ];
  // First look: what needs the boss, else everything.
  const current = tab || (tabs[0][2].length ? 'you' : 'all');
  const shown = (tabs.find((t) => t[0] === current) || tabs[4])[2];

  // A buzz about one report opens its sheet.
  useEffect(() => {
    if (!days || !focusCheck) return;
    const hit = list.find((d) => d.check?.id === focusCheck || d.earlier?.some((e) => e.id === focusCheck));
    if (hit) setOpened(hit.date);
    setFocusCheck(null);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = new Map();
  for (const d of reports) for (const g of d.check.gaps) count.set(label(g.item), (count.get(label(g.item)) || 0) + 1);
  const often = [...count].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const withGaps = tabs[1][2].length;

  const refresh = async () => { await Promise.all([loadTypes(), loadDays(typeId)]); };
  const master = !!data?.master;
  const openDay = opened && list.find((d) => d.date === opened);

  const head = (
    <div className="flex items-center gap-2">
      {type && <button onClick={() => setMonthly(true)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt"><CalendarRange size={14} /><span className="hidden sm:inline">Monthly report</span></button>}
      {master && <>
      <button onClick={() => setSettings('new')} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt"><Plus size={14} /><span className="hidden sm:inline">New report</span></button>
      {type && (
        <button onClick={() => setSettings(type.id)} aria-label="Settings" title="The list, days and due time"
          className="grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt"><Gear size={16} /></button>
      )}
      </>}
    </div>
  );

  return (
    <Page title="Report checks" onBack={onBack} action={head}>
      {error && <p className="pt-4 text-sm text-bad">{error}</p>}
      {!data ? <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div> : (
        <div className="space-y-4 pb-8">
          {data.types.length > 1 && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {data.types.map((t) => (
                <button key={t.id} onClick={() => setTypeId(t.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${t.id === typeId ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                  {t.name}{t.waiting > 0 && <span className="rounded-full bg-warn/20 px-1.5 text-xs text-warn">{t.waiting}</span>}
                </button>
              ))}
            </div>
          )}
          {!data.types.length && <p className="pt-12 text-center text-sm text-mute">No reports yet.{master ? ' Tap New report to add one.' : ''}</p>}

          {type && (
            <p className="text-sm text-mute">
              <span className="text-txt">{type.name}</span>{type.writer ? ` · ${type.writer}` : ''} · expected {workDays(type.work_days)}, due the next day by {hour(type.due_hour)}
              {!type.active && ' · paused'}
              {type.backfill?.state === 'running' && <span className="ml-2 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> going through past reports</span>}
            </p>
          )}

          {type && !days && <div className="grid place-items-center pt-10 text-mute"><Loader2 className="animate-spin" /></div>}
          {type && days && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={reports.length} text="reports in 30 days" />
                <Stat value={withGaps} text="with something missing" tone={withGaps ? 'text-warn' : 'text-ok'} />
                <Stat value={tabs[2][2].length} text="days with no report" tone={tabs[2][2].length ? 'text-bad' : 'text-txt'} />
                <Stat value={tabs[0][2].length} text="notes to send" tone={tabs[0][2].length ? 'text-p1' : 'text-txt'} />
              </div>
              {often.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="mr-1 text-xs text-mute">Missing most often</span>
                  {often.map(([item, n]) => (
                    <span key={item} className="rounded-full bg-warn/15 px-2.5 py-0.5 text-xs text-warn">{item} <span className="opacity-70">{n}/{reports.length}</span></span>
                  ))}
                </div>
              )}
              <Strip days={list} onOpen={(d) => d?.check && setOpened(d.date)} />
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {tabs.map(([k, text, l]) => (
                  <button key={k} onClick={() => setTab(k)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${current === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                    {text}
                    <span className={`rounded-full px-1.5 text-xs ${k === 'you' && l.length ? 'bg-warn/20 text-warn' : 'bg-white/10'}`}>{l.length}</span>
                  </button>
                ))}
              </div>
              {shown.length === 0 ? <p className="pt-10 text-center text-sm text-mute">Nothing here.</p> : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {shown.map((d) => <DayCard key={d.date} d={d} onOpen={() => setOpened(d.date)} />)}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {openDay?.check && (
        <SidePanel title={niceDay(openDay.date)} icon={<Chip c={chipOf(openDay)} />} onClose={() => setOpened(null)}>
          <p className="-mt-1 mb-3 truncate text-xs text-mute">{openDay.check.title}</p>
          <CheckDetail check={openDay.check} master={master} onChanged={refresh} />
          {openDay.earlier.length > 0 && (
            <div className="mt-4 border-t border-stroke pt-3 text-xs text-mute">
              <span className="flex items-center gap-1.5"><History size={13} /> Earlier copies of this day</span>
              {openDay.earlier.map((e) => (
                <a key={e.id} href={e.document_id ? `/api/documents/${e.document_id}/file` : undefined} target="_blank" rel="noreferrer" className="ml-5 mt-1 block truncate hover:text-txt">
                  {e.title} · {e.gaps.length ? `${e.gaps.length} missing` : 'complete'}
                </a>
              ))}
            </div>
          )}
        </SidePanel>
      )}
      {monthly && type && (
        <SidePanel title={`Monthly report · ${type.name}`} icon={<CalendarRange size={18} className="text-mute" />} onClose={() => setMonthly(false)}>
          <Monthly type={type} />
        </SidePanel>
      )}
      {settings && (
        <SidePanel title={settings === 'new' ? 'New report' : type?.name} icon={<Gear size={18} className="text-mute" />} onClose={() => setSettings(null)}>
          <div className="space-y-4">
            <TypeForm type={settings === 'new' ? null : type} onCancel={() => setSettings(null)}
              onSaved={async (t) => { setSettings(null); await loadTypes(); if (t?.id) setTypeId(t.id); await loadDays(t?.id || typeId); }}
              onDeleted={async () => { setSettings(null); const d = await loadTypes(); setTypeId(d.types[0]?.id ?? null); }} />
            {settings !== 'new' && type && <div className="rounded-2xl border border-stroke p-4"><Backfill type={type} onStarted={refresh} /></div>}
          </div>
        </SidePanel>
      )}
    </Page>
  );
}
