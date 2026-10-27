import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Timer, Download, Star } from 'lucide-react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';

// What sits beside a chat that is about a case (server/caseFocus.js): the case's files on the
// left, and on the right the timer that says how long the case took. On a phone neither fits
// beside the chat, so the same parts go in the case sheet instead.

const pad = (n) => String(n).padStart(2, '0');
/** 0:42:10 — the running session. */
export const clock = (s) => `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
/** 4:05 (minutes:seconds), or 1h04 past the hour — for the chip, where room is short. */
export const shortClock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}` : `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`);
/** 1h 15m — a total. */
export const span = (s) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
};

/**
 * The timer. It only runs while someone has started it: the chat's first message sent here,
 * or Start / Resume. It stops only on Pause, or when the chat is no longer open at all
 * (left, closed, asleep), and then comes back paused, so time away is never booked. The
 * server counts the time from 30-second beats, capped, so this page cannot inflate it.
 */
export function useCaseTimer(convId, primary) {
  const [running, setRunning] = useState(false);
  const [session, setSession] = useState(0); // seconds this sitting, for the big number
  const [totals, setTotals] = useState(null);
  const live = useRef({ on: false, beat: null, tick: null });

  useEffect(() => {
    if (convId && primary) api.get(`/case-focus/${convId}/time`).then(setTotals).catch(() => {});
  }, [convId, primary?.number]); // eslint-disable-line react-hooks/exhaustive-deps

  const beat = useCallback((start) => api.post(`/case-focus/${convId}/beat`, { start }).then(setTotals).catch(() => {}), [convId]);

  const start = useCallback(() => {
    if (live.current.on || !convId) return;
    live.current.on = true;
    setRunning(true);
    beat(true);
    live.current.beat = setInterval(() => beat(false), 30000);
    let last = Date.now();
    // A tab that was asleep jumps ahead by at most two minutes, as the server's count does.
    live.current.tick = setInterval(() => {
      const n = Date.now();
      const gone = Math.min(n - last, 120000) / 1000; // worked out here: the updater runs later, after `last` has moved on
      last = n;
      setSession((s) => s + gone);
    }, 1000);
  }, [convId, beat]);

  const stop = useCallback((final) => {
    if (!live.current.on) return;
    live.current.on = false;
    clearInterval(live.current.beat);
    clearInterval(live.current.tick);
    setRunning(false);
    final();
  }, []);

  const pause = useCallback(() => stop(() => beat(false)), [stop, beat]);

  // Leaving the chat or closing the page: one last beat, sent so it outlives the page.
  useEffect(() => {
    if (!convId) return undefined;
    const last = () => fetch(`/api/case-focus/${convId}/beat`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    const away = () => stop(last);
    window.addEventListener('pagehide', away);
    return () => { window.removeEventListener('pagehide', away); away(); };
  }, [convId, stop]);

  return { running, session: Math.floor(session), totals, start, pause };
}

/** The case's own files from the Shelf, the summary first. */
export function useCaseFiles(convId, primary, refresh) {
  const [files, setFiles] = useState(null);
  useEffect(() => {
    if (convId && primary) api.get(`/case-focus/${convId}/files`).then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [convId, primary?.number, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  return files;
}

// 24 Oct, or 24 Oct 2025 when it is not this year
/**
 * The case's legal dates, read by Reem from its files and emails (server/caseDeadlines.js).
 * The first look starts the reading, which takes a little while, so the page asks again until it is done.
 */
export function useCaseDeadlines(convId, primary, refresh) {
  const [state, setState] = useState(null);
  const timer = useRef();
  const load = useCallback((force) => {
    if (!convId || !primary) return;
    clearTimeout(timer.current);
    (force ? api.post(`/case-focus/${convId}/deadlines/scan`) : api.get(`/case-focus/${convId}/deadlines`))
      .then((s) => { setState(s); if (s.scanning) timer.current = setTimeout(() => load(false), 4000); })
      .catch(() => {});
  }, [convId, primary?.number]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(false); return () => clearTimeout(timer.current); }, [load, refresh]);
  return { ...state, checkAgain: () => load(true) };
}

const DAY_MS = 86400000;
const daysFrom = (today, due) => Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
const leftLabel = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? `in ${n} days` : n === -1 ? 'yesterday' : `${-n} days ago`);
const dueLabel = (due) => new Date(`${due}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function DeadlineRow({ d, today, onOpen }) {
  const [open, setOpen] = useState(false);
  const n = daysFrom(today, d.due);
  const tone = n < 0 ? 'text-mute' : n <= 7 ? 'text-bad' : n <= 30 ? 'text-warn' : 'text-txt';
  return (
    <li className={`rounded-lg border px-2.5 py-2 ${n >= 0 && n <= 7 ? 'border-bad/40 bg-bad/[0.07]' : 'border-stroke/60'}`}>
      <button onClick={() => setOpen((o) => !o)} className="block w-full text-left">
        <span className={`flex items-baseline justify-between gap-2 text-xs font-medium ${tone}`}>
          <span>{dueLabel(d.due)}</span><span className="shrink-0">{leftLabel(n)}</span>
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug">{d.what}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 border-t border-stroke/60 pt-1.5 text-[11px] text-mute">
          <p className="italic">“{d.quote}”</p>
          {d.basis && <p>Worked out: {d.basis}</p>}
          <p className="truncate" title={d.source_name}>From {d.source_name}</p>
          {d.doc_id && <button onClick={() => onOpen(d.doc_id)} className="text-p1 hover:underline">Open the source</button>}
        </div>
      )}
    </li>
  );
}

export function CaseDeadlines({ deadlines: s, onOpen }) {
  const [showPast, setShowPast] = useState(false);
  if (!s?.today) return <p className="text-xs text-mute">Loading…</p>;
  const list = s.deadlines || [];
  const coming = list.filter((d) => daysFrom(s.today, d.due) >= 0);
  const past = list.filter((d) => daysFrom(s.today, d.due) < 0).reverse(); // most recent first
  return (
    <div className="space-y-2">
      {s.scanning && <p className="text-xs text-p1">Reading the case files and emails…</p>}
      {!s.scanning && s.error && <p className="text-xs text-bad">{s.error}</p>}
      {!s.scanning && !list.length && !s.error && <p className="text-xs text-mute">No legal dates found in the case papers.</p>}
      {coming.length > 0 && <ul className="space-y-1.5">{coming.map((d) => <DeadlineRow key={d.id} d={d} today={s.today} onOpen={onOpen} />)}</ul>}
      {past.length > 0 && (
        <>
          <button onClick={() => setShowPast((v) => !v)} className="text-xs text-mute hover:text-txt">
            {showPast ? 'Hide' : 'Show'} {past.length} passed
          </button>
          {showPast && <ul className="space-y-1.5">{past.map((d) => <DeadlineRow key={d.id} d={d} today={s.today} onOpen={onOpen} />)}</ul>}
        </>
      )}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <p className="text-[10px] leading-tight text-mute">Found by Reem in the case papers. Check the source before relying on a date.</p>
        {!s.scanning && <button onClick={s.checkAgain} className="shrink-0 text-[11px] text-p1 hover:underline">Check again</button>}
      </div>
    </div>
  );
}

const when = (at) => {
  const d = new Date(at * 1000);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
};

export function CaseFiles({ files, number, onOpen, onOpenShelf }) {
  if (!files) return <p className="px-1 text-xs text-mute">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-mute">{files.length === 1 ? '1 file' : `${files.length} files`} · {number}</p>
      {files.length === 0 && <p className="px-1 text-sm text-mute">No files for this case on your Shelf yet.</p>}
      <div className="space-y-0.5">
        {files.map((f) => (
          <button key={f.id} onClick={() => onOpen(f.id)} title={f.title || f.name}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.07]">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-p1/15 text-p1">
              {f.summary ? <Star size={14} /> : <Icon name="file" size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{f.title || f.name}</span>
              <span className="block text-[11px] text-mute">{f.summary ? 'Case summary · ' : ''}{when(f.created_at)}</span>
            </span>
          </button>
        ))}
      </div>
      {onOpenShelf && <button onClick={onOpenShelf} className="px-1 text-xs text-p1 hover:underline">Open in Shelf</button>}
    </div>
  );
}

export function CaseTimer({ timer }) {
  const { running, session, totals, start, pause } = timer;
  const fresh = !session && !totals?.total;
  const top = Math.max(1, ...(totals?.days || []).map((d) => d.seconds));
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <Timer size={18} className={running ? 'text-p1' : 'text-mute'} />
          <b className="font-mono text-2xl font-light tabular-nums">{clock(session)}</b>
        </div>
        <p className="mt-0.5 text-xs text-mute">{running ? 'this session' : fresh ? 'not started' : 'Paused · send a message or press Resume'}</p>
        <button onClick={running ? pause : start}
          className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-full py-2 text-sm font-medium transition ${running
            ? 'border border-stroke hover:bg-white/10' : 'bg-gradient-to-r from-p1 to-p2 text-white hover:brightness-110'}`}>
          {running ? <><Pause size={15} /> Pause</> : <><Play size={15} /> {fresh ? 'Start' : 'Resume'}</>}
        </button>
      </div>
      {totals && (
        <>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-mute">Today</dt><dd className="tabular-nums">{span(totals.today)}</dd></div>
            <div className="flex justify-between"><dt className="text-mute">Last 7 days</dt><dd className="tabular-nums">{span(totals.week)}</dd></div>
            <div className="flex justify-between"><dt className="text-mute">All time</dt><dd className="tabular-nums">{span(totals.total)}</dd></div>
            {totals.chats > 1 && <p className="text-right text-[11px] text-mute">across {totals.chats} chats</p>}
          </dl>
          <div>
            <div className="flex h-12 items-end gap-1" aria-label="Time on this case, last 7 days">
              {totals.days.map((d) => (
                <span key={d.day} title={`${d.day}: ${span(d.seconds)}`} className="flex-1 rounded-t bg-p1/70"
                  style={{ height: `${Math.max(d.seconds ? 8 : 2, (d.seconds / top) * 100)}%`, opacity: d.seconds ? 1 : 0.25 }} />
              ))}
            </div>
            <p className="mt-1 text-[11px] text-mute">Last 7 days</p>
          </div>
        </>
      )}
      <p className="text-[11px] text-mute">Only you can see your time.</p>
    </div>
  );
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Time on cases: every case this person timed, in a date range, with a CSV for billing. */
export function CaseTimeSheet({ onClose }) {
  const [range, setRange] = useState({ from: '', to: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const q = range.from && range.to ? `?from=${range.from}&to=${range.to}` : '';
    api.get(`/case-focus/time${q}`).then((d) => { setData(d); setRange((r) => (r.from ? r : { from: d.from, to: d.to })); setError(''); })
      .catch((e) => setError(e.message));
  }, [range.from, range.to]);

  const download = () => {
    const rows = [['Case', `Time ${data.from} to ${data.to} (hours)`, 'All time (hours)', 'Chats', 'Last worked'],
      ...data.cases.map((c) => [c.case_number, (c.seconds / 3600).toFixed(2), (c.total / 3600).toFixed(2), c.chats, c.last_day])];
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `time-on-cases-${data.from}-to-${data.to}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Sheet title="Time on cases" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Timer size={16} /></span>}
      action={data?.cases.length > 0 && (
        <button onClick={download} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-xs hover:border-p1/60 hover:text-p1">
          <Download size={14} /> CSV
        </button>
      )}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input type="date" value={range.from} max={range.to || today()} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="rounded-lg border border-stroke bg-white/5 px-2 py-1.5" />
          <span className="text-mute">to</span>
          <input type="date" value={range.to} min={range.from} max={today()} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="rounded-lg border border-stroke bg-white/5 px-2 py-1.5" />
        </div>
        {error && <p className="text-bad">{error}</p>}
        {data && data.cases.length === 0 && <p className="text-mute">No time on any case yet. The timer starts in a chat about a case.</p>}
        {data?.cases.length > 0 && (
          <table className="w-full text-left">
            <thead className="text-xs text-mute">
              <tr><th className="py-1.5 font-normal">Case</th><th className="py-1.5 text-right font-normal">In range</th><th className="py-1.5 text-right font-normal">All time</th></tr>
            </thead>
            <tbody>
              {data.cases.map((c) => (
                <tr key={c.case_key} className="border-t border-stroke/60">
                  <td className="py-2">
                    <span className="block">{c.case_number}</span>
                    <span className="block text-[11px] text-mute">{c.chats === 1 ? '1 chat' : `${c.chats} chats`} · last {c.last_day}</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{span(c.seconds)}</td>
                  <td className="py-2 text-right tabular-nums text-mute">{span(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[11px] text-mute">Only you can see your time.</p>
      </div>
    </Sheet>
  );
}
