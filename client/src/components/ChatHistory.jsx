import { useEffect, useState } from 'react';
import { Search, X, Users } from 'lucide-react';
import { api } from '../lib/api';
import { groupChats } from '../lib/chatGroups';
import Icon from './Icon';
import Avatar from './Avatar';

// The column beside a Riley chat: New chat and Team chat, then every past chat. It sits
// inside the page, the way Team chat keeps its own list, so the sidebar is left for places.

// wrap each occurrence of q in <mark>
function Highlight({ text, q }) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-p1/35 px-0.5 text-txt">{p}</mark> : p));
}

function when(ts) {
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// Sentence case and no letter-spacing: a heading here is a whisper, not a banner.
const Label = ({ children }) => (
  <div className="px-3 pb-1 pt-4 text-[11px] font-medium text-mute/80">{children}</div>
);

export default function ChatHistory({ agents, convs, activeConvId, messagesOpen, unreadMessages = 0, onMessages, onNewChat, onOpenConv, onDeleteConv, onClose }) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const t = setTimeout(() => api.get(`/conversations/search?q=${encodeURIComponent(term)}`).then(setResults).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, convs]);

  const closeSearch = () => { setQ(''); setResults(null); };
  const groups = groupChats(convs);

  // One chat row, drawn like a row in Team chat: the agent that answered, the title, and
  // when it was last touched. The snippet only appears while searching, where it is the
  // whole point -- it shows you which chat the match is in.
  const chatRow = (c, { snippet }) => {
    const a = byId[c.agent_id];
    const active = c.id === activeConvId;
    return (
      <li key={c.id} className={`group flex items-center rounded-2xl transition ${active ? 'bg-gradient-to-r from-p1/[0.16] to-white/[0.04] ring-1 ring-p1/15' : 'hover:bg-white/[0.05]'}`}>
        <button onClick={() => onOpenConv(c.id)} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left">
          {a
            ? <Avatar icon={a.icon} color={a.color} size={36} className="shadow-none" />
            : <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.07] text-mute"><Icon name="sparkles" size={16} /></span>}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm ${active ? 'font-medium' : ''}`}><Highlight text={c.title || 'Untitled'} q={results && q.trim()} /></span>
            {snippet && c.snippet
              ? <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-mute"><Highlight text={c.snippet} q={q.trim()} /></span>
              : <span className="mt-0.5 block truncate text-xs text-mute">{[a?.name, c.updated_at && when(c.updated_at)].filter(Boolean).join(' · ')}</span>}
          </span>
        </button>
        <button onClick={() => onDeleteConv(c.id)} aria-label="Delete chat"
          className="mr-2 grid size-8 shrink-0 place-items-center rounded-full text-mute opacity-50 hover:bg-white/10 hover:text-bad md:opacity-0 md:group-hover:opacity-100">
          <Icon name="trash" size={15} />
        </button>
      </li>
    );
  };

  return (
    <>
      <header className="flex items-center gap-1 border-b border-stroke/60 px-4 pb-2 pt-safe">
        <h1 className="flex-1 py-[9px] text-xl font-light leading-7">Chats</h1>
        <button onClick={onClose} aria-label="Back to the chat" className="-mr-2 grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt md:hidden"><Icon name="x" size={18} /></button>
      </header>

      {/* New chat and Team chat sit side by side as buttons; search is a row below. */}
      <div className="flex gap-2 px-3 pb-3 pt-3">
        <button onClick={onNewChat}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">
          <Icon name="edit" size={17} /> New chat
        </button>
        {/* Team chat: messages between people - separate from the AI chats below */}
        <button onClick={onMessages} aria-label={unreadMessages ? `Team chat, ${unreadMessages} unread` : 'Team chat'}
          className={`relative flex flex-1 items-center justify-center gap-2 rounded-full border py-2.5 text-sm font-medium transition active:scale-[0.98] ${messagesOpen ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200' : 'border-stroke bg-white/[0.05] hover:bg-white/10'}`}>
          <Users size={17} className="text-emerald-300" /> Team chat
          {unreadMessages > 0 && (
            <span className="absolute -right-1 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-semibold text-white ring-2 ring-bg">
              {unreadMessages > 99 ? '99+' : unreadMessages}
            </span>
          )}
        </button>
      </div>

      <div className="glass mx-3 mb-1 flex items-center gap-2 rounded-full px-4">
        <Search size={16} className="shrink-0 text-mute" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats"
          onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
          className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-mute/70" />
        {q && <button onClick={closeSearch} aria-label="Clear search" className="shrink-0 text-mute hover:text-txt"><X size={15} /></button>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-safe">
        {/* Searching replaces the date headings with one flat list of matches: the
            groupings are about recency, which is not what you are scanning for. */}
        {results ? (
          <>
            <Label>{results.length ? `Results for “${q.trim()}”` : 'Results'}</Label>
            <ul className="space-y-0.5">
              {results.length === 0 && <li className="px-3 py-3 text-sm text-mute">No chats match “{q.trim()}”</li>}
              {results.map((c) => chatRow(c, { snippet: true }))}
            </ul>
          </>
        ) : convs.length === 0 ? (
          <>
            <Label>Chats</Label>
            <p className="px-3 py-3 text-sm text-mute">Your chats will appear here</p>
          </>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <Label>{g.label}</Label>
              <ul className="space-y-0.5">{g.items.map((c) => chatRow(c, { snippet: false }))}</ul>
            </div>
          ))
        )}
      </div>
    </>
  );
}
