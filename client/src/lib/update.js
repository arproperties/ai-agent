import { registerSW } from 'virtual:pwa-register';

// Getting a new version onto an installed copy of Reem.
//
// On an iPad or tablet the installed app is rarely started fresh: it is paused in the
// background and picked up again, and the browser only looks for a new version of the
// service worker when a page is loaded. So a deploy never reached it, and the only way
// to see a change was to delete the home-screen icon and install again.
//
// Now the app asks the server for a new version on start and every time it comes back to
// the front. A new version is downloaded but never switched to on its own: reloading by
// itself would throw away whatever the person was in the middle of. Instead <UpdateButton>
// appears at the top of the menu, and the page reloads only when they tap it.
let ready = false;
let apply = null;
const watchers = new Set();

export function startUpdates() {
  if (!('serviceWorker' in navigator)) return;
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true;
      watchers.forEach((fn) => fn(true));
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('focus', check);
    },
  });
}

// Whether a new version is waiting; `fn` hears when one arrives.
export function updateReady() { return ready; }
export function onUpdateReady(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

// Switch to the new version: the waiting worker takes over and the page reloads onto it.
export function applyUpdate() { apply?.(true); }
