import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import Icon from './components/Icon';
import Chat from './components/Chat';
import ChatHistory from './components/ChatHistory';
import AgentSheet from './components/AgentSheet';
import { FilesPage, MemoryPage } from './components/Knowledge';
import EmailPage from './components/EmailSheet';
import AdminPage, { MyActivitySheet } from './components/Admin';
import MessengerPage from './components/Messenger';
import ListsPage from './components/Lists';
import MeetingsPage from './components/Meetings';
import TranscribePage from './components/Transcribe';
import ResponsibilitiesPage from './components/Responsibilities';
import PropertiesPage from './components/Properties';
import LeasingPage from './components/Leasing';
import RegionSettings from './components/RegionSettings';
import SourcesPage from './components/SourcesPage';
import ChecklistsPage from './components/Checklists';
import BuildingsPage from './components/Buildings';
import InventoryPage from './components/Inventory';
import { useMessenger } from './lib/useMessenger';
import { claimPush, releasePush } from './lib/push';
import { loadRegion, onRegion } from './lib/region';
import { NotifyPrompt } from './components/Notifications';
import MessageToast from './components/MessageToast';
import Orb from './components/Orb';

// back from the Microsoft sign-in page: /?outlook=connected or /?outlook=error&message=…
const params = new URLSearchParams(window.location.search);
const outlookReturn = params.get('outlook') && { status: params.get('outlook'), message: params.get('message') };
// a notification tapped while Riley was closed: /?chat=12 opens that team chat,
// /?todos=1 opens the list of what is due
const notifiedChat = Number(params.get('chat')) || null;
const notifiedTodos = params.get('todos') === '1';
const notifiedDuties = params.get('responsibilities') === '1'; // the master gave them a new responsibility
const notifiedLeasing = params.get('leasing') === 'alerts'; // a leasing alert: rent due, overdue, a lease ending
const notifiedReminders = params.get('reminders') === '1'; // a reminder from someone else: it waits on the first screen of a new chat
// a staff job in one of their buildings needs them: /?building=2&job=41
const notifiedBuilding = Number(params.get('building')) ? { building: Number(params.get('building')), job: Number(params.get('job')) || null } : null;
if (outlookReturn || notifiedChat || notifiedTodos || notifiedDuties || notifiedLeasing || notifiedBuilding) window.history.replaceState(null, '', '/');

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [config, setConfig] = useState({ models: [], voices: [], folders: [], voice: false });
  const [agents, setAgents] = useState([]);
  const [convs, setConvs] = useState([]);
  const [convsLoaded, setConvsLoaded] = useState(false); // an empty list means nothing until it has arrived
  const [expiring, setExpiring] = useState([]); // paperwork running out inside a month
  const [due, setDue] = useState({ todos: [], routines: [], fromOthers: [] }); // reminders that have come round, and routines asking to be done
  const [chat, setChat] = useState({ key: 0, id: null });
  const [drawer, setDrawer] = useState(false);
  const [history, setHistory] = useState(false); // on a phone: the list of chats is showing in place of the chat
  const [editing, setEditing] = useState(null); // agent being edited, or {} for a new one
  const [panel, setPanel] = useState(outlookReturn ? 'email' : notifiedChat ? 'messages' : notifiedTodos ? 'todos' : notifiedDuties ? 'duties' : notifiedBuilding ? 'buildings' : notifiedReminders ? null : 'leasing'); // home is Leasing's Overview; null is the chat. 'files' | 'memory' | 'email' | 'people' | 'messages' | 'todos' | 'meetings' | 'transcribe' | 'duties' | 'checklists' | 'buildings' | 'inventory'
  const [leasingTab, setLeasingTab] = useState(notifiedLeasing ? 'alerts' : 'overview'); // which section of Leasing is open; the sidebar shortcuts set it too
  const [leasingReport, setLeasingReport] = useState('daily'); // which report is open in Leasing's Reports; the sidebar's Reports shortcuts set it
  const [leasingAlert, setLeasingAlert] = useState(''); // which kind of alert Leasing's Alerts is showing ('' is all); the sidebar's Alerts shortcuts set it
  const [jumpToChat, setJumpToChat] = useState(notifiedChat); // a team chat a notification asked for
  const [helper, setHelper] = useState({ open: false, key: 0, id: null }); // Riley floating over whatever screen is open: its own chat, kept while the screens change
  const [dataKey, setDataKey] = useState(0); // goes up when Riley adds something from a chat, so the screen behind is read again
  const [hasBuildings, setHasBuildings] = useState(false); // the master, or someone who runs a building
  const [jumpToBuilding, setJumpToBuilding] = useState(notifiedBuilding); // a building (and job) a notification asked for
  const dm = useMessenger(me); // people-to-people chat: live connection, chat list, unread count

  const chatOpened = useCallback(() => setJumpToChat(null), []);

  useEffect(() => {
    api.get('/auth/me').then((r) => setMe(r.user)).catch(() => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('jarvis:signedout', out);
    return () => window.removeEventListener('jarvis:signedout', out);
  }, []);

  // This device's notifications follow whoever is signed in (see claimPush).
  useEffect(() => { if (me?.id) claimPush(); }, [me?.id]);
  // The business's currency and time zone: read once signed in, and the screens are drawn again whenever it changes.
  const [, setRegionSeen] = useState(0);
  useEffect(() => { if (me?.id) loadRegion(); return onRegion(() => setRegionSeen((n) => n + 1)); }, [me?.id]);

  const loadAgents = useCallback(() => api.get('/agents').then(setAgents), []);
  const loadConvs = useCallback(() => api.get('/conversations').then((c) => { setConvs(c); setConvsLoaded(true); }), []);
  // A month ahead, not the Shelf's ninety days: this feeds a badge and one line on the
  // first screen, and both are only worth showing for what has to be acted on now.
  const loadExpiring = useCallback(() => api.get('/documents/expiring?days=30').then(setExpiring).catch(() => {}), []);
  // Only what is actually due: a reminder set for next month is not something to carry a
  // badge about, and a list that is always lit is a list nobody reads. Both lists feed one
  // count, because "what do I have to do" is one question however many tables answer it.
  const loadDue = useCallback(() => Promise.all([
    api.get('/todos/due').catch(() => []),
    api.get('/routines/due').catch(() => []),
    api.get('/team-reminders/inbox').catch(() => []), // what other people have asked of them
  ]).then(([todos, routines, fromOthers]) => setDue({ todos, routines, fromOthers })), []);

  // A notification tapped while Riley was already open somewhere: the service worker
  // brings that window forward rather than starting a second one, and says what the
  // notice was about — a team chat, or the list of what has just fallen due.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const tapped = (e) => {
      if (e.data?.type !== 'notification') return;
      const where = new URL(e.data.url, window.location.origin).searchParams;
      if (where.get('todos') === '1') { setPanel('todos'); loadDue(); return; }
      if (where.get('responsibilities') === '1') { setPanel('duties'); return; }
      if (where.get('leasing') === 'alerts') { setLeasingTab('alerts'); setPanel('leasing'); return; }
      if (Number(where.get('building'))) {
        setJumpToBuilding({ building: Number(where.get('building')), job: Number(where.get('job')) || null });
        setPanel('buildings');
        return;
      }
      // A reminder from someone else waits on the first screen of a new chat.
      if (where.get('reminders') === '1') { setChat({ key: Date.now(), id: null }); setPanel(null); loadDue(); return; }
      const id = Number(where.get('chat')) || null;
      if (!id) return;
      setPanel('messages');
      setJumpToChat(id);
    };
    navigator.serviceWorker.addEventListener('message', tapped);
    return () => navigator.serviceWorker.removeEventListener('message', tapped);
  }, [loadDue]);

  useEffect(() => {
    if (!me) return;
    api.get('/config').then(setConfig);
    loadAgents();
    loadConvs();
    loadExpiring();
    loadDue();
    api.get('/buildings').then((b) => setHasBuildings(me.role === 'master' || b.length > 0)).catch(() => {});
  }, [me, loadAgents, loadConvs, loadExpiring, loadDue]);

  const openChat = (id) => { setChat({ key: Date.now(), id }); setDrawer(false); setHistory(false); setPanel(null); };
  const onConversation = (id) => { if (id) setChat((c) => ({ ...c, id })); loadConvs(); };
  const deleteConv = async (id) => {
    if (!confirm('Delete this chat?')) return;
    await api.del(`/conversations/${id}`);
    if (id === chat.id) openChat(null);
    loadConvs();
  };
  const logout = async () => {
    await releasePush();
    await api.post('/auth/logout').catch(() => {});
    setMe(null); setAgents([]); setConvs([]); setChat({ key: Date.now(), id: null }); setDrawer(false);
  };

  if (me === undefined) return null;
  const resetting = new URLSearchParams(window.location.search).has('reset'); // opened a password-reset link
  if (!me || resetting) return <Auth onAuthed={(u) => { setMe(u); setChat({ key: Date.now(), id: null }); }} />;

  return (
    <div className="relative z-10 flex h-dvh">
      {drawer && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setDrawer(false)} />}
      <aside className={`max-md:liquid-glass rail-wash fixed inset-y-0 left-0 z-40 w-[86%] max-w-[320px] border-r border-stroke transition-transform duration-300 md:static md:z-auto md:w-72 md:translate-x-0 ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar user={me} agents={agents} filesOpen={panel === 'files'}
          expiring={expiring.length} dueTodos={due.todos.length + due.routines.length} todosOpen={panel === 'todos'} onTodos={() => { setPanel('todos'); setDrawer(false); }}
          meetingsOpen={panel === 'meetings'} onMeetings={() => { setPanel('meetings'); setDrawer(false); }}
          transcribeOpen={panel === 'transcribe'} onTranscribe={() => { setPanel('transcribe'); setDrawer(false); }}
          dutiesOpen={panel === 'duties'} onDuties={() => { setPanel('duties'); setDrawer(false); }}
          propertiesOpen={panel === 'properties'} onProperties={() => { setPanel('properties'); setDrawer(false); }}
          chatsOpen={panel === null || panel === 'messages'} unreadMessages={dm.unread}
          onChats={() => { setPanel(null); setHistory(true); setDrawer(false); }}
          leasingOpen={panel === 'leasing'} leasingTab={leasingTab}
          onLeasing={(tab = 'overview', sub) => {
            setLeasingTab(tab);
            if (tab === 'reports' && sub) setLeasingReport(sub);
            if (tab === 'alerts') setLeasingAlert(sub || '');
            setPanel('leasing'); setDrawer(false);
          }}
          checklistsOpen={panel === 'checklists'} onChecklists={() => { setPanel('checklists'); setDrawer(false); }}
          hasBuildings={hasBuildings} buildingsOpen={panel === 'buildings'} onBuildings={() => { setJumpToBuilding(null); setPanel('buildings'); setDrawer(false); }}
          inventoryOpen={panel === 'inventory'} onInventory={() => { setPanel('inventory'); setDrawer(false); }}
          onEditAgent={(a) => { setEditing(a); setDrawer(false); }} onFiles={() => { setPanel('files'); setDrawer(false); }} onMemory={() => { setPanel('memory'); setDrawer(false); }}
          onEmail={() => { setPanel('email'); setDrawer(false); }} onPeople={() => { setPanel('people'); setDrawer(false); }} sourcesOpen={panel === 'sources'} onSources={() => { setPanel('sources'); setDrawer(false); }} regionOpen={panel === 'region'} onRegion={() => { setPanel('region'); setDrawer(false); }} onActivity={() => { setPanel('activity'); setDrawer(false); }}
          onLogout={logout} onClose={() => setDrawer(false)} />
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {agents.length > 0 ? (
          // The chats and the chat side by side, as in Team chat; on a phone it is one or the other.
          <div className="flex min-h-0 flex-1">
            <section className={`${history ? 'flex' : 'hidden md:flex'} w-full min-w-0 flex-col list-wash border-stroke md:w-80 md:border-r`}>
              <ChatHistory agents={agents} convs={convs} activeConvId={chat.id}
                messagesOpen={panel === 'messages'} unreadMessages={dm.unread} onMessages={() => { setPanel('messages'); setHistory(false); }}
                onNewChat={() => openChat(null)} onOpenConv={openChat} onDeleteConv={deleteConv} onClose={() => setHistory(false)} />
            </section>
            <section className={`${history ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col`}>
              <Chat key={chat.key} user={me} agents={agents} folders={config.folders} dm={dm} conversationId={chat.id} voiceEnabled={config.voice} onChanged={() => setDataKey((n) => n + 1)}
                firstRun={convsLoaded && convs.length === 0} expiring={expiring} onOpenFiles={() => setPanel('files')}
                due={due} onDueChanged={loadDue} onOpenLists={() => setPanel('todos')}
                onConversation={onConversation} onMenu={() => setDrawer(true)} onHistory={() => setHistory(true)} onNewChat={() => openChat(null)} menuBadge={dm.unread} />
            </section>
          </div>
        ) : (
          // No chat here means no chat header, so carry the menu button ourselves —
          // otherwise there is no way back to the sidebar (or to sign out) on mobile.
          <div className="flex h-full flex-col">
            <header className="flex items-center gap-1 border-b border-stroke/60 px-2 pb-2 pt-safe md:px-4">
              <button onClick={() => setDrawer(true)} aria-label={dm.unread ? 'Menu (new messages)' : 'Menu'} title="Menu"
                className="relative grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt md:hidden">
                <Icon name="menu" />
                {dm.unread > 0 && <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-emerald-400 ring-2 ring-bg" />}
              </button>
            </header>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <p className="text-lg font-medium">No agents yet</p>
              {me.role === 'master' ? (
                <>
                  <p className="max-w-sm text-sm text-mute">You need at least one agent before you can start a conversation.</p>
                  <button onClick={() => setEditing({})}
                    className="mt-2 rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2.5 font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">
                    Create an agent
                  </button>
                </>
              ) : (
                // Only the master creates agents, so do not offer a button that would be refused.
                <p className="max-w-sm text-sm text-mute">No agents have been assigned to you yet. Ask your administrator to give you access to one.</p>
              )}
            </div>
          </div>
        )}
        {panel === 'files' && <FilesPage folders={config.folders} me={me} onBack={() => { setPanel(null); loadExpiring(); }} onOpenChat={openChat} />}
        {panel === 'meetings' && <MeetingsPage master={me.role === 'master'} dm={dm} onOpenFiles={() => setPanel('files')} onBack={() => setPanel(null)} />}
        {panel === 'transcribe' && <TranscribePage onBack={() => setPanel(null)} />}
        {panel === 'duties' && <ResponsibilitiesPage onBack={() => setPanel(null)} />}
        {panel === 'properties' && <PropertiesPage key={`p${dataKey}`} me={me} onBack={() => setPanel(null)} />}
        {panel === 'sources' && <SourcesPage onBack={() => setPanel(null)} />}
        {panel === 'region' && <RegionSettings onBack={() => setPanel(null)} />}
        {panel === 'leasing' && <LeasingPage key={`l${dataKey}`} tab={leasingTab} onTab={setLeasingTab} report={leasingReport} onReport={setLeasingReport} alert={leasingAlert} onAlert={setLeasingAlert} onBack={() => setPanel(null)} />}
        {panel === 'checklists' && <ChecklistsPage me={me} onBack={() => setPanel(null)} />}
        {panel === 'buildings' && <BuildingsPage me={me} start={jumpToBuilding} onBack={() => setPanel(null)} />}
        {panel === 'inventory' && <InventoryPage me={me} onBack={() => setPanel(null)} />}
        {panel === 'todos' && <ListsPage onBack={() => setPanel(null)} onChanged={loadDue} />}
        {panel === 'memory' && <MemoryPage onBack={() => setPanel(null)} />}
        {panel === 'email' && <EmailPage returned={outlookReturn} onBack={() => setPanel(null)} />}
        {panel === 'people' && <AdminPage agents={agents} me={me} onBack={() => setPanel(null)} />}
        {panel === 'messages' && <MessengerPage dm={dm} voiceEnabled={config.voice} openChatId={jumpToChat} onOpened={chatOpened} onBack={() => setPanel(null)} />}
      </main>

      {editing && (
        <AgentSheet agent={editing} config={config} me={me} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadAgents(); }} />
      )}
      {panel === 'activity' && <MyActivitySheet onClose={() => setPanel(null)} />}
      {/* Riley, on every screen: a small live orb in the bottom corner that opens a chat over
          whatever is on screen. Not on the chat screens themselves, which are already that. */}
      {agents.length > 0 && panel !== null && panel !== 'messages' && panel !== 'activity' && !editing && (
        <>
          {helper.open && (
            <div className="sky fixed inset-0 z-50 flex flex-col overflow-hidden md:inset-auto md:bottom-24 md:right-5 md:h-[min(680px,calc(100dvh-7.5rem))] md:w-[420px] md:rounded-3xl md:border md:border-stroke md:shadow-2xl">
              <Chat key={helper.key} user={me} agents={agents} folders={config.folders} dm={dm} conversationId={helper.id} voiceEnabled={false}
                expiring={[]} onOpenFiles={() => { setHelper((h) => ({ ...h, open: false })); setPanel('files'); }} onOpenLists={() => { setHelper((h) => ({ ...h, open: false })); setPanel('todos'); }}
                onDueChanged={loadDue} onConversation={(id) => { if (id) setHelper((h) => ({ ...h, id })); loadConvs(); }}
                onNewChat={() => setHelper({ open: true, key: Date.now(), id: null })} onClose={() => setHelper((h) => ({ ...h, open: false }))}
                onChanged={() => setDataKey((n) => n + 1)} />
            </div>
          )}
          <button onClick={() => setHelper((h) => ({ ...h, open: !h.open }))} aria-label={helper.open ? 'Close Riley' : 'Ask Riley'} title={helper.open ? 'Close' : 'Ask Riley'}
            className={`fixed bottom-5 right-5 z-50 grid size-14 place-items-center rounded-full border border-stroke bg-surface shadow-xl transition hover:scale-105 active:scale-95 ${helper.open ? 'max-md:hidden' : ''}`}>
            <Orb state={helper.open ? 'thinking' : 'idle'} className="pointer-events-none !absolute left-1/2 top-1/2 w-[104px] -translate-x-1/2 -translate-y-1/2 scale-[0.46]" />
          </button>
        </>
      )}
      <NotifyPrompt />
      <MessageToast toast={dm.toast} onClose={dm.dismissToast}
        onOpen={(id) => { dm.dismissToast(); setJumpToChat(id); setPanel('messages'); setDrawer(false); }} />
    </div>
  );
}
