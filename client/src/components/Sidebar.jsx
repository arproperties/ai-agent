import { useEffect, useState } from 'react';
import { Search, X, Users } from 'lucide-react';
import { api } from '../lib/api';
import Icon from './Icon';
import Avatar from './Avatar';

// wrap each occurrence of q in <mark>
function Highlight({ text, q }) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-p1/35 px-0.5 text-txt">{p}</mark> : p));
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  return <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

function when(ts) {
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const Label = ({ children, action }) => (
  <div className="flex items-center justify-between px-5 pb-2 pt-5 text-[11px] font-medium tracking-[0.14em] text-mute">
    <span>{children}</span>{action}
  </div>
);

export default function Sidebar({ user, agents, convs, activeConvId, filesOpen, onNewChat, onOpenConv, onDeleteConv, onEditAgent, onFiles, onMemory, onEmail, onPeople, onLogout, onClose }) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const t = setTimeout(() => api.get(`/conversations/search?q=${encodeURIComponent(term)}`).then(setResults).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, convs]);
  const list = results ?? convs;

  return (
    <div className="flex h-full flex-col pt-safe">
      <header className="flex items-center justify-between px-5 pb-3 pt-2 text-xs tracking-[0.14em] text-mute">
        <span>JARVIS</span>
        <span className="flex items-center gap-3"><Clock />
          <button onClick={onClose} aria-label="Close menu" className="-mr-2 grid size-8 place-items-center rounded-full hover:bg-white/10 md:hidden"><Icon name="x" size={18} /></button>
        </span>
      </header>

      <div className="px-4">
        <button onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">
          <Icon name="edit" size={17} /> New chat
        </button>
      </div>

      <Label action={<span>{agents.length}</span>}>YOUR TEAM</Label>
      <div className="grid grid-cols-4 gap-y-3 px-4">
        {agents.map((a) => (
          <button key={a.id} onClick={() => onEditAgent(a)} title={`Edit ${a.name}`} className="group flex flex-col items-center gap-1">
            <Avatar icon={a.icon} color={a.color} size={40} className="transition group-hover:scale-105 group-active:scale-95" />
            <span className="w-full truncate px-0.5 text-center text-[11px] text-mute group-hover:text-txt">{a.name.split(' ')[0]}</span>
          </button>
        ))}
        <button onClick={() => onEditAgent({})} className="group flex flex-col items-center gap-1" aria-label="New agent">
          <span className="grid size-10 place-items-center rounded-full border border-dashed border-white/25 text-mute transition group-hover:border-p1 group-hover:text-p1">
            <Icon name="plus" size={18} />
          </span>
          <span className="text-[11px] text-mute">Add</span>
        </button>
      </div>

      <Label>CHATS</Label>
      {convs.length > 0 && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-full border border-stroke bg-white/[0.04] px-3 focus-within:border-p1/60">
          <Search size={15} className="shrink-0 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats"
            className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-mute/70" />
          {q && <button onClick={() => setQ('')} aria-label="Clear search" className="text-mute hover:text-txt"><X size={15} /></button>}
        </div>
      )}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {convs.length === 0 && <li className="px-3 py-4 text-sm text-mute">Your chats will appear here</li>}
        {results?.length === 0 && <li className="px-3 py-4 text-sm text-mute">No chats match “{q.trim()}”</li>}
        {list.map((c) => {
          const a = byId[c.agent_id];
          return (
            <li key={c.id} className={`group flex items-center rounded-xl transition ${c.id === activeConvId ? 'bg-white/10' : 'hover:bg-white/5'}`}>
              <button onClick={() => onOpenConv(c.id)} className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 text-left">
                {a ? <Avatar icon={a.icon} color={a.color} size={26} className="shadow-none" />
                  : <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-white/10 text-mute"><Icon name="sparkles" size={13} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm"><Highlight text={c.title || 'Untitled'} q={results && q.trim()} /></span>
                    <span className="shrink-0 text-[11px] text-mute">{when(c.updated_at)}</span>
                  </span>
                  {c.snippet && <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-mute"><Highlight text={c.snippet} q={q.trim()} /></span>}
                </span>
              </button>
              <button onClick={() => onDeleteConv(c.id)} aria-label="Delete chat"
                className="grid size-8 shrink-0 place-items-center rounded-full text-mute opacity-50 hover:text-bad md:opacity-0 md:group-hover:opacity-100">
                <Icon name="trash" size={15} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="space-y-1 border-t border-stroke/60 p-3 pb-safe">
        <div className={`grid gap-1 ${user.role === 'master' ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <button onClick={onFiles} className={`flex flex-col items-center gap-1 rounded-xl py-2 text-xs ${filesOpen ? 'bg-white/10' : 'hover:bg-white/5'}`}>
            <span className="grid size-8 place-items-center rounded-full bg-sky-400/20 text-sky-300"><Icon name="folder" size={17} /></span> Shelf
          </button>
          <button onClick={onMemory} className="flex flex-col items-center gap-1 rounded-xl py-2 text-xs hover:bg-white/5">
            <span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Icon name="brain" size={17} /></span> Memory
          </button>
          <button onClick={onEmail} className="flex flex-col items-center gap-1 rounded-xl py-2 text-xs hover:bg-white/5">
            <span className="grid size-8 place-items-center rounded-full bg-cyan-400/20 text-cyan-300"><Icon name="mail" size={17} /></span> Email
          </button>
          {user.role === 'master' && (
            <button onClick={onPeople} className="flex flex-col items-center gap-1 rounded-xl py-2 text-xs hover:bg-white/5">
              <span className="grid size-8 place-items-center rounded-full bg-emerald-400/20 text-emerald-300"><Users size={17} /></span> People
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 rounded-xl px-2.5 py-2">
          <span className="grid size-8 place-items-center rounded-full bg-white/10 text-sm font-medium">{user.name[0]?.toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{user.name}</span>
            <span className="block truncate text-xs text-mute">{user.email}</span>
          </span>
          <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
