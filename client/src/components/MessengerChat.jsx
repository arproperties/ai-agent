import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft, Check, CheckCheck, Clock, AlertCircle, Paperclip, SendHorizontal, Reply, Copy, Trash2,
  X, ArrowDown, FileText, Download, Users, ChevronDown, Ban, Smile, Info,
} from 'lucide-react';
import { api } from '../lib/api';
import { onLive } from '../lib/live';

// ---------- small shared helpers (also used by Messenger.jsx) ----------
const SHADES = ['from-emerald-400 to-teal-600', 'from-sky-400 to-indigo-500', 'from-amber-300 to-orange-500',
  'from-rose-400 to-pink-600', 'from-violet-400 to-fuchsia-500', 'from-lime-400 to-green-600', 'from-cyan-400 to-blue-600'];
const NAME_COLORS = ['text-emerald-300', 'text-sky-300', 'text-amber-300', 'text-rose-300', 'text-violet-300', 'text-lime-300', 'text-cyan-300', 'text-pink-300'];

export const initials = (name = '?') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

export function PersonAvatar({ id = 0, name, size = 44, group = false, online = false }) {
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <span style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
        className={`grid place-items-center rounded-full bg-gradient-to-br font-medium text-white ${SHADES[id % SHADES.length]}`}>
        {group ? <Users size={Math.round(size * 0.45)} strokeWidth={1.75} /> : initials(name)}
      </span>
      {online && <span className="absolute bottom-0 right-0 size-3 rounded-full border-2 border-bg bg-ok" />}
    </span>
  );
}

const pad = (n) => String(n).padStart(2, '0');
export const clock = (ts) => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** "14:05" today, "Yesterday", "Mon" this week, otherwise "3 Sep". */
export function listTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (sameDay(d, now)) return clock(ts);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
export function lastSeenText(ts) {
  if (!ts) return '';
  const label = dayLabel(ts);
  return `last seen ${label === 'Today' ? 'today' : label === 'Yesterday' ? 'yesterday' : label} at ${clock(ts)}`;
}
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** A one-line summary of a message, for the chat list and reply quotes. */
export function preview(m) {
  if (!m) return '';
  if (m.deleted) return 'This message was deleted';
  if (m.kind === 'image') return m.body ? `📷 ${m.body}` : '📷 Photo';
  if (m.kind === 'file') return `📄 ${m.body || m.file?.name || m.fileName || 'File'}`;
  return m.body;
}

/** Ticks on your own message: one grey, two grey (delivered), two blue (read). */
export function Ticks({ m, others, className = '' }) {
  if (m.failed) return <AlertCircle size={14} className={`text-bad ${className}`} />;
  if (m.pending) return <Clock size={13} className={`text-white/55 ${className}`} />;
  const read = others.length > 0 && others.every((o) => o.read >= m.id);
  const delivered = others.length > 0 && others.every((o) => o.delivered >= m.id);
  if (read) return <CheckCheck size={16} className={`text-sky-400 ${className}`} />;
  if (delivered) return <CheckCheck size={16} className={`text-white/55 ${className}`} />;
  return <Check size={15} className={`text-white/55 ${className}`} />;
}

// links in a message become tappable
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
function Linked({ text }) {
  return text.split(URL_RE).map((part, i) => (i % 2
    ? <a key={i} href={part} target="_blank" rel="noreferrer noopener" className="break-all text-sky-300 underline">{part}</a>
    : part));
}

const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// One to three emoji on their own are shown large, without a bubble, as in WhatsApp.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\s)+$/u;
const bigEmoji = (t) => !!t && t.length <= 20 && EMOJI_ONLY.test(t) && (t.match(/\p{Extended_Pictographic}/gu) || []).length <= 3;

const MINE = '#005c4b';
const THEIRS = '#252140';

