import { useEffect, useMemo, useRef, useState } from 'react';
import { api, streamChat } from '../lib/api';
import { speakText, stopSpeaking, togglePause } from '../lib/voice';
import Icon from './Icon';
import Orb from './Orb';
import Avatar from './Avatar';
import Message from './Message';
import Composer from './Composer';
import LiveVoice from './LiveVoice';
import Sheet from './Sheet';
import { FileCard, FileViewer, FileDetail } from './Knowledge';

const IconBtn = ({ icon, label, onClick, className = '' }) => (
  <button onClick={onClick} aria-label={label} title={label}
    className={`grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt ${className}`}>
    <Icon name={icon} />
  </button>
);

export default function Chat({ user, agents, folders, conversationId, voiceEnabled, onConversation, onMenu, onNewChat }) {
  const [convId, setConvId] = useState(conversationId);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [orb, setOrb] = useState('idle');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState('');
  const [voice, setVoice] = useState({ id: null, state: 'idle' }); // reply being read aloud
  const [live, setLive] = useState(false); // hands-free voice mode is open
  const [viewer, setViewer] = useState(null); // file open in the full-screen viewer
  const [details, setDetails] = useState(null); // file open in the details sheet
  const [chatFiles, setChatFiles] = useState(null); // list of this chat's attachments
  const abortRef = useRef();
  const scrollRef = useRef();
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  const toBottom = () => requestAnimationFrame(() => scrollRef.current && (scrollRef.current.scrollTop = scrollRef.current.scrollHeight));

  useEffect(() => {
    if (conversationId) api.get(`/conversations/${conversationId}/messages`).then((m) => { setMessages(m); toBottom(); });
    return () => { abortRef.current?.abort(); stopSpeaking(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 4000); };

  const docIds = [...new Set(messages.flatMap((m) => (m.files || []).map((f) => f.docId)).filter(Boolean))];
  const openFile = (id) => api.get(`/documents/${id}`).then(setViewer).catch((e) => flash(e.message));
  const showChatFiles = () => api.get(`/documents?ids=${docIds.join(',')}`).then(setChatFiles).catch((e) => flash(e.message));

  // Tapping the reply that is already talking pauses or resumes it; tapping one
  // that is still being generated gives up on it. Anything else starts fresh.
  const say = (text, id, agentId) => {
    if (voice.id === id) {
      if (voice.state === 'loading') return stopSpeaking();
      return togglePause();
    }
    speakText(text, agentId, (s) => {
      if (s === 'error') { flash("Couldn't play that out loud. Please try again."); s = 'idle'; }
      setVoice(s === 'idle' ? { id: null, state: 'idle' } : { id, state: s });
      setOrb(s === 'speaking' ? 'speaking' : s === 'loading' ? 'thinking' : 'idle');
    }).catch((e) => flash(e.message));
  };

  // onDelta: live voice mode starts reading the reply out while it is still arriving
  const send = async (text, files, { voice, onDelta } = {}) => {
    stopSpeaking();
    const form = new FormData();
    if (convId) form.append('conversationId', convId);
    form.append('text', text);
    files.forEach((f) => form.append('files', f));

    const aid = `a${Date.now()}`;
    setMessages((m) => [...m,
      { id: `u${aid}`, role: 'user', content: text, files: files.map((f) => ({ name: f.name, kind: f.type.startsWith('image/') ? 'image' : 'doc', preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null })) },
      { id: aid, role: 'assistant', content: '', streaming: true }]);
    const update = (patch) => setMessages((m) => m.map((x) => (x.id === aid ? { ...x, ...patch } : x)));
    toBottom();

    setBusy(true); setOrb('thinking'); setStatus('Choosing the best agent…');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let reply = '';
    let agentId = null;
    try {
      await streamChat(form, {
        signal: ctrl.signal,
        onEvent: (event, d) => {
          if (event === 'meta') { setConvId(d.conversationId); onConversation(d.conversationId); }
          else if (event === 'agent') { agentId = d.id; update({ agent_id: d.id, why: d.why }); }
          else if (event === 'files') { // saved attachments: link them so they can be viewed
            setMessages((m) => m.map((x) => (x.id === `u${aid}` ? { ...x, files: x.files.map((f) => ({ ...f, ...d.find((s) => s.name === f.name) })) } : x)));
          }
          else if (event === 'status') setStatus(d.label);
          else if (event === 'notice') flash(d.message);
          else if (event === 'error') update({ error: d.message });
          else if (event === 'sources') update({ sources: d });
          else if (event === 'delta') {
            if (!reply) setOrb('speaking');
            setStatus('');
            reply += d.text;
            update({ content: reply });
            onDelta?.(reply, agentId);
          }
        },
      });
    } catch (e) {
      if (e.name !== 'AbortError') update({ error: e.message });
    }
    update({ streaming: false });
    setBusy(false); setOrb('idle'); setStatus('');
    onConversation(null);
    if (voice && reply) say(reply, aid, agentId);
    return { reply, agentId }; // live voice mode reads the reply out itself
  };

  const lastAgent = byId[[...messages].reverse().find((m) => m.agent_id)?.agent_id];
  // one random suggestion from each agent, so the whole team is visible
  const starters = useMemo(() => agents.filter((a) => a.starters?.length)
    .map((a) => ({ a, s: a.starters[Math.floor(Math.random() * a.starters.length)] })), [agents]);
  const firstName = user.name.split(' ')[0];

  return (
    <div className="relative flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-1 border-b border-stroke/60 px-2 pb-2 pt-safe md:px-4">
        <IconBtn icon="menu" label="Menu" onClick={onMenu} className="md:hidden" />
        <div className="flex min-w-0 flex-1 items-center gap-3 py-1 pl-1">
          {lastAgent ? (
            <Avatar icon={lastAgent.icon} color={lastAgent.color} size={38}
              className={`transition ${orb !== 'idle' ? 'animate-pulse ring-2 ring-white/40 ring-offset-2 ring-offset-bg' : ''}`} />
          ) : (
            <span className={`grid size-[38px] shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 via-p2 to-p3 text-white ${orb !== 'idle' ? 'animate-pulse' : ''}`}>
              <Icon name="sparkles" size={18} />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium leading-tight">{lastAgent ? lastAgent.name : 'New chat'}</span>
            <span className="block truncate text-xs text-mute">
              {status || (orb === 'listening' ? 'Listening…' : orb === 'speaking' && !busy ? 'Speaking…' : `Auto-picks from your ${agents.length} agents`)}
            </span>
          </span>
        </div>
        {voiceEnabled && (
          <IconBtn icon="live" label="Live voice — hands free" onClick={() => { stopSpeaking(); setLive(true); }} />
        )}
        {docIds.length > 0 && (
          <button onClick={showChatFiles} aria-label="Files in this chat" title="Files in this chat"
            className="relative grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <Icon name="clip" />
            <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-p1 px-1 text-[10px] font-semibold leading-4 text-white">{docIds.length}</span>
          </button>
        )}
        <IconBtn icon="edit" label="New chat" onClick={onNewChat} />
      </header>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-6 px-5 py-8 text-center">
            <Orb state={orb} className="w-[min(52vw,220px)]" />
            <div>
              <b className="block text-[21px] font-light">{orb === 'listening' ? 'Listening…' : orb === 'thinking' ? 'Thinking…' : `Hi ${firstName}`}</b>
              <span className="text-sm text-mute">Ask anything. The right agent will answer.</span>
            </div>
            <div className="flex -space-x-2">
              {agents.slice(0, 7).map((a) => <Avatar key={a.id} icon={a.icon} color={a.color} size={30} className="ring-2 ring-bg" />)}
            </div>
            {starters.length > 0 && (
              <div className="flex max-w-xl flex-wrap justify-center gap-2">
                {starters.map(({ s, a }) => (
                  <button key={a.id + s} onClick={() => send(s, [])}
                    className="glass flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-[13px] transition hover:-translate-y-px hover:bg-white/10">
                    <Avatar icon={a.icon} color={a.color} size={22} className="shadow-none" /> {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6">
            {messages.map((m) => (
              <Message key={m.id} msg={m} agent={byId[m.agent_id]} voiceEnabled={voiceEnabled} onOpenFile={openFile}
                voice={voice.id === m.id ? voice.state : 'idle'} onStopSpeak={stopSpeaking}
                onSpeak={() => say(m.content, m.id, m.agent_id)} />
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <Composer busy={busy} voiceEnabled={voiceEnabled} onSend={send} onStop={() => abortRef.current?.abort()}
          onVoiceState={(s) => { stopSpeaking(); setOrb(s); }} onError={flash} />
      </div>

      {live && (
        <LiveVoice onAsk={(text, onDelta) => send(text, [], { onDelta })} onClose={() => setLive(false)} onError={flash} />
      )}

      {chatFiles && (
        <Sheet title="Files in this chat" onClose={() => setChatFiles(null)}
          icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Icon name="clip" size={16} /></span>}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {chatFiles.map((d) => <FileCard key={d.id} d={d} onOpen={setViewer} />)}
          </div>
        </Sheet>
      )}
      {viewer && <FileViewer d={viewer} onClose={() => setViewer(null)} onInfo={(d) => { setViewer(null); setDetails(d); }} />}
      {details && <FileDetail d={details} folders={folders} me={user} onClose={() => setDetails(null)} onChanged={() => {}} />}

      {toast && (
        <div className="rise absolute inset-x-4 top-20 z-30 mx-auto max-w-md rounded-2xl border border-warn/30 bg-[#1d1830]/95 px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
