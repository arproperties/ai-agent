import { useEffect, useState } from 'react';
import { BarChart3, BellRing, CalendarDays, ClipboardList, Eye, Globe, Landmark, LayoutDashboard, Megaphone, MessagesSquare, Search, Users } from 'lucide-react';
import { api } from '../lib/api';
import Icon from './Icon';
import { AGENT_COLORS } from './Avatar';
import { NotifyBell } from './Notifications';
import SettingsMenu from './SettingsMenu';

// The sidebar is the app's main nav: the places you can go. The chats themselves - New
// chat, Team chat and the history - live beside the chat, in ChatHistory.

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  return <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

/**
 * One of the main places: a coloured disc, its name, and a line saying what is in there.
 * The sections inside each (Leasing's tabs, the reports, the kinds of alert) are chosen on
 * the page itself, so the sidebar stays a few rows long. `badge` is a count asking for attention.
 */
function Place({ Ico, color, label, hint, here, onClick, badge = 0 }) {
  return (
    <button onClick={onClick} aria-current={here ? 'page' : undefined}
      className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition ${here ? 'bg-white/10' : 'hover:bg-white/[0.06]'}`}>
      <span className={`grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white shadow-lg transition group-hover:scale-105 group-active:scale-95 ${AGENT_COLORS[color] || color}`}>
        <Ico size={16} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm ${here ? 'font-medium text-txt' : 'text-txt/90'}`}>{label}</span>
        <span className="block truncate text-[11px] text-mute">{hint}</span>
      </span>
      {badge > 0 && <span className="shrink-0 rounded-full bg-bad px-1.5 text-[11px] font-semibold leading-[18px] text-white">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

export default function Sidebar({ user, agents, filesOpen, expiring = 0, dueTodos = 0, todosOpen, onTodos, meetingsOpen, onMeetings, transcribeOpen, onTranscribe, dutiesOpen, onDuties, checklistsOpen, onChecklists, hasBuildings, buildingsOpen, onBuildings, inventoryOpen, onInventory, propertiesOpen, onProperties, chatsOpen, unreadMessages = 0, onChats, leasingOpen, leasingTab, onLeasing, onEditAgent, onFiles, onMemory, onEmail, onPeople, sourcesOpen, onSources, regionOpen, onRegion, onActivity, onLogout, onClose }) {
  // Only shown once somebody has actually looked at this account, so it is silent for
  // anyone nobody inspects - and impossible to miss for anyone who is.
  const [watched, setWatched] = useState(0);
  useEffect(() => { api.get('/access').then((r) => setWatched(r.length)).catch(() => {}); }, []);
  // How many leasing alerts of each kind are open (overdue, due today, a contract missing…), counted again when Leasing is opened or left.
  const [alerts, setAlerts] = useState({ count: 0, rules: {} });
  useEffect(() => { api.get('/leasing/alerts/count').then(setAlerts).catch(() => {}); }, [leasingOpen, leasingTab]);

  // The main places. What is inside each is chosen on its own page.
  const places = [
    { Ico: LayoutDashboard, color: 'amber', label: 'Overview', hint: 'Occupancy, rent and what needs attention', here: leasingOpen && leasingTab === 'overview', onClick: () => onLeasing('overview') },
    { Ico: MessagesSquare, color: 'from-cyan-400 to-blue-600 shadow-cyan-500/30', label: 'Chats', hint: 'Riley, and your team chat', here: chatsOpen, onClick: onChats, badge: unreadMessages },
    { Ico: ClipboardList, color: 'teal', label: 'Leasing', hint: 'Leases, and the buildings they are in',
      here: leasingOpen && (leasingTab === 'bookings' || leasingTab === 'buildings'), onClick: () => onLeasing(leasingTab === 'buildings' ? 'buildings' : 'bookings') },
    { Ico: CalendarDays, color: 'blue', label: 'Calendar', hint: 'Who is in which unit, month by month', here: leasingOpen && leasingTab === 'calendar', onClick: () => onLeasing('calendar') },
    { Ico: Users, color: 'rose', label: 'Tenants', hint: 'The people and companies renting', here: leasingOpen && leasingTab === 'tenants', onClick: () => onLeasing('tenants') },
    { Ico: BarChart3, color: 'violet', label: 'Reports', hint: 'Daily, rent roll, overdue, collections', here: leasingOpen && leasingTab === 'reports', onClick: () => onLeasing('reports') },
    { Ico: BellRing, color: 'from-orange-400 to-red-500 shadow-red-500/30', label: 'Alerts', hint: alerts.count ? `${alerts.count} need${alerts.count === 1 ? 's' : ''} attention` : 'Nothing needs attention',
      here: leasingOpen && leasingTab === 'alerts', onClick: () => onLeasing('alerts'), badge: alerts.count },
    { Ico: Landmark, color: 'slate', label: 'Properties', hint: 'Companies, buildings, units, documents', here: propertiesOpen, onClick: onProperties },
    { Ico: Megaphone, color: 'from-emerald-400 to-teal-600 shadow-emerald-500/30', label: 'Sources', hint: 'Where tenants come from', here: sourcesOpen, onClick: onSources },
    // The business's currency, time zone and phone country code: the master's to set.
    user.role === 'master' && { Ico: Globe, color: 'from-indigo-400 to-purple-600 shadow-indigo-500/30', label: 'Region', hint: 'Currency, time zone, phone code', here: regionOpen, onClick: onRegion },
  ].filter(Boolean);
  // The box at the top narrows the rows to those whose name or line mentions what is typed.
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const shown = term ? places.filter((p) => `${p.label} ${p.hint}`.toLowerCase().includes(term)) : places;

  return (
    <div className="flex h-full flex-col pt-safe">
      <header className="flex items-center justify-between px-4 pb-2 pt-2 text-xs tracking-[0.14em] text-mute">
        <span>RILEY</span>
        <span className="flex items-center gap-3"><Clock />
          <button onClick={onClose} aria-label="Close menu" className="-mr-2 grid size-8 place-items-center rounded-full hover:bg-white/10 md:hidden"><Icon name="x" size={18} /></button>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <label className="relative mt-2 block px-0.5">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the menu"
            className="w-full rounded-xl border border-p1/15 bg-p1/[0.08] py-2 pl-9 pr-3 text-sm outline-none placeholder:text-mute focus:border-p1/50" />
        </label>
        <div className="space-y-1 pt-2">
          {shown.map((p) => <Place key={p.label} {...p} />)}
          {shown.length === 0 && <p className="px-2.5 py-2 text-sm text-mute">Nothing matches.</p>}
        </div>
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
          <SettingsMenu user={user} agents={agents} onEditAgent={onEditAgent} expiring={expiring} dueTodos={dueTodos}
            filesOpen={filesOpen} todosOpen={todosOpen} meetingsOpen={meetingsOpen} transcribeOpen={transcribeOpen} dutiesOpen={dutiesOpen} checklistsOpen={checklistsOpen} hasBuildings={hasBuildings} buildingsOpen={buildingsOpen} inventoryOpen={inventoryOpen} propertiesOpen={propertiesOpen} leasingOpen={leasingOpen}
            onFiles={onFiles} onTodos={onTodos} onMeetings={onMeetings} onTranscribe={onTranscribe} onDuties={onDuties} onChecklists={onChecklists} onBuildings={onBuildings} onInventory={onInventory} onProperties={onProperties} onLeasing={onLeasing}
            onMemory={onMemory} onEmail={onEmail} onPeople={onPeople} onRegion={onRegion} />
          <NotifyBell />
          <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
