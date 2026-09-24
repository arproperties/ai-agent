import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Check, Bell, BellOff, Trash2, ListTodo, Loader2, Plus } from 'lucide-react';
import { api } from '../lib/api';
import Sheet from './Sheet';
import Icon from './Icon';

// ---------- time ----------
// The picker works in the browser's own timezone, which is the user's, so converting to
// and from epoch seconds is plain Date arithmetic. The server stores the absolute moment,
// so nothing here depends on where the server happens to be running.
const pad = (n) => String(n).padStart(2, '0');

export const toInput = (secs) => {
  if (!secs) return '';
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromInput = (v) => (v ? Math.round(new Date(v).getTime() / 1000) : null);

const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** How a reminder reads, and whether its moment has arrived. null when there is no reminder. */
export function reminder(t) {
  if (!t?.remind_at) return null;
  const at = new Date(t.remind_at * 1000);
  const now = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(now.getDate() + 1);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = sameDay(at, now) ? 'Today'
    : sameDay(at, tomorrow) ? 'Tomorrow'
    : at.toLocaleDateString([], { day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  const due = at <= now;
  return { at, due, soon: at - now < 86400000, label: due ? `Due ${day}, ${time}` : `${day}, ${time}` };
}

// A relative day at a round hour, for the one-tap chips. "Tonight" after six in the
// evening would be a reminder in the past, so it rolls to the next one.
const roundTo = (days, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const CHIPS = [
  ['Tonight', () => (roundTo(0, 18) > new Date() ? roundTo(0, 18) : roundTo(1, 18))],
  ['Tomorrow', () => roundTo(1, 9)],
  ['Next week', () => roundTo(7, 9)],
];

// ---------- data ----------
function useTodos(onChanged) {
  const [open, setOpen] = useState(null); // null = not loaded yet, so "empty" never flashes
  const [done, setDone] = useState([]);

  const load = useCallback(async () => {
    const [o, d] = await Promise.all([api.get('/todos'), api.get('/todos?done=1')]);
    setOpen(o);
    setDone(d);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => { load().catch(() => setOpen([])); }, [load]);
  return { open, done, load };
}

// ---------- the reminder control, shared by the add box and the edit sheet ----------
function ReminderField({ value, onChange }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map(([label, when]) => (
          <button key={label} type="button" onClick={() => onChange(toInput(Math.round(when().getTime() / 1000)))}
            className="rounded-full border border-stroke bg-white/[0.04] px-3 py-1 text-xs text-mute transition hover:bg-white/10 hover:text-txt">
            {label}
          </button>
        ))}
        {value && (
          <button type="button" onClick={() => onChange('')} title="No reminder"
            className="flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-xs text-mute transition hover:text-bad">
            <BellOff size={13} /> Clear
          </button>
        )}
      </div>
      <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60 [color-scheme:dark]" />
    </div>
  );
}

// ---------- add ----------
function AddTodo({ onAdded }) {
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [showWhen, setShowWhen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.post('/todos', { text: body, remind_at: fromInput(when) });
      setText(''); setWhen(''); setShowWhen(false); setError('');
      await onAdded();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-2xl border border-stroke bg-white/[0.04] p-3">
      <div className="flex items-center gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="What needs doing?"
          className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-mute/70" />
        {/* The bell is the whole "optional" part: a todo without it is just a todo. */}
        <button type="button" onClick={() => setShowWhen((v) => !v)} aria-label={when ? 'Change the reminder' : 'Add a reminder'}
          title={when ? 'Change the reminder' : 'Add a reminder'}
          className={`grid size-9 shrink-0 place-items-center rounded-full transition ${when || showWhen ? 'bg-warn/20 text-warn' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
          <Bell size={17} />
        </button>
        <button type="submit" disabled={!text.trim() || busy} aria-label="Add"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white shadow-lg shadow-p1/25 transition active:scale-95 disabled:opacity-40 disabled:shadow-none">
          {busy ? <Loader2 size={17} className="animate-spin" /> : <Plus size={18} />}
        </button>
      </div>
      {showWhen && <ReminderField value={when} onChange={setWhen} />}
      {when && !showWhen && <p className="px-1 text-xs text-warn">Reminder: {reminder({ remind_at: fromInput(when) })?.label}</p>}
      {error && <p className="px-1 text-xs text-bad">{error}</p>}
    </form>
  );
}

// ---------- one line ----------
function Row({ t, onToggle, onOpen }) {
  const r = reminder(t);
  const tone = t.done ? 'text-mute' : r?.due ? 'text-bad' : r?.soon ? 'text-warn' : 'text-mute';
  return (
    <li className="group flex items-start gap-3 rounded-2xl px-2 py-2.5 transition hover:bg-white/[0.04]">
      <button onClick={() => onToggle(t)} aria-label={t.done ? `Re-open ${t.text}` : `Mark ${t.text} done`}
        className={`mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full border transition ${
          t.done ? 'border-ok/60 bg-ok/20 text-ok' : 'border-white/25 text-transparent hover:border-p1 hover:text-p1/60'}`}>
        <Check size={14} strokeWidth={3} />
      </button>
      <button onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
        <span className={`block text-[15px] leading-snug ${t.done ? 'text-mute line-through' : ''}`}>{t.text}</span>
        {t.notes && <span className="mt-0.5 block line-clamp-2 text-xs leading-snug text-mute">{t.notes}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
          {r && <span className={`flex items-center gap-1 ${tone}`}><Bell size={11} /> {r.label}</span>}
          {(t.doc_title || t.doc_name) && <span className="flex items-center gap-1 text-mute"><Icon name="file" size={11} /> {t.doc_title || t.doc_name}</span>}
          {t.agent_name && <span className="text-mute">from {t.agent_name}</span>}
        </span>
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

// ---------- edit / delete ----------
function TodoSheet({ t, onClose, onSaved }) {
  const [text, setText] = useState(t.text);
  const [notes, setNotes] = useState(t.notes || '');
  const [when, setWhen] = useState(toInput(t.remind_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); await onSaved(); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const save = () => act(() => api.patch(`/todos/${t.id}`, { text, notes, remind_at: fromInput(when) }));
  const remove = () => confirm('Delete this todo?') && act(() => api.del(`/todos/${t.id}`));

  return (
    <Sheet title="Todo" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><ListTodo size={16} /></span>}>
      <div className="space-y-4">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          className="w-full rounded-xl border border-stroke bg-white/[0.04] px-3 py-2.5 text-[15px] outline-none focus:border-p1/60" />
        <label className="block space-y-1.5">
          <span className="text-xs text-mute">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} placeholder="Anything worth keeping with it"
            className="w-full resize-none rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-p1/60 placeholder:text-mute/70" />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs text-mute">Remind me</span>
          <ReminderField value={when} onChange={setWhen} />
          {/* Said plainly here, where somebody is in the middle of setting one, rather than
              left to be discovered the first time a reminder does not arrive. */}
          <p className="text-[11px] leading-snug text-mute">When the time comes this moves to the top of your list and shows on the menu. Jarvis can't reach you outside the app.</p>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={remove} disabled={busy}
            className="flex items-center gap-2 rounded-full border border-stroke px-4 py-2.5 text-sm text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50">
            <Trash2 size={15} /> Delete
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

// ---------- the panel under the To-do tab ----------
// Only the list and its add box: the screen around it, and the tab strip that puts
// Routines next door, live in Lists.jsx. Nothing in this file knows routines exist.
export default function TodoPanel({ onChanged, onDue }) {
  const { open, done, load } = useTodos(onChanged);
  const [editing, setEditing] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const toggle = async (t) => {
    await api.patch(`/todos/${t.id}`, { done: !t.done });
    await load();
  };

  // The server already sorts by reminder, soonest first with the unreminded last, so
  // these three buckets only have to split that order — never re-sort it.
  const due = (open || []).filter((t) => reminder(t)?.due);
  const later = (open || []).filter((t) => reminder(t) && !reminder(t).due);
  const someday = (open || []).filter((t) => !t.remind_at);
  const editingRow = editing && [...(open || []), ...done].find((t) => t.id === editing);

  useEffect(() => { if (open) onDue?.(due.length); }, [open, due.length, onDue]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-stroke/60 px-4 pb-4 md:px-8">
        <div className="mx-auto w-full max-w-3xl"><AddTodo onAdded={load} /></div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto max-w-3xl pb-6">
          {open?.length === 0 && done.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
              <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><ListTodo size={36} strokeWidth={1.4} /></span>
              <div>
                <p className="text-lg font-light">Nothing on your list</p>
                <p className="max-w-xs text-sm text-mute">Add something above, or just tell an agent in chat — “remind me to renew the trade licence on 5 October”.</p>
              </div>
            </div>
          ) : open && (
            <>
              {due.length > 0 && <Group title="Due now" count={due.length} tone="text-bad">{due.map((t) => <Row key={t.id} t={t} onToggle={toggle} onOpen={(x) => setEditing(x.id)} />)}</Group>}
              {later.length > 0 && <Group title="Coming up" count={later.length} tone="text-warn">{later.map((t) => <Row key={t.id} t={t} onToggle={toggle} onOpen={(x) => setEditing(x.id)} />)}</Group>}
              {someday.length > 0 && <Group title="No reminder" count={someday.length}>{someday.map((t) => <Row key={t.id} t={t} onToggle={toggle} onOpen={(x) => setEditing(x.id)} />)}</Group>}
              {done.length > 0 && (
                <section className="pt-4">
                  <button onClick={() => setShowDone((v) => !v)} className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium tracking-[0.14em] text-mute transition hover:text-txt">
                    DONE · {done.length}
                    <Icon name="chevron" size={13} className={`transition ${showDone ? 'rotate-90' : ''}`} />
                  </button>
                  {showDone && <ul>{done.map((t) => <Row key={t.id} t={t} onToggle={toggle} onOpen={(x) => setEditing(x.id)} />)}</ul>}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {editingRow && <TodoSheet t={editingRow} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
