import { useCallback, useEffect, useState } from 'react';
import { Check, Repeat, Loader2, Plus, Pause, Play, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { toInput, fromInput } from './Todos';
import Sheet from './Sheet';

// Routines are the things that come back. Nothing here knows about todos, and nothing in
// Todos.jsx knows about routines — they only ever meet in the tab strip above them.

const UNITS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']];
const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** A moment in words, relative where that is clearer than a date. */
export function when(secs) {
  if (!secs) return null;
  const at = new Date(secs * 1000);
  const now = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = sameDay(at, now) ? 'today'
    : sameDay(at, tomorrow) ? 'tomorrow'
    : sameDay(at, yesterday) ? 'yesterday'
    : at.toLocaleDateString([], { day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return { day, time, label: `${day}, ${time}` };
}

// The last seven days, oldest first, each marked if a turn was done that day. Only shown
// for daily routines: a row of seven days says nothing useful about a monthly one.
function week(history) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      key: d.toDateString(),
      letter: d.toLocaleDateString([], { weekday: 'narrow' }),
      done: history.some((t) => sameDay(new Date(t * 1000), d)),
      today: i === 0,
    });
  }
  return days;
}

function useRoutines(onChanged) {
  const [rows, setRows] = useState(null);
  const load = useCallback(async () => {
    const r = await api.get('/routines');
    setRows(r);
    onChanged?.();
    return r;
  }, [onChanged]);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  return { rows, load };
}

