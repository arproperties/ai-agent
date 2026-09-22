import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import Icon from './components/Icon';
import Chat from './components/Chat';
import AgentSheet from './components/AgentSheet';
import { FilesPage, MemorySheet } from './components/Knowledge';
import EmailSheet from './components/EmailSheet';
import AdminPage, { MyActivitySheet } from './components/Admin';
import MessengerPage from './components/Messenger';
import { useMessenger } from './lib/useMessenger';

// back from the Microsoft sign-in page: /?outlook=connected or /?outlook=error&message=…
const params = new URLSearchParams(window.location.search);
const outlookReturn = params.get('outlook') && { status: params.get('outlook'), message: params.get('message') };
if (outlookReturn) window.history.replaceState(null, '', '/');

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [config, setConfig] = useState({ models: [], voices: [], folders: [], voice: false });
  const [agents, setAgents] = useState([]);
  const [convs, setConvs] = useState([]);
  const [chat, setChat] = useState({ key: 0, id: null });
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState(null); // agent being edited, or {} for a new one
  const [panel, setPanel] = useState(outlookReturn ? 'email' : null); // 'files' | 'memory' | 'email' | 'people' | 'messages'
  const dm = useMessenger(me); // people-to-people chat: live connection, chat list, unread count

  useEffect(() => {
    api.get('/auth/me').then((r) => setMe(r.user)).catch(() => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('jarvis:signedout', out);
    return () => window.removeEventListener('jarvis:signedout', out);
  }, []);

  const loadAgents = useCallback(() => api.get('/agents').then(setAgents), []);
  const loadConvs = useCallback(() => api.get('/conversations').then(setConvs), []);

  useEffect(() => {
    if (!me) return;
    api.get('/config').then(setConfig);
    loadAgents();
    loadConvs();
  }, [me, loadAgents, loadConvs]);

  const openChat = (id) => { setChat({ key: Date.now(), id }); setDrawer(false); setPanel(null); };
  const onConversation = (id) => { if (id) setChat((c) => ({ ...c, id })); loadConvs(); };
  const deleteConv = async (id) => {
    if (!confirm('Delete this chat?')) return;
    await api.del(`/conversations/${id}`);
    if (id === chat.id) openChat(null);
    loadConvs();
  };
  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    setMe(null); setAgents([]); setConvs([]); setChat({ key: Date.now(), id: null }); setDrawer(false);
  };

  if (me === undefined) return null;
  const resetting = new URLSearchParams(window.location.search).has('reset'); // opened a password-reset link
  if (!me || resetting) return <Auth onAuthed={(u) => { setMe(u); setChat({ key: Date.now(), id: null }); }} />;

  return (
    <div className="relative z-10 flex h-dvh">
      {drawer && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setDrawer(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[86%] max-w-[320px] border-r border-stroke bg-[#0f0d20] transition-transform duration-300 md:static md:z-auto md:w-72 md:translate-x-0 md:bg-transparent ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar user={me} agents={agents} convs={convs} activeConvId={panel === 'files' || panel === 'messages' ? null : chat.id} filesOpen={panel === 'files'}
          messagesOpen={panel === 'messages'} unreadMessages={dm.unread} onMessages={() => { setPanel('messages'); setDrawer(false); }}
          onNewChat={() => openChat(null)} onOpenConv={openChat} onDeleteConv={deleteConv}
          onEditAgent={(a) => { setEditing(a); setDrawer(false); }} onFiles={() => { setPanel('files'); setDrawer(false); }} onMemory={() => { setPanel('memory'); setDrawer(false); }}
          onEmail={() => { setPanel('email'); setDrawer(false); }} onPeople={() => { setPanel('people'); setDrawer(false); }} onActivity={() => { setPanel('activity'); setDrawer(false); }}
          onLogout={logout} onClose={() => setDrawer(false)} />
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {agents.length > 0 ? (
          <Chat key={chat.key} user={me} agents={agents} folders={config.folders} conversationId={chat.id} voiceEnabled={config.voice}
            onConversation={onConversation} onMenu={() => setDrawer(true)} onNewChat={() => openChat(null)} menuBadge={dm.unread} />
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
        {panel === 'files' && <FilesPage folders={config.folders} me={me} onBack={() => setPanel(null)} onOpenChat={openChat} />}
        {panel === 'people' && <AdminPage agents={agents} me={me} onBack={() => setPanel(null)} />}
        {panel === 'messages' && <MessengerPage dm={dm} onBack={() => setPanel(null)} />}
      </main>

      {editing && (
        <AgentSheet agent={editing} config={config} me={me} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadAgents(); }} />
      )}
      {panel === 'memory' && <MemorySheet onClose={() => setPanel(null)} />}
      {panel === 'email' && <EmailSheet returned={outlookReturn} onClose={() => setPanel(null)} />}
      {panel === 'activity' && <MyActivitySheet onClose={() => setPanel(null)} />}
    </div>
  );
}
