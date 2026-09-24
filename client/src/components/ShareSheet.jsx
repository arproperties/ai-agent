import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';
import { PersonAvatar } from './MessengerChat';

// Picking where a reply goes. One place at a time, on purpose: sharing the same answer
// into three chats is three deliberate taps, not one tick-everything gesture.
//
// The list is the chats the person already has, then everyone else they could start one
// with. Picking somebody new opens the chat first, exactly as the Messages screen does.
const match = (q, ...fields) => {
  const s = q.trim().toLowerCase();
  return !s || fields.some((f) => (f || '').toLowerCase().includes(s));
};

export default function ShareSheet({ dm, messageId, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null); // key of the row being shared to
  const [error, setError] = useState('');

  useEffect(() => { dm.loadChats(); dm.loadPeople(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const chats = (dm.chats || []).map((c) => ({
      key: `c${c.id}`, chatId: c.id, name: c.name, group: c.kind === 'group',
      avatarId: c.kind === 'group' ? c.id : c.peerId,
      sub: c.kind === 'group' ? `${c.members.length} people` : 'Chat',
      peerId: c.peerId,
    }));
    const talking = new Set(chats.map((c) => c.peerId).filter(Boolean));
    const fresh = dm.people.filter((p) => !talking.has(p.id)).map((p) => ({
      key: `p${p.id}`, userId: p.id, name: p.name, group: false, avatarId: p.id, sub: p.email,
    }));
    return [...chats, ...fresh].filter((r) => match(q, r.name, r.sub));
  }, [dm.chats, dm.people, q]);

  const share = async (row) => {
    setBusy(row.key); setError('');
    try {
      let { chatId } = row;
      if (!chatId) {
        const chat = await api.post('/messenger/chats', { userId: row.userId });
        dm.upsert(chat);
        chatId = chat.id;
      }
      await api.post(`/messenger/chats/${chatId}/share`, { messageId });
      onDone(`Shared with ${row.name}`);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  };

  return (
    <Sheet title="Share with" icon={<Icon name="share" className="text-p1" />} onClose={onClose}>
      <p className="mb-3 text-sm text-mute">
        The reply is sent as a message, labelled with the agent who wrote it. Your question and the rest of this chat stay private.
      </p>

      <div className="mb-2 flex items-center gap-2 rounded-full bg-white/5 px-3.5 py-2">
        <Icon name="search" size={16} className="shrink-0 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people and groups"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute" />
      </div>

      {error && <p className="mb-2 text-sm text-bad">{error}</p>}

      {dm.chats === null ? (
        <p className="py-6 text-center text-sm text-mute">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-mute">{q ? 'Nobody by that name.' : 'There is nobody else on the team yet.'}</p>
      ) : (
        <ul className="-mx-1.5">
          {rows.map((r) => (
            <li key={r.key}>
              <button onClick={() => share(r)} disabled={busy !== null}
                className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-white/5 disabled:opacity-40">
                <PersonAvatar id={r.avatarId || 0} name={r.name} size={44} group={r.group}
                  online={!r.group && dm.online.has(r.peerId ?? r.userId)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-mute">{r.sub}</span>
                </span>
                <Icon name={busy === r.key ? 'spinner' : 'share'} size={17}
                  className={`shrink-0 text-mute ${busy === r.key ? 'animate-spin' : ''}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
