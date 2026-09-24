import { api } from './api';

// Switching notifications on, from the browser's side.
//
// Three separate things have to be true before a phone can buzz, and they fail in
// different ways, so they are checked one at a time and each gets its own honest answer:
//   1. the browser can do it at all (an iPhone only can once Jarvis is on the Home
//      Screen, and only on iOS 16.4 or newer),
//   2. the person has tapped Allow — which the browser will only ask in response to a
//      real tap, never on our own,
//   3. the server has its keys, so there is something to subscribe to.
//
// The subscription then lives on the server as one row for this device. Switching off
// deletes it here and there, so the two never disagree about what is on.

export const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** 'granted' | 'denied' | 'default' — 'default' means they have not been asked yet. */
export const permission = () => (canPush() ? Notification.permission : 'denied');

// The public key arrives as base64url text and the browser wants raw bytes.
function keyBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const ready = () => navigator.serviceWorker.ready;

/** Is this device already switched on? Reads the browser, which is the one that knows. */
export async function isSubscribed() {
  if (!canPush() || permission() !== 'granted') return false;
  return !!(await (await ready()).pushManager.getSubscription());
}

/**
 * Ask for permission, subscribe, and tell the server. Must be called straight from a tap.
 * Returns { ok: true } or { ok: false, reason } with something we can actually show.
 */
export async function enablePush() {
  if (!canPush()) {
    // Nearly always an iPhone in Safari rather than on the Home Screen.
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return { ok: false, reason: iOS ? 'Add Jarvis to your Home Screen first — tap Share, then “Add to Home Screen”, and open it from there.' : 'This browser cannot show notifications.' };
  }
  const { enabled, key } = await api.get('/push/key');
  if (!enabled) return { ok: false, reason: 'Notifications are not switched on for this server yet.' };

  const answer = await Notification.requestPermission();
  if (answer !== 'granted') {
    return { ok: false, reason: answer === 'denied'
      ? 'Notifications are blocked for Jarvis. You can turn them back on in your phone’s settings, under Jarvis.'
      : 'No answer given, so nothing changed. Tap again when you are ready.' };
  }

  const reg = await ready();
  // applicationServerKey cannot be changed on an existing subscription, so one made with
  // an older key is dropped rather than reused — otherwise every push to it would fail.
  const existing = await reg.pushManager.getSubscription();
  await existing?.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.post('/push/subscribe', { subscription: sub.toJSON(), device: navigator.userAgent });
  return { ok: true };
}

/** Switching off: this device only, and on both sides. */
export async function disablePush() {
  if (!canPush()) return;
  const sub = await (await ready()).pushManager.getSubscription();
  if (!sub) return;
  await api.del(`/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`).catch(() => {});
  await sub.unsubscribe();
}

/** Sends one to this device, so it can be seen working without asking a colleague. */
export const testPush = () => api.post('/push/test');