// ---------- one message ----------
function Bubble({ m, mine, showName, sender, nameColor, others, first, onMenu, onReply, onRetry, onView, onJump }) {
  const [dx, setDx] = useState(0);
  const touch = useRef(null);
  const press = useRef(null);

  const start = (e) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, swiping: false };
    press.current = setTimeout(() => { press.current = null; touch.current = null; setDx(0); onMenu(m, t.clientX, t.clientY); }, 480);
  };
  const move = (e) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const x = t.clientX - s.x; const y = t.clientY - s.y;
    if (Math.abs(x) > 8 || Math.abs(y) > 8) { clearTimeout(press.current); press.current = null; }
    if (!s.swiping && x > 12 && Math.abs(y) < 16) s.swiping = true;
    if (s.swiping && !m.deleted) setDx(Math.max(0, Math.min(80, x)));
  };
  const end = () => {
    clearTimeout(press.current); press.current = null;
    if (dx > 56) onReply(m);
    setDx(0); touch.current = null;
  };

  const canAct = !m.pending && !m.failed;
  const big = m.kind === 'text' && !m.deleted && !m.replyTo && bigEmoji(m.body);
  const tail = first && !big ? (mine ? 'rounded-tr-none' : 'rounded-tl-none') : '';

  return (
    <div className={`group relative flex ${mine ? 'justify-end' : 'justify-start'} ${first ? 'mt-2' : 'mt-0.5'}`}>
      {dx > 0 && <Reply size={18} className="absolute left-1 top-1/2 -translate-y-1/2 text-mute" style={{ opacity: dx / 60 }} />}
      <div
        onTouchStart={canAct ? start : undefined} onTouchMove={canAct ? move : undefined} onTouchEnd={canAct ? end : undefined}
        onContextMenu={(e) => { if (!canAct) return; e.preventDefault(); onMenu(m, e.clientX, e.clientY); }}
        onClick={m.failed ? () => onRetry(m) : undefined}
        className={`relative max-w-[82%] select-none rounded-2xl md:max-w-[65%] md:select-text [-webkit-touch-callout:none]
          ${big ? 'px-1 pb-5 pt-0' : `px-2.5 pb-1.5 pt-1.5 shadow-[0_1px_1.5px_rgb(0_0_0/0.35)] ${mine ? 'text-white' : 'text-txt'}`}
          ${tail} ${m.failed ? 'cursor-pointer ring-1 ring-bad/60' : ''}`}
        style={{ background: big ? 'transparent' : mine ? MINE : THEIRS, transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .2s' }}>
        {/* the little corner tail on the first bubble of a run */}
        {first && !big && (
          <svg viewBox="0 0 8 13" width="8" height="13" aria-hidden="true" className={`absolute top-0 ${mine ? '-right-2' : '-left-2'}`}
            style={mine ? undefined : { transform: 'scaleX(-1)' }}>
            <path d="M0 0h6.5c1.3 0 1.9 1.5 1 2.4L0 11z" fill={mine ? MINE : THEIRS} />
          </svg>
        )}
        {canAct && !isTouch && (
          <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(m, r.left, r.bottom); }} aria-label="Message options"
            style={{ background: big ? 'rgb(0 0 0 / 0.4)' : mine ? MINE : THEIRS }}
            className="absolute right-1 top-1 z-10 grid size-6 place-items-center rounded-full opacity-0 transition group-hover:opacity-100">
            <ChevronDown size={16} className="text-white/70" />
          </button>
        )}
        {showName && <div className={`mb-0.5 text-[13px] font-medium ${nameColor}`}>{sender}</div>}

        {m.replyTo && (
          <button onClick={() => onJump(m.replyTo.id)}
            className={`mb-1 block w-full rounded-lg border-l-4 px-2 py-1 text-left text-[13px] ${mine ? 'border-emerald-300 bg-black/20' : 'border-p1 bg-white/5'}`}>
            <span className="block truncate font-medium text-emerald-200">{m.replyTo.name}</span>
            <span className="line-clamp-2 text-white/70">{m.replyTo.deleted ? 'This message was deleted' : preview({ ...m.replyTo, file: null })}</span>
          </button>
        )}

        {m.deleted ? (
          <span className="inline-flex items-center gap-1.5 italic text-white/55"><Ban size={14} /> This message was deleted</span>
        ) : (
          <>
            {m.kind === 'image' && m.file && (
              <button onClick={() => onView(m.file.url)} className="mb-1 block overflow-hidden rounded-xl">
                <img src={m.file.url} alt={m.file.name} loading="lazy" className="max-h-80 min-h-24 w-full min-w-40 max-w-72 object-cover" />
              </button>
            )}
            {m.kind === 'file' && m.file && (
              <a href={m.pending ? undefined : `${m.file.url}?download=1`} download={m.file.name}
                className="mb-1 flex items-center gap-2.5 rounded-xl bg-black/20 p-2.5 pr-3">
                <FileText size={28} className="shrink-0 text-white/80" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.file.name}</span>
                  <span className="text-xs text-white/55">{size(m.file.size)}</span>
                </span>
                {!m.pending && <Download size={18} className="shrink-0 text-white/70" />}
              </a>
            )}
            {m.body && m.kind !== 'file' && (big
              ? <span className="text-5xl leading-tight">{m.body}</span>
              : <span className="whitespace-pre-wrap break-words text-[15px] leading-snug"><Linked text={m.body} /></span>)}
            {m.kind === 'file' && m.body && m.body !== m.file?.name && (
              <span className="whitespace-pre-wrap break-words text-[15px] leading-snug"><Linked text={m.body} /></span>
            )}
          </>
        )}
        {/* the invisible spacer keeps the time from sitting on top of the last word */}
        {!big && <span className={`invisible inline-block align-bottom ${mine ? 'w-[4.25rem]' : 'w-10'}`} aria-hidden="true" />}
        <span className={`absolute bottom-1 right-2 flex items-center gap-1 text-[11px] leading-none text-white/55 ${big ? 'rounded-full bg-black/40 px-1.5 py-0.5' : ''}`}>
          {m.failed ? <span className="text-bad">Tap to retry</span> : clock(m.createdAt)}
          {mine && <Ticks m={m} others={others} />}
        </span>
      </div>
    </div>
  );
}