// ---------- add ----------
function AddRoutine({ onAdded }) {
  const [text, setText] = useState('');
  const [unit, setUnit] = useState('day');
  const [every, setEvery] = useState(1);
  const [starts, setStarts] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.post('/routines', { text: body, unit, every, starts_at: fromInput(starts) });
      setText(''); setStarts(''); setEvery(1); setUnit('day'); setOpen(false); setError('');
      await onAdded();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-2xl border border-stroke bg-white/[0.04] p-3">
      <div className="flex items-center gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="What comes back?"
          onFocus={() => setOpen(true)}
          className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-mute/70" />
        <button type="submit" disabled={!text.trim() || busy} aria-label="Add"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white shadow-lg shadow-p1/25 transition active:scale-95 disabled:opacity-40 disabled:shadow-none">
          {busy ? <Loader2 size={17} className="animate-spin" /> : <Plus size={18} />}
        </button>
      </div>
      {open && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {UNITS.map(([u, label]) => (
              <button key={u} type="button" onClick={() => { setUnit(u); setEvery(1); }}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  unit === u && every === 1 ? 'border-p1/60 bg-p1/15 text-txt' : 'border-stroke bg-white/[0.04] text-mute hover:text-txt'}`}>
                {label}
              </button>
            ))}
            {/* The two rhythms people actually ask for that are not one-per-unit. */}
            <button type="button" onClick={() => { setUnit('week'); setEvery(2); }}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                unit === 'week' && every === 2 ? 'border-p1/60 bg-p1/15 text-txt' : 'border-stroke bg-white/[0.04] text-mute hover:text-txt'}`}>
              Fortnightly
            </button>
            <button type="button" onClick={() => { setUnit('month'); setEvery(3); }}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                unit === 'month' && every === 3 ? 'border-p1/60 bg-p1/15 text-txt' : 'border-stroke bg-white/[0.04] text-mute hover:text-txt'}`}>
              Quarterly
            </button>
          </div>
          <label className="block space-y-1">
            <span className="px-1 text-xs text-mute">First one — this sets the time of day, and the weekday for a weekly routine</span>
            <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)}
              className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60 [color-scheme:dark]" />
          </label>
        </div>
      )}
      {error && <p className="px-1 text-xs text-bad">{error}</p>}
    </form>
  );
}

// ---------- one line ----------
function Row({ r, onTick, onOpen }) {
  const due = r.due ? when(r.due_at) : null;
  const next = when(r.next_at);
  return (
    <li className={`group flex items-start gap-3 rounded-2xl px-2 py-2.5 transition hover:bg-white/[0.04] ${r.paused ? 'opacity-55' : ''}`}>
      <button onClick={() => onTick(r)} disabled={r.paused}
        aria-label={r.done_at ? `Undo ${r.text}` : `Mark ${r.text} done`}
        className={`mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full border transition disabled:cursor-default ${
          r.done_at ? 'border-ok/60 bg-ok/20 text-ok' : 'border-white/25 text-transparent hover:border-p1 hover:text-p1/60'}`}>
        <Check size={14} strokeWidth={3} />
      </button>
      <button onClick={() => onOpen(r)} className="min-w-0 flex-1 text-left">
        <span className="block text-[15px] leading-snug">{r.text}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1 text-mute"><Repeat size={11} /> {r.cadence}</span>
          <span className="text-mute/50">·</span>
          {r.paused ? <span className="text-mute">Paused</span>
            : due ? <span className="text-bad">Due {due.day === 'today' ? `today, ${due.time}` : due.label}</span>
            : r.done_at ? <span className="text-ok">Done {when(r.done_at).day} · next {next.label}</span>
            : <span className="text-mute">Next {next.label}</span>}
        </span>
        {/* Seven days only makes sense for something that happens every day. */}
        {r.unit === 'day' && r.every_n === 1 && !r.paused && (
          <span className="mt-1.5 flex gap-1">
            {week(r.history).map((d) => (
              <span key={d.key} title={d.key}
                className={`grid size-[15px] place-items-center rounded-full text-[8px] font-medium ${
                  d.done ? 'bg-ok/25 text-ok' : d.today ? 'border border-dashed border-white/25 text-mute' : 'bg-white/[0.06] text-mute/60'}`}>
                {d.letter}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}

const Group = ({ title, count, tone = 'text-mute', children }) => (
  <section className="space-y-0.5">
    <h2 className={`px-2 pb-1 pt-3 text-[11px] font-medium tracking-[0.14em] ${tone}`}>{title.toUpperCase()} · {count}</h2>
    <ul>{children}</ul>
  </section>
);

// ---------- edit ----------
function RoutineSheet({ r, onClose, onSaved }) {
  const [text, setText] = useState(r.text);
  const [notes, setNotes] = useState(r.notes || '');
  const [every, setEvery] = useState(r.every_n);
  const [unit, setUnit] = useState(r.unit);
  const [starts, setStarts] = useState(toInput(r.starts_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); await onSaved(); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const save = () => act(() => api.patch(`/routines/${r.id}`, { text, notes, every: Number(every) || 1, unit, starts_at: fromInput(starts) }));
  const pause = () => act(() => api.patch(`/routines/${r.id}`, { paused: !r.paused }));
  const remove = () => confirm(`Delete "${r.text}" and everything recorded about it?`) && act(() => api.del(`/routines/${r.id}`));

  return (
    <Sheet title="Routine" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Repeat size={16} /></span>}>
      <div className="space-y-4">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2.5 text-[15px] outline-none focus:border-p1/60" />
        <label className="block space-y-1.5">
          <span className="text-xs text-mute">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Anything worth keeping with it"
            className="w-full resize-none rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60 placeholder:text-mute/70" />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs text-mute">Comes round</span>
          <div className="flex items-center gap-2">
            <span className="text-sm text-mute">Every</span>
            <input type="number" min={1} max={366} value={every} onChange={(e) => setEvery(e.target.value)}
              className="w-16 rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60" />
            <select value={unit} onChange={(e) => setUnit(e.target.value)}
              className="flex-1 rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60">
              {UNITS.map(([u]) => <option key={u} value={u} className="bg-[#141128]">{u}{Number(every) > 1 ? 's' : ''}</option>)}
            </select>
          </div>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs text-mute">Counting from</span>
          <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)}
            className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60 [color-scheme:dark]" />
          <span className="block text-[11px] leading-snug text-mute">
            Every turn is worked out from this, so it fixes the time of day — and the weekday, or the day of the month.
            It shows on your list when it comes round; Jarvis can't reach you outside the app.
          </span>
        </label>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={remove} disabled={busy} aria-label="Delete"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50">
            <Trash2 size={16} />
          </button>
          {/* Pausing is the way to put a routine down without losing what it recorded. */}
          <button onClick={pause} disabled={busy}
            className="flex items-center gap-2 rounded-full border border-stroke px-4 py-2.5 text-sm text-mute transition hover:text-txt disabled:opacity-50">
            {r.paused ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}
          </button>
          <button onClick={save} disabled={busy || !text.trim()}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98] disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- the panel under the Routines tab ----------
export default function RoutinePanel({ onChanged, onDue }) {
  const { rows, load } = useRoutines(onChanged);
  const [editing, setEditing] = useState(null);

  useEffect(() => { if (rows) onDue?.(rows.filter((r) => r.due).length); }, [rows, onDue]);

  const tick = async (r) => {
    await api.post(`/routines/${r.id}/done`, { done: !r.done_at });
    await load();
  };

  const due = (rows || []).filter((r) => r.due);
  const live = (rows || []).filter((r) => !r.due && !r.paused);
  const paused = (rows || []).filter((r) => r.paused);
  const editingRow = editing && (rows || []).find((r) => r.id === editing);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-stroke/60 px-4 pb-4 md:px-8">
        <div className="mx-auto w-full max-w-3xl"><AddRoutine onAdded={load} /></div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto max-w-3xl pb-6">
          {rows?.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
              <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Repeat size={34} strokeWidth={1.4} /></span>
              <div>
                <p className="text-lg font-light">No routines yet</p>
                <p className="max-w-xs text-sm text-mute">
                  Things that come back — the tablets each morning, the VAT return each quarter. Unlike a todo, a routine is never finished.
                </p>
              </div>
            </div>
          ) : rows && (
            <>
              {due.length > 0 && <Group title="Due now" count={due.length} tone="text-bad">{due.map((r) => <Row key={r.id} r={r} onTick={tick} onOpen={(x) => setEditing(x.id)} />)}</Group>}
              {live.length > 0 && <Group title="Coming round" count={live.length}>{live.map((r) => <Row key={r.id} r={r} onTick={tick} onOpen={(x) => setEditing(x.id)} />)}</Group>}
              {paused.length > 0 && <Group title="Paused" count={paused.length}>{paused.map((r) => <Row key={r.id} r={r} onTick={tick} onOpen={(x) => setEditing(x.id)} />)}</Group>}
            </>
          )}
        </div>
      </div>
      {editingRow && <RoutineSheet r={editingRow} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
