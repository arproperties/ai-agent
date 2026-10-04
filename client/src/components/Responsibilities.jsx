import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// What each person is responsible for. The master writes them from the person's page
// under People (ResponsibilitiesEditor); everyone reads their own from the gear menu
// (the default export). The server is server/responsibilities.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

/** A text box that grows with what is written, so a long one is read without scrolling inside it. */
function Grow({ value, onChange, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} value={value} onChange={onChange} rows={5} {...rest} />;
}

function Form({ start, onSave, onCancel }) {
  const [title, setTitle] = useState(start?.title || '');
  const [body, setBody] = useState(start?.body || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onSave({ title, body }); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Title (optional), e.g. Rent collection"
        className={FIELD} />
      <Grow value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write anything: what they look after, how, how often, who to tell…"
        className={`${FIELD} min-h-[8rem] resize-none leading-relaxed`} autoFocus={!start} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function Item({ r, children }) {
  return (
    <div className="rounded-2xl bg-white/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {r.title && <p className="font-medium">{r.title}</p>}
          {r.body && <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${r.title ? 'mt-1 text-txt/85' : ''}`}>{r.body}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The master's side, as a tab on someone's page under People. */
export function ResponsibilitiesEditor({ person, isMe }) {
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null); // an id, 'new', or null
  const [error, setError] = useState('');

  const load = () => api.get(`/responsibilities/user/${person.id}`).then(setRows).catch((e) => { setError(e.message); setRows([]); });
  useEffect(() => { setRows(null); setEditing(null); load(); }, [person.id]);

  const add = async (v) => { await api.post(`/responsibilities/user/${person.id}`, v); setEditing(null); load(); };
  const save = (id) => async (v) => { await api.put(`/responsibilities/${id}`, v); setEditing(null); load(); };
  const remove = async (r) => {
    if (!confirm(`Delete "${r.title || r.body.slice(0, 40)}"?`)) return;
    try { await api.del(`/responsibilities/${r.id}`); load(); } catch (e) { setError(e.message); }
  };

  if (rows === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <div className="space-y-2.5">
      {error && <p className="text-sm text-bad">{error}</p>}
      {rows.length === 0 && editing !== 'new' && (
        <p className="py-3 text-sm text-mute">Nothing written down for {person.name} yet.</p>
      )}
      {rows.map((r) => (editing === r.id
        ? <Form key={r.id} start={r} onSave={save(r.id)} onCancel={() => setEditing(null)} />
        : (
          <Item key={r.id} r={r}>
            <button onClick={() => setEditing(r.id)} aria-label="Edit" title="Edit"
              className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
            <button onClick={() => remove(r)} aria-label="Delete" title="Delete"
              className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
          </Item>
        )))}
      {editing === 'new'
        ? <Form onSave={add} onCancel={() => setEditing(null)} />
        : (
          <button onClick={() => setEditing('new')}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
            <Plus size={16} /> Add a responsibility
          </button>
        )}
      <p className="text-xs leading-relaxed text-mute">
        {isMe ? 'These are yours.' : `${person.name} can read these from the menu, and their phone buzzes when you add or change one.`}
        {' '}Riley knows them too, so anyone can ask "who handles…?".
      </p>
    </div>
  );
}

/** Each person's own, read only. */
export default function ResponsibilitiesPage({ onBack }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/responsibilities/mine').then(setRows).catch(() => setRows([])); }, []);
  return (
    <Page title="My responsibilities" onBack={onBack}>
      {rows === null && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
      {rows?.length === 0 && <p className="py-8 text-center text-sm text-mute">Nothing has been given to you yet.</p>}
      <div className="space-y-2.5">{rows?.map((r) => <Item key={r.id} r={r} />)}</div>
    </Page>
  );
}