// ---------- the long-press / right-click menu ----------
function Menu({ at, mine, onClose, onReply, onCopy, onDelete }) {
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const w = 200; const h = mine ? 150 : 104;
  const left = Math.min(Math.max(8, at.x - (mine ? w : 0)), window.innerWidth - w - 8);
  const top = Math.min(at.y, window.innerHeight - h - 8);
  const item = 'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-white/10';
  return createPortal(
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ left, top, width: w }}
        className="rise absolute overflow-hidden rounded-2xl border border-stroke bg-[#1b1834] py-1 shadow-2xl shadow-black/60">
        <button className={item} onClick={onReply}><Reply size={17} /> Reply</button>
        <button className={item} onClick={onCopy}><Copy size={17} /> Copy</button>
        {mine && <button className={`${item} text-bad`} onClick={onDelete}><Trash2 size={17} /> Delete for everyone</button>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- typing box ----------
const EMOJI = ['😀', '😂', '🥰', '😍', '😊', '😉', '😎', '🤔', '😅', '😭', '😢', '😮', '😡', '🥳', '😴', '🤗',
  '👍', '👎', '👏', '🙏', '💪', '👌', '🤝', '🙌', '👋', '🤲', '❤️', '💚', '🔥', '🎉', '✨', '💯',
  '✅', '❌', '⭐', '📌', '📎', '📅', '⏰', '📞', '📧', '🏠', '🏢', '💼', '💰', '🚗', '✈️', '☕'];

function Composer({ chatId, reply, onCancelReply, replyName, onSend }) {
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const [file, setFile] = useState(null);
  const box = useRef();
  const pick = useRef();
  const lastTyping = useRef(0);
  const thumb = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => thumb && URL.revokeObjectURL(thumb), [thumb]);

  useEffect(() => { if (reply) box.current?.focus(); }, [reply]);
  // grow with the text, up to about six lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const change = (v) => {
    setText(v);
    if (v && Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      api.post(`/messenger/chats/${chatId}/typing`).catch(() => {});
    }
  };
  const addEmoji = (e) => {
    const el = box.current;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    change(text.slice(0, at) + e + text.slice(end));
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + e.length; } });
  };
  const send = () => {
    const body = text.trim();
    if (!body && !file) return;
    onSend({ body, file });
    setText(''); setFile(null); lastTyping.current = 0;
    box.current?.focus();
  };

  return (
    <div className="relative border-t border-white/[0.06] bg-[#13112a]/85 px-2 pb-safe pt-2 backdrop-blur-xl md:px-4">
     <div className="mx-auto max-w-4xl">
      {(reply || file) && (
        <div className="mb-2 space-y-2">
          {reply && (
            <div className="flex items-center gap-2 rounded-xl border-l-4 border-emerald-400 bg-white/5 py-1.5 pl-3 pr-1">
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="block font-medium text-emerald-300">{replyName}</span>
                <span className="line-clamp-1 text-mute">{preview(reply)}</span>
              </span>
              <button onClick={onCancelReply} aria-label="Cancel reply" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10"><X size={16} /></button>
            </div>
          )}
          {file && (
            <div className="flex items-center gap-3 rounded-xl bg-white/5 p-2 pr-1">
              {thumb ? <img src={thumb} alt="" className="size-12 rounded-lg object-cover" /> : <FileText size={28} className="ml-1 text-mute" />}
              <span className="min-w-0 flex-1 text-sm">
                <span className="block truncate">{file.name}</span>
                <span className="text-xs text-mute">{size(file.size)} · add a caption below, or just send</span>
              </span>
              <button onClick={() => setFile(null)} aria-label="Remove file" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10"><X size={16} /></button>
            </div>
          )}
        </div>
      )}
      {emoji && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setEmoji(false)} />
          <div className="rise absolute bottom-full left-2 z-50 mb-2 grid w-[min(22rem,calc(100vw-1rem))] grid-cols-8 gap-0.5 rounded-2xl border border-stroke bg-[#1b1834]/95 p-2 shadow-2xl shadow-black/60 backdrop-blur-xl md:left-4">
            {EMOJI.map((e) => (
              <button key={e} onClick={() => addEmoji(e)} className="grid aspect-square place-items-center rounded-lg text-2xl transition hover:scale-110 hover:bg-white/10">{e}</button>
            ))}
          </div>
        </>
      )}
      <div className="flex items-end gap-2">
        <input ref={pick} type="file" hidden onChange={(e) => { const f = e.target.files[0]; if (f) setFile(f); e.target.value = ''; }} />
        <div className="flex min-w-0 flex-1 items-end rounded-[24px] border border-white/10 bg-white/[0.07] transition focus-within:border-emerald-400/50 focus-within:bg-white/[0.09]">
          <button onClick={() => setEmoji((v) => !v)} aria-label="Emoji" title="Emoji"
            className={`grid size-11 shrink-0 place-items-center rounded-full transition hover:text-txt ${emoji ? 'text-emerald-300' : 'text-mute'}`}>
            <Smile size={22} />
          </button>
          <textarea ref={box} rows={1} value={text} placeholder="Type a message"
            onChange={(e) => change(e.target.value)}
            onPaste={(e) => { const f = e.clipboardData?.files?.[0]; if (f) { e.preventDefault(); setFile(f); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 leading-snug outline-none placeholder:text-mute/70" />
          <button onClick={() => pick.current.click()} aria-label="Attach a photo or file" title="Attach a photo or file"
            className="grid size-11 shrink-0 place-items-center rounded-full text-mute transition hover:text-txt">
            <Paperclip size={20} />
          </button>
        </div>
        <button onClick={send} aria-label="Send" disabled={!text.trim() && !file}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg shadow-emerald-500/30 transition hover:brightness-110 active:scale-95 disabled:opacity-45 disabled:shadow-none">
          <SendHorizontal size={20} />
        </button>
      </div>
     </div>
    </div>
  );
}

// ---------- the conversation ----------
export default function MessengerChat({ chat, dm, onBack, onInfo }) {
  const me = dm.me;
  const [messages, setMessages] = useState(null);
  const [more, setMore] = useState(false);
  const [reply, setReply] = useState(null);
  const [menu, setMenu] = useState(null); // { m, x, y }
  const [viewing, setViewing] = useState(null);
  const [below, setBelow] = useState(0); // new messages that arrived while scrolled up
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef();
  const stick = useRef(true); // follow new messages while the reader is at the bottom
  const restore = useRef(null); // keep the place when older messages load above
  const loadingOlder = useRef(false);
  const chatId = chat.id;

  const byId = Object.fromEntries(chat.members.map((m) => [m.id, m]));
  const nameOf = (id) => (id === me.id ? 'You' : byId[id]?.name || 'Former member');
  const others = chat.members.filter((m) => m.id !== me.id);
  const colorOf = (id) => NAME_COLORS[id % NAME_COLORS.length];

  // real messages in id order; "sending…" ones stay at the end until the server has them
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

  // first page
  useEffect(() => {
    let live = true;
    dm.setActive(chatId);
    api.get(`/messenger/chats/${chatId}/messages`).then((r) => {
      if (!live) return;
      stick.current = true;
      setMessages(r.messages);
      setMore(r.more);
    }).catch(() => live && setMessages([]));
    return () => { live = false; dm.setActive(null); };
  }, [chatId, dm.setActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: new and deleted messages; after a reconnect, whatever was missed
  const lastReal = useRef(0);
  useEffect(() => {
    lastReal.current = [...(messages || [])].reverse().find((m) => typeof m.id === 'number')?.id || 0;
  }, [messages]);
  useEffect(() => onLive((event, d) => {
    if (event === 'message' && d.chatId === chatId) {
      const el = scroller.current;
      const near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      if (d.userId !== me.id && !near && !d.deleted) setBelow((n) => n + 1);
      stick.current = near || d.userId === me.id;
      merge([d]);
    } else if (event === 'ready' && lastReal.current) {
      api.get(`/messenger/chats/${chatId}/messages?after=${lastReal.current}`).then((r) => merge(r.messages)).catch(() => {});
    }
  }), [chatId, me.id, merge]);

  // blue ticks for the other side, once the messages are actually on screen
  const myRead = byId[me.id]?.read || 0;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !lastReal.current) return;
      if (lastReal.current > myRead) dm.markRead(chatId, lastReal.current);
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [messages, myRead, chatId, dm.markRead]); // eslint-disable-line react-hooks/exhaustive-deps

  // scrolling: stay at the bottom for new messages, hold position when older ones load
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current != null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const loadOlder = async () => {
    if (!more || loadingOlder.current || !messages?.length) return;
    loadingOlder.current = true;
    try {
      const first = messages.find((m) => typeof m.id === 'number');
      if (!first) return;
      const r = await api.get(`/messenger/chats/${chatId}/messages?before=${first.id}`);
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
  const toBottom = () => {
    const el = scroller.current;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setBelow(0);
  };
  const jump = (id) => {
    const el = document.getElementById(`dm-${id}`);
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
      merge([await api.upload(`/messenger/chats/${chatId}/messages`, form)]);
    } catch (e) {
      setMessages((list) => list.map((x) => (x.nonce === temp.nonce && typeof x.id === 'string' ? { ...x, pending: false, failed: e.message } : x)));
    }
  };
  const send = ({ body, file }) => {
    const nonce = Math.random().toString(36).slice(2, 12);
    const image = file && /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
    const temp = {
      id: `tmp-${nonce}`, nonce, pending: true, chatId, userId: me.id, createdAt: Math.floor(Date.now() / 1000),
      kind: file ? (image ? 'image' : 'file') : 'text', body, deleted: false,
      file: file ? { name: file.name, size: file.size, mime: file.type, url: URL.createObjectURL(file) } : null,
      upload: file || null,
      replyTo: reply ? { id: reply.id, userId: reply.userId, kind: reply.kind, body: reply.body, fileName: reply.file?.name, deleted: false } : null,
    };
    stick.current = true;
    setReply(null);
    merge([temp]);
    post(temp);
  };
  const retry = (m) => {
    setMessages((list) => list.map((x) => (x.nonce === m.nonce ? { ...x, pending: true, failed: false } : x)));
    post(m);
  };

  const remove = async (m) => {
    setMenu(null);
    if (!confirm('Delete this message for everyone?')) return;
    try { await api.del(`/messenger/messages/${m.id}`); } catch (e) { alert(e.message); }
  };
  const copy = (m) => {
    setMenu(null);
    navigator.clipboard?.writeText(m.body || m.file?.name || '').catch(() => {});
  };

  // ---------- header line ----------
  const typers = Object.keys(dm.typing[chatId] || {}).map(Number).filter((id) => id !== me.id);
  let status;
  if (typers.length) {
    status = <span className="text-emerald-300">{chat.kind === 'group' ? `${typers.map((id) => byId[id]?.name?.split(' ')[0]).filter(Boolean).join(', ')} typing…` : 'typing…'}</span>;
  } else if (chat.kind === 'direct') {
    status = dm.online.has(chat.peerId) ? 'online' : lastSeenText(dm.lastSeen[chat.peerId]);
  } else {
    status = chat.members.map((m) => (m.id === me.id ? 'You' : m.name)).join(', ');
  }

  // ---------- drag a file onto the chat (desktop) ----------
  const drop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) send({ body: '', file: f });
  };

  let prevDay = null;
  let prev = null;
  return (
    <div className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={drop}>
      <header className="z-10 flex items-center gap-2 border-b border-white/[0.06] bg-[#13112a]/85 px-2 pb-2 pt-safe backdrop-blur-xl md:px-4">
        <button onClick={onBack} aria-label="Back to chats" className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt md:hidden">
          <ChevronLeft size={24} />
        </button>
        <button onClick={onInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 pr-2 text-left hover:bg-white/5">
          <PersonAvatar id={chat.kind === 'group' ? chat.id : chat.peerId} name={chat.name} size={42} group={chat.kind === 'group'}
            online={chat.kind === 'direct' && dm.online.has(chat.peerId)} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-medium">{chat.name}</span>
            <span className="block truncate text-xs text-mute">{status || ' '}</span>
          </span>
        </button>
        <button onClick={onInfo} aria-label={chat.kind === 'group' ? 'Group info' : 'Contact info'} title={chat.kind === 'group' ? 'Group info' : 'Contact info'}
          className="grid size-10 shrink-0 place-items-center rounded-full text-mute transition hover:bg-white/10 hover:text-txt">
          <Info size={20} />
        </button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="dm-wallpaper min-h-0 flex-1 overflow-y-auto">
       <div className="mx-auto w-full max-w-4xl px-4 pb-4 md:px-10">
        {messages === null && <p className="py-10 text-center text-sm text-mute">Loading…</p>}
        {more && <p className="py-3 text-center text-xs text-mute">Loading earlier messages…</p>}
        {messages?.length === 0 && (
          <div className="mx-auto mt-16 flex max-w-xs flex-col items-center gap-3 rounded-3xl border border-white/[0.06] bg-[#1b1834]/80 px-6 py-6 text-center shadow-xl backdrop-blur">
            <PersonAvatar id={chat.kind === 'group' ? chat.id : chat.peerId} name={chat.name} size={64} group={chat.kind === 'group'} />
            <p className="text-sm text-mute">Say hello to {chat.kind === 'group' ? 'the group' : chat.name.split(' ')[0]}</p>
            <span className="text-4xl">👋</span>
          </div>
        )}
        {messages?.map((m) => {
          const d = new Date(m.createdAt * 1000).toDateString();
          const newDay = d !== prevDay;
          prevDay = d;
          const first = newDay || !prev || prev.userId !== m.userId || prev.kind === 'system' || m.createdAt - prev.createdAt > 300;
          prev = m;
          const mine = m.userId === me.id;
          const withName = m.replyTo ? { ...m, replyTo: { ...m.replyTo, name: nameOf(m.replyTo.userId) } } : m;
          return (
            // keyed by the nonce while there is one, so "sending…" turning real does not redraw it
            <div key={m.nonce || m.id} id={typeof m.id === 'number' ? `dm-${m.id}` : undefined} className="rounded-xl">
              {newDay && (
                <div className="sticky top-2 z-[5] my-3 flex justify-center">
                  <span className="rounded-full border border-white/[0.06] bg-[#1b1834]/90 px-3.5 py-1 text-xs font-medium text-mute shadow-md backdrop-blur">{dayLabel(m.createdAt)}</span>
                </div>
              )}
              {m.kind === 'system' ? (
                <div className="my-2 flex justify-center">
                  <span className="max-w-[85%] rounded-full bg-[#1b1834]/80 px-3.5 py-1 text-center text-xs text-mute backdrop-blur">{m.body}</span>
                </div>
              ) : (
                <Bubble m={withName} mine={mine} first={first} others={others}
                  showName={chat.kind === 'group' && !mine && first} sender={nameOf(m.userId)} nameColor={colorOf(m.userId)}
                  onMenu={(msg, x, y) => setMenu({ m: msg, x, y })} onReply={setReply} onRetry={retry} onView={setViewing} onJump={jump} />
              )}
            </div>
          );
        })}
       </div>
      </div>

      {!atBottom && (
        <button onClick={toBottom} aria-label="Jump to the latest message"
          className="absolute bottom-24 right-4 grid size-11 place-items-center rounded-full border border-white/10 bg-[#1b1834]/95 text-txt shadow-xl backdrop-blur md:right-8">
          <ArrowDown size={20} />
          {below > 0 && <span className="absolute -top-1.5 -right-1 grid min-w-5 place-items-center rounded-full bg-emerald-500 px-1 text-[11px] font-semibold">{below}</span>}
        </button>
      )}

      <Composer chatId={chatId} reply={reply} replyName={reply && nameOf(reply.userId)} onCancelReply={() => setReply(null)} onSend={send} />

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
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-2 border-dashed border-emerald-400/70 bg-bg/80 text-emerald-300">
          Drop to send
        </div>
      )}
    </div>
  );
}
