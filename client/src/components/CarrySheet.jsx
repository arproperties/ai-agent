import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';
import Avatar from './Avatar';

// Picking earlier chats to bring into this one. Several at a time, on purpose: the whole
// point is pulling two or three conversations together, so this is the one place in the
// app where tick-several-then-done is the right gesture.
//
// The list is the recent chats; typing searches titles and message text through the same
// endpoint the sidebar uses, so a chat from months ago is found by something said in it.
const MAX = 6;
const when = (ts) => {
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export default function CarrySheet({ agents, currentId, picked, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(null);
  const [found, setFound] = useState(null);
  const [chosen, setChosen] = useState(picked);
  const [error, setError] = useState('');
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  useEffect(() => {
    api.get('/conversations').then(setAll).catch((e) => setError(e.message));
  }, []);

  // Searching hits the server (message text, not just titles), so it waits for a pause in typing
  useEffect(() => {
    const term = q.trim();
    if (!term) return setFound(null);
    const t = setTimeout(() => {
      api.get(`/conversations/search?q=${encodeURIComponent(term)}`).then(setFound).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // A chat cannot be brought into itself, and one already carried in is shown as ticked
  const rows = useMemo(() => (found ?? all ?? []).filter((c) => c.id !== currentId), [found, all, currentId]);
  const isOn = (id) => chosen.some((c) => c.id === id);
  const full = chosen.length >= MAX;

  const toggle = (c) => {
    if (isOn(c.id)) return setChosen(chosen.filter((x) => x.id !== c.id));
    if (full) return setError(`Six chats at a time is the limit — that is already a lot to hold at once.`);
    setError('');
    setChosen([...chosen, { id: c.id, title: c.title || 'Untitled chat' }]);
  };

  return (
    <Sheet title="Bring in a chat" icon={<Icon name="history" className="text-p1" />} onClose={onClose}>
      <p className="mb-3 text-sm text-mute">
        Pick the chats whose points you need here. Jarvis reads each one and keeps it for the rest of this conversation,
        so you can ask it to pull them together.
      </p>

      <div className="mb-2 flex items-center gap-2 rounded-full bg-white/5 px-3.5 py-2">
        <Icon name="search" size={16} className="shrink-0 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your chats"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute" />
      </div>

      {error && <p className="mb-2 text-sm text-bad">{error}</p>}

      {all === null ? (
        <p className="py-6 text-center text-sm text-mute">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-mute">{q ? 'No chat matches that.' : 'You have no other chats yet.'}</p>
      ) : (
        <ul className="-mx-1.5">
          {rows.map((c) => {
            const a = byId[c.agent_id];
            const on = isOn(c.id);
            return (
              <li key={c.id}>
                <button onClick={() => toggle(c)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition hover:bg-white/5 ${on ? 'bg-white/[0.07]' : ''}`}>
                  {a ? <Avatar icon={a.icon} color={a.color} size={34} className="shadow-none" />
                    : <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-white/10 text-mute"><Icon name="sparkles" size={15} /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{c.title || 'Untitled chat'}</span>
                    <span className="block truncate text-xs text-mute">{c.snippet || `${a ? `${a.name} · ` : ''}${when(c.updated_at)}`}</span>
                  </span>
                  <span className={`grid size-6 shrink-0 place-items-center rounded-full border transition ${
                    on ? 'border-p1 bg-p1 text-white' : 'border-stroke'}`}>
                    {on && <Icon name="check" size={14} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 -mx-1 mt-3 bg-[#141128] pt-2">
        <button onClick={() => { onDone(chosen); onClose(); }}
          className="w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-3 font-medium text-white transition active:scale-[0.99]">
          {chosen.length === 0 ? 'Done' : `Bring in ${chosen.length} chat${chosen.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Sheet>
  );
}
