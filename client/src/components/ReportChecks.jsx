import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Copy, Check, X, RotateCw, FileText, History, Sparkles, Trash2, Settings as Gear, CalendarRange, Download, Radar, AlertTriangle, ArrowLeft, Play, Mail, Database, FileSignature, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import { createPortal } from 'react-dom';

// Settings → Autonomous Agents (server/reportChecks.js; the code still says report checks, the
// screen's first name). Not the chat agents: each of these works in the background on one kind of
// work report. Made from one sentence (NewAgent), which Reem turns into the settings below.
// Reem reads each work report as it comes
// in and lists what is missing against the report's own list. Built like Lease renewals: a
// few numbers, tabs with counts, and a card per day; tapping one slides up its gaps and the
// note, which the master copies into WhatsApp (nothing is sent from Reem). The list, days and
// due time sit behind the gear. Anyone else with the module only reads.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHOWN_DAYS = 30;
const CARDS_SHOWN = 8; // the newest; the rest behind "Show more"
const niceDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hour = (h) => `${String(h).padStart(2, '0')}:00`;
const workDays = (s) => (String(s) === '0123456' ? 'every day' : [...String(s)].map((d) => DAYS[d]).join(', '));
// When a report is expected, said in words. No days: it comes whenever there is one, and is never late.
const schedule = (t) => (t.work_days ? `expected ${workDays(t.work_days)}, due the next day by ${hour(t.due_hour)}` : 'whenever one comes, never late');
// A watcher (server/agentRuns.js): where it looks and when it runs.
const SOURCE_NAMES = { email: 'your email', saifsys: 'saifsys', leases: 'leases' };
const SOURCE_ICONS = { email: Mail, saifsys: Database, leases: FileSignature };
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const runs = (t) => (t.cadence === 'weekly' ? `every ${FULL_DAYS[t.run_weekday]} at ${hour(t.run_hour)}`
  : t.cadence === 'monthly' ? `on the 1st of each month at ${hour(t.run_hour)}` : `every day at ${hour(t.run_hour)}`);
const looksAt = (t) => (t.sources || []).map((x) => SOURCE_NAMES[x] || x).join(', ');
const when = (secs) => new Date(secs * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });
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
// A day below the type's daily target: { done, target, reason }, as the server says it.
function shortOf(target, check) {
  const raw = check?.facts?.units_done;
  const done = Number(raw);
  if (!target || raw === null || raw === undefined || !Number.isFinite(done) || done >= target) return null;
  const reason = String(check.facts.short_reason || '').trim();
  return { done, target, reason: /^not given$/i.test(reason) ? '' : reason };
}
function chipOf(d) {
  if (d.missing) return d.late ? ['No report', 'bad'] : ['Not due yet', 'mute'];
  const n = d.check.gaps.length;
  if (!n) return ['Complete', 'ok'];
  if (needsYou(d)) return [`${n} missing · note to send`, 'warn'];
  if (d.check.note_state === 'sent') return [`${n} missing · note sent`, 'p1'];
  return [`${n} missing`, 'warn'];
}

