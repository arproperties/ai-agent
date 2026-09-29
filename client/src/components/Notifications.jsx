import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, X } from 'lucide-react';
import { canPush, isSubscribed, enablePush, disablePush, testPush } from '../lib/push';

// Turning the phone's notifications on, and off again.
//
// Two pieces, one state. The banner is how anyone finds this at all — it sits at the top
// of Team chat while notifications are off, because that is the screen where missing a
// message actually costs something. The bell in the menu is how it goes off again
// afterwards, and is quiet enough to live there permanently.
//
// The browser is the single source of truth about whether this device is on. Nothing is
// remembered in React that the browser could contradict a moment later: someone can
// revoke the permission in their phone's settings without ever opening Jarvis.

const DISMISSED = 'jarvis:notify-banner-dismissed';

// The banner and the bell are two separate components showing one fact, so whichever of
// them changes it tells the other. Otherwise switching notifications on from Team chat
// would leave the bell in the menu still saying they are off.
const watchers = new Set();
const tellEveryone = () => watchers.forEach((fn) => fn());

/** state: null while checking, then 'on' | 'off' | 'unavailable'. */
export function usePush() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    if (!canPush()) return setState('unavailable');
    isSubscribed().then((on) => setState(on ? 'on' : 'off'), () => setState('off'));
  }, []);

  useEffect(() => {
    check();
    watchers.add(check);
    // Someone can revoke the permission in their phone's settings without ever opening
    // Jarvis, so coming back to the app asks the browser again rather than trusting this.
    document.addEventListener('visibilitychange', check);
    return () => { watchers.delete(check); document.removeEventListener('visibilitychange', check); };
  }, [check]);

  // Returns { ok, reason } so each caller can say what went wrong in its own way. The
  // permission prompt only appears if this runs from a real tap, so it must not be
  // wrapped in anything that defers it.
  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (state === 'on') {
        await disablePush();
        setState('off');
        tellEveryone();
        return { ok: true, on: false };
      }
      const out = await enablePush();
      if (out.ok) { setState('on'); tellEveryone(); }
      return { ...out, on: out.ok };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      setBusy(false);
    }
  }, [state]);

  return { state, busy, toggle, refresh: check };
}

/** The bell in the menu, beside sign out. Hidden entirely where it could not work. */
export function NotifyBell() {
  const { state, busy, toggle } = usePush();
  if (state === null || state === 'unavailable') return null;
  const on = state === 'on';
  const label = on ? 'Notifications are on — tap to turn off' : 'Turn on notifications';
  return (
    <button
      onClick={async () => { const r = await toggle(); if (!r.ok && r.reason) alert(r.reason); }}
      disabled={busy} aria-label={label} title={label}
      className={`grid size-8 place-items-center rounded-full hover:bg-white/10 disabled:opacity-50 ${on ? 'text-emerald-300' : 'text-mute hover:text-txt'}`}>
      {on ? <Bell size={16} /> : <BellOff size={16} />}
    </button>
  );
}

/**
 * The row at the top of Team chat, while notifications are off.
 *
 * It can be dismissed, and then stays dismissed on this device — being asked twice is
 * how a useful prompt turns into a nuisance. Turning notifications on from the menu
 * later works just the same.
 */
