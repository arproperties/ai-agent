import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Loader2, Hand, Square, Check, X, Maximize2, Minimize2, Keyboard, CornerDownLeft, Lock, ShieldCheck, CircleCheck, CircleSlash } from 'lucide-react';
import { api } from '../lib/api';

// Reem using a website, live in the chat (server/browser/). The window shows the page as
// it is now, each new picture fading in over the last; the steps Reem took tick in under
// it. Take over sends the person's taps and typing to the page. When Reem needs them, the
// card turns amber: OK / No before a click that can't be taken back, or Done after a step
// only they can do (a CAPTCHA, a code, UAE Pass). Finished, it folds into one line.

const ACTIVE = ['working', 'waiting_person', 'waiting_ok'];
const split = (u) => { try { const x = new URL(u); return { host: x.hostname.replace(/^www\./, ''), path: `${x.pathname}${x.search}`.replace(/^\/$/, '') }; } catch { return { host: '', path: '' }; } };

/** The page picture: a new one fades in over the old, so the window never flickers. */
// Keys the page gets as keys (the rest of what's typed goes in as text).
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

function Frame({ src, onTap, onType, onKey, scanning, handing }) {
  const [shown, setShown] = useState(src);
  const [next, setNext] = useState(null);
  const [ready, setReady] = useState(false);
  const [focused, setFocused] = useState(false);
  const box = useRef();
  // Typing on the keyboard while the window has focus goes to the page: letters are
  // gathered for a moment and sent together, a key like Tab or Enter goes on its own.
  const typed = useRef('');
  const timer = useRef();
  const flush = () => { clearTimeout(timer.current); if (typed.current) { onType(typed.current); typed.current = ''; } };
  const keyDown = (e) => {
    if (!handing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) { e.preventDefault(); typed.current += e.key; clearTimeout(timer.current); timer.current = setTimeout(flush, 150); }
    else if (KEYS.has(e.key)) { e.preventDefault(); flush(); onKey(e.key); }
  };
  const paste = (e) => { if (!handing) return; e.preventDefault(); flush(); onType(e.clipboardData.getData('text').slice(0, 500)); };
  useEffect(() => { if (src && src !== shown && src !== next) { setNext(src); setReady(false); } }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = () => {
    setReady(true);
    setTimeout(() => { setShown(next); setNext(null); setReady(false); }, 450);
  };
  const tap = (e) => {
    if (!handing || !box.current) return;
    const r = box.current.getBoundingClientRect();
    box.current.focus({ preventScroll: true });
    flush();
    onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  return (
    <div ref={box} onClick={tap} onKeyDown={keyDown} onPaste={paste} tabIndex={handing ? 0 : -1}
      onFocus={() => setFocused(true)} onBlur={() => { flush(); setFocused(false); }}
      className={`relative aspect-[16/9] w-full overflow-hidden bg-white outline-none transition-shadow duration-300 ${handing ? 'cursor-text' : ''} ${handing && focused ? 'ring-2 ring-inset ring-p1' : ''}`}>
      {shown ? <img src={shown} alt="The page Reem is using" draggable={false} className="absolute inset-0 size-full select-none object-cover object-top" />
        : <div className="absolute inset-0 grid place-items-center bg-surface-2"><Loader2 size={20} className="animate-spin text-p1" /></div>}
      {next && <img src={next} alt="" draggable={false} onLoad={loaded}
        className={`absolute inset-0 size-full select-none object-cover object-top transition-opacity duration-[450ms] ease-out ${ready ? 'opacity-100' : 'opacity-0'}`} />}
      {scanning && <div className="pointer-events-none absolute inset-x-0 top-0 h-1/4"><div className="rb-scan size-full" /></div>}
      {handing && (
        <span className="rb-in pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur">
          {focused ? <><Keyboard size={12} /> Typing goes to the page</> : <><Hand size={12} /> Click a box on the page, then type</>}
        </span>
      )}
    </div>
  );
}

/** Full screen: the window over the whole app, to read a page or work in it comfortably. Esc closes it. */
function FullView({ title, status, waiting, onClose, children }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="rb-in fixed inset-0 z-[80] flex flex-col bg-black/70 backdrop-blur-md" onClick={onClose}>
      <div className="mx-auto flex w-full max-w-[min(96vw,calc(80vh*16/9+2rem))] flex-1 flex-col justify-center overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className={`rb-glow ${waiting ? 'rb-wait' : ''} rounded-3xl`}>
          <div className="rounded-3xl border border-stroke bg-surface pb-4 shadow-2xl">
            <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{title}</p>
                <p key={status} className={`rb-in truncate text-xs ${waiting ? 'font-medium text-warn' : 'rb-shimmer'}`}>{status}</p>
              </div>
              <IconButton label="Back to the chat (Esc)" onClick={onClose}><X size={17} /></IconButton>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function IconButton({ label, onClick, disabled, danger, children }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={`grid size-8 place-items-center rounded-full text-mute transition-all duration-200 hover:scale-105 hover:bg-white/10 active:scale-95 disabled:opacity-50 ${danger ? 'hover:text-bad' : 'hover:text-txt'}`}>
      {children}
    </button>
  );
}

export default function BrowserCard({ task: start, onChanged }) {
  const [t, setT] = useState(start);
  const [control, setControl] = useState(false);
  const [big, setBig] = useState(false);
  const [typing, setTyping] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const box = useRef();
  const active = ACTIVE.includes(t.status);
  const waitingPerson = t.status === 'waiting_person';
  const waitingOk = t.status === 'waiting_ok';
  const waiting = waitingOk || waitingPerson;
  const handing = control || waitingPerson; // a person's step: their taps go to the page

  useEffect(() => { setT((x) => ({ ...x, ...start })); }, [start]);
  // While it works: the job's state (and so the newest picture) every second.
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      api.get(`/browser/tasks/${t.id}`).then((n) => { setT(n); if (n.status !== t.status) onChanged?.(n); }).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [active, t.id, t.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Reem needs them: the card comes into view, question first.
  useEffect(() => {
    if (waiting) setTimeout(() => box.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
  }, [waiting]);

  const run = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  // One after another, so fast typing reaches the page in the order it was typed.
  const queue = useRef(Promise.resolve());
  const input = (body) => { queue.current = queue.current.then(() => api.post(`/browser/tasks/${t.id}/input`, body)).catch((e) => setError(e.message)); return queue.current; };
  const sendTyping = (e) => {
    e.preventDefault();
    if (!typing) return;
    input({ kind: 'type', text: typing });
    setTyping('');
  };
  const stop = () => run('stop', async () => { const n = await api.post(`/browser/tasks/${t.id}/stop`); setT(n); onChanged?.(n); });
  const { host, path } = split(t.url);

  // Finished: one line, folding in from the card it was.
  if (!active) {
    const done = t.status === 'done';
    return (
      <div className={`rb-in flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-sm shadow-sm ${done ? 'border-ok/30 bg-ok/[0.06]' : 'border-stroke bg-white/[0.03]'}`}>
        <span className={`rb-pop grid size-8 shrink-0 place-items-center rounded-full ${done ? 'bg-ok/15 text-ok' : 'bg-white/10 text-mute'}`}>
          {done ? <CircleCheck size={17} /> : <CircleSlash size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{t.goal || host || 'Browser'}</p>
          <p className="truncate text-xs text-mute">{host}{host && ' · '}{t.steps} step{t.steps === 1 ? '' : 's'} · {done ? 'Done' : 'Stopped'}{t.note ? ` · ${t.note}` : ''}</p>
        </div>
      </div>
    );
  }

  const steps = (t.history || []).slice(-4);
  return (
    <div ref={box} className={`rise rb-glow ${waiting ? 'rb-wait' : ''} scroll-mt-4 rounded-3xl`}>
      <div className="overflow-hidden rounded-3xl border border-stroke bg-surface shadow-xl shadow-p1/10 transition-shadow duration-500">
        {/* Header: what Reem is doing, and what it's on now. */}
        <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
          <span className={`relative grid size-10 shrink-0 place-items-center rounded-2xl text-white shadow-lg transition-all duration-500 ${waiting ? 'bg-gradient-to-br from-amber-400 to-orange-500 shadow-warn/30' : 'bg-gradient-to-br from-p1 to-p2 shadow-p1/30'}`}>
            {waiting ? <ShieldCheck size={19} /> : <Globe size={19} className="animate-[spin_8s_linear_infinite]" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">{t.goal || 'Using a website'}</p>
            <p key={waiting ? 'w' : t.step} className={`rb-in truncate text-xs ${waiting ? 'font-medium text-warn' : 'rb-shimmer'}`}>
              {waitingOk ? 'Waiting for your OK' : waitingPerson ? 'Your turn in the window' : (t.step || 'Starting…')}
            </p>
          </div>
          <span className="hidden shrink-0 rounded-full bg-p1/10 px-2.5 py-1 text-[11px] font-medium tabular-nums text-p1 sm:inline">{t.steps} step{t.steps === 1 ? '' : 's'}</span>
          <IconButton label={big ? 'Back to the chat' : 'Full screen'} onClick={() => setBig((b) => !b)}>
            {big ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          <IconButton label="Stop" danger disabled={!!busy} onClick={stop}>
            {busy === 'stop' ? <Loader2 size={15} className="animate-spin" /> : <Square size={13} className="fill-current" />}
          </IconButton>
        </div>

        {(() => {
          const body = (
            <>
        {/* Reem needs them: the question, first, so it's never below the screen. */}
        {waitingOk && t.ask && (
          <div className="rb-drop mx-4 mb-3 rounded-2xl border border-warn/40 bg-gradient-to-br from-warn/[0.12] to-warn/[0.04] p-3.5">
            <p className="text-sm">Reem wants to press <span className="font-semibold">“{t.ask.label}”</span>{t.ask.host ? <span className="text-mute"> on {t.ask.host}</span> : ''}</p>
            {t.ask.what && <p className="mt-1 text-xs leading-relaxed text-mute">{t.ask.what}</p>}
            <div className="mt-3 flex gap-2">
              <button disabled={!!busy} onClick={() => run('ok', () => api.post(`/browser/tasks/${t.id}/answer`, { ok: true }))}
                className="rb-breathe flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-semibold text-white shadow-lg shadow-p1/25 transition-transform duration-150 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-60">
                {busy === 'ok' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} OK, press it
              </button>
              <button disabled={!!busy} onClick={() => run('no', () => api.post(`/browser/tasks/${t.id}/answer`, { ok: false }))}
                className="flex items-center gap-1.5 rounded-full border border-stroke bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-mute transition-all duration-150 hover:text-txt active:scale-[0.97] disabled:opacity-60">
                <X size={15} /> No
              </button>
            </div>
          </div>
        )}
        {waitingPerson && t.ask && (
          <div className="rb-drop mx-4 mb-3 rounded-2xl border border-warn/40 bg-gradient-to-br from-warn/[0.12] to-warn/[0.04] p-3.5">
            <p className="text-sm font-medium">{t.ask.why}</p>
            <p className="mt-1 text-xs text-mute">Do it in the window below, then tap Done.</p>
            <button disabled={!!busy} onClick={() => run('done', () => api.post(`/browser/tasks/${t.id}/answer`, { done: true }))}
              className="rb-breathe mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-semibold text-white shadow-lg shadow-p1/25 transition-transform duration-150 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60">
              {busy === 'done' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Done
            </button>
          </div>
        )}

        {/* The window: never taller than part of the screen, so the buttons stay in sight. */}
        <div className="px-4">
          <div className="mx-auto overflow-hidden rounded-2xl border border-stroke shadow-lg transition-[max-width] duration-500 ease-out"
            style={{ maxWidth: big ? 'min(100%, calc(80vh * 16 / 9))' : '100%' }}>
            <div className="flex items-center gap-2 border-b border-stroke bg-surface-2 px-3 py-2">
              <span className="flex gap-1.5"><span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" /></span>
              <div className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-black/[0.06] px-3 py-1 text-xs">
                <Lock size={11} className="shrink-0 text-ok" />
                <span className="truncate"><span className="font-medium">{host || 'Opening…'}</span><span className="text-mute">{path}</span></span>
              </div>
              {active && !waiting && <Loader2 size={14} className="shrink-0 animate-spin text-p1" />}
            </div>
            <Frame src={t.frameAt ? `/api/browser/tasks/${t.id}/frame.jpg?t=${t.frameAt}` : null} scanning={!waiting && !control} handing={handing}
              onTap={(x, y) => input({ kind: 'click', x, y })} onType={(text) => input({ kind: 'type', text })} onKey={(key) => input({ kind: 'key', key })} />
          </div>
        </div>

        {/* Typing into the page, while it's the person's turn. */}
        {handing && (
          <form onSubmit={sendTyping} className="rb-in mx-4 mt-3 flex items-center gap-2">
            <div className="glass flex min-w-0 flex-1 items-center gap-2 rounded-full px-3.5 py-2 focus-within:border-p1/70">
              <Keyboard size={15} className="shrink-0 text-mute" />
              <input value={typing} onChange={(e) => setTyping(e.target.value)} placeholder="Type into the page…" autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </div>
            <button type="button" onClick={() => input({ kind: 'key', key: 'Enter' })} title="Press Enter" aria-label="Press Enter"
              className="grid size-9 place-items-center rounded-full border border-stroke text-mute transition-all hover:text-txt active:scale-95"><CornerDownLeft size={15} /></button>
          </form>
        )}

            </>
          );
          return big ? <FullView title={t.goal || 'Using a website'} status={waitingOk ? 'Waiting for your OK' : waitingPerson ? 'Your turn in the window' : (t.step || 'Working…')} waiting={waiting} onClose={() => setBig(false)}>{body}</FullView> : body;
        })()}

        {/* What Reem has done so far, each step ticking in. */}
        {steps.length > 0 && (
          <ol className="mx-4 mt-3 space-y-1.5">
            {steps.map((s, i) => {
              const now = i === steps.length - 1 && !waiting;
              return (
                <li key={s.at} className="rb-in flex items-center gap-2 text-xs">
                  <span className={`grid size-4 shrink-0 place-items-center rounded-full ${now ? 'text-p1' : 'bg-ok/15 text-ok'}`}>
                    {now ? <Loader2 size={12} className="animate-spin" /> : <Check size={10} strokeWidth={3} className="rb-pop" />}
                  </span>
                  <span className={`truncate ${now ? 'text-txt' : 'text-mute'}`}>{s.text}</span>
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-2 flex items-center gap-1 px-3 pb-3 pt-1">
          {!waitingPerson && (
            <button onClick={() => setControl((c) => !c)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all duration-200 active:scale-95 ${control ? 'bg-p1 text-white shadow-md shadow-p1/30' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
              <Hand size={13} /> {control ? 'Give back to Reem' : 'Take over'}
            </button>
          )}
          <span className="flex-1" />
          <span className="pr-1 text-[11px] text-mute sm:hidden">{t.steps} step{t.steps === 1 ? '' : 's'}</span>
        </div>
        {error && <p className="rb-in px-4 pb-3 text-xs text-bad">{error}</p>}
      </div>
    </div>
  );
}
