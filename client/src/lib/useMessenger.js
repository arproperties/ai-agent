import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { startLive, stopLive, onLive } from './live';

// A soft two-note blip for an incoming message. iOS only lets a page make sound after
// the person has touched it once, so the audio is unlocked on the first tap.
let audio = null;
if (typeof window !== 'undefined') {
  const unlock = () => {
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no audio */ }
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
}
function blip() {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.09]]) {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t + at); o.stop(t + at + 0.18);
    }
  } catch { /* ignore */ }
}

const TYPING_MS = 4500;
const lastAt = (c) => c.last?.createdAt || c.createdAt || 0;
const sortChats = (list) => [...list].sort((a, b) => lastAt(b) - lastAt(a) || b.id - a.id);

/**
 * Everything the Messages screen and the unread badges share: the chat list, who is
 * online, who is typing. Lives in App so the badge keeps counting while the screen is shut.
 */
export function useMessenger(me) {
  const [chats, setChats] = useState(null); // null until the first load
  const [people, setPeople] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [lastSeen, setLastSeen] = useState({});
  const [typing, setTyping] = useState({}); // chatId -> { userId: until }
  const active = useRef(null); // the chat on screen, whose messages count as read
  const known = useRef(null); // the list as of the last render, readable from the live handler
  known.current = chats;
  const meId = me?.id;

  const loadChats = useCallback(() => api.get('/messenger/chats').then((l) => setChats(sortChats(l))).catch(() => {}), []);
  const loadPeople = useCallback(() => api.get('/messenger/people').then((ps) => {
    setPeople(ps);
    setLastSeen((s) => ({ ...Object.fromEntries(ps.map((p) => [p.id, p.lastSeen])), ...s }));
  }).catch(() => {}), []);

  const upsert = useCallback((chat) => setChats((l) => sortChats([...(l || []).filter((c) => c.id !== chat.id), chat])), []);
  const refreshChat = useCallback((id) => api.get(`/messenger/chats/${id}`).then(upsert).catch(() => {
    setChats((l) => (l || []).filter((c) => c.id !== id));
  }), [upsert]);

  useEffect(() => {
    if (!meId) return undefined;
    startLive();
    loadChats(); // straight away, not only once the live line is up
    loadPeople();
    const off = onLive((event, d) => {
      if (event === 'ready') {
        setOnline(new Set(d.online));
        loadChats(); // after a reconnect: whatever arrived while the line was down
      } else if (event === 'message') {
        const mine = d.userId === meId;
        const seen = mine || d.kind === 'system' || (active.current === d.chatId && document.visibilityState === 'visible');
        if (!known.current?.some((c) => c.id === d.chatId)) refreshChat(d.chatId); // a chat new to this app
        setChats((l) => {
          const c = (l || []).find((x) => x.id === d.chatId);
          if (!c) return l;
          const isNew = !c.last || d.id >= c.last.id;
          return sortChats(l.map((x) => (x.id === d.chatId ? {
            ...x,
            last: isNew ? d : x.last,
            unread: isNew && !seen && !d.deleted ? x.unread + 1 : x.unread,
          } : x)));
        });
        if (!mine && !d.deleted && d.kind !== 'system' && !seen) blip();
        if (!mine) setTyping((t) => { const c = { ...(t[d.chatId] || {}) }; delete c[d.userId]; return { ...t, [d.chatId]: c }; });
      } else if (event === 'receipt') {
        setChats((l) => l && l.map((c) => (c.id !== d.chatId ? c : {
          ...c,
          unread: d.userId === meId && c.last && d.read >= c.last.id ? 0 : c.unread,
          members: c.members.map((m) => (m.id === d.userId ? { ...m, read: Math.max(m.read, d.read), delivered: Math.max(m.delivered, d.delivered) } : m)),
        })));
      } else if (event === 'typing') {
        setTyping((t) => ({ ...t, [d.chatId]: { ...(t[d.chatId] || {}), [d.userId]: Date.now() + TYPING_MS } }));
      } else if (event === 'presence') {
        setOnline((s) => { const n = new Set(s); d.online ? n.add(d.userId) : n.delete(d.userId); return n; });
        if (d.lastSeen) setLastSeen((s) => ({ ...s, [d.userId]: d.lastSeen }));
      } else if (event === 'chat') {
        refreshChat(d.id);
      } else if (event === 'removed') {
        setChats((l) => (l || []).filter((c) => c.id !== d.chatId));
      }
    });
    return () => { off(); stopLive(); setChats(null); };
  }, [meId, loadChats, loadPeople, refreshChat]);

  // "typing…" fades on its own if the next keystroke never comes
  useEffect(() => {
    const t = setInterval(() => setTyping((all) => {
      const now = Date.now();
      let changed = false;
      const next = {};
      for (const [chatId, users] of Object.entries(all)) {
        const kept = Object.fromEntries(Object.entries(users).filter(([, until]) => until > now));
        if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
        next[chatId] = kept;
      }
      return changed ? next : all;
    }), 1000);
    return () => clearInterval(t);
  }, []);

  const unread = useMemo(() => (chats || []).reduce((n, c) => n + (c.unread ? 1 : 0), 0), [chats]);

  // "(2) Jarvis" in the browser tab, like WhatsApp Web
  useEffect(() => {
    document.title = unread ? `(${unread}) Jarvis` : 'Jarvis';
  }, [unread]);

  /** The screen has shown everything up to `id`: clear the badge and send the blue ticks. */
  const markRead = useCallback((chatId, id) => {
    setChats((l) => l && l.map((c) => (c.id === chatId ? { ...c, unread: 0, members: c.members.map((m) => (m.id === meId ? { ...m, read: Math.max(m.read, id) } : m)) } : c)));
    api.post(`/messenger/chats/${chatId}/read`, { upTo: id }).catch(() => {});
  }, [meId]);

  const setActive = useCallback((id) => { active.current = id; }, []);

  return { me, chats, people, online, lastSeen, typing, unread, loadChats, loadPeople, upsert, refreshChat, markRead, setActive };
}
