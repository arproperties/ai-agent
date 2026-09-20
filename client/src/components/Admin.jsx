import { useEffect, useState } from 'react';
import { Loader2, Star, UserPlus, Ban, ChevronLeft, ExternalLink, Eye } from 'lucide-react';
import { api } from '../lib/api';
import Avatar from './Avatar';
import Sheet from './Sheet';

// Master's people screen. Everything here is also enforced server-side in
// server/admin.js, behind requireMaster - this is the convenient way in, not the guard.

const MODES = [['chat', 'Chats with'], ['knowledge', 'Reads its shelf']];

function AddPerson({ onAdded, onCancel }) {
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setError(''); };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/admin/users', f);
      onAdded();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-2xl border border-stroke bg-white/[0.04] p-3.5">
      <input value={f.name} onChange={set('name')} placeholder="Their name" required className={field} />
      <input type="email" value={f.email} onChange={set('email')} placeholder="Their email" required className={field} />
      <input value={f.password} onChange={set('password')} placeholder="A starting password (8+ characters)" minLength={8} required className={field} />
      <p className="text-xs text-mute">You will need to pass this password on to them. They can change it from the sign-in screen.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="flex-1 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Adding…' : 'Add person'}
        </button>
        <button type="button" onClick={onCancel} className="glass rounded-full px-4 py-2 text-sm text-mute">Cancel</button>
      </div>
    </form>
  );
}

/**
 * One person's agents. The PUT replaces the whole set, so this edits a local copy of
 * it and sends the end state - which is also why it has to read the current set first.
 */
