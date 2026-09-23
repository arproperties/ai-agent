import { useEffect, useState } from 'react';
import Icon from './Icon';

// Two things a brand-new account never finds on its own: what this app can do beyond
// answering a question, and that it can live on the home screen instead of in a browser
// tab. Both sit on the empty chat screen, which is the only screen everybody sees first.

// localStorage is gone in a private window and throws rather than returning null in a
// few browsers, so nothing here may depend on it working.
const remembered = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not worth a failure */ } };

const ABILITIES = [
  ['clip', 'Send it a document', 'Attach a contract, invoice, Emirates ID or a photo of one. It reads it, files it under the right folder, and finds it again months later.'],
  ['mail', 'Let it read your email', 'Connect your mailbox from the menu and ask about it in plain words. Replies are written for you and wait until you tap Approve — nothing is ever sent on its own.'],
  ['brain', 'It remembers you', 'What you tell it once, it keeps: your company, your properties, how you like answers written. You never start from nothing again.'],
];

/** Shown until the first conversation exists, then never again. */
export function Welcome() {
  return (
    <div className="w-full max-w-md space-y-2 text-left">
      <p className="px-1 text-[11px] font-medium tracking-[0.14em] text-mute">WHILE YOU ARE HERE</p>
      {ABILITIES.map(([icon, title, body]) => (
        <div key={title} className="glass flex gap-3 rounded-2xl px-3.5 py-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-p1/20 text-p1">
            <Icon name={icon} size={16} />
          </span>
          <span className="min-w-0">
            <b className="block text-sm font-medium">{title}</b>
            <span className="mt-0.5 block text-xs leading-relaxed text-mute">{body}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The app has been installable all along - it just never said so. Chrome hands us its own
 * install prompt through `beforeinstallprompt`; iPhone has no such event and never will,
 * so there the only honest thing to offer is the two taps to do it by hand.
 */
export function InstallHint() {
  const [prompt, setPrompt] = useState(null);
  const [gone, setGone] = useState(() => remembered('jarvis.install') === 'done');

  useEffect(() => {
    const grab = (e) => { e.preventDefault(); setPrompt(e); };
    const done = () => { remember('jarvis.install', 'done'); setGone(true); };
    window.addEventListener('beforeinstallprompt', grab);
    window.addEventListener('appinstalled', done);
    return () => {
      window.removeEventListener('beforeinstallprompt', grab);
      window.removeEventListener('appinstalled', done);
    };
  }, []);

  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // Nothing to say to a browser that cannot install and cannot be told how to.
  if (gone || installed || (!prompt && !iphone)) return null;

  const dismiss = () => { remember('jarvis.install', 'done'); setGone(true); };
  const install = async () => {
    dismiss();
    prompt.prompt();
    await prompt.userChoice.catch(() => {});
  };

  return (
    <div className="glass flex w-full max-w-md items-center gap-3 rounded-2xl px-3.5 py-3 text-left">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white">
        <Icon name="sparkles" size={16} />
      </span>
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-mute">
        {prompt
          ? <>Keep Jarvis one tap away instead of hunting for the page.</>
          : <>Keep Jarvis one tap away: tap <b className="font-medium text-txt">Share</b>, then <b className="font-medium text-txt">Add to Home Screen</b>.</>}
      </span>
      {prompt && (
        <button onClick={install} className="shrink-0 rounded-full bg-gradient-to-br from-p1 to-p2 px-3.5 py-1.5 text-xs font-medium text-white">
          Install
        </button>
      )}
      <button onClick={dismiss} aria-label="Hide this" className="grid size-7 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
