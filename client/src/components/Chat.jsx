import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTodo, BellRing, Check, Lightbulb, X, Bell } from 'lucide-react';
import { api, streamChat } from '../lib/api';
import { speakText, stopSpeaking, togglePause } from '../lib/voice';
import Icon from './Icon';
import Orb from './Orb';
import Avatar from './Avatar';
import Message from './Message';
import DraftCard from './DraftCard';
import TeamReminderCard, { ReminderPhotos } from './TeamReminderCard';
import ResponsibilityCard from './ResponsibilityCard';
import InventoryCard from './InventoryCard';
import BookingCard from './BookingCard';
import { usePush } from './Notifications';
import { permission } from '../lib/push';
import Composer from './Composer';
import LiveVoice from './LiveVoice';
import Sheet from './Sheet';
import ShareSheet from './ShareSheet';
import CarrySheet from './CarrySheet';
import PdfSheet from './PdfSheet';
import { lastDrawing, exportAsked } from '../lib/drawing';
import { Welcome, InstallHint } from './FirstRun';
import { FileCard, FileViewer, FileDetail, expiry } from './Knowledge';

// Which reply can be shared: one the server has written down. A reply still streaming
// has only a made-up id here, and the share is sent by id so the team gets the words
// Reem actually said, not whatever the browser is holding.
const savedIdOf = (m) => (m.error ? null : m.saved ?? (typeof m.id === 'number' ? m.id : null));
const shareIdOf = (m) => (m.role === 'assistant' ? savedIdOf(m) : null);
// The latest saved drawing at or before message i: what "convert into pdf" hands over.
function drawingUpTo(messages, i) {
  for (let j = i; j >= 0; j--) {
    const drawing = shareIdOf(messages[j]) && lastDrawing(messages[j].content);
    if (drawing) return { drawing, messageId: shareIdOf(messages[j]) };
  }
  return undefined;
}

const IconBtn = ({ icon, label, onClick, className = '' }) => (
  <button onClick={onClick} aria-label={label} title={label}
    className={`grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt ${className}`}>
    <Icon name={icon} />
  </button>
);