function PersonSheet({ person, agents, me, onClose, onChanged }) {
  const [rows, setRows] = useState(null); // { [agentId]: { mode, primary } }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('agents');

  useEffect(() => {
    api.get(`/admin/users/${person.id}/agents`)
      .then((as) => setRows(Object.fromEntries(as.map((a) => [a.agent_id, { mode: a.mode, primary: a.is_primary }]))))
      .catch((e) => { setError(e.message); setRows({}); });
  }, [person.id]);

  const toggle = (id) => setRows((r) => {
    const next = { ...r };
    if (next[id]) delete next[id]; else next[id] = { mode: 'chat', primary: false };
    return next;
  });
  const setMode = (id, mode) => setRows((r) => ({ ...r, [id]: { ...r[id], mode } }));
  // At most one primary, and only a chat agent can be one.
  const setPrimary = (id) => setRows((r) => Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, { ...v, primary: Number(k) === id && !v.primary }]),
  ));

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/admin/users/${person.id}/agents`, {
        agents: Object.entries(rows).map(([agentId, v]) => ({ agentId: Number(agentId), mode: v.mode, primary: v.primary })),
      });
      onChanged();
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const disable = async () => {
    const next = !person.disabled;
    const ask = next
      ? `Disable ${person.name}? They will be signed out everywhere and cannot sign back in. Their files and chats are kept.`
      : `Let ${person.name} sign in again?`;
    if (!confirm(ask)) return;
    try {
      await api.put(`/admin/users/${person.id}/disabled`, { disabled: next });
      onChanged();
      onClose();
    } catch (e) { setError(e.message); }
  };

  const chatCount = Object.values(rows || {}).filter((v) => v.mode === 'chat').length;
  // Assignments to agents the master does not own - every account still holds its own
  // copy of the starter agents from before agents became master-owned. The checkbox
  // list cannot show them, and saving replaces the whole set, so say so rather than
  // letting one press quietly empty someone's sidebar.
  const foreign = Object.keys(rows || {}).filter((id) => !agents.some((a) => a.id === Number(id))).length;

  return (
    <Sheet title={person.name} onClose={onClose} tab={tab} onTab={setTab}
      tabs={[['agents', 'Agents'], ['documents', 'Shelf'], ['conversations', 'Chats'], ['memory', 'Memory'], ['activity', 'Activity']]}
      icon={<span className="grid size-8 place-items-center rounded-full bg-white/10 text-sm font-medium">{person.name[0]?.toUpperCase()}</span>}>
      <div className="space-y-4">
        <p className="-mt-1 text-xs text-mute">{person.email}{person.disabled && ' · disabled'}</p>

        {tab === 'memory' && <Memories person={person} />}
        {tab === 'activity' && <Activity person={person} />}
        {(tab === 'documents' || tab === 'conversations') && <Browse person={person} kind={tab} />}

        {tab === 'agents' && (rows === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
          <>
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium tracking-[0.14em] text-mute">AGENTS</span>
              {agents.length === 0 && <p className="py-3 text-sm text-mute">You have no agents to give out yet.</p>}
              {agents.map((a) => {
                const on = !!rows[a.id];
                return (
                  <div key={a.id} className={`rounded-2xl border px-3 py-2.5 transition ${on ? 'border-p1/40 bg-p1/[0.07]' : 'border-stroke bg-white/[0.03]'}`}>
                    <div className="flex items-center gap-2.5">
                      <button onClick={() => toggle(a.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <Avatar icon={a.icon} color={a.color} size={30} className={on ? '' : 'opacity-40 grayscale'} />
                        <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                      </button>
                      {on && rows[a.id].mode === 'chat' && (
                        <button onClick={() => setPrimary(a.id)} aria-label="Make primary"
                          title={rows[a.id].primary ? 'Primary agent' : 'Make this their primary agent'}
                          className={rows[a.id].primary ? 'text-amber-300' : 'text-mute hover:text-txt'}>
                          <Star size={16} fill={rows[a.id].primary ? 'currentColor' : 'none'} />
                        </button>
                      )}
                      <input type="checkbox" checked={on} onChange={() => toggle(a.id)} aria-label={`Give ${a.name} to ${person.name}`}
                        className="size-4 shrink-0 accent-p1" />
                    </div>
                    {on && (
                      <select value={rows[a.id].mode} onChange={(e) => setMode(a.id, e.target.value)}
                        className="glass mt-2 w-full rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-p1/70">
                        {MODES.map(([v, l]) => <option key={v} value={v} className="bg-bg">{l}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-mute">
              <b className="font-medium text-txt/80">Chats with</b> puts the agent in their sidebar.{' '}
              <b className="font-medium text-txt/80">Reads its shelf</b> keeps the agent hidden but lets their other agents
              use what you have shared on it.
              {chatCount > 1 && ' The starred agent is the one their new chats open with.'}
            </p>

            {foreign > 0 && (
              <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
                {person.name} also has {foreign} agent{foreign === 1 ? '' : 's'} that you do not own, left over from before
                agents became yours to hand out. {foreign === 1 ? 'It is' : 'They are'} not listed above, and saving here
                will take {foreign === 1 ? 'it' : 'them'} away — their files stay, moving into their own library.
              </p>
            )}

            {error && <p className="text-sm text-bad">{error}</p>}

            <button onClick={save} disabled={busy}
              className="w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-60">
              {busy ? 'Saving…' : 'Save agents'}
            </button>

            {person.id !== me.id && (
              <button onClick={disable}
                className="flex w-full items-center justify-center gap-2 rounded-full border border-bad/40 py-2.5 text-sm text-bad hover:bg-bad/10">
                <Ban size={15} /> {person.disabled ? 'Re-enable this account' : 'Disable this account'}
              </button>
            )}
          </>
        ))}
      </div>
    </Sheet>
  );
}

const when = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const exactly = (ts) => (ts ? new Date(ts * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export const ACCESS_WORDS = {
  document: 'opened a file',
  file: 'opened a file',
  conversation: 'read a chat',
  memory: 'looked at the memory',
};

/** What the master has read about this person. The same rows they can see themselves. */
function Activity({ person }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/admin/users/${person.id}/access`).then(setRows).catch(() => setRows([])); }, [person.id]);
  if (rows === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (!rows.length) return <p className="py-6 text-center text-sm text-mute">You have not opened anything of theirs.</p>;
  return (
    <>
      <p className="text-xs text-mute">{person.name} can see this list too, on their own account.</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-sm">
            <Eye size={14} className="shrink-0 text-mute" />
            <span className="flex-1">You {ACCESS_WORDS[r.action] || r.action}</span>
            <span className="shrink-0 text-xs text-mute">{exactly(r.created_at)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Someone else's workspace, read-only. Master can see all of it (spec §2), but nothing
 * on this screen writes: it is for looking, and the person's own app remains the only
 * place it can be changed.
 */
function Browse({ person, kind }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);   // the expanded document or conversation
  const [error, setError] = useState('');
  const base = `/admin/users/${person.id}`;

  useEffect(() => {
    setRows(null); setOpen(null);
    api.get(`${base}/${kind}`).then(setRows).catch((e) => { setError(e.message); setRows([]); });
  }, [person.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const expand = async (id) => {
    if (open?.id === id) return setOpen(null);
    setOpen({ id, loading: true });
    try { setOpen({ id, ...(await api.get(`${base}/${kind}/${id}`)) }); }
    catch (e) { setOpen({ id, error: e.message }); }
  };

  if (error) return <p className="py-4 text-sm text-bad">{error}</p>;
  if (rows === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (!rows.length) return <p className="py-6 text-center text-sm text-mute">Nothing here.</p>;

  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const showing = open?.id === r.id;
        return (
          <li key={r.id} className="rounded-2xl border border-stroke bg-white/[0.03]">
            <button onClick={() => expand(r.id)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{r.title || r.name || 'Untitled'}</span>
                <span className="block truncate text-xs text-mute">
                  {kind === 'documents'
                    ? [r.folder, r.kind === 'note' && 'note', when(r.doc_date ? null : r.created_at)].filter(Boolean).join(' · ')
                    : when(r.updated_at)}
                </span>
              </span>
              <ChevronLeft size={15} className={`shrink-0 text-mute transition ${showing ? '-rotate-90' : 'rotate-180'}`} />
            </button>

            {showing && (
              <div className="space-y-2 border-t border-stroke/60 px-3 py-2.5 text-sm">
                {open.loading && <Loader2 size={15} className="animate-spin text-mute" />}
                {open.error && <p className="text-bad">{open.error}</p>}

                {kind === 'documents' && open.summary !== undefined && (
                  <>
                    {open.summary && <p className="leading-relaxed text-txt/85">{open.summary}</p>}
                    <p className="text-xs text-mute">{[open.name, open.mime, open.shared && 'shared'].filter(Boolean).join(' · ')}</p>
                    {open.openable && (
                      <a href={`/api${base}/documents/${open.id}/file`} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-p1 hover:underline">
                        <ExternalLink size={13} /> Open the file
                      </a>
                    )}
                  </>
                )}

                {kind === 'conversations' && open.messages && (
                  open.messages.length
                    ? open.messages.map((m) => (
                      <p key={m.id} className="leading-relaxed">
                        <span className="text-[11px] uppercase tracking-wide text-mute">{m.role === 'user' ? person.name : m.agent_name || 'Assistant'}</span>
                        <span className="mt-0.5 block whitespace-pre-wrap text-txt/85">{m.content}</span>
                      </p>
                    ))
                    : <p className="text-mute">No messages.</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Memories({ person }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/admin/users/${person.id}/memories`).then(setRows).catch(() => setRows([])); }, [person.id]);
  if (rows === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (!rows.length) return <p className="py-6 text-center text-sm text-mute">Nothing learned yet.</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((m) => <li key={m.id} className="rounded-xl bg-white/5 px-3 py-2 text-sm leading-relaxed">{m.text}</li>)}
    </ul>
  );
}

/**
 * The other side of the ledger: shown to the person who was looked at, not the one
 * looking. This is what makes the record an audit trail rather than a diary.
 */
export function MyActivitySheet({ onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/access').then(setRows).catch(() => setRows([])); }, []);
  return (
    <Sheet title="Who has looked at your workspace" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-white/10 text-mute"><Eye size={17} /></span>}>
      {rows === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <div className="space-y-3">
          <p className="text-sm text-mute">
            Whoever runs this workspace can open your files, chats and memory. Every time they do, it is listed here.
          </p>
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-sm">
                <Eye size={14} className="shrink-0 text-mute" />
                <span className="flex-1"><b className="font-medium">{r.actor_name || r.actor_email}</b> {ACCESS_WORDS[r.action] || r.action}</span>
                <span className="shrink-0 text-xs text-mute">{exactly(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

export default function AdminSheet({ agents, me, onClose }) {
  const [people, setPeople] = useState(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => api.get('/admin/users').then(setPeople);
  useEffect(() => { load(); }, []);

  const person = open && people?.find((p) => p.id === open);

  return (
    <>
      <Sheet title="People" onClose={onClose}
        icon={<span className="grid size-8 place-items-center rounded-full bg-emerald-400/20 text-emerald-300"><UserPlus size={17} /></span>}>
        <div className="space-y-3">
          {people === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
            <>
              <ul className="space-y-1.5">
                {people.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => setOpen(p.id)}
                      className="flex w-full items-center gap-3 rounded-2xl border border-stroke bg-white/[0.03] px-3 py-2.5 text-left transition hover:bg-white/[0.07]">
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-medium">{p.name[0]?.toUpperCase()}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm">{p.name}</span>
                          {p.role === 'master' && <span className="shrink-0 rounded-full bg-p1/25 px-2 py-0.5 text-[10px] text-p1">master</span>}
                          {p.disabled && <span className="shrink-0 rounded-full bg-bad/20 px-2 py-0.5 text-[10px] text-bad">disabled</span>}
                        </span>
                        <span className="block truncate text-xs text-mute">
                          {p.email} · {p.role === 'master' ? `${agents.length} own` : `${p.agents} agent${p.agents === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      <ChevronLeft size={16} className="shrink-0 rotate-180 text-mute" />
                    </button>
                  </li>
                ))}
              </ul>

              {adding
                ? <AddPerson onAdded={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
                : (
                  <button onClick={() => setAdding(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-p1/50 py-3 text-sm text-p1 hover:bg-p1/10">
                    <UserPlus size={16} /> Add a person
                  </button>
                )}
            </>
          )}
        </div>
      </Sheet>

      {person && <PersonSheet person={person} agents={agents} me={me} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}
