// The one live connection to the server for the Messages screen (Server-Sent Events).
// The browser reconnects it by itself after a drop; the server answers every
// (re)connect with a `ready` event, which is the cue to fetch anything missed.
//
// iPhone suspends a home-screen app in the background and the stream can die without
// an error, so coming back to the front always checks it and reopens it if needed.

const EVENTS = ['ready', 'message', 'receipt', 'typing', 'presence', 'chat', 'removed'];
const listeners = new Set();
let source = null;
let wanted = false;

function open() {
  if (source && source.readyState !== EventSource.CLOSED) return;
  source?.close();
  source = new EventSource('/api/messenger/events');
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
}

export function startLive() {
  wanted = true;
  open();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
}

export function stopLive() {
  wanted = false;
  source?.close();
  source = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onVisible);
}

/** fn(eventName, data) for every live event; returns the unsubscribe. */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
