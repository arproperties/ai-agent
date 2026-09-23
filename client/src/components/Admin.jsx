import { useEffect, useState } from 'react';
import { Loader2, UserPlus, Ban, ChevronLeft, ExternalLink, Eye, Check, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import Avatar from './Avatar';
import Sheet from './Sheet';

/**
 * One agent, as a card in a grid. The same shape whether it is being picked as the
 * person's own agent or ticked as a shelf - only the corner mark differs, so the two
 * grids read as one screen rather than two unrelated controls.
 */
function AgentCard({ agent, on, label, onClick }) {
  return (
    <button onClick={onClick} aria-pressed={on} aria-label={label}
      className={`group relative flex items-center gap-3 overflow-hidden rounded-[1.25rem] border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 ${
        on
          ? 'border-p1/50 bg-gradient-to-r from-p1/20 via-p1/[0.07] to-transparent shadow-lg shadow-p1/20'
          : 'border-stroke bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.07]'}`}>
      {/* The chosen card gets the same aurora bloom the background has, so selection
          reads as light rather than as one more outline. */}
      {on && <span aria-hidden className="pointer-events-none absolute -left-6 top-1/2 size-24 -translate-y-1/2 rounded-full bg-p1/30 blur-2xl" />}

      <Avatar icon={agent.icon} color={agent.color} size={42}
        className={`relative transition duration-200 ${on ? 'ring-2 ring-white/25' : 'opacity-65 saturate-50 group-hover:opacity-90 group-hover:saturate-100'}`} />
      <span className={`relative min-w-0 flex-1 truncate text-sm font-medium transition ${on ? 'text-txt' : 'text-mute group-hover:text-txt/80'}`}>
        {agent.name}
      </span>

      <span className={`relative grid size-[18px] shrink-0 place-items-center rounded-full transition ${
        on ? 'bg-gradient-to-br from-p1 to-p2 text-white shadow-md shadow-p1/40' : 'border border-white/15 bg-white/[0.04] group-hover:border-white/30'}`}>
        {on && <Check size={11} strokeWidth={3.5} />}
      </span>
    </button>
  );
}

// Master's people screen. Everything here is also enforced server-side in
// server/admin.js, behind requireMaster - this is the convenient way in, not the guard.
//
// Assignments carry a mode, but this screen only ever writes 'chat'. The other mode,
// 'knowledge', hides the agent while still lending its shelf; nobody wanted the choice,
// and 'chat' is its superset - shelfIds() ignores mode entirely. The column and the
// server still honour both, so the picker can come back without a migration.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

function AddPerson({ onAdded, onCancel }) {
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setError(''); };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api.post('/admin/users', f);
      onAdded(created.id);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const field = FIELD;
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
 * The three things about an account that can go wrong after it was made: a misspelt
 * name, the wrong email, a password nobody remembers. Whatever is typed here replaces
 * what is there - except the password, which is left alone when the box stays empty,
 * so saving a name change never quietly locks somebody out.
 */
function EditPerson({ person, isMe, onSaved, onCancel }) {
  const [f, setF] = useState({ name: person.name, email: person.email, password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setError(''); };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/admin/users/${person.id}`, f);
      onSaved(f.password
        ? `Saved. ${f.name} signs in with the new password from now on, and is signed out everywhere${isMe ? ' except here' : ''}.`
        : 'Saved.');
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="mt-3 max-w-md space-y-2.5 rounded-2xl border border-stroke bg-white/[0.04] p-3.5">
      <label className="block space-y-1">
        <span className="text-[11px] font-medium tracking-[0.14em] text-mute">NAME</span>
        <input value={f.name} onChange={set('name')} required className={FIELD} />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] font-medium tracking-[0.14em] text-mute">EMAIL THEY SIGN IN WITH</span>
        <input type="email" value={f.email} onChange={set('email')} required className={FIELD} />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] font-medium tracking-[0.14em] text-mute">NEW PASSWORD</span>
        <input value={f.password} onChange={set('password')} placeholder="Leave empty to keep the current one"
          minLength={8} autoComplete="new-password" className={FIELD} />
      </label>
      <p className="text-xs leading-relaxed text-mute">
        {f.password
          ? `You will need to pass this password on to ${f.name}. They can change it again from the sign-in screen.`
          : 'Their password stays as it is unless you type a new one.'}
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="flex-1 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save details'}
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
function PersonDetail({ person, agents, me, onBack, onChanged }) {
  // One question, so one piece of state: which agent this person talks to. Every other
  // agent lends its shelf automatically - that is the rule, not a per-person choice, so
  // there is nothing else to ask. The 'knowledge' assignments that carry it are still
  // written on save; they are just derived rather than picked.
  const [chatId, setChatId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [demoted, setDemoted] = useState(0);
  // Assignments to agents the master does not own - every account still holds its own
  // copy of the starter agents from before agents became master-owned. The grid cannot
  // show them, and saving replaces the whole set, so say so rather than letting one
  // press quietly empty someone's sidebar.
  const [foreign, setForeign] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('agents');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    setLoaded(false);
    api.get(`/admin/users/${person.id}/agents`)
      .then((as) => {
        // One chat agent is the rule now, but accounts predating it hold several. Keep
        // the starred one (or the first) and say so before they save - the rest stay
        // reachable as shelves, so nothing anyone filed stops being findable.
        const chat = as.filter((a) => a.mode === 'chat');
        const pick = chat.find((a) => a.is_primary) ?? chat[0] ?? null;
        setChatId(pick?.agent_id ?? null);
        setDemoted(Math.max(0, chat.length - 1));
        setForeign(as.filter((a) => !agents.some((o) => o.id === a.agent_id)).length);
        setLoaded(true);
      })
      .catch((e) => { setError(e.message); setLoaded(true); });
  }, [person.id]);

  const chooseChat = (id) => {
    setChatId((cur) => (cur === id ? null : id));
    setDemoted(0);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/admin/users/${person.id}/agents`, {
        agents: chatId
          // Their agent, then every other agent as a shelf it may read.
          ? [{ agentId: chatId, mode: 'chat', primary: true },
             ...agents.filter((a) => a.id !== chatId).map((a) => ({ agentId: a.id, mode: 'knowledge', primary: false }))]
          : [],
      });
      setDemoted(0);
      onChanged();
      setBusy(false);
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
    } catch (e) { setError(e.message); }
  };

  const chatAgent = agents.find((a) => a.id === chatId);

  // No Activity tab: reading is still recorded, and each person still sees who looked
  // at their workspace from the eye in their own sidebar - the master just does not get
  // a screen for it here.
  const TABS = [['agents', 'Agents'], ['documents', 'Shelf'], ['conversations', 'Chats'], ['memory', 'Memory']];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Everything on this screen sits in one centred column. On a wide monitor the
          panel is over a thousand pixels across, and a row of controls stretched to
          that width reads as a stripe rather than as a card. */}
      <div className="border-b border-stroke/60 px-4 pb-3 pt-4 md:px-6">
        <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} aria-label="Back to everyone" className="-ml-2 grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt md:hidden">
            <ChevronLeft size={20} />
          </button>
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-white/10 text-base font-medium">{person.name[0]?.toUpperCase()}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-light leading-tight">{person.name}</p>
            <p className="truncate text-xs text-mute">{person.email}{person.disabled && ' · disabled'}</p>
          </div>
          {person.role === 'master' && <span className="shrink-0 rounded-full bg-p1/25 px-2.5 py-1 text-[11px] text-p1">master</span>}
          {!editing && (
            <button onClick={() => { setEditing(true); setNote(''); }} title="Change their name, email or password"
              aria-label={`Change ${person.name}'s name, email or password`}
              className="grid size-9 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
              <Pencil size={16} />
            </button>
          )}
        </div>

        {editing ? (
          <EditPerson key={person.id} person={person} isMe={person.id === me.id}
            onSaved={(msg) => { setEditing(false); setNote(msg); onChanged(); }}
            onCancel={() => setEditing(false)} />
        ) : (
          <>
            {note && <p className="mt-2.5 rounded-xl border border-ok/40 bg-ok/10 px-3 py-2 text-xs leading-relaxed text-ok">{note}</p>}
            <div className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1">
              {TABS.map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute hover:bg-white/5'}`}>{l}</button>
              ))}
            </div>
          </>
        )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe md:px-6">
        <div className="@container mx-auto w-full max-w-4xl space-y-4">

        {tab === 'memory' && <Memories person={person} />}
        {(tab === 'documents' || tab === 'conversations') && <Browse person={person} kind={tab} />}

        {tab === 'agents' && (!loaded ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
          <>
            {agents.length === 0 && <p className="py-3 text-sm text-mute">You have no agents to give out yet.</p>}

            {agents.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] font-medium tracking-[0.14em] text-mute">THEIR AGENT</span>
                  <span className="text-[11px] text-mute">pick one</span>
                </div>
                {/* Container queries, not screen ones: this panel sits beside a
                    sidebar and a people list, so on a tablet the window is wide while
                    the panel is not. Asking the window gave two columns there and cut
                    "Operations Manager" down to "Opera…". One card a row until the
                    panel itself has room for two, three once it is properly wide. */}
                <div className="grid grid-cols-1 gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3">
                  {agents.map((a) => (
                    <AgentCard key={a.id} agent={a} on={chatId === a.id} onClick={() => chooseChat(a.id)}
                      label={`Make ${a.name} the agent ${person.name} chats with`} />
                  ))}
                </div>
                <p className="pt-0.5 text-xs leading-relaxed text-mute">
                  {chatAgent ? (
                    <>
                      {person.name} chats with {chatAgent.name} — and only {chatAgent.name}.
                      {agents.length > 1 && ` When they ask something it does not know, it reads every other agent's shelf, so nothing you have filed is out of reach. The other agents stay hidden; ${person.name} never sees them.`}
                      {' '}Tap {chatAgent.name} again to leave them with no agent.
                    </>
                  ) : `${person.name} has no agent yet, so they cannot start a conversation.`}
                </p>
              </div>
            )}

            {demoted > 0 && (
              <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
                {person.name} used to chat with {demoted + 1} agents. A person has one now, so
                {chatAgent ? ` ${chatAgent.name} is selected` : ' none is selected'} and the other {demoted === 1 ? 'one leaves' : `${demoted} leave`} their
                sidebar when you save. Nothing is lost — {demoted === 1 ? 'its shelf is' : 'their shelves are'} still read in the background.
              </p>
            )}

            {foreign > 0 && (
              <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
                {person.name} also has {foreign} agent{foreign === 1 ? '' : 's'} that you do not own, left over from before
                agents became yours to hand out. {foreign === 1 ? 'It is' : 'They are'} not listed above, and saving here
                will take {foreign === 1 ? 'it' : 'them'} away — their files stay, moving into their own library.
              </p>
            )}

            {error && <p className="text-sm text-bad">{error}</p>}

            {/* Column-reverse on a phone puts Save under the thumb and the account
                switch below it; from a tablet up they become a footer row, the quiet
                action on the left and the one they came for on the right. */}
            <div className="flex flex-col-reverse gap-2 pt-1 @md:flex-row @md:items-center @md:justify-between">
              {person.id !== me.id ? (
                <button onClick={disable}
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-bad/40 py-2.5 text-sm text-bad hover:bg-bad/10 @md:w-auto @md:px-5">
                  <Ban size={15} /> {person.disabled ? 'Re-enable this account' : 'Disable this account'}
                </button>
              ) : <span className="hidden @md:block" />}

              <button onClick={save} disabled={busy}
                className="w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/20 transition active:scale-[0.99] disabled:opacity-60 @md:w-auto @md:px-8">
                {busy ? 'Saving…' : 'Save agents'}
              </button>
            </div>
          </>
        ))}
        </div>
      </div>
    </div>
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