function CheckDetail({ check, master, onChanged, target }) {
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
      {target > 0 && check.facts?.units_done != null && (() => {
        const short = shortOf(target, check);
        return (
          <p className={`rounded-2xl border px-3.5 py-2.5 ${short ? 'border-bad/40 text-bad' : 'border-stroke text-ok'}`}>
            {check.facts.units_done} of {target} units done{short ? (short.reason ? `: ${short.reason}` : ': no reason given') : ''}
          </p>
        );
      })()}
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

// `initial`: what Reem set up from the master's sentence, for a new agent opened with Change.
function TypeForm({ type, initial, onSaved, onCancel, onDeleted }) {
  const from = type || initial;
  const [t, setT] = useState(() => ({
    name: from?.name || '', writer: from?.writer || '',
    items: from?.items?.length ? from.items : [''], due_hour: from?.due_hour ?? 12, work_days: from?.work_days ?? '123456', active: from?.active ?? true,
    daily_target: from?.daily_target ?? '',
  }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const set = (k, v) => setT((o) => ({ ...o, [k]: v }));
  const setItem = (i, v) => set('items', t.items.map((x, k) => (k === i ? v : x)));
  // A point is "Short label — what exactly": shown as the two parts, kept as one line.
  const partsOf = (item) => { const at = item.indexOf(' — '); return at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 3)]; };
  const setPart = (i, which, v) => { const [l, d] = partsOf(t.items[i]); const n = which === 0 ? [v, d] : [l, v]; setItem(i, n[1] ? `${n[0]} — ${n[1]}` : n[0]); };
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
      const body = { ...t, items: t.items.filter((i) => i.trim()), due_hour: Number(t.due_hour), daily_target: Number(t.daily_target) || 0, ...(!type && initial?.brief && { brief: initial.brief }) };
      onSaved(type ? await api.patch(`/report-checks/types/${type.id}`, body) : await api.post('/report-checks/types', body));
    } catch (err) { setError(err.message); }
    setBusy('');
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${type.name}" and every check of it?`)) return;
    try { await api.del(`/report-checks/types/${type.id}`); onDeleted(); } catch (e) { setError(e.message); }
  };

  return (
    <form onSubmit={save} className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-xs text-mute">Agent name</span>
          <input value={t.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Cleaning Agent" className={FIELD} /></label>
        <label className="block"><span className="mb-1 block text-xs text-mute">Watches (who sends the report)</span>
          <input value={t.writer} onChange={(e) => set('writer', e.target.value)} placeholder="e.g. Faisal" className={FIELD} /></label>
      </div>
            <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-xs text-mute">What it checks in each report</span>
          <button type="button" onClick={draft} disabled={!!busy || !t.name.trim()} className="flex items-center gap-1 text-xs text-p1 disabled:opacity-50">
            {busy === 'draft' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Let Reem write it
          </button>
        </div>
        <div className="space-y-1.5">
          {t.items.map((item, i) => {
            const [l, d] = partsOf(item);
            return (
              <div key={i} className="flex items-start gap-1.5 rounded-xl border border-stroke bg-white/[0.04] px-3 py-1.5">
                <Check size={14} className="mt-1.5 shrink-0 text-ok" />
                <div className="min-w-0 flex-1">
                  <input value={l} onChange={(e) => setPart(i, 0, e.target.value)} placeholder="Short name, e.g. Photos" className="w-full bg-transparent font-medium outline-none" />
                  <input value={d} onChange={(e) => setPart(i, 1, e.target.value)} placeholder="What exactly (optional)" className="w-full bg-transparent text-xs text-mute outline-none" />
                </div>
                <button type="button" aria-label="Remove" onClick={() => set('items', t.items.filter((_, k) => k !== i))}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={14} /></button>
              </div>
            );
          })}
          <button type="button" onClick={() => set('items', [...t.items, ''])} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> Add a point</button>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs text-mute">A report is expected on</span>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => set('work_days', t.work_days ? '' : '123456')}
            className={`rounded-full border px-3 py-1 text-xs ${!t.work_days ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute'}`}>Whenever one comes</button>
          {DAYS.map((d, i) => (
            <button type="button" key={d} onClick={() => flipDay(String(i))}
              className={`rounded-full border px-3 py-1 text-xs ${t.work_days.includes(String(i)) ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute'}`}>{d}</button>
          ))}
        </div>
      </div>
      {t.work_days && (
        <label className="flex items-center gap-2"><span className="text-xs text-mute">Each day&apos;s report is due the next day by</span>
          <input type="number" min={0} max={23} value={t.due_hour} onChange={(e) => set('due_hour', e.target.value)} className="glass w-16 rounded-xl px-2 py-1.5 text-center outline-none" />
          <span className="text-xs text-mute">:00</span></label>
      )}
      <label className="block"><span className="mb-1 block text-xs text-mute">Daily target <span className="opacity-70">(optional)</span></span>
        <span className="flex items-center gap-2">
          <input type="number" min={0} max={1000} value={t.daily_target} onChange={(e) => set('daily_target', e.target.value)} placeholder="e.g. 4" className="glass w-20 rounded-xl px-2 py-1.5 text-center outline-none" />
          <span className="text-xs text-mute">units a day</span>
        </span>
        <span className="mt-1 block text-xs text-mute">Reem buzzes when a report has fewer. Leave empty if there is no target.</span></label>
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



/** A watcher's settings: its sentence, where it looks and when it runs. */
function WatcherForm({ type, initial, onSaved, onCancel, onDeleted }) {
  const from = type || initial;
  const [t, setT] = useState(() => ({
    name: from?.name || '', brief: from?.brief || '', sources: from?.sources || [], cadence: from?.cadence || 'daily',
    run_hour: from?.run_hour ?? 8, run_weekday: from?.run_weekday ?? 0, active: from?.active ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setT((o) => ({ ...o, [k]: v }));
  const flip = (x) => set('sources', t.sources.includes(x) ? t.sources.filter((y) => y !== x) : [...t.sources, x]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { ...t, kind: 'watch', run_hour: Number(t.run_hour), run_weekday: Number(t.run_weekday) };
      onSaved(type ? await api.patch(`/report-checks/types/${type.id}`, body) : await api.post('/report-checks/types', body));
    } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${type.name}" and everything it found?`)) return;
    try { await api.del(`/report-checks/types/${type.id}`); onDeleted(); } catch (e) { setError(e.message); }
  };
  const chip = (on) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-p1/60 bg-p1/15' : 'border-stroke text-mute'}`;
  return (
    <form onSubmit={save} className="space-y-3 text-sm">
      <label className="block"><span className="mb-1 block text-xs text-mute">Name</span>
        <input value={t.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Unanswered tenant emails" className={FIELD} /></label>
      <label className="block"><span className="mb-1 block text-xs text-mute">What it does</span>
        <textarea value={t.brief} onChange={(e) => set('brief', e.target.value)} rows={4} className={`${FIELD} resize-y`} /></label>
      <div>
        <span className="mb-1 block text-xs text-mute">Where it looks (reading only)</span>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(SOURCE_NAMES).map(([k, n]) => <button type="button" key={k} onClick={() => flip(k)} className={chip(t.sources.includes(k))}>{n}</button>)}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs text-mute">When it runs</span>
        <div className="flex flex-wrap gap-1.5">
          {[['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month (the 1st)']].map(([k, n]) => (
            <button type="button" key={k} onClick={() => set('cadence', k)} className={chip(t.cadence === k)}>{n}</button>
          ))}
        </div>
        {t.cadence === 'weekly' && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => <button type="button" key={d} onClick={() => set('run_weekday', i)} className={chip(Number(t.run_weekday) === i)}>{d}</button>)}
          </div>
        )}
        <label className="mt-2 flex items-center gap-2"><span className="text-xs text-mute">At</span>
          <input type="number" min={0} max={23} value={t.run_hour} onChange={(e) => set('run_hour', e.target.value)} className="glass w-16 rounded-xl px-2 py-1.5 text-center outline-none" />
          <span className="text-xs text-mute">:00 Dubai time</span></label>
      </div>
      <button type="button" role="switch" aria-checked={t.active} onClick={() => set('active', !t.active)}
        className="flex w-full items-center gap-3 rounded-2xl border border-stroke px-4 py-2.5 text-left">
        <span className="flex-1">The agent runs and buzzes when it finds something</span>
        <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${t.active ? 'bg-p1' : 'bg-white/15'}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${t.active ? 'left-[22px]' : 'left-0.5'}`} />
        </span>
      </button>
      {error && <p className="text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Btn primary type="submit" busy={busy} disabled={busy}>Save</Btn>
        <Btn type="button" onClick={onCancel}>Cancel</Btn>
        {type && <button type="button" onClick={remove} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:text-bad"><Trash2 size={13} /> Delete</button>}
      </div>
    </form>
  );
}

/** A watcher's page: when it runs, Run now, and what each run found. */
function WatcherView({ type, master }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/report-checks/types/${type.id}/runs`).then(setData).catch((e) => setError(e.message)), [type.id]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => {
    if (!data?.running) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [data?.running, load]);
  const runNow = async () => {
    setError('');
    try { await api.post(`/report-checks/types/${type.id}/run`); await load(); } catch (e) { setError(e.message); }
  };
  const list = data?.runs || [];
  const found = list.filter((r) => !r.error && !r.nothing_new).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={list.length} text="runs" />
        <Stat value={found} text={`with something to tell you · $${(data?.cost ?? 0).toFixed(2)} this month`} tone={found ? 'text-warn' : 'text-txt'} />
        <div className="col-span-2 flex items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] p-4">
          <div className="min-w-0 flex-1 text-sm">
            <p className="flex flex-wrap items-center gap-1.5">{(type.sources || []).map((x) => { const I = SOURCE_ICONS[x] || Database; return <span key={x} className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs"><I size={12} />{SOURCE_NAMES[x] || x}</span>; })}</p>
            <p className="mt-1 text-xs text-mute">Runs {runs(type)}{list[0] ? ` · last ${when(list[0].ran_at)}` : ''}</p>
          </div>
          {master && <Btn primary busy={!!data?.running} onClick={runNow}><Play size={14} /> {data?.running ? 'Running…' : 'Run now'}</Btn>}
        </div>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!data ? <div className="grid place-items-center pt-10 text-mute"><Loader2 className="animate-spin" /></div>
        : !list.length ? <p className="pt-10 text-center text-sm text-mute">It has not run yet. It runs {runs(type)}{master ? ', or tap Run now' : ''}.</p> : (
          <ul className="grid items-start gap-3 lg:grid-cols-2">
            {list.map((r) => (
              <li key={r.id} className={`rounded-2xl border bg-white/[0.04] p-4 text-sm ${!r.error && !r.nothing_new ? 'border-warn/50' : 'border-stroke'}`}>
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 font-medium">{r.error ? 'The run failed' : r.headline || (r.nothing_new ? 'Nothing new' : 'Findings')}</p>
                  <Chip c={r.error ? ['Failed', 'bad'] : r.nothing_new ? ['Nothing new', 'mute'] : [`${r.findings.length} found`, 'warn']} />
                </div>
                <p className="mt-0.5 text-xs text-mute">{when(r.ran_at)}{r.tools_used ? ` · looked ${r.tools_used} times` : ''}</p>
                {r.error && <p className="mt-2 text-bad">{r.error}</p>}
                {r.findings.length > 0 && (
                  <ul className="mt-3 space-y-2 border-t border-stroke pt-3">
                    {r.findings.map((f, i) => (
                      <li key={i} className="flex gap-2">
                        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${f.level === 'high' ? 'bg-bad' : 'bg-warn'}`} />
                        <span><span className="font-medium">{f.title}</span>{f.detail && <span className="block text-mute">{f.detail}</span>}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

const EXAMPLES = [
  "Watch Umer's AC cleaning reports. He must do 4 units a day. Tell me when he does fewer or leaves things out.",
  'Every morning at 9, tell me which emails from tenants or staff have no reply after 24 hours.',
  'Every Sunday, list the leases ending in the next 60 days that have no renewal started.',
  "Check Faisal's daily cleaning reports: location, before and after photos, chemicals used.",
];

/** What an agent is and does, as a card: for a new one before Start, and for one being changed. */
function AgentCard({ plan, muted = false }) {
  return (
        <div className={`rounded-2xl border p-4 ${muted ? 'border-stroke bg-white/[0.04]' : 'border-p1/40 bg-p1/[0.06]'}`}>
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white"><Radar size={17} /></span>
            <div className="min-w-0">
              <p className="truncate text-base font-medium">{plan.name}</p>
              {plan.kind === 'watch' ? <p className="text-xs text-mute">Looks in {looksAt(plan)}</p> : plan.writer && <p className="text-xs text-mute">Watches {plan.writer}</p>}
            </div>
          </div>
          {plan.summary && <p className="mt-3">{plan.summary}</p>}
          {plan.kind !== 'watch' && <ul className="mt-3 space-y-1.5 border-t border-stroke pt-3">
            {plan.items.map((i) => (
              <li key={i} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-ok" />
                <span><span className="font-medium">{label(i)}</span>{i.includes(' — ') && <span className="text-mute"> {i.split(' — ').slice(1).join(' — ')}</span>}</span></li>
            ))}
          </ul>}
          <p className="mt-3 border-t border-stroke pt-3 text-xs text-mute">
            {plan.kind === 'watch' ? `Runs ${runs(plan)}. Reads only: it never sends or changes anything.`
              : <>{schedule(plan).replace(/^./, (c) => c.toUpperCase())}{plan.daily_target ? ` · target ${plan.daily_target} a day` : ''}</>}
          </p>
        </div>
  );
}

/**
 * A new Autonomous Agent from one sentence: Reem sets it up and shows it as a card to Start, or to
 * Change in the full form first.
 */
function NewAgent({ onMade, onCancel }) {
  const [brief, setBrief] = useState('');
  const [plan, setPlan] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const setup = async () => {
    setBusy('plan'); setError('');
    try { setPlan(await api.post('/report-checks/plan', { brief })); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const start = async () => {
    setBusy('start'); setError('');
    try { onMade(await api.post('/report-checks/types', { ...plan, daily_target: plan.daily_target || 0 })); } catch (e) { setError(e.message); setBusy(''); }
  };

  if (editing) return plan.kind === 'watch' ? <WatcherForm initial={plan} onSaved={onMade} onCancel={() => setEditing(false)} />
    : <TypeForm initial={plan} onSaved={onMade} onCancel={() => setEditing(false)} />;
  if (plan) {
    return (
      <div className="space-y-4 text-sm">
        <AgentCard plan={plan} />
        {plan.limits && <p className="flex items-start gap-2 rounded-2xl border border-warn/40 px-3.5 py-2.5 text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {plan.limits}</p>}
        {error && <p className="text-bad">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Btn primary busy={busy === 'start'} onClick={start}><Radar size={14} /> Start</Btn>
          <Btn onClick={() => setEditing(true)}>Change</Btn>
          <Btn onClick={() => setPlan(null)}><ArrowLeft size={14} /> Back</Btn>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <label className="block">
        <span className="mb-1.5 block text-base">What should this agent do?</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} autoFocus
          placeholder="Say it in your own words: whose reports to watch, what must be in them, and when to tell you."
          className={`${FIELD} resize-y`} />
      </label>
      <div>
        <p className="mb-1.5 text-xs text-mute">Or start from an example</p>
        <div className="space-y-1.5">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setBrief(e)} className="block w-full rounded-xl border border-stroke px-3 py-2 text-left text-xs text-mute transition hover:text-txt">{e}</button>
          ))}
        </div>
      </div>
      {error && <p className="text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Btn primary busy={busy === 'plan'} disabled={brief.trim().length < 8} onClick={setup}><Sparkles size={14} /> Set it up</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
      <p className="text-xs text-mute">An agent can watch the files that reach Reem (uploads, PDFs, WhatsApp photos shared into a chat), or look in your email, saifsys and the leases on a schedule. It only reads: it never messages anyone or changes anything by itself.</p>
    </div>
  );
}

/** What an agent does, in words, for one made before it had a sentence. */
const sentenceOf = (t) => t.brief || (t.kind === 'watch' ? '' :
  `Check ${t.writer ? `${t.writer}'s ` : ''}${t.name.replace(/\s*(daily\s+)?(report|agent)$/i, '')} reports: ${(t.items || []).map(label).join(', ')}.` +
  `${t.daily_target ? ` Target ${t.daily_target} units a day.` : ''} ${t.work_days ? `Expected ${workDays(t.work_days)}, due the next day by ${hour(t.due_hour)}.` : 'They come whenever there is one.'}`);
const asPlan = (t) => ({ ...t, summary: '', limits: '' });

/**
 * Changing an agent the way it was made: its sentence in the big box, the card of what it does now
 * under it, and Update with Reem to see the new card before Save. The full settings are behind
 * Fine-tune, for whoever wants them.
 */
function EditAgent({ type, onSaved, onDeleted, onCancel }) {
  const start = sentenceOf(type);
  const [brief, setBrief] = useState(start);
  const [plan, setPlan] = useState(null);
  const [fine, setFine] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const update = async () => {
    setBusy('plan'); setError('');
    try { setPlan(await api.post('/report-checks/plan', { brief, current: type })); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const save = async () => {
    setBusy('save'); setError('');
    try {
      const body = type.kind === 'watch'
        ? { kind: 'watch', name: plan.name, brief, sources: plan.sources, cadence: plan.cadence, run_hour: plan.run_hour, run_weekday: plan.run_weekday }
        : { name: plan.name, writer: plan.writer, items: plan.items, work_days: plan.work_days, due_hour: plan.due_hour, daily_target: plan.daily_target || 0, brief };
      onSaved(await api.patch(`/report-checks/types/${type.id}`, body));
    } catch (e) { setError(e.message); setBusy(''); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${type.name}" and everything it found?`)) return;
    try { await api.del(`/report-checks/types/${type.id}`); onDeleted(); } catch (e) { setError(e.message); }
  };

  if (fine) {
    return type.kind === 'watch'
      ? <WatcherForm type={type} onSaved={onSaved} onCancel={() => setFine(false)} onDeleted={onDeleted} />
      : <TypeForm type={type} onSaved={onSaved} onCancel={() => setFine(false)} onDeleted={onDeleted} />;
  }
  return (
    <div className="space-y-4 text-sm">
      <label className="block">
        <span className="mb-1.5 block text-base">What should this agent do?</span>
        <textarea value={brief} onChange={(e) => { setBrief(e.target.value); setPlan(null); }} rows={5}
          placeholder="Say it in your own words." className={`${FIELD} resize-y`} />
      </label>
      {plan ? (
        <>
          <p className="text-xs text-mute">After the change:</p>
          <AgentCard plan={plan} />
          {plan.limits && <p className="flex items-start gap-2 rounded-2xl border border-warn/40 px-3.5 py-2.5 text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {plan.limits}</p>}
        </>
      ) : (
        <>
          <p className="text-xs text-mute">What it does now:</p>
          <AgentCard plan={asPlan(type)} muted />
        </>
      )}
      {error && <p className="text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {plan ? <Btn primary busy={busy === 'save'} onClick={save}><Check size={14} /> Save</Btn>
          : <Btn primary busy={busy === 'plan'} disabled={brief.trim().length < 8 || brief.trim() === start.trim()} onClick={update}><Sparkles size={14} /> Update with Reem</Btn>}
        {plan && <Btn onClick={() => setPlan(null)}><ArrowLeft size={14} /> Back</Btn>}
        <Btn onClick={() => setFine(true)}>Fine-tune</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
        <button type="button" onClick={remove} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:text-bad"><Trash2 size={13} /> Delete</button>
      </div>
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
function DayCard({ d, onOpen, target }) {
  const gaps = d.check?.gaps || [];
  const short = shortOf(target, d.check);
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
            {short && <span className="w-fit rounded-full bg-bad/15 px-2 py-0.5 text-xs text-bad">{short.done} of {short.target} units</span>}
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

const shiftMonth = (m, n) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const CELL = {
  ok: 'bg-ok/15 text-ok border-ok/30', warn: 'bg-warn/15 text-warn border-warn/30', bad: 'bg-bad/15 text-bad border-bad/30',
  mute: 'bg-white/[0.04] text-mute border-stroke', none: 'border-transparent text-mute/40',
};

/** One month as a calendar, Monday first: each day coloured by its report; any month can be picked. */
function MonthCalendar({ month, months, onMonth, days, onOpen }) {
  const byDay = new Map(days.map((d) => [d.date, d]));
  const today = dubaiToday();
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const now = today.slice(0, 7);
  const oldest = months.length ? months[months.length - 1] : now;
  const short = (d) => {
    if (!d) return '';
    if (d.missing) return d.late ? 'none' : '';
    return d.check.gaps.length ? `${d.check.gaps.length} gaps` : '✓';
  };
  return (
    <div className="rounded-2xl border border-stroke bg-white/[0.04] p-4">
      <div className="flex items-center gap-2">
        <button onClick={() => onMonth(shiftMonth(month, -1))} disabled={month <= oldest} aria-label="Earlier month"
          className="grid size-9 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt disabled:opacity-30"><ChevronLeft size={16} /></button>
        <p className="flex-1 text-center text-base">{monthName(month)}</p>
        <button onClick={() => onMonth(shiftMonth(month, 1))} disabled={month >= now} aria-label="Later month"
          className="grid size-9 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt disabled:opacity-30"><ChevronRight size={16} /></button>
      </div>
      {months.length > 1 && (
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {months.map((mm) => (
            <button key={mm} onClick={() => onMonth(mm)}
              className={`rounded-full px-2.5 py-0.5 text-xs transition ${mm === month ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
              {monthName(mm).replace(` ${now.slice(0, 4)}`, '')}
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className="pb-1 text-center text-[11px] text-mute">{d}</span>)}
        {cells.map((day, i) => {
          if (!day) return <span key={i} />;
          const d = byDay.get(day);
          const t = day > today ? 'none' : d ? chipOf(d)[1] : 'none';
          return (
            <button key={day} disabled={!d?.check} onClick={() => onOpen(day)} title={d ? `${niceDay(day)} · ${chipOf(d)[0]}` : niceDay(day)}
              className={`flex min-h-[52px] flex-col items-start justify-between rounded-xl border p-1.5 text-left transition ${CELL[t]} ${day === today ? 'ring-2 ring-p1/60' : ''} ${d?.check ? 'hover:brightness-110' : 'cursor-default'}`}>
              <span className="text-xs font-medium tabular-nums">{Number(day.slice(8))}</span>
              <span className="w-full truncate text-[10px] leading-tight opacity-90">{short(d)}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-mute">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[4px] bg-ok/60" />Complete</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[4px] bg-warn/60" />Gaps</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[4px] bg-bad/60" />No report</span>
      </div>
    </div>
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
  <div className="flex items-baseline gap-2 rounded-2xl border border-stroke bg-white/[0.04] px-4 py-2.5">
    <span className={`text-xl font-light tabular-nums ${tone}`}>{value}</span>
    <span className="text-xs text-mute">{text}</span>
  </div>
);

export default function ReportChecks({ onBack, focus = null }) {
  const [data, setData] = useState(null);
  const [typeId, setTypeId] = useState(null);
  const [days, setDays] = useState(null);
  const [tab, setTab] = useState(null);
  const [more, setMore] = useState(false); // past the first few cards
  const [opened, setOpened] = useState(null); // a date
  const [month, setMonth] = useState(() => dubaiToday().slice(0, 7)); // YYYY-MM on the calendar
  const [months, setMonths] = useState([]);
  const [settings, setSettings] = useState(null); // 'new' | type id
  const [monthly, setMonthly] = useState(false);
  const [error, setError] = useState('');
  const [focusCheck, setFocusCheck] = useState(typeof focus === 'number' ? focus : null);

  const loadTypes = useCallback(async () => { const d = await api.get('/report-checks'); setData(d); return d; }, []);
  const loadDays = useCallback(async (id, m) => { if (id) setDays(await api.get(`/report-checks/types/${id}/days?month=${m}`)); }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await loadTypes();
        let pick = d.types[0]?.id ?? null;
        // A buzz about one report opens straight on it.
        if (typeof focus === 'number') pick = (await api.get(`/report-checks/checks/${focus}`).catch(() => null))?.type_id ?? pick;
        // A watcher's buzz opens on that agent: /?reportchecks=agent-7
        const agent = /^agent-(\d+)$/.exec(String(focus || ''));
        if (agent && d.types.some((t) => t.id === Number(agent[1]))) pick = Number(agent[1]);
        setTypeId(pick);
      } catch (e) { setError(e.message); }
    })();
  }, [focus, loadTypes]);
  useEffect(() => { setDays(null); setTab(null); setMore(false); loadDays(typeId, month).catch((e) => setError(e.message)); }, [typeId, month, loadDays]);
  useEffect(() => {
    if (!typeId) return;
    const now = dubaiToday().slice(0, 7);
    api.get(`/report-checks/types/${typeId}/months`).then((r) => setMonths([...new Set([now, ...r.months])].sort().reverse())).catch(() => setMonths([now]));
  }, [typeId]);

  const type = data?.types.find((t) => t.id === typeId);
  useEffect(() => {
    if (type?.backfill?.state !== 'running') return undefined;
    const t = setInterval(() => { loadTypes().catch(() => {}); loadDays(typeId, month).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [type?.backfill?.state, typeId, loadTypes, loadDays]);

  const list = (days?.days || []).filter((d) => d.date <= dubaiToday());
  const monthWord = monthName(month).split(' ')[0];
  const reports = list.filter((d) => d.check);
  const tabs = [
    ['you', 'Needs you', list.filter(needsYou)],
    ['gaps', 'Gaps', reports.filter((d) => d.check.gaps.length)],
    ['none', 'No report', list.filter((d) => d.missing && d.late)],
    ['ok', 'Complete', reports.filter((d) => !d.check.gaps.length)],
    ['all', 'All', list],
  ];
  // First look: what needs the boss, else everything.
  const current = tab || (tabs[0][2].length ? 'you' : tabs[1][2].length ? 'gaps' : 'all');
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

  const refresh = async () => { await Promise.all([loadTypes(), loadDays(typeId, month)]); };
  const master = !!data?.master;
  const openDay = opened && list.find((d) => d.date === opened);

  const head = (
    <div className="flex items-center gap-2">
      {type && type.kind !== 'watch' && <button onClick={() => setMonthly(true)} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt"><CalendarRange size={14} /><span className="hidden sm:inline">Monthly report</span></button>}
      {master && <>
      <button onClick={() => setSettings('new')} className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt"><Plus size={14} /><span className="hidden sm:inline">New agent</span></button>
      {type && (
        <button onClick={() => setSettings(type.id)} aria-label="Settings" title="The list, days and due time"
          className="grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt"><Gear size={16} /></button>
      )}
      </>}
    </div>
  );

  return (
    <Page title="Autonomous Agents" onBack={onBack} action={head}>
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
          {!data.types.length && <p className="pt-12 text-center text-sm text-mute">No agents yet.{master ? ' Tap New agent and say what it should do.' : ''}</p>}

          {type?.kind === 'watch' && (
            <>
              <p className="text-sm text-mute"><span className="text-txt">{type.name}</span> · {type.brief}{!type.active && ' · paused'}</p>
              <WatcherView key={type.id} type={type} master={master} />
            </>
          )}
          {type && type.kind !== 'watch' && (
            <p className="text-sm text-mute">
              <span className="text-txt">{type.name}</span>{type.writer ? ` · ${type.writer}` : ''}{type.daily_target ? ` · target ${type.daily_target} a day` : ''} · {schedule(type)}
              {!type.active && ' · paused'}
              {type.backfill?.state === 'running' && <span className="ml-2 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> going through past reports</span>}
            </p>
          )}

          {type && type.kind !== 'watch' && !days && <div className="grid place-items-center pt-10 text-mute"><Loader2 className="animate-spin" /></div>}
          {type && type.kind !== 'watch' && days && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={reports.length} text={`reports in ${monthWord}`} />
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
              <div className="space-y-4 lg:grid lg:grid-cols-[minmax(320px,400px)_1fr] lg:items-start lg:gap-5 lg:space-y-0">
              <div className="lg:sticky lg:top-0"><MonthCalendar month={month} months={months} onMonth={setMonth} days={list} onOpen={(date) => setOpened(date)} /></div>
              <div className="space-y-4">
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {tabs.map(([k, text, l]) => (
                  <button key={k} onClick={() => { setTab(k); setMore(false); }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${current === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                    {text}
                    <span className={`rounded-full px-1.5 text-xs ${k === 'you' && l.length ? 'bg-warn/20 text-warn' : 'bg-white/10'}`}>{l.length}</span>
                  </button>
                ))}
              </div>
              {(() => {
                // A day with no report has nothing to open: the dates are enough, in one line.
                const none = shown.filter((d) => d.missing);
                const cards = shown.filter((d) => !d.missing);
                const first = more ? cards : cards.slice(0, CARDS_SHOWN);
                if (!shown.length) return <p className="pt-10 text-center text-sm text-mute">Nothing here.</p>;
                return (
                  <div className="space-y-3">
                    {none.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-stroke bg-white/[0.04] px-4 py-2.5 text-xs">
                        <span className="mr-1 text-bad">No report on {none.length} day{none.length === 1 ? '' : 's'}:</span>
                        {[...none].reverse().map((d) => <span key={d.date} className={`rounded-full px-2 py-0.5 ${d.late ? 'bg-bad/15 text-bad' : 'bg-white/10 text-mute'}`}>{niceDay(d.date)}</span>)}
                      </div>
                    )}
                    {first.length > 0 && (
                      <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                        {first.map((d) => <DayCard key={d.date} d={d} target={type.daily_target} onOpen={() => setOpened(d.date)} />)}
                      </ul>
                    )}
                    {cards.length > CARDS_SHOWN && (
                      <button onClick={() => setMore(!more)} className="mx-auto block rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:text-txt">
                        {more ? 'Show fewer' : `Show ${cards.length - CARDS_SHOWN} more`}
                      </button>
                    )}
                  </div>
                );
              })()}
              </div>
              </div>
            </>
          )}
        </div>
      )}

      {openDay?.check && (
        <SidePanel title={niceDay(openDay.date)} icon={<Chip c={chipOf(openDay)} />} onClose={() => setOpened(null)}>
          <p className="-mt-1 mb-3 truncate text-xs text-mute">{openDay.check.title}</p>
          <CheckDetail check={openDay.check} master={master} onChanged={refresh} target={type?.daily_target} />
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
      {settings === 'new' && (
        <SidePanel title="New agent" icon={<Radar size={18} className="text-p1" />} onClose={() => setSettings(null)}>
          <NewAgent onCancel={() => setSettings(null)}
            onMade={async (t) => { setSettings(null); await loadTypes(); if (t?.id) setTypeId(t.id); await loadDays(t?.id || typeId, month); }} />
        </SidePanel>
      )}
      {settings && settings !== 'new' && (
        <SidePanel title={type?.name} icon={<Gear size={18} className="text-mute" />} onClose={() => setSettings(null)}>
          <div className="space-y-4">
            {type && <EditAgent key={type.id} type={type} onCancel={() => setSettings(null)}
              onSaved={async () => { setSettings(null); await loadTypes(); await loadDays(typeId, month); }}
              onDeleted={async () => { setSettings(null); const d = await loadTypes(); setTypeId(d.types[0]?.id ?? null); }} />}
            {settings !== 'new' && type && type.kind !== 'watch' && <div className="rounded-2xl border border-stroke p-4"><Backfill type={type} onStarted={refresh} /></div>}
          </div>
        </SidePanel>
      )}
    </Page>
  );
}