export default function Chat({ user, agents, folders, dm, conversationId, voiceEnabled, firstRun = false, expiring = [], due = { todos: [], routines: [], fromOthers: [] }, onDueChanged, onConversation, onMenu, onNewChat, onOpenFiles, onOpenLists, menuBadge = 0 }) {
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
  const [drafts, setDrafts] = useState([]); // every email written in this chat, whatever became of it
  const [mailbox, setMailbox] = useState(null); // the address a draft would be sent from
  const [reminders, setReminders] = useState([]); // reminders for other people got ready in this chat
  const [duties, setDuties] = useState([]); // responsibility changes got ready in this chat (master only)
  const [stock, setStock] = useState([]); // inventory items got ready in this chat, waiting for Add
  const [bookings, setBookings] = useState([]); // ARS bookings got ready in this chat, waiting for Create
  const [suggested, setSuggested] = useState([]); // reminders Reem spotted, waiting for a yes or no
  const push = usePush();
  const [sharing, setSharing] = useState(null); // id of the reply waiting on a chat to be picked
  const [pdfOf, setPdfOf] = useState(null); // { id, content, own } of the message being made into a PDF
  const [carry, setCarry] = useState([]); // earlier chats picked for the message being written
  const [carrying, setCarrying] = useState([]); // titles of the chats this conversation is already using
  const [picking, setPicking] = useState(false); // the bring-in-a-chat sheet is open
  const abortRef = useRef();
  const scrollRef = useRef();
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  const toBottom = () => requestAnimationFrame(() => scrollRef.current && (scrollRef.current.scrollTop = scrollRef.current.scrollHeight));

  useEffect(() => {
    if (conversationId) {
      api.get(`/conversations/${conversationId}/messages`).then((m) => {
        setMessages(m);
        setCarrying([...new Set(m.flatMap((x) => x.carried || []))]);
        toBottom();
      });
      // Every status, not just the ones still waiting: a sent email that vanishes on
      // reload leaves no answer to "did I send that?". The card says what became of it.
      // Oldest first, because the list arrives newest first and these read as chat.
      api.get(`/email/drafts?conversation=${conversationId}`).then((r) => setDrafts(r.drafts.slice().reverse())).catch(() => {});
      api.get(`/team-reminders?conversation=${conversationId}`).then(setReminders).catch(() => {});
      if (user.role === 'master') api.get(`/responsibilities/proposals?conversation=${conversationId}`).then(setDuties).catch(() => {});
      api.get(`/saifsys/ars/bookings?conversation=${conversationId}`).then(setBookings).catch(() => {});
      api.get(`/inventory/proposals?conversation=${conversationId}`).then(setStock).catch(() => {});
    }
    api.get('/imap').then((r) => setMailbox(r.account?.email || null)).catch(() => {});
    // Only on the first screen, where they are shown. The server decides whether it is
    // time for a real look; most of the time this just returns what is already waiting.
    if (!conversationId) api.post('/suggestions/scan').then(setSuggested).catch(() => {});
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
    // The chats picked for this message. They are cleared as it goes: once sent they are the
    // conversation's, not the composer's, and the strip above the composer says so.
    const brought = carry;
    if (brought.length) form.append('carry', JSON.stringify(brought.map((c) => c.id)));
    setCarry([]);

    const aid = `a${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    setMessages((m) => [...m,
      { id: `u${aid}`, role: 'user', content: text, created_at: now, carried: brought.map((c) => c.title), files: files.map((f) => ({ name: f.name, kind: f.type.startsWith('image/') ? 'image' : 'doc', preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null })) },
      { id: aid, role: 'assistant', content: '', streaming: true, created_at: now }]);
    const update = (patch) => setMessages((m) => m.map((x) => (x.id === aid ? { ...x, ...patch } : x)));
    toBottom();

    setBusy(true); setOrb('thinking'); setStatus('Choosing the best agent…');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let reply = '';
    let agentId = null;
    let savedId = null; // the row id the server gave the reply, sent when sharing it
    let failed = false; // an error is already on the bubble
    let acted = false; // a card was put in the chat, which is an answer in itself
    try {
      await streamChat(form, {
        signal: ctrl.signal,
        onEvent: (event, d) => {
          if (event === 'meta') { setConvId(d.conversationId); onConversation(d.conversationId); }
          else if (event === 'agent') { agentId = d.id; update({ agent_id: d.id, why: d.why }); }
          else if (event === 'files') { // saved attachments: link them so they can be viewed
            setMessages((m) => m.map((x) => (x.id === `u${aid}` ? { ...x, files: x.files.map((f) => ({ ...f, ...d.find((s) => s.name === f.name) })) } : x)));
          }
          else if (event === 'repeat') {
            // The same question, asked again before it was answered: it stays on screen once,
            // as the server keeps it once, and the reply lands under the first asking.
            setMessages((m) => m.filter((x) => x.id !== `u${aid}`)
              .map((x) => (x.role === 'user' && x.content === text && !x.saved ? { ...x, saved: d.userMessageId } : x)));
          }
          else if (event === 'carried') setCarrying(d.map((c) => c.title));
          else if (event === 'status') setStatus(d.label);
          else if (event === 'notice') flash(d.message);
          else if (event === 'error') { failed = true; update({ error: d.message }); }
          else if (event === 'sources') update({ sources: d });
          else if (event === 'done') {
            savedId = d.messageId;
            // their own message gets its saved id too, so it can be made into a PDF
            if (d.userMessageId) setMessages((m) => m.map((x) => (x.id === `u${aid}` ? { ...x, saved: d.userMessageId } : x)));
          }
          else if (event === 'teamReminder') { acted = true; setReminders((rs) => [...rs.filter((x) => x.id !== d.id), d]); toBottom(); }
          else if (event === 'responsibility') { acted = true; setDuties((ps) => [...ps.filter((x) => x.id !== d.id), d]); toBottom(); }
          else if (event === 'inventoryAdd') { acted = true; setStock((ps) => [...ps.filter((x) => x.id !== d.id), d]); toBottom(); }
          else if (event === 'arsBooking') { acted = true; setBookings((bs) => [...bs.filter((x) => x.id !== d.id), d]); toBottom(); }
          else if (event === 'draft') { acted = true; setDrafts((ds) => [...ds.filter((x) => x.id !== d.id), d]); toBottom(); }
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
      if (e.name !== 'AbortError') { failed = true; update({ error: e.message }); }
    }
    // A turn that ends with no words used to leave the three dots bouncing for good, which
    // reads as "still coming" and gets the question asked again. Say what happened instead.
    if (!reply && !failed && acted) setMessages((m) => m.filter((x) => x.id !== aid));
    else if (!reply && !failed) update({ error: ctrl.signal.aborted ? 'Stopped before a reply came.' : 'No reply came through. Please ask again.' });
    update({ streaming: false, saved: savedId });
    // "…convert into pdf": the reply is the PDF's content, so open it straight away.
    if (!voice && savedId && /\bpdf\b/i.test(text) && /<!--\s*doc\s*-->/i.test(reply)) setPdfOf({ id: savedId, content: reply });
    setBusy(false); setOrb('idle'); setStatus('');
    onConversation(null);
    if (voice && reply) say(reply, aid, agentId);
    return { reply, agentId }; // live voice mode reads the reply out itself
  };

  // Delete, as in WhatsApp: the one message goes, here and on the server, and the agent
  // no longer has it. Only a saved message: one still on its way has no row to remove.
  const removeMessage = async (m) => {
    if (!confirm(m.role === 'user' ? 'Delete this message?' : 'Delete this reply?')) return;
    try {
      await api.del(`/messages/${savedIdOf(m)}`);
      if (voice.id === m.id) stopSpeaking();
      setMessages((list) => list.filter((x) => x.id !== m.id));
    } catch (e) { flash(e.message); }
  };

  const lastAgent = byId[[...messages].reverse().find((m) => m.agent_id)?.agent_id];
  // one random suggestion from each agent, so the whole team is visible
  const starters = useMemo(() => agents.filter((a) => a.starters?.length)
    .map((a) => ({ a, s: a.starters[Math.floor(Math.random() * a.starters.length)] })), [agents]);
  const firstName = user.name.split(' ')[0];
  // The two lists are counted apart and named apart — "2 reminders and 1 routine" says
  // where to look, which a bare total would not — but they lead to the same screen.
  const dueNow = useMemo(() => {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [due.todos.length && plural(due.todos.length, 'reminder'), due.routines.length && plural(due.routines.length, 'routine')];
    const count = due.todos.length + due.routines.length;
    return { count, label: `${parts.filter(Boolean).join(' and ')} due`, first: (due.todos[0] || due.routines[0])?.text };
  }, [due]);

  return (
    <div className="relative flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-1 border-b border-stroke/60 px-2 pb-2 pt-safe md:px-4">
        <span className="relative md:hidden">
          <IconBtn icon="menu" label={menuBadge ? 'Menu (new messages)' : 'Menu'} onClick={onMenu} />
          {menuBadge > 0 && <span className="pointer-events-none absolute right-1.5 top-1.5 size-2.5 rounded-full bg-emerald-400 ring-2 ring-bg" />}
        </span>
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
        <IconBtn icon="edit" label="New Reem chat" onClick={onNewChat} />
      </header>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-6 px-5 py-8 text-center">
            {/* Smaller on somebody's very first visit: the orb is the welcome for a
                returning user, but on day one what is under it has to be on the screen. */}
            <Orb state={orb} className={firstRun ? 'w-[min(32vw,132px)]' : 'w-[min(52vw,220px)]'} />
            <div>
              <b className="block text-[21px] font-light">
                {orb === 'listening' ? 'Listening…' : orb === 'thinking' ? 'Thinking…' : firstRun ? `Welcome, ${firstName}` : `Hi ${firstName}`}
              </b>
              <span className="text-sm text-mute">
                {firstRun ? 'Start with one of these. The right agent answers.' : 'Ask anything. The right agent will answer.'}
              </span>
            </div>
            <div className="flex -space-x-2">
              {agents.slice(0, 7).map((a) => <Avatar key={a.id} icon={a.icon} color={a.color} size={30} className="ring-2 ring-bg" />)}
            </div>
            {/* A reminder that has come round is the closest thing this app has to being
                tapped on the shoulder, so it sits above the paperwork warning. Both lists
                are counted here: separate screens, one answer to "what needs me now". */}
            {/* Sent by someone else: each one on its own, with its own Done, because the
                sender is waiting to see that tick and there is no other screen for it. */}
            {(due.fromOthers || []).map((r) => (
              <div key={`from${r.id}`}
                className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-p2/40 bg-p2/[0.09] px-3.5 py-3 text-left">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-p2/20 text-p2"><BellRing size={16} /></span>
                <span className="min-w-0 flex-1">
                  <b className="block text-sm font-medium">{r.text}</b>
                  <span className="block truncate text-xs text-mute">From {r.sender_name}</span>
                  <ReminderPhotos photos={r.photos} className="mt-2" />
                </span>
                <button onClick={() => api.post(`/team-reminders/inbox/${r.id}/done`).then(onDueChanged).catch((e) => flash(e.message))}
                  className="flex shrink-0 items-center gap-1 rounded-full border border-stroke px-3 py-1.5 text-xs hover:border-ok/60 hover:text-ok">
                  <Check size={13} /> Done
                </button>
              </div>
            ))}
            {/* Spotted by Reem in new email and chat. A suggestion, never a reminder until
                "Remind me" is tapped — then it is an ordinary todo on their own list. */}
            {suggested.map((sg) => (
              <div key={`sg${sg.id}`}
                className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-stroke bg-white/[0.04] px-3.5 py-3 text-left">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-warn/15 text-warn"><Lightbulb size={16} /></span>
                <span className="min-w-0 flex-1">
                  <b className="block text-sm font-medium">{sg.text}</b>
                  <span className="block truncate text-xs text-mute">
                    {sg.remind_at ? `${new Date(sg.remind_at * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ` : ''}
                    {sg.why || (sg.source === 'email' ? 'From your email' : 'From your chats')}
                  </span>
                </span>
                <button onClick={() => api.post(`/suggestions/${sg.id}/accept`).then(() => { setSuggested((x) => x.filter((y) => y.id !== sg.id)); onDueChanged?.(); flash('Added to your list'); }).catch((e) => flash(e.message))}
                  className="shrink-0 rounded-full border border-stroke px-3 py-1.5 text-xs hover:border-p1/60 hover:text-p1">
                  Remind me
                </button>
                <button onClick={() => api.post(`/suggestions/${sg.id}/dismiss`).then(() => setSuggested((x) => x.filter((y) => y.id !== sg.id))).catch((e) => flash(e.message))}
                  aria-label="Not needed" title="Not needed" className="-mr-1 shrink-0 text-mute hover:text-txt">
                  <X size={16} />
                </button>
              </div>
            ))}
            {/* Reminders only reach a phone that has said yes. It cannot be switched on for
                them, so this stays until they tap it — unless they have blocked it outright. */}
            {push.state === 'off' && permission() !== 'denied' && (
              <button onClick={() => push.toggle().then((r) => (r.ok ? flash('Notifications are on') : flash(r.reason)))} disabled={push.busy}
                className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-p1/40 bg-p1/[0.09] px-3.5 py-3 text-left transition hover:bg-white/[0.07] disabled:opacity-60">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-p1/20 text-p1"><Bell size={16} /></span>
                <span className="min-w-0 flex-1">
                  <b className="block text-sm font-medium">Turn on notifications</b>
                  <span className="block truncate text-xs text-mute">So reminders reach your phone</span>
                </span>
                <Icon name="chevron" size={16} className="shrink-0 text-mute" />
              </button>
            )}
            {dueNow.count > 0 && onOpenLists && (
              <button onClick={onOpenLists}
                className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-p1/40 bg-p1/[0.09] px-3.5 py-3 text-left transition hover:bg-white/[0.07]">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-p1/20 text-p1"><ListTodo size={16} /></span>
                <span className="min-w-0 flex-1">
                  <b className="block text-sm font-medium">{dueNow.label}</b>
                  <span className="block truncate text-xs text-mute">{dueNow.first}</span>
                </span>
                <Icon name="chevron" size={16} className="shrink-0 text-mute" />
              </button>
            )}
            {expiring.length > 0 && onOpenFiles && (
              <button onClick={onOpenFiles}
                className={`flex w-full max-w-md items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition hover:bg-white/[0.07] ${
                  expiring.some((d) => expiry(d)?.gone) ? 'border-bad/40 bg-bad/[0.07]' : 'border-warn/40 bg-warn/[0.07]'}`}>
                <span className={`grid size-8 shrink-0 place-items-center rounded-full ${expiring.some((d) => expiry(d)?.gone) ? 'bg-bad/20 text-bad' : 'bg-warn/20 text-warn'}`}>
                  <Icon name="file" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <b className="block text-sm font-medium">
                    {expiring.length === 1 ? '1 document needs attention' : `${expiring.length} documents need attention`}
                  </b>
                  {/* The date first: this line is one truncation away from being useless,
                      and a title that runs out of room still leaves the warning readable. */}
                  <span className="block truncate text-xs text-mute">
                    {expiry(expiring[0]).label} · {expiring[0].title || expiring[0].name}
                  </span>
                </span>
                <Icon name="chevron" size={16} className="shrink-0 text-mute" />
              </button>
            )}
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
            {firstRun && <Welcome />}
            <InstallHint />
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
            {messages.map((m, i) => (
              <Message key={m.id} msg={m} agent={byId[m.agent_id]} voiceEnabled={voiceEnabled} onOpenFile={openFile}
                savedId={shareIdOf(m)} drawingFrom={exportAsked(m.content) ? drawingUpTo(messages, i) : undefined}
                voice={voice.id === m.id ? voice.state : 'idle'} onStopSpeak={stopSpeaking}
                onSpeak={() => say(m.content, m.id, m.agent_id)}
                onShare={dm && shareIdOf(m) ? () => setSharing(shareIdOf(m)) : undefined}
                onDelete={savedIdOf(m) && !m.streaming ? () => removeMessage(m) : undefined}
                onPdf={savedIdOf(m) && m.content && !(m.role === 'assistant' && lastDrawing(m.content)) ? () => setPdfOf({ id: savedIdOf(m), content: m.content, own: m.role === 'user' }) : undefined} />
            ))}
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} from={d.from || mailbox}
                onChanged={(u) => setDrafts((ds) => ds.map((x) => (x.id === u.id ? u : x)))}
                onRemoved={(id) => setDrafts((ds) => ds.filter((x) => x.id !== id))} />
            ))}
            {reminders.map((r) => (
              <TeamReminderCard key={r.id} reminder={r}
                onChanged={(u) => setReminders((rs) => rs.map((x) => (x.id === u.id ? u : x)))} />
            ))}
            {duties.map((p) => (
              <ResponsibilityCard key={p.id} proposal={p}
                onChanged={(u) => setDuties((ps) => ps.map((x) => (x.id === u.id ? u : x)))} />
            ))}
            {stock.map((p) => (
              <InventoryCard key={p.id} proposal={p}
                onChanged={(u) => setStock((ps) => ps.map((x) => (x.id === u.id ? u : x)))} />
            ))}
            {bookings.map((b) => (
              <BookingCard key={b.id} booking={b}
                onChanged={(u) => setBookings((bs) => bs.map((x) => (x.id === u.id ? u : x)))} />
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-6xl">
        {/* What this conversation is working from, once something has been brought in: the
            answer to "does this chat have both of those chats in it". */}
        {carrying.length > 0 && (
          <div className="flex items-center gap-2 px-4 pt-1 text-xs text-mute md:px-7">
            <Icon name="history" size={13} className="shrink-0 text-p1" />
            <span className="truncate">Using {carrying.join(' · ')}</span>
          </div>
        )}
        <Composer busy={busy} voiceEnabled={voiceEnabled} carry={carry} onPickChats={() => setPicking(true)}
          onDropChat={(id) => setCarry((c) => c.filter((x) => x.id !== id))}
          onSend={send} onStop={() => abortRef.current?.abort()}
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
      {sharing && (
        <ShareSheet dm={dm} messageId={sharing} onClose={() => setSharing(null)} onDone={flash} />
      )}
      {pdfOf && (
        <PdfSheet messageId={pdfOf.id} content={pdfOf.content} own={pdfOf.own} onOpenFile={openFile} onClose={() => setPdfOf(null)} />
      )}
      {picking && (
        <CarrySheet agents={agents} currentId={convId} picked={carry} onClose={() => setPicking(false)} onDone={setCarry} />
      )}
      {viewer && <FileViewer d={viewer} onClose={() => setViewer(null)} onInfo={(d) => { setViewer(null); setDetails(d); }} />}
      {details && <FileDetail d={details} folders={folders} me={user} onClose={() => setDetails(null)} onChanged={() => {}} />}

      {toast && (
        <div className="rise absolute inset-x-4 top-20 z-30 mx-auto max-w-md rounded-2xl border border-warn/30 bg-[#1d1830]/95 px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
