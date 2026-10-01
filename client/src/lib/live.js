// The one live connection to the server for the Messages screen (Server-Sent Events).
// The browser reconnects it by itself after a drop; the server answers every
// (re)connect with a `ready` event, which is the cue to fetch anything missed.
//
// iPhone suspends a home-screen app in the background and the stream can die without
// an error, so coming back to the front always checks it and reopens it if needed.
//
// It also tells the server whether Reem is actually on screen — visible and, on a
// laptop, the window in front. A stream that is merely open (a background tab, an app
// just swiped away) does not count, so those people still get the notification.
import { api } from './api';

const EVENTS = ['ready', 'message', 'receipt', 'typing', 'presence', 'chat', 'removed'];
const listeners = new Set();
let source = null;
let wanted = false;
const sid = Math.random().toString(36).slice(2, 12);
let told = null;

const watching = () => document.visibilityState === 'visible' && document.hasFocus();

function tell(force) {
  const now = watching();
  if (!force && now === told) return;
  told = now;
  api.post('/messenger/watching', { sid, watching: now }).catch(() => {});
}
const onFocusChange = () => tell(false);

function open() {
  if (source && source.readyState !== EventSource.CLOSED) return;
  source?.close();
  told = watching();
  source = new EventSource(`/api/messenger/events?sid=${sid}&watching=${told ? 1 : 0}`);
  // A reconnect reuses the address above, whose answer may be stale by now.
  source.addEventListener('ready', () => tell(true));
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of listeners) fn(name, data);
    });
  }
}

function onVisible() {
  if (wanted && document.visibilityState === 'visible') open();
  if (wanted) tell(false);
}

export function startLive() {
  wanted = true;
  open();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  window.addEventListener('focus', onFocusChange);
  window.addEventListener('blur', onFocusChange);
}

export function stopLive() {
  wanted = false;
  source?.close();
  source = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onVisible);
  window.removeEventListener('focus', onFocusChange);
  window.removeEventListener('blur', onFocusChange);
}

/** fn(eventName, data) for every live event; returns the unsubscribe. */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
