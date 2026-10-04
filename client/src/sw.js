/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

// The service worker: the small piece of Riley that keeps running when Riley is closed.
//
// It does two jobs. The first is the one it always did — hold the app's files so the
// screen appears instantly and works on a bad connection. Vite used to write this file
// for us; it is written by hand now only because the second job cannot be generated:
// receiving a notification while the app is shut, and opening the right chat when the
// notification is tapped.
//
// Nothing secret lives here. The file is served to every browser, so the notice arrives
// already written by the server and this only shows it.

// ---------- the app's files (job one, unchanged in behaviour) ----------
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
const files = self.__WB_MANIFEST;
precacheAndRoute(files);
// On the dev server nothing is precached, and binding to a page that is not there stops the
// whole worker from starting (so notifications could never be tried on localhost).
const hasApp = files.some((f) => (f.url || f) === 'index.html');

// Any address the user navigates to is answered with the app itself — except /api, which
// must always reach the real server. This is the same rule the generated worker had.
if (hasApp) registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api/] }));

// ---------- notifications (job two) ----------

// One notice, already addressed and written by server/push.js.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }

  // A browser will show its own blunt "This site has been updated in the background" if
  // we receive a push and show nothing, so there is always a notification, even if the
  // payload arrived empty.
  // Closing the one already showing before putting up the next matters on a Mac: there,
  // Chrome swaps the text of a same-tag notification in silence, so every message after
  // the first in a chat arrived with no banner at all. Closed and shown fresh, it pops up.
  const tag = data.tag || 'jarvis';
  event.waitUntil(self.registration.getNotifications({ tag })
    .then((open) => open.forEach((n) => n.close()), () => {})
    .then(() => self.registration.showNotification(data.title || 'Riley', {
    body: data.body || 'You have a new message',
    // The tag is the chat. A second message from the same chat replaces the first rather
    // than stacking up ten notices while someone is typing a paragraph one line at a time.
    tag,
    renotify: true,
    icon: '/icons/icon-192.png',
    // Android paints the status-bar badge as one flat colour from the image's see-through
    // parts, so the full square app icon came out as a white box. This is the outline alone.
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
  })));
});

// Tapping it. If Riley is already open somewhere, that window is brought forward and
// told which chat to show; opening a second copy of the app instead would lose whatever
// the person was in the middle of.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (mine) {
      await mine.focus();
      mine.postMessage({ type: 'notification', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