/**
 * Master's people screen. A full-screen panel like the Shelf rather than a dialog: it
 * holds somebody's whole workspace - their files, chats, memory and the record of what
 * has been read - and that is more than a modal should carry. On a wide screen the
 * list stays beside the person so moving between people does not mean closing anything;
 * on a phone the list hands over to the detail and a back arrow returns.
 */
export default function AdminPage({ agents, me, onBack }) {
  const [people, setPeople] = useState(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => api.get('/admin/users').then(setPeople);
  useEffect(() => { load(); }, []);

  const person = open && people?.find((p) => p.id === open);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg/95 backdrop-blur-xl">
      <header className="flex items-center gap-2 border-b border-stroke/60 px-4 py-3 pt-safe md:px-6">
        <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
          <ChevronLeft size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-light leading-tight">People</h1>
          <p className="text-xs text-mute">{people ? `${people.length} with an account` : 'Loading…'}</p>
        </div>
        <button onClick={() => { setAdding(true); setOpen(null); }}
          className="flex items-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-95">
          <UserPlus size={16} /> Add
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className={`min-h-0 w-full shrink-0 overflow-y-auto border-stroke/60 p-3 md:block md:w-64 md:border-r xl:w-80 ${person || adding ? 'hidden' : 'block'}`}>
          {people === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
            <ul className="space-y-1.5">
              {people.map((p) => {
                const active = p.id === open;
                return (
                  <li key={p.id}>
                    <button onClick={() => { setOpen(p.id); setAdding(false); }}
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition ${active ? 'border-p1/60 bg-p1/10' : 'border-stroke bg-white/[0.03] hover:bg-white/[0.07]'}`}>
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-medium">{p.name[0]?.toUpperCase()}</span>
                      {/* The name and nothing else. The agent count used to sit under
                          it, but it is the same number for everybody and says nothing
                          about the person; it is on their screen if it is ever wanted. */}
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate text-sm">{p.name}</span>
                        {p.role === 'master' && <span className="shrink-0 rounded-full bg-p1/25 px-2 py-0.5 text-[10px] text-p1">master</span>}
                        {p.disabled && <span className="shrink-0 rounded-full bg-bad/20 px-2 py-0.5 text-[10px] text-bad">disabled</span>}
                      </span>
                      <ChevronLeft size={15} className="shrink-0 rotate-180 text-mute md:hidden" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className={`min-h-0 min-w-0 flex-1 flex-col ${person || adding ? 'flex' : 'hidden md:flex'}`}>
          {adding ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              <div className="mx-auto max-w-md space-y-3">
                <h2 className="text-lg font-light">Add a person</h2>
                <AddPerson onAdded={(id) => { setAdding(false); load().then(() => setOpen(id ?? null)); }} onCancel={() => setAdding(false)} />
              </div>
            </div>
          ) : person ? (
            <PersonDetail key={person.id} person={person} agents={agents} me={me} onBack={() => setOpen(null)} onChanged={load} />
          ) : (
            <div className="hidden flex-1 flex-col items-center justify-center gap-2 px-8 text-center md:flex">
              <span className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-emerald-400/25 to-p1/10 text-emerald-300"><UserPlus size={28} strokeWidth={1.4} /></span>
              <p className="text-sm text-mute">Pick someone to see what they have and what they can use.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
