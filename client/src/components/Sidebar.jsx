import { useEffect, useRef, useState } from 'react';
import { Search, X, Users, Eye } from 'lucide-react';
import { api } from '../lib/api';
import { groupChats } from '../lib/chatGroups';
import Icon from './Icon';
import Avatar from './Avatar';
import { NotifyBell } from './Notifications';
import { Row, Count } from './NavRow';
import SettingsMenu from './SettingsMenu';

// The sidebar is deliberately monochrome. Every destination is the same quiet row, so
// the eye lands on the chat you are looking for rather than on the furniture. Colour is
// spent only where it carries information: an agent's avatar (which is how you tell one
// agent from another) and a count that wants attention.

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

// Sentence case and no letter-spacing: a heading here is a whisper, not a banner.
const Label = ({ children, action }) => (
  <div className="flex items-center justify-between px-2.5 pb-1 pt-4 text-[11px] font-medium text-mute/80">
    <span>{children}</span>{action}
  </div>
);

export default function Sidebar({ user, agents, convs, activeConvId, filesOpen, expiring = 0, dueTodos = 0, todosOpen, onTodos, meetingsOpen, onMeetings, transcribeOpen, onTranscribe, tenantCare, tenantCareOpen, onTenantCare, dutiesOpen, onDuties, messagesOpen, unreadMessages = 0, onMessages, onNewChat, onOpenConv, onDeleteConv, onEditAgent, onFiles, onMemory, onEmail, onPeople, onActivity, onLogout, onClose }) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const searchRef = useRef(null);
  // Only shown once somebody has actually looked at this account, so it is silent for
  // anyone nobody inspects - and impossible to miss for anyone who is.
  const [watched, setWatched] = useState(0);
  useEffect(() => { api.get('/access').then((r) => setWatched(r.length)).catch(() => {}); }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const t = setTimeout(() => api.get(`/conversations/search?q=${encodeURIComponent(term)}`).then(setResults).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, convs]);

  const closeSearch = () => { setQ(''); setResults(null); setSearching(false); };
  const showTeam = user.role === 'master' || agents.length > 1;
  const groups = groupChats(convs);

  // One chat row, used by both the grouped list and the search results. Search is the
  // only place the snippet appears: in the idle list it doubles the height of every row
  // to repeat what the title already says, but while searching it is the whole point --
  // it shows you which chat the match is in.
  const chatRow = (c, { snippet }) => {
    const a = byId[c.agent_id];
    return (
      <li key={c.id} className={`group flex items-center rounded-lg transition ${c.id === activeConvId ? 'bg-white/10' : 'hover:bg-white/[0.06]'}`}>
        <button onClick={() => onOpenConv(c.id)} className="flex min-w-0 flex-1 items-center gap-2.5 py-[7px] pl-2.5 text-left">
          {snippet && (a
            ? <Avatar icon={a.icon} color={a.color} size={22} className="shadow-none" />
            : <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-white/10 text-mute"><Icon name="sparkles" size={12} /></span>)}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm"><Highlight text={c.title || 'Untitled'} q={results && q.trim()} /></span>
              {snippet && <span className="shrink-0 text-[11px] text-mute">{when(c.updated_at)}</span>}
            </span>
            {snippet && c.snippet && <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-mute"><Highlight text={c.snippet} q={q.trim()} /></span>}
          </span>
        </button>
        <button onClick={() => onDeleteConv(c.id)} aria-label="Delete chat"
          className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-mute opacity-50 hover:bg-white/10 hover:text-bad md:opacity-0 md:group-hover:opacity-100">
          <Icon name="trash" size={14} />
        </button>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col pt-safe">
      <header className="flex items-center justify-between px-4 pb-2 pt-2 text-xs tracking-[0.14em] text-mute">
        <span>REEM</span>
        <span className="flex items-center gap-3"><Clock />
          <button onClick={onClose} aria-label="Close menu" className="-mr-2 grid size-8 place-items-center rounded-full hover:bg-white/10 md:hidden"><Icon name="x" size={18} /></button>
        </span>
      </header>

      {/* Pinned: the three things you reach for without looking. */}
      <div className="space-y-0.5 px-2">
        <Row icon={<Icon name="edit" size={17} />} label="New chat" onClick={onNewChat} />
        {searching ? (
          <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-2.5">
            <Search size={17} className="shrink-0 text-mute" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats"
              onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
              className="w-full bg-transparent py-[7px] text-sm outline-none placeholder:text-mute/70" />
            <button onClick={closeSearch} aria-label="Clear search" className="shrink-0 text-mute hover:text-txt"><X size={15} /></button>
          </div>
        ) : (
          <Row icon={<Search size={17} />} label="Search chats"
            onClick={() => { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()); }} />
        )}
        {/* Team chat: messages between people - separate from the AI chats below */}
        <Row icon={<Users size={17} />} label="Team chat" active={messagesOpen} onClick={onMessages}
          aria-label={unreadMessages ? `Team chat, ${unreadMessages} unread` : 'Team chat'}
          badge={<Count n={unreadMessages} tone="unread" />} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {/* With a single agent the grid is just one avatar saying what the whole app
            already says, so only show it to the master (who adds agents here) or to
            anyone who really does have a team. */}
        {showTeam && (<>
          <Label action={<span>{agents.length}</span>}>Your team</Label>
          <div className="grid grid-cols-4 gap-y-3 px-1.5 pt-1">
            {agents.map((a) => (
              <button key={a.id} onClick={() => onEditAgent(a)} title={`Edit ${a.name}`} className="group flex flex-col items-center gap-1">
                <Avatar icon={a.icon} color={a.color} size={36} className="transition group-hover:scale-105 group-active:scale-95" />
                <span className="w-full truncate px-0.5 text-center text-[11px] text-mute group-hover:text-txt">{a.name.split(' ')[0]}</span>
              </button>
            ))}
            {/* Only the master creates agents; the server refuses anyone else, so do not
                offer a form that can only end in "Not allowed". */}
            {user.role === 'master' && (
              <button onClick={() => onEditAgent({})} className="group flex flex-col items-center gap-1" aria-label="New agent">
                <span className="grid size-9 place-items-center rounded-full border border-dashed border-white/25 text-mute transition group-hover:border-p1 group-hover:text-p1">
                  <Icon name="plus" size={16} />
                </span>
                <span className="text-[11px] text-mute">Add</span>
              </button>
            )}
          </div>
        </>)}

        {/* Searching replaces the date headings with one flat list of matches: the
            groupings are about recency, which is not what you are scanning for. */}
        {results ? (
          <>
            <Label>{results.length ? `Results for “${q.trim()}”` : 'Results'}</Label>
            <ul className="space-y-0.5">
              {results.length === 0 && <li className="px-2.5 py-3 text-sm text-mute">No chats match “{q.trim()}”</li>}
              {results.map((c) => chatRow(c, { snippet: true }))}
            </ul>
          </>
        ) : convs.length === 0 ? (
          <>
            <Label>Chats</Label>
            <p className="px-2.5 py-3 text-sm text-mute">Your chats will appear here</p>
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

      {/* relative: the settings menu opens against this, so it spans the sidebar. */}
      <div className="relative border-t border-stroke/60 p-2 pb-safe">
        <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-medium">{user.name[0]?.toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{user.name}</span>
            <span className="block truncate text-xs text-mute">{user.email}</span>
          </span>
          {false && watched > 0 && ( /* hidden for everyone for now */
            <button onClick={onActivity} aria-label="Who has looked at your workspace" title="Who has looked at your workspace"
              className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
              <Eye size={16} />
            </button>
          )}
          <SettingsMenu user={user} expiring={expiring} dueTodos={dueTodos} tenantCare={tenantCare}
            filesOpen={filesOpen} todosOpen={todosOpen} meetingsOpen={meetingsOpen} transcribeOpen={transcribeOpen} tenantCareOpen={tenantCareOpen} dutiesOpen={dutiesOpen}
            onFiles={onFiles} onTodos={onTodos} onMeetings={onMeetings} onTranscribe={onTranscribe} onTenantCare={onTenantCare} onDuties={onDuties}
            onMemory={onMemory} onEmail={onEmail} onPeople={onPeople} />
          <NotifyBell />
          <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
