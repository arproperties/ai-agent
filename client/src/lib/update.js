import { registerSW } from 'virtual:pwa-register';

// Getting a new version onto an installed copy of Reem.
//
// On an iPad or tablet the installed app is rarely started fresh: it is paused in the
// background and picked up again, and the browser only looks for a new version of the
// service worker when a page is loaded. So a deploy never reached it, and the only way
// to see a change was to delete the home-screen icon and install again.
//
// Now the app asks the server for a new version on start and every time it comes back to
// the front. When one is there, the new worker takes over (src/sw.js skips waiting) and
// the page reloads itself onto it — at the moment the person returns, not halfway
// through something they are doing.
export function startUpdates() {
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    immediate: true,
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
