// Tells the server when something broke in the browser. Nothing here may throw: it runs
// on the path where things are already going wrong, and a reporter that fails takes the
// last word about the failure with it.

// The same fault usually arrives many times over - a failing render retries, a broken
// interval fires again every second. One report of each is enough to act on.
const already = new Set();
let sent = 0;
const MAX_PER_SESSION = 10;

export function reportError(message, stack, url = window.location.pathname) {
  try {
    const key = `${message}`.slice(0, 200);
    if (already.has(key) || sent >= MAX_PER_SESSION) return;
    already.add(key);
    sent += 1;
    // keepalive so it still goes out when the error is what is closing the page.
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(message).slice(0, 500), stack: stack ? String(stack).slice(0, 4000) : null, url }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* there is nowhere left to complain to */ }
}

/**
 * Faults nobody caught: a throw outside React, and a promise nobody handled. Ordinary API
 * failures are not reported from here - they are thrown by api.js, caught where they were
 * asked for, and shown to the person as a message. Those are the app working.
 */
export function watchForErrors() {
  window.addEventListener('error', (e) => {
    if (e.error || e.message) reportError(e.error?.message || e.message, e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    reportError(r?.message || String(r), r?.stack);
  });
}
