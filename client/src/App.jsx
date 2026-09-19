import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import Chat from './components/Chat';
import AgentSheet from './components/AgentSheet';
import { FilesPage, MemorySheet } from './components/Knowledge';
import EmailSheet from './components/EmailSheet';

// back from the Microsoft sign-in page: /?outlook=connected or /?outlook=error&message=…
const params = new URLSearchParams(window.location.search);
const outlookReturn = params.get('outlook') && { status: params.get('outlook'), message: params.get('message') };
if (outlookReturn) window.history.replaceState(null, '', '/');

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [inviteRequired, setInviteRequired] = useState(false);
  const [config, setConfig] = useState({ models: [], voices: [], folders: [], voice: false });
  const [agents, setAgents] = useState([]);
  const [convs, setConvs] = useState([]);
  const [chat, setChat] = useState({ key: 0, id: null });
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState(null); // agent being edited, or {} for a new one
  const [panel, setPanel] = useState(outlookReturn ? 'email' : null); // 'files' | 'memory' | 'email'

  useEffect(() => {
    api.get('/auth/me').then((r) => { setMe(r.user); setInviteRequired(r.inviteRequired); }).catch(() => setMe(null));
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
  if (!me || resetting) return <Auth inviteRequired={inviteRequired} onAuthed={(u) => { setMe(u); setChat({ key: Date.now(), id: null }); }} />;

  return (
    <div className="relative z-10 flex h-dvh">
      {drawer && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setDrawer(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[86%] max-w-[320px] border-r border-stroke bg-[#0f0d20] transition-transform duration-300 md:static md:z-auto md:w-72 md:translate-x-0 md:bg-transparent ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar user={me} agents={agents} convs={convs} activeConvId={panel === 'files' ? null : chat.id} filesOpen={panel === 'files'}
          onNewChat={() => openChat(null)} onOpenConv={openChat} onDeleteConv={deleteConv}
          onEditAgent={(a) => { setEditing(a); setDrawer(false); }} onFiles={() => { setPanel('files'); setDrawer(false); }} onMemory={() => { setPanel('memory'); setDrawer(false); }}
          onEmail={() => { setPanel('email'); setDrawer(false); }}
          onLogout={logout} onClose={() => setDrawer(false)} />
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {agents.length > 0 && (
          <Chat key={chat.key} user={me} agents={agents} folders={config.folders} conversationId={chat.id} voiceEnabled={config.voice}
            onConversation={onConversation} onMenu={() => setDrawer(true)} onNewChat={() => openChat(null)} />
        )}
        {panel === 'files' && <FilesPage folders={config.folders} onBack={() => setPanel(null)} onOpenChat={openChat} />}
      </main>

      {editing && (
        <AgentSheet agent={editing} config={config} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadAgents(); }} />
      )}
      {panel === 'memory' && <MemorySheet onClose={() => setPanel(null)} />}
      {panel === 'email' && <EmailSheet returned={outlookReturn} onClose={() => setPanel(null)} />}
    </div>
  );
}
