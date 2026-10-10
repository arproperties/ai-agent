import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ListChecks, Loader2, Plus, Pencil, Trash2, Sparkles, X, Play } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// Checklists: the points of one job, ticked each time it is done. A person writes a title
// and a description, Reem decides the points, and they change what they like before saving.
// Daily ones come back empty each morning; when-needed ones are started each time the job
// comes up. The master sees everyone's under Team, and ticks nothing there.
// The server is server/checklists.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const KINDS = [
  ['daily', 'Daily', 'Comes back empty every morning.'],
  ['ondemand', 'When needed', 'You start it each time the job comes up.'],
];
const date = (secs) => new Date(secs * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
const dayDate = (day) => new Date(`${day}T00:00:00`);
const runName = (r) => r.label || (r.day ? dayDate(r.day).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : date(r.started_at));

function Points({ items, readOnly, onTick }) {
  return (
    <ul className="space-y-0.5">
      {items.map((i, n) => (
        <li key={i.id ?? `t${i.item_id ?? n}`}>
          <button onClick={() => onTick?.(i)} disabled={readOnly}
            className="flex w-full items-start gap-3 rounded-xl px-1 py-1.5 text-left transition enabled:hover:bg-white/[0.04] disabled:cursor-default">
            <span className={`mt-0.5 grid size-[20px] shrink-0 place-items-center rounded-full border transition ${
              i.done_at ? 'border-ok/60 bg-ok/20 text-ok' : 'border-white/25 text-transparent'}`}>
              <Check size={13} strokeWidth={3} />
            </span>
            <span className={`text-[15px] leading-snug ${i.done_at ? 'text-mute line-through' : ''}`}>{i.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One go, opened: fetched on its own because the list only carries the counts. */
function RunView({ runId, readOnly, onChanged }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/checklists/runs/${runId}`).then(setRun).catch((e) => setError(e.message)); }, [runId]);

  const tick = async (i) => {
    try {
      setRun(await api.post(`/checklists/runs/${runId}/items/${i.id}`, { done: !i.done_at }));
      onChanged?.();
    } catch (e) { setError(e.message); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${runName(run)}" and its ticks?`)) return;
    try { await api.del(`/checklists/runs/${runId}`); onChanged?.(); } catch (e) { setError(e.message); }
  };

  if (error) return <p className="px-1 py-2 text-sm text-bad">{error}</p>;
  if (!run) return <Loader2 size={16} className="mx-auto my-3 animate-spin text-mute" />;
  return (
    <div className="rounded-xl bg-white/[0.03] p-2">
      <Points items={run.items} readOnly={readOnly} onTick={tick} />
      {!readOnly && (
        <button onClick={remove} className="mt-1 flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-mute hover:text-bad">
          <Trash2 size={13} /> Delete this one
        </button>
      )}
    </div>
  );
}

const Progress = ({ done, total }) => (
  <span className={`shrink-0 text-xs ${total > 0 && done === total ? 'text-ok' : 'text-mute'}`}>{done} of {total}</span>
);

function Card({ c, readOnly, onChanged, onEdit }) {
  const [open, setOpen] = useState(null); // the go that is opened, by id
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const daily = c.kind === 'daily';

  const guard = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // The day's go is only written on its first tick, so the first tick starts it.
  const tickToday = (i) => guard(async () => {
    let runId = c.today.id;
    let id = i.id;
    if (!runId) {
      const run = await api.post(`/checklists/${c.id}/start`, {});
      runId = run.id;
      id = run.items.find((x) => x.item_id === i.item_id)?.id;
    }
    await api.post(`/checklists/runs/${runId}/items/${id}`, { done: !i.done_at });
    await onChanged();
  });

  const start = (e) => {
    e.preventDefault();
    guard(async () => {
      const run = await api.post(`/checklists/${c.id}/start`, { label });
      setLabel('');
      await onChanged();
      setOpen(run.id);
    });
  };

  // Today is shown in full above, so a daily checklist's list of goes is the days before.
  const earlier = c.runs.filter((r) => r.id !== c.today?.id);

  return (
    <div className="space-y-2.5 rounded-2xl bg-white/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{c.title}</p>
          <p className="mt-0.5 text-[11px] text-mute">{daily ? 'Daily' : 'When needed'} · {c.items.length} points</p>
        </div>
        {daily && <Progress done={c.today.done} total={c.today.total} />}
        {!readOnly && (
          <button onClick={() => onEdit(c)} aria-label="Edit" title="Edit"
            className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
        )}
      </div>
      {c.description && <p className="line-clamp-2 whitespace-pre-wrap text-sm text-txt/70">{c.description}</p>}

      {daily && <Points items={c.today.items} readOnly={readOnly} onTick={tickToday} />}
      {daily && (
        <div className="flex gap-1.5 pt-0.5">
          {c.week.map((d, n) => {
            const full = d.total > 0 && d.done === d.total;
            const past = n < 6 && d.run_id;
            return (
              <button key={d.day} disabled={!past} onClick={() => setOpen(open === d.run_id ? null : d.run_id)}
                title={`${dayDate(d.day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}: ${d.done} of ${d.total}`}
                className={`grid size-[22px] place-items-center rounded-full text-[9px] font-medium disabled:cursor-default ${
                  full ? 'bg-ok/25 text-ok' : d.done ? 'bg-warn/25 text-warn' : n === 6 ? 'border border-dashed border-white/25 text-mute' : 'bg-white/[0.06] text-mute/60'} ${
                  open === d.run_id && past ? 'ring-1 ring-white/40' : ''}`}>
                {dayDate(d.day).toLocaleDateString([], { weekday: 'narrow' })}
              </button>
            );
          })}
        </div>
      )}

      {!daily && !readOnly && (
        <form onSubmit={start} className="flex items-center gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Name this one, e.g. Unit 304"
            className="min-w-0 flex-1 rounded-full border border-stroke bg-white/[0.04] px-3.5 py-2 text-sm outline-none focus:border-p1/60 placeholder:text-mute/70" />
          <button disabled={busy} className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            <Play size={14} /> Start
          </button>
        </form>
      )}

      {(daily ? earlier.filter((r) => r.id === open) : earlier).map((r) => (
        <div key={r.id} className="space-y-1.5">
          {!daily && (
            <button onClick={() => setOpen(open === r.id ? null : r.id)}
              className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition hover:bg-white/[0.04] ${open === r.id ? 'bg-white/[0.04]' : ''}`}>
              <span className="min-w-0 flex-1 truncate">{runName(r)}</span>
              {r.finished_at ? <span className="shrink-0 text-xs text-ok">Finished {date(r.finished_at)}</span> : <Progress done={r.done} total={r.total} />}
            </button>
          )}
          {open === r.id && (
            // A day that has passed is a record; only a when-needed go is still ticked here.
            <RunView runId={r.id} readOnly={readOnly || !!r.day} onChanged={onChanged} />
          )}
        </div>
      ))}
      {!daily && earlier.length === 0 && readOnly && <p className="text-sm text-mute">Not started yet.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

/** One point, in a box that grows with it: a long one is read whole, not cut off at the edge of a phone. */
function PointInput({ value, onChange, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  // A point is one line of text; Enter would only add a break the server strips again.
  return <textarea ref={ref} value={value} rows={1} onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))} {...rest} />;
}

function Editor({ start, onSaved, onCancel }) {
  const [title, setTitle] = useState(start?.title || '');
  const [description, setDescription] = useState(start?.description || '');
  const [kind, setKind] = useState(start?.kind || 'daily');
  const [items, setItems] = useState(start?.items || []);
  const [busy, setBusy] = useState(''); // 'draft' | 'save' | 'delete'
  const [error, setError] = useState('');

  const act = async (what, fn) => {
    if (busy) return;
    setBusy(what);
    setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const draft = () => {
    if (items.length && !confirm('Replace the points below with new ones from Reem?')) return;
    act('draft', async () => {
      const r = await api.post('/checklists/draft', { title, description });
      setItems(r.items.map((text) => ({ text })));
    });
  };
  const save = (e) => {
    e.preventDefault();
    act('save', async () => {
      const body = { title, description, kind, items };
      await (start ? api.put(`/checklists/${start.id}`, body) : api.post('/checklists', body));
      await onSaved();
    });
  };
  const remove = () => confirm(`Delete "${start.title}" and everything ticked on it?`)
    && act('delete', async () => { await api.del(`/checklists/${start.id}`); await onSaved(); });
  const setText = (n, text) => setItems((list) => list.map((i, k) => (k === n ? { ...i, text } : i)));

  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Title, e.g. Tenant move-out" className={FIELD} autoFocus={!start} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000}
        placeholder="Describe the job in a line or two. Reem works out the points from this."
        className={`${FIELD} resize-none leading-relaxed`} />
      <div className="grid grid-cols-2 gap-2">
        {KINDS.map(([k, name, hint]) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            className={`rounded-xl border px-3 py-2 text-left transition ${kind === k ? 'border-p1/60 bg-p1/15' : 'border-stroke bg-white/[0.04] text-mute hover:text-txt'}`}>
            <span className="block text-sm font-medium">{name}</span>
            <span className="block text-[11px] leading-snug text-mute">{hint}</span>
          </button>
        ))}
      </div>

      <button type="button" onClick={draft} disabled={!title.trim() || !!busy}
        className="flex w-full items-center justify-center gap-2 rounded-full border border-p1/50 bg-p1/10 py-2.5 text-sm font-medium transition hover:bg-p1/20 disabled:opacity-50">
        {busy === 'draft' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        {busy === 'draft' ? 'Reem is working out the points…' : items.length ? 'Ask Reem for new points' : 'Let Reem make the points'}
      </button>

      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((i, n) => (
            <li key={n} className="flex items-start gap-2">
              <span className="w-5 shrink-0 pt-2.5 text-right text-xs text-mute">{n + 1}</span>
              <PointInput value={i.text} onChange={(text) => setText(n, text)} maxLength={300}
                className="min-w-0 flex-1 resize-none rounded-xl border border-stroke bg-white/[0.04] px-3 py-2 text-sm leading-snug outline-none focus:border-p1/60" />
              <button type="button" onClick={() => setItems((list) => list.filter((_, k) => k !== n))} aria-label={`Remove point ${n + 1}`}
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><X size={15} /></button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setItems((list) => [...list, { text: '' }])}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-mute hover:text-txt"><Plus size={15} /> Add a point yourself</button>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {start && (
          <button type="button" onClick={remove} disabled={!!busy} aria-label="Delete" title="Delete"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50"><Trash2 size={16} /></button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={!!busy || !title.trim() || !items.some((i) => i.text.trim())}
          className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function Mine() {
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null); // an id, 'new', or null
  const load = useCallback(() => api.get('/checklists').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  const saved = async () => { setEditing(null); await load(); };

  if (rows === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <div className="space-y-2.5">
      {editing === 'new'
        ? <Editor onSaved={saved} onCancel={() => setEditing(null)} />
        : (
          <button onClick={() => setEditing('new')}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
            <Plus size={16} /> New checklist
          </button>
        )}
      {rows.length === 0 && editing !== 'new' && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><ListChecks size={34} strokeWidth={1.4} /></span>
          <div>
            <p className="text-lg font-light">No checklists yet</p>
            <p className="max-w-xs text-sm text-mute">Give a job a title and a line about it, and Reem works out the points to tick.</p>
          </div>
        </div>
      )}
      {rows.map((c) => (editing === c.id
        ? <Editor key={c.id} start={c} onSaved={saved} onCancel={() => setEditing(null)} />
        : <Card key={c.id} c={c} onChanged={load} onEdit={(x) => setEditing(x.id)} />))}
    </div>
  );
}

/** The master's side: everyone's checklists and how far along they are. Nothing is ticked here. */
function Team() {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/checklists/team').then(setPeople).catch((e) => { setError(e.message); setPeople([]); }); }, []);

  if (people === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-bad">{error}</p>}
      {people.length === 0 && !error && <p className="py-8 text-center text-sm text-mute">Nobody else has made a checklist yet.</p>}
      {people.map((p) => (
        <section key={p.id} className="space-y-2.5">
          <h2 className="px-1 text-sm font-medium">{p.name}</h2>
          {p.checklists.map((c) => <Card key={c.id} c={c} readOnly />)}
        </section>
      ))}
    </div>
  );
}

export default function ChecklistsPage({ me, onBack }) {
  const [tab, setTab] = useState('mine');
  const master = me.role === 'master';
  return (
    <Page title="Checklists" onBack={onBack}>
      {master && (
        <div className="mb-3 grid grid-cols-2 rounded-full bg-white/5 p-1 text-sm sm:max-w-xs">
          {[['mine', 'Mine'], ['team', 'Team']].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-full py-1.5 transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>{l}</button>
          ))}
        </div>
      )}
      {tab === 'team' && master ? <Team /> : <Mine />}
    </Page>
  );
}