export function NotifyBanner() {
  const { state, busy, toggle } = usePush();
  const [hidden, setHidden] = useState(() => { try { return !!localStorage.getItem(DISMISSED); } catch { return false; } });
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);

  if (state === null || state === 'on' || hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try { localStorage.setItem(DISMISSED, '1'); } catch { /* a locked-down browser just gets asked again */ }
  };

  const turnOn = async () => {
    setProblem('');
    const r = await toggle();
    if (!r.ok) return setProblem(r.reason || 'That did not work.');
    // One straight away, so the first notification they ever see is one they asked for
    // rather than a surprise at midnight.
    setDone(true);
    testPush().catch(() => {});
    setTimeout(dismiss, 2500);
  };

  return (
    <div className="mx-3 mb-2 rounded-2xl border border-stroke bg-white/[0.04] px-3.5 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><Bell size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{done ? 'Notifications are on' : 'Get notified of new messages'}</p>
          <p className="mt-0.5 text-xs text-mute">
            {done ? 'We just sent you one so you can see what it looks like.' : 'Jarvis can buzz your phone when a message arrives, even when the app is closed.'}
          </p>
          {problem && <p className="mt-1.5 text-xs text-warn">{problem}</p>}
          {!done && (
            <button onClick={turnOn} disabled={busy}
              className="mt-2 rounded-full bg-emerald-500 px-4 py-1.5 text-[13px] font-medium text-white active:scale-[0.98] disabled:opacity-60">
              {busy ? 'Just a moment…' : 'Turn on'}
            </button>
          )}
        </div>
        <button onClick={dismiss} aria-label="Not now" className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-mute hover:bg-white/10 hover:text-txt">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

const SNOOZED = 'jarvis:notify-prompt-snoozed';
const SNOOZE_FOR = 3 * 24 * 3600 * 1000;

/**
 * The card that greets anyone whose device is not set up yet, right after they open
 * Jarvis. The Team chat banner alone was too easy to miss: most of the team never turned
 * notifications on, and a chat app that never buzzes is a chat app nobody opens.
 *
 * "Not now" puts it away for a few days on this device, not for good. An iPhone in Safari
 * cannot be switched on at all, so it gets the Home Screen steps instead of a button.
 */
export function NotifyPrompt() {
  const { state, busy, toggle } = usePush();
  const [hidden, setHidden] = useState(() => {
    try { return Date.now() < Number(localStorage.getItem(SNOOZED) || 0); } catch { return false; }
  });
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);

  const iPhoneInSafari = /iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone;
  const blocked = state === 'off' && typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const needsHomeScreen = state === 'unavailable' && iPhoneInSafari;
  if (hidden || state === null || (state === 'on' && !done) || (state === 'unavailable' && !needsHomeScreen)) return null;

  const later = () => {
    setHidden(true);
    try { localStorage.setItem(SNOOZED, String(Date.now() + SNOOZE_FOR)); } catch { /* asked again next time */ }
  };
  const turnOn = async () => {
    setProblem('');
    const r = await toggle();
    if (!r.ok) return setProblem(r.reason || 'That did not work.');
    setDone(true);
    testPush().catch(() => {});
    setTimeout(() => setHidden(true), 2500);
  };

  const title = done ? 'Notifications are on' : needsHomeScreen ? 'Add Jarvis to your Home Screen' : blocked ? 'Notifications are blocked' : 'Turn on notifications';
  const text = done ? 'We just sent you one so you can see what it looks like.'
    : needsHomeScreen ? 'iPhone only allows notifications from the Home Screen app. Tap the Share button, then “Add to Home Screen”, and open Jarvis from there.'
    : blocked ? 'This device is set to block Jarvis. Allow notifications for this site in your browser or phone settings, then come back.'
    : 'So you know the moment a colleague messages you — even when Jarvis is closed.';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center">
      <div className="rise w-full max-w-sm rounded-3xl border border-stroke bg-[#141225] p-6 text-center shadow-2xl">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><Bell size={22} /></span>
        <p className="mt-4 text-lg font-medium">{title}</p>
        <p className="mt-1.5 text-sm text-mute">{text}</p>
        {problem && <p className="mt-2 text-xs text-warn">{problem}</p>}
        {!done && (
          <div className="mt-5 flex flex-col gap-2">
            {!needsHomeScreen && !blocked && (
              <button onClick={turnOn} disabled={busy}
                className="rounded-full bg-emerald-500 py-2.5 text-sm font-medium text-white active:scale-[0.98] disabled:opacity-60">
                {busy ? 'Just a moment…' : 'Turn on'}
              </button>
            )}
            <button onClick={later} className="rounded-full py-2 text-sm text-mute hover:text-txt">
              {needsHomeScreen || blocked ? 'OK' : 'Not now'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
