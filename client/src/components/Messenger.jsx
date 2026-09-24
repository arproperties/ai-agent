import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Search, X, SquarePen, Users, UserPlus, Check, ArrowRight, LogOut, Pencil, MessageCircle, Crown, UserMinus, Lock } from 'lucide-react';
import { api } from '../lib/api';
import Sheet from './Sheet';
import MessengerChat, { PersonAvatar, Ticks, listTime, preview, lastSeenText } from './MessengerChat';
import { NotifyBanner } from './Notifications';

const SearchBox = ({ value, onChange, placeholder }) => (
  <div className="mx-3 mb-2 flex items-center gap-2 rounded-full border border-stroke bg-white/[0.04] px-3 focus-within:border-emerald-400/60">
    <Search size={15} className="shrink-0 text-mute" />
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-mute/70" />
    {value && <button onClick={() => onChange('')} aria-label="Clear search" className="text-mute hover:text-txt"><X size={15} /></button>}
  </div>
);

const match = (q, ...texts) => { const t = q.trim().toLowerCase(); return !t || texts.some((x) => x?.toLowerCase().includes(t)); };

// ---------- the list of chats ----------
const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups']];

function ChatList({ dm, activeId, onOpen, onNew, onBack }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const me = dm.me;
  const unreadCount = (dm.chats || []).filter((c) => c.unread).length;
  const list = (dm.chats || []).filter((c) => match(q, c.name, c.last?.body)
    && (filter === 'all' || (filter === 'unread' ? c.unread > 0 || c.id === activeId : c.kind === 'group')));

  return (
    <>
      <header className="flex items-center gap-1 px-2 pb-2 pt-safe md:px-3">
        <button onClick={onBack} aria-label="Back to Jarvis" title="Back to Jarvis"
          className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
          <ChevronLeft size={24} />
        </button>
        <h1 className="flex-1 text-xl font-light">Team chat</h1>
        <button onClick={onNew} aria-label="New chat" title="New chat"
          className="grid size-10 place-items-center rounded-full text-emerald-300 hover:bg-white/10">
          <SquarePen size={21} />
        </button>
      </header>
      {/* Only while notifications are off, and only here: this is the screen where a
          missed message actually matters. */}
      <NotifyBanner />
      {(dm.chats?.length || 0) > 0 && (
        <>
          <SearchBox value={q} onChange={setQ} placeholder="Search chats" />
          <div className="flex gap-2 px-3 pb-2">
            {FILTERS.map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`rounded-full px-3.5 py-1 text-[13px] transition ${filter === k ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/[0.06] text-mute hover:bg-white/10 hover:text-txt'}`}>
                {label}{k === 'unread' && unreadCount > 0 ? ` ${unreadCount}` : ''}
              </button>
            ))}
          </div>
        </>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-safe">
        {dm.chats === null && <li className="px-4 py-6 text-sm text-mute">Loading…</li>}
        {dm.chats?.length === 0 && (
          <li className="flex flex-col items-center gap-3 px-8 py-14 text-center">
            <span className="grid size-16 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><MessageCircle size={30} /></span>
            <p className="font-medium">No messages yet</p>
            <p className="text-sm text-mute">Chat with anyone on your team, one to one or in a group.</p>
            <button onClick={onNew}
              className="mt-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/25 active:scale-[0.98]">
              Start a chat
            </button>
          </li>
        )}
        {dm.chats?.length > 0 && list.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-mute">
            {q ? `No chats match “${q.trim()}”` : filter === 'unread' ? 'You’re all caught up ✨' : 'No groups yet'}
          </li>
        )}
        {list.map((c) => {
          const typers = Object.keys(dm.typing[c.id] || {}).map(Number).filter((id) => id !== me.id);
          const mine = c.last?.userId === me.id;
          const others = c.members.filter((m) => m.id !== me.id);
          const who = c.kind === 'group' && c.last && c.last.kind !== 'system' && !mine
            ? `${c.members.find((m) => m.id === c.last.userId)?.name.split(' ')[0] || 'Someone'}: ` : '';
          return (
            <li key={c.id}>
              <button onClick={() => onOpen(c.id)}
                className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition ${c.id === activeId ? 'bg-gradient-to-r from-emerald-400/[0.14] to-white/[0.04] ring-1 ring-emerald-400/20' : 'hover:bg-white/[0.05]'}`}>
                <PersonAvatar id={c.kind === 'group' ? c.id : c.peerId} name={c.name} size={48} group={c.kind === 'group'}
                  online={c.kind === 'direct' && dm.online.has(c.peerId)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate font-medium ${c.unread ? 'text-white' : ''}`}>{c.name}</span>
                    {c.last && <span className={`shrink-0 text-xs ${c.unread ? 'text-emerald-300' : 'text-mute'}`}>{listTime(c.last.createdAt)}</span>}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-sm text-mute">
                      {typers.length > 0 ? (
                        <span className="truncate text-emerald-300">{c.kind === 'group' ? `${c.members.find((m) => m.id === typers[0])?.name.split(' ')[0]} is typing…` : 'typing…'}</span>
                      ) : (
                        <>
                          {mine && !c.last.deleted && <Ticks m={c.last} others={others} className="shrink-0" />}
                          <span className={`truncate ${c.last?.deleted ? 'italic' : ''}`}>{c.last ? `${who}${preview(c.last)}` : 'No messages yet'}</span>
                        </>
                      )}
                    </span>
                    {c.unread > 0 && (
                      <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-semibold text-white">{c.unread > 99 ? '99+' : c.unread}</span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------- picking people: a one-to-one chat, or the members of a new group ----------
function PersonRow({ p, dm, picked, onClick }) {
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-white/5">
        <PersonAvatar id={p.id} name={p.name} size={44} online={dm.online.has(p.id)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{p.name}</span>
          <span className="block truncate text-xs text-mute">{dm.online.has(p.id) ? 'online' : lastSeenText(dm.lastSeen[p.id]) || p.email}</span>
        </span>
        {picked !== undefined && (
          <span className={`grid size-6 shrink-0 place-items-center rounded-full border-2 ${picked ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-white/30'}`}>
            {picked && <Check size={14} strokeWidth={3} />}
          </span>
        )}
      </button>
    </li>
  );
}

function NewChat({ dm, onClose, onOpened }) {
  const [step, setStep] = useState('person'); // 'person' | 'members' | 'name'
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dm.loadPeople(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const people = dm.people.filter((p) => match(q, p.name, p.email));
  const toggle = (id) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const nameOf = (id) => dm.people.find((p) => p.id === id)?.name || '';

  const start = async (body) => {
    setBusy(true); setError('');
    try {
      const chat = await api.post('/messenger/chats', body);
      dm.upsert(chat);
      onOpened(chat.id);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const back = () => (step === 'name' ? setStep('members') : step === 'members' ? (setStep('person'), setPicked([])) : onClose());
  const title = step === 'person' ? 'New chat' : step === 'members' ? 'Add group members' : 'New group';

  return (
    <>
      <header className="flex items-center gap-1 px-2 pb-2 pt-safe md:px-3">
        <button onClick={back} aria-label="Back" className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
          <ChevronLeft size={24} />
        </button>
        <span className="min-w-0 flex-1">
          <h1 className="text-lg font-light">{title}</h1>
          {step === 'members' && <p className="text-xs text-mute">{picked.length ? `${picked.length} selected` : 'Pick who to add'}</p>}
        </span>
      </header>

      {step === 'name' ? (
        <div className="space-y-4 px-4 pt-2">
          <div className="flex items-center gap-3">
            <PersonAvatar id={picked[0] || 0} size={56} group />
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Group name"
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && start({ name, members: picked })}
              className="min-w-0 flex-1 border-b-2 border-emerald-500/70 bg-transparent py-2 text-lg outline-none placeholder:text-mute/70" />
          </div>
          <p className="text-sm text-mute">Members: {['You', ...picked.map(nameOf)].join(', ')}</p>
          {error && <p className="text-sm text-bad">{error}</p>}
          <button onClick={() => start({ name, members: picked })} disabled={!name.trim() || busy}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3 font-medium text-white shadow-lg shadow-emerald-500/25 disabled:opacity-40">
            <Check size={18} /> {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      ) : (
        <>
          {step === 'members' && picked.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-3 pb-2">
              {picked.map((id) => (
                <button key={id} onClick={() => toggle(id)} className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 py-1 pl-1 pr-2.5 text-sm">
                  <PersonAvatar id={id} name={nameOf(id)} size={24} /> {nameOf(id).split(' ')[0]} <X size={14} className="text-mute" />
                </button>
              ))}
            </div>
          )}
          <SearchBox value={q} onChange={setQ} placeholder="Search people" />
          <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-safe">
            {step === 'person' && (
              <li>
                <button onClick={() => setStep('members')} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left hover:bg-white/5">
                  <span className="grid size-11 place-items-center rounded-full bg-emerald-500 text-white"><Users size={21} /></span>
                  <span className="font-medium">New group</span>
                </button>
              </li>
            )}
            {step === 'person' && <li className="px-3 pb-1 pt-3 text-xs tracking-[0.12em] text-mute">PEOPLE</li>}
            {dm.people.length === 0 && <li className="px-4 py-6 text-sm text-mute">Nobody else has an account yet. People added under People can be messaged here.</li>}
            {people.map((p) => (step === 'person'
              ? <PersonRow key={p.id} p={p} dm={dm} onClick={() => !busy && start({ userId: p.id })} />
              : <PersonRow key={p.id} p={p} dm={dm} picked={picked.includes(p.id)} onClick={() => toggle(p.id)} />))}
            {error && step === 'person' && <li className="px-4 py-2 text-sm text-bad">{error}</li>}
          </ul>
          {step === 'members' && picked.length > 0 && (
            <button onClick={() => setStep('name')} aria-label="Next"
              className="absolute bottom-[max(env(safe-area-inset-bottom),20px)] right-5 grid size-14 place-items-center rounded-full bg-emerald-500 text-white shadow-xl shadow-emerald-500/30 active:scale-95">
              <ArrowRight size={24} />
            </button>
          )}
        </>
      )}
    </>
  );
}

// ---------- group / contact info ----------
/**
 * Said wherever somebody might be forming a picture of who can see this. Team chat is
 * private from everyone not in the chat — but not from whoever runs the workspace, whose
 * People screen lists every one of these transcripts, and not from the AI once a member
 * asks for a summary. That is a deliberate choice about a workplace tool; the only
 * indefensible version of it is the one nobody is told about. When either of those two
 * facts changes, this line changes with it.
 */
function PrivacyNote({ className = '' }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs leading-relaxed text-mute/80 ${className}`}>
      <Lock size={12} className="mt-0.5 shrink-0" />
      <span>Sent to the AI only when somebody in the chat asks for a summary. Whoever runs this workspace can read these messages.</span>
    </p>
  );
}

function ChatInfo({ chat, dm, onClose, onLeft }) {
  const me = dm.me;
  const mine = chat.members.find((m) => m.id === me.id);
  const admin = mine?.role === 'admin';
  const [name, setName] = useState(chat.name);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { if (adding) dm.loadPeople(); }, [adding]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn) => {
    setError('');
    try { const r = await fn(); if (r?.id) dm.upsert(r); return true; } catch (e) { setError(e.message); return false; }
  };
  const rename = async () => { if (await act(() => api.patch(`/messenger/chats/${chat.id}`, { name }))) setEditing(false); };
  const add = async () => { if (await act(() => api.post(`/messenger/chats/${chat.id}/members`, { userIds: picked }))) { setAdding(false); setPicked([]); } };
  const remove = (m) => confirm(`Remove ${m.name} from "${chat.name}"?`) && act(() => api.del(`/messenger/chats/${chat.id}/members/${m.id}`).then(() => dm.refreshChat(chat.id)));
  const promote = (m) => act(() => api.post(`/messenger/chats/${chat.id}/members/${m.id}/admin`));
  const leave = async () => {
    if (!confirm(`Leave "${chat.name}"?`)) return;
    if (await act(() => api.del(`/messenger/chats/${chat.id}/members/${me.id}`))) onLeft();
  };

  if (chat.kind === 'direct') {
    const p = dm.people.find((x) => x.id === chat.peerId);
    return (
      <Sheet title="Contact info" onClose={onClose}>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <PersonAvatar id={chat.peerId} name={chat.name} size={88} />
          <p className="mt-2 text-xl">{chat.name}</p>
          {p?.email && <p className="text-sm text-mute">{p.email}</p>}
          <p className="text-sm text-mute">{dm.online.has(chat.peerId) ? 'online' : lastSeenText(dm.lastSeen[chat.peerId])}</p>
        </div>
        <PrivacyNote className="border-t border-stroke/60 pt-3" />
      </Sheet>
    );
  }

  const inGroup = new Set(chat.members.map((m) => m.id));
  // you first, then admins, then everyone else A–Z
  const members = [...chat.members].sort((a, b) => (b.id === me.id) - (a.id === me.id)
    || (b.role === 'admin') - (a.role === 'admin') || a.name.localeCompare(b.name));
  const candidates = dm.people.filter((p) => !inGroup.has(p.id));

  return (
    <Sheet title="Group info" onClose={onClose}>
      <div className="flex flex-col items-center gap-2 pb-4 pt-2 text-center">
        <PersonAvatar id={chat.id} size={80} group />
        {editing ? (
          <div className="mt-2 flex w-full items-center gap-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} onKeyDown={(e) => e.key === 'Enter' && rename()}
              className="min-w-0 flex-1 rounded-xl border border-stroke bg-white/5 px-3 py-2 outline-none focus:border-emerald-400/60" />
            <button onClick={rename} className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-white">Save</button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="mt-2 flex items-center gap-2 text-xl hover:text-emerald-300">
            {chat.name} <Pencil size={15} className="text-mute" />
          </button>
        )}
        <p className="text-sm text-mute">Group · {chat.members.length} members</p>
      </div>
      {error && <p className="mb-2 text-sm text-bad">{error}</p>}

      {adding ? (
        <div className="rounded-2xl bg-white/[0.04] p-2">
          <p className="px-2 pb-1 pt-1 text-sm font-medium">Add people</p>
          {candidates.length === 0 && <p className="px-2 py-3 text-sm text-mute">Everyone is already in this group.</p>}
          <ul className="max-h-72 overflow-y-auto">
            {candidates.map((p) => (
              <PersonRow key={p.id} p={p} dm={dm} picked={picked.includes(p.id)}
                onClick={() => setPicked((l) => (l.includes(p.id) ? l.filter((x) => x !== p.id) : [...l, p.id]))} />
            ))}
          </ul>
          <div className="flex gap-2 p-2">
            <button onClick={() => { setAdding(false); setPicked([]); }} className="flex-1 rounded-full bg-white/10 py-2 text-sm">Cancel</button>
            <button onClick={add} disabled={!picked.length} className="flex-1 rounded-full bg-emerald-500 py-2 text-sm font-medium text-white disabled:opacity-40">
              Add {picked.length || ''}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-1 text-xs tracking-[0.12em] text-mute">{chat.members.length} MEMBERS</p>
          <ul className="-mx-2">
            {admin && (
              <li>
                <button onClick={() => setAdding(true)} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-white/5">
                  <span className="grid size-11 place-items-center rounded-full bg-emerald-500 text-white"><UserPlus size={20} /></span>
                  <span className="font-medium">Add people</span>
                </button>
              </li>
            )}
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-2xl px-2.5 py-2">
                <PersonAvatar id={m.id} name={m.name} size={44} online={m.id !== me.id && dm.online.has(m.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.id === me.id ? 'You' : m.name}</span>
                  {m.role === 'admin' && <span className="text-xs text-emerald-300">Group admin</span>}
                </span>
                {admin && m.id !== me.id && (
                  <span className="flex shrink-0 gap-1">
                    {m.role !== 'admin' && (
                      <button onClick={() => promote(m)} title="Make group admin" aria-label={`Make ${m.name} a group admin`}
                        className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-emerald-300"><Crown size={17} /></button>
                    )}
                    <button onClick={() => remove(m)} title="Remove from group" aria-label={`Remove ${m.name}`}
                      className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><UserMinus size={17} /></button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button onClick={leave} className="mt-3 flex w-full items-center gap-3 rounded-2xl px-2.5 py-3 text-bad hover:bg-bad/10">
            <LogOut size={20} /> Leave group
          </button>
          <PrivacyNote className="mt-3 border-t border-stroke/60 pt-3" />
        </>
      )}
    </Sheet>
  );
}

// ---------- the page ----------
export default function MessengerPage({ dm, openChatId = null, onOpened, onBack }) {
  const [openId, setOpenId] = useState(openChatId);
  const [mode, setMode] = useState('list'); // 'list' | 'new'
  const [info, setInfo] = useState(false);
  const chat = useMemo(() => dm.chats?.find((c) => c.id === openId) || null, [dm.chats, openId]);

  // Sent here by a tapped notification while the screen was already open.
  useEffect(() => {
    if (!openChatId) return;
    setMode('list');
    setOpenId(openChatId);
    onOpened?.();
  }, [openChatId, onOpened]);

  // removed from the open group, or it was deleted: back to the list
  useEffect(() => {
    if (openId && dm.chats && !chat) { setOpenId(null); setInfo(false); }
  }, [openId, dm.chats, chat]);

  // Escape closes the open chat on desktop, then the page
  useEffect(() => {
    const key = (e) => {
      if (e.key !== 'Escape' || info || document.querySelector('.fixed.inset-0.z-50')) return;
      if (openId) setOpenId(null); else if (mode === 'new') setMode('list'); else onBack();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [openId, mode, info, onBack]);

  return (
    <div className="sky absolute inset-0 z-20 flex">
      <section className={`${openId ? 'hidden md:flex' : 'flex'} relative w-full min-w-0 flex-col border-white/[0.06] md:w-80 md:border-r lg:w-96`}>
        {mode === 'new'
          ? <NewChat dm={dm} onClose={() => setMode('list')} onOpened={(id) => { setMode('list'); setOpenId(id); }} />
          : <ChatList dm={dm} activeId={openId} onOpen={setOpenId} onNew={() => setMode('new')} onBack={onBack} />}
      </section>
      <section className={`${openId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {chat ? (
          <MessengerChat key={chat.id} chat={chat} dm={dm} onBack={() => setOpenId(null)} onInfo={() => setInfo(true)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <div className="relative mb-2 grid size-32 place-items-center">
              <span className="absolute inset-2 rounded-full bg-emerald-400/25 blur-2xl" />
              <span className="absolute left-2 top-4 grid size-16 -rotate-12 place-items-center rounded-[22px] bg-gradient-to-br from-violet-400 to-fuchsia-500 text-white shadow-xl shadow-fuchsia-500/20">
                <Users size={28} />
              </span>
              <span className="relative ml-8 mt-6 grid size-20 rotate-6 place-items-center rounded-[26px] bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-2xl shadow-emerald-500/30">
                <MessageCircle size={38} />
              </span>
            </div>
            <h2 className="text-2xl font-light text-txt">Team chat</h2>
            <p className="max-w-sm text-sm text-mute">Message anyone on your team, one to one or in a group. New messages appear the moment someone sends one.</p>
            <button onClick={() => setMode('new')}
              className="mt-1 flex items-center gap-2 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/25 transition hover:brightness-110 active:scale-[0.98]">
              <SquarePen size={16} /> Start a new chat
            </button>
            <PrivacyNote className="mt-6 max-w-xs justify-center text-center" />
          </div>
        )}
      </section>
      {info && chat && <ChatInfo chat={chat} dm={dm} onClose={() => setInfo(false)} onLeft={() => { setInfo(false); setOpenId(null); }} />}
    </div>
  );
}
