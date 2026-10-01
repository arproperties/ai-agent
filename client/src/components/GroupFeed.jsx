import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ArrowDown, Download, X, Sparkles, SendHorizontal, ArrowRight, Hash } from 'lucide-react';
import { api } from '../lib/api';
import { onLive } from '../lib/live';
import { PersonAvatar, Bubble, Menu, Composer, NAME_COLORS, dayLabel } from './MessengerChat';

/**
 * The master's page for a whole group: every topic they are in as one timeline, and
 * one box at the bottom. Reem suggests which topic a new message belongs in and the
 * master confirms it with a tap; a reply goes back to the topic of the message it
 * answers, with no guessing. Everyone else only ever writes inside a topic.
 */
export default function GroupFeed({ group, topics, dm, onBack, voiceEnabled }) {
  const me = dm.me;
  const [messages, setMessages] = useState(null);
  const [more, setMore] = useState(false);
  const [reply, setReply] = useState(null);
  const [menu, setMenu] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const [below, setBelow] = useState(0);
  // A message waiting for its topic: { body, file, chatId, routing, choosing, error }
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState({ key: 0, text: '' }); // words handed back to the box
  const scroller = useRef();
  const stick = useRef(true);
  const restore = useRef(null);
  const loadingOlder = useRef(false);
  const groupId = group.id;

  const topicIds = useMemo(() => topics.map((t) => t.id), [topics]);
  const topicKey = topicIds.join(',');
  const byTopic = useMemo(() => Object.fromEntries(topics.map((t) => [t.id, t])), [topics]);
  const nameOf = (m) => (m.userId === me.id ? 'You' : byTopic[m.chatId]?.members.find((x) => x.id === m.userId)?.name
    || dm.people.find((p) => p.id === m.userId)?.name || 'Former member');
  const othersIn = (chatId) => (byTopic[chatId]?.members || []).filter((x) => x.id !== me.id);

  const merge = useCallback((incoming) => setMessages((list) => {
    let next = list || [];
    for (const m of incoming) {
      next = next.filter((x) => !(m.nonce && x.nonce === m.nonce && typeof x.id === 'string'));
      const i = next.findIndex((x) => x.id === m.id);
      next = i >= 0 ? next.map((x, j) => (j === i ? { ...x, ...m } : x)) : [...next, m];
    }
    const real = next.filter((x) => typeof x.id === 'number').sort((a, b) => a.id - b.id);
    return [...real, ...next.filter((x) => typeof x.id !== 'number')];
  }), []);

  // first page, and every topic on it counts as on screen
  useEffect(() => {
    let live = true;
    dm.setActive(topicIds);
    api.get(`/messenger/groups/${groupId}/messages`).then((r) => {
      if (!live) return;
      stick.current = true;
      setMessages(r.messages);
      setMore(r.more);
    }).catch(() => live && setMessages([]));
    return () => { live = false; dm.setActive(null); };
  }, [groupId, topicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastReal = useRef(0);
  useEffect(() => {
    lastReal.current = [...(messages || [])].reverse().find((m) => typeof m.id === 'number')?.id || 0;
  }, [messages]);
  useEffect(() => onLive((event, d) => {
    if (event === 'message' && topicIds.includes(d.chatId)) {
      const el = scroller.current;
      const near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      if (d.userId !== me.id && !near && !d.deleted) setBelow((n) => n + 1);
      stick.current = near || d.userId === me.id;
      merge([d]);
    } else if (event === 'ready' && lastReal.current) {
      api.get(`/messenger/groups/${groupId}/messages?after=${lastReal.current}`).then((r) => merge(r.messages)).catch(() => {});
    }
  }), [groupId, topicKey, me.id, merge]); // eslint-disable-line react-hooks/exhaustive-deps

  // blue ticks, topic by topic, for what is on screen
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !messages) return;
      const top = {};
      for (const m of messages) if (typeof m.id === 'number') top[m.chatId] = Math.max(top[m.chatId] || 0, m.id);
      for (const [chatId, id] of Object.entries(top)) {
        const mine = byTopic[chatId]?.members.find((x) => x.id === me.id);
        if (mine && id > mine.read) dm.markRead(Number(chatId), id);
      }
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [messages, byTopic]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current != null) { el.scrollTop = el.scrollHeight - restore.current; restore.current = null; }
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const loadOlder = async () => {
    if (!more || loadingOlder.current || !messages?.length) return;
    loadingOlder.current = true;
    try {
      const first = messages.find((m) => typeof m.id === 'number');
      if (!first) return;
      const r = await api.get(`/messenger/groups/${groupId}/messages?before=${first.id}`);
      restore.current = scroller.current.scrollHeight - scroller.current.scrollTop;
      stick.current = false;
      setMessages((list) => [...r.messages, ...list]);
      setMore(r.more);
    } finally { loadingOlder.current = false; }
  };
  const onScroll = () => {
    const el = scroller.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    setAtBottom(near);
    if (near) setBelow(0);
    if (el.scrollTop < 120) loadOlder();
  };
  const jump = (id) => {
    const el = document.getElementById(`gm-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.animate([{ background: 'rgb(255 255 255 / 0.12)' }, { background: 'transparent' }], { duration: 1400 });
  };

  // ---------- sending ----------
  const post = async (temp) => {
    const form = new FormData();
    form.append('body', temp.body);
    form.append('nonce', temp.nonce);
    if (temp.replyTo) form.append('replyTo', temp.replyTo.id);
    if (temp.upload) form.append('file', temp.upload);
    try {
      merge([await api.upload(`/messenger/chats/${temp.chatId}/messages`, form)]);
    } catch (e) {
      setMessages((list) => list.map((x) => (x.nonce === temp.nonce && typeof x.id === 'string' ? { ...x, pending: false, failed: e.message } : x)));
    }
  };
  const deliver = ({ body, file, chatId, replyTo = null }) => {
    const nonce = Math.random().toString(36).slice(2, 12);
    const image = file && /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
    const temp = {
      id: `tmp-${nonce}`, nonce, pending: true, chatId, userId: me.id, createdAt: Math.floor(Date.now() / 1000),
      kind: file ? (image ? 'image' : 'file') : 'text', body, deleted: false,
      file: file ? { name: file.name, size: file.size, mime: file.type, url: URL.createObjectURL(file) } : null,
      upload: file || null,
      replyTo: replyTo ? { id: replyTo.id, userId: replyTo.userId, kind: replyTo.kind, body: replyTo.body, fileName: replyTo.file?.name, deleted: false } : null,
    };
    stick.current = true;
    merge([temp]);
    post(temp);
  };
  const retry = (m) => {
    setMessages((list) => list.map((x) => (x.nonce === m.nonce ? { ...x, pending: true, failed: false } : x)));
    post(m);
  };

  // The box: a reply knows its topic; anything else is routed, then confirmed.
  const send = async ({ body, file }) => {
    if (reply) {
      const to = reply;
      setReply(null);
      return deliver({ body, file, chatId: to.chatId, replyTo: to });
    }
    if (topics.length === 1) return deliver({ body, file, chatId: topics[0].id });
    setPending({ body, file, chatId: null, routing: true });
    try {
      const { chatId } = await api.post(`/messenger/groups/${groupId}/route`, { text: body });
      setPending((p) => p && { ...p, routing: false, chatId, choosing: !chatId });
    } catch (e) {
      setPending((p) => p && { ...p, routing: false, choosing: true, error: e.message });
    }
  };
  const confirm = () => {
    if (!pending?.chatId) return;
    deliver(pending);
    setPending(null);
  };
  const callBack = () => {
    setDraft((d) => ({ key: d.key + 1, text: pending?.body || '' }));
    setPending(null);
  };

  const remove = async (m) => {
    setMenu(null);
    if (!window.confirm('Delete this message for everyone?')) return;
    try { await api.del(`/messenger/messages/${m.id}`); } catch (e) { alert(e.message); }
  };
  const copy = (m) => {
    setMenu(null);
    navigator.clipboard?.writeText(m.body || m.file?.name || '').catch(() => {});
  };

  let prevDay = null;
  let prev = null;
  const chosen = pending?.chatId ? byTopic[pending.chatId] : null;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="z-10 flex items-center gap-2 border-b border-white/[0.06] bg-[#13112a]/85 px-2 pb-2 pt-safe backdrop-blur-xl md:px-4">
        <button onClick={onBack} aria-label="Back to topics" className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt md:hidden">
          <ChevronLeft size={24} />
        </button>
        <PersonAvatar id={group.id} size={42} group />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-medium">{group.name}</span>
          <span className="block truncate text-xs text-mute">All topics · {topics.map((t) => t.name).join(', ')}</span>
        </span>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
       <div className="mx-auto w-full max-w-6xl px-4 pb-4 md:px-10">
        {messages === null && <p className="py-10 text-center text-sm text-mute">Loading…</p>}
        {more && <p className="py-3 text-center text-xs text-mute">Loading earlier messages…</p>}
        {messages?.length === 0 && (
          <p className="mx-auto mt-16 max-w-xs text-center text-sm text-mute">Nothing said in this group yet. Type below and Reem will put it in the right topic.</p>
        )}
        {messages?.map((m) => {
          const d = new Date(m.createdAt * 1000).toDateString();
          const newDay = d !== prevDay;
          prevDay = d;
          const first = newDay || !prev || prev.userId !== m.userId || prev.chatId !== m.chatId || prev.kind === 'system' || m.createdAt - prev.createdAt > 300;
          prev = m;
          const mine = m.userId === me.id;
          const topic = byTopic[m.chatId];
          const withName = m.replyTo ? { ...m, replyTo: { ...m.replyTo, name: nameOf({ userId: m.replyTo.userId, chatId: m.chatId }) } } : m;
          return (
            <div key={m.nonce || m.id} id={typeof m.id === 'number' ? `gm-${m.id}` : undefined} className="rounded-xl">
              {newDay && (
                <div className="sticky top-2 z-[5] my-3 flex justify-center">
                  <span className="rounded-full border border-white/[0.06] bg-[#1b1834]/90 px-3.5 py-1 text-xs font-medium text-mute shadow-md backdrop-blur">{dayLabel(m.createdAt)}</span>
                </div>
              )}
              {m.kind === 'system' ? (
                <div className="my-2 flex justify-center">
                  <span className="max-w-[85%] rounded-full bg-[#1b1834]/80 px-3.5 py-1 text-center text-xs text-mute backdrop-blur">#{topic?.name} · {m.body}</span>
                </div>
              ) : (
                <Bubble m={withName} mine={mine} first={first} others={othersIn(m.chatId)} tag={first ? topic?.name : null}
                  showName={!mine && first} sender={nameOf(m)} nameColor={NAME_COLORS[m.userId % NAME_COLORS.length]}
                  onMenu={(msg, x, y) => setMenu({ m: msg, x, y })} onReply={setReply} onRetry={retry} onView={setViewing} onJump={jump} />
              )}
            </div>
          );
        })}
       </div>
      </div>

      {!atBottom && (
        <button onClick={() => { scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); setBelow(0); }} aria-label="Jump to the latest message"
          className="absolute bottom-24 right-4 grid size-11 place-items-center rounded-full border border-white/10 bg-[#1b1834]/95 text-txt shadow-xl backdrop-blur md:right-8">
          <ArrowDown size={20} />
          {below > 0 && <span className="absolute -top-1.5 -right-1 grid min-w-5 place-items-center rounded-full bg-emerald-500 px-1 text-[11px] font-semibold">{below}</span>}
        </button>
      )}

      {pending ? (
        <div className="border-t border-white/[0.06] bg-[#13112a]/85 px-3 pb-safe pt-3 backdrop-blur-xl md:px-4">
         <div className="mx-auto max-w-6xl space-y-2.5 pb-2">
          <p className="line-clamp-2 rounded-xl bg-white/5 px-3 py-2 text-sm text-txt/90">{pending.body || (pending.file ? `📎 ${pending.file.name}` : '')}</p>
          {pending.routing ? (
            <p className="flex items-center gap-2 text-sm text-mute"><Sparkles size={15} className="animate-pulse text-emerald-300" /> Reem is picking the topic…</p>
          ) : pending.choosing || !chosen ? (
            <>
              <p className="text-sm text-mute">{pending.error || 'Which topic should this go in?'}</p>
              <div className="flex flex-wrap gap-2">
                {topics.map((t) => (
                  <button key={t.id} onClick={() => setPending((p) => ({ ...p, chatId: t.id, choosing: false, error: null }))}
                    className={`flex items-center gap-1 rounded-full px-3.5 py-1.5 text-sm transition ${t.id === pending.chatId ? 'bg-emerald-500 text-white' : 'bg-white/[0.07] text-txt hover:bg-white/15'}`}>
                    <Hash size={13} /> {t.name}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <ArrowRight size={16} className="shrink-0 text-emerald-300" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium"># {chosen.name}</span>
                <span className="text-xs text-mute"> · {chosen.members.filter((x) => x.id !== me.id).map((x) => x.name.split(' ')[0]).join(', ')}</span>
              </span>
              <button onClick={() => setPending((p) => ({ ...p, choosing: true }))} className="shrink-0 rounded-full bg-white/10 px-3.5 py-1.5 text-sm hover:bg-white/15">Change</button>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={callBack} className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15"><X size={15} /> Cancel</button>
            <button onClick={confirm} disabled={!chosen || pending.routing}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-500/30 disabled:opacity-40 disabled:shadow-none">
              <SendHorizontal size={16} /> {chosen ? `Send to # ${chosen.name}` : 'Send'}
            </button>
          </div>
         </div>
        </div>
      ) : (
        <Composer key={draft.key} chatId={null} initial={draft.text} voiceEnabled={voiceEnabled}
          reply={reply} replyName={reply && `${nameOf(reply)} · # ${byTopic[reply.chatId]?.name || ''}`} onCancelReply={() => setReply(null)}
          placeholder={topics.length > 1 ? 'Message — Reem picks the topic' : 'Type a message'} onSend={send} />
      )}

      {menu && (
        <Menu at={menu} mine={menu.m.userId === me.id} onClose={() => setMenu(null)}
          onReply={() => { setReply(menu.m); setMenu(null); }} onCopy={() => copy(menu.m)} onDelete={() => remove(menu.m)} />
      )}
      {viewing && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => setViewing(null)}>
          <img src={viewing} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          <a href={`${viewing}?download=1`} onClick={(e) => e.stopPropagation()} aria-label="Download"
            className="absolute right-16 top-[max(env(safe-area-inset-top),16px)] grid size-10 place-items-center rounded-full bg-white/10 text-white"><Download size={20} /></a>
          <button aria-label="Close" className="absolute right-4 top-[max(env(safe-area-inset-top),16px)] grid size-10 place-items-center rounded-full bg-white/10 text-white"><X size={20} /></button>
        </div>,
        document.body,
      )}
    </div>
  );
}
