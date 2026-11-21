import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotebookPen, PenLine, Type, Search, Pin, Trash2, Loader2, Check, Plus, X, BookOpen, CalendarDays, CalendarClock, Copy, Flame, Paperclip, Coffee, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import DiaryPad, { makeThumb, PAPER } from './DiaryPad';

// Diary: the person's own notebook. A page is some writing, a pen drawing, or both, kept
// to read back later. There is no Save button: a page saves itself a moment after each
// change, and a page left empty is not kept. Private to them - see server/diary.js.
//
// It is drawn as a real diary in the app's own colours: a heading with the numbers that matter,
// a quick way to add a page, and the pages themselves in an open leather-bound book with
// spiral rings and stitching, the days written on its ruled pages. Only the pen's sheet stays
// cream, so ink looks like ink.

// What each colour is: the accent it tints the page with. "plain" is the app's own surface.
const ACCENTS = {
  plain: { accent: null, name: 'Midnight' },
  yellow: { accent: '#fbbf24', name: 'Amber' },
  green: { accent: '#4ade80', name: 'Mint' },
  blue: { accent: '#38bdf8', name: 'Sky' },
  pink: { accent: '#f472b6', name: 'Rose' },
  purple: { accent: '#a78bfa', name: 'Violet' },
};
const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
/** The sheet itself: the app's surface, lightly washed with the page's colour. */
const sheetOf = (k) => {
  const a = (ACCENTS[k] || ACCENTS.plain).accent;
  return a
    ? `linear-gradient(180deg, ${mix(a, 19, 'var(--color-surface-2)')}, ${mix(a, 11, 'var(--color-surface)')})`
    : 'linear-gradient(180deg, var(--color-surface-2), var(--color-surface))';
};
/** The little square that picks a colour: the same wash, stronger, so the colours can be told apart. */
const swatchOf = (k) => {
  const a = (ACCENTS[k] || ACCENTS.plain).accent;
  return a ? mix(a, 70, 'var(--color-surface-2)') : 'var(--color-surface-2)';
};
const INK = 'var(--color-txt)';
const INK_SOFT = 'var(--color-mute)';
const RULE = 'color-mix(in srgb, var(--color-txt) 11%, transparent)'; // the faint lines of ruled paper
const MARGIN = 'color-mix(in srgb, var(--color-p2) 55%, transparent)'; // the margin line
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif";
const SHEET_SHADOW = '0 1px 0 rgba(255,255,255,0.07) inset, 0 14px 26px -14px rgba(0,0,0,0.85)';
// The cover: the app's violet and pink, deepened by the surface so it suits the dark and the light theme.
const LEATHER = `linear-gradient(135deg, ${mix('var(--color-p1)', 46, 'var(--color-surface)')}, ${mix('var(--color-p2)', 30, 'var(--color-surface)')})`;
const STITCH = 'color-mix(in srgb, var(--color-txt) 38%, transparent)';
// One spiral ring, repeated down the middle of the book.
const RING = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='64'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='%23f8fafc'/><stop offset='.55' stop-color='%2394a3b8'/><stop offset='1' stop-color='%23475569'/></linearGradient></defs><rect x='3' y='24' width='50' height='16' rx='8' fill='url(%23g)' stroke='%23334155' stroke-width='1.2'/></svg>\")";
const SAVE_AFTER = 700; // ms of quiet before a change is saved
const DAY_S = 86400;

const day = (secs) => new Date(secs * 1000);
const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const when = (secs) => {
  const d = day(secs);
  return startOf(d) === startOf(new Date())
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const fullDate = (secs) => day(secs).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- the things on the desk ----------

/** A coffee cup, with the ring a wet cup leaves. Only decoration. */
function CoffeeCup({ className = '', size = 30 }) {
  return (
    <span aria-hidden className={`relative inline-grid shrink-0 place-items-center ${className}`}>
      <span className="absolute left-1/2 top-1/2 size-12 -translate-x-[35%] -translate-y-[25%] rounded-full border-[3px] border-amber-600/25" />
      <span className="absolute left-1/2 top-1/2 size-10 -translate-x-[20%] -translate-y-[10%] rounded-full border border-amber-600/15" />
      <Coffee size={size} strokeWidth={1.5} className="relative text-amber-300 drop-shadow-[0_2px_3px_rgba(0,0,0,0.5)]" />
    </span>
  );
}

/** A paper clip holding the corner of a sheet. */
const Clip = ({ className = '', size = 28, tone = 'text-slate-300' }) => (
  <Paperclip aria-hidden size={size} strokeWidth={1.7} className={`absolute z-10 ${tone} drop-shadow-[0_2px_2px_rgba(0,0,0,0.55)] ${className}`} />
);

// Small drawn things for the desk, in the app's colours.
const Mug = ({ className = '' }) => (
  <svg aria-hidden viewBox="0 0 64 72" className={className}>
    <path d="M22 6c-3 4 3 6 0 11M33 4c-3 4 3 6 0 11" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="2" strokeLinecap="round" />
    <path d="M48 30h5a8 8 0 0 1 0 17h-5" fill="none" stroke="var(--color-p1)" strokeWidth="6" />
    <rect x="9" y="22" width="40" height="42" rx="9" fill="var(--color-p1)" />
    <ellipse cx="29" cy="25" rx="18" ry="4.5" fill="#3b2a1d" />
    <path d="M29 53c-5-5-10-1-6 4l6 6 6-6c4-5-1-9-6-4z" fill="#fff" opacity=".92" />
  </svg>
);
const Pen = ({ className = '' }) => (
  <svg aria-hidden viewBox="0 0 200 20" className={className}>
    <rect x="6" y="4" width="152" height="12" rx="6" fill="var(--color-p1)" />
    <rect x="12" y="7" width="64" height="3" rx="1.5" fill="#fff" opacity=".35" />
    <rect x="148" y="4" width="14" height="12" fill="#fbbf24" />
    <path d="M162 4l30 6-30 6z" fill="#e8d5b5" />
    <path d="M182 8l10 2-10 2z" fill="#2a2118" />
  </svg>
);
const Pencil = ({ className = '' }) => (
  <svg aria-hidden viewBox="0 0 220 22" className={className}>
    <rect x="4" y="3" width="22" height="16" rx="5" fill="var(--color-p2)" />
    <rect x="24" y="3" width="10" height="16" fill="#cbd5e1" />
    <rect x="34" y="3" width="140" height="16" fill="#fbbf24" />
    <rect x="34" y="3" width="140" height="5" fill="#fde68a" opacity=".7" />
    <path d="M174 3l36 8-36 8z" fill="#f1d9b0" />
    <path d="M200 9l10 2-10 2z" fill="#2a2118" />
  </svg>
);
const Laptop = ({ className = '' }) => (
  <svg aria-hidden viewBox="0 0 160 110" className={className}>
    <rect x="26" y="6" width="108" height="72" rx="6" fill="#1b1834" stroke="var(--color-p1)" strokeWidth="3" />
    <rect x="34" y="14" width="92" height="56" rx="3" fill="#251f45" />
    {[24, 40, 56].map((y, i) => (
      <g key={y}>
        <rect x="42" y={y} width="9" height="9" rx="2" fill={i === 2 ? 'none' : '#4ade80'} stroke="#4ade80" strokeWidth="1.5" />
        <rect x="58" y={y + 2.5} width={[56, 44, 50][i]} height="4" rx="2" fill="#a78bfa" />
      </g>
    ))}
    <path d="M8 84h144l-10 16H18z" fill="#cbd5e1" />
    <rect x="62" y="84" width="36" height="5" rx="2" fill="#94a3b8" />
  </svg>
);

// ---------- the book ----------

/**
 * A leather-bound diary lying open: the cover with its stitching, the pages inside it, and the
 * spiral rings down the middle. What goes in is the pages themselves.
 */
function Book({ children }) {
  return (
    <div className="relative rounded-[26px] p-3 md:p-5" style={{ background: LEATHER, boxShadow: '0 24px 40px -18px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.2)' }}>
      <div aria-hidden className="pointer-events-none absolute inset-1.5 rounded-[22px] border-2 border-dashed md:inset-2.5" style={{ borderColor: STITCH }} />
      <div className="relative">
        {children}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-14 -translate-x-1/2 md:block" style={{ backgroundImage: RING, backgroundRepeat: 'repeat-y', backgroundPosition: 'center 8px' }} />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px md:block" style={{ background: 'rgba(0,0,0,0.5)' }} />
      </div>
    </div>
  );
}

/** One page's paper: the sheet, its ruled lines, and the shade where it curls into the spine. */
const PageBg = ({ side, colour = 'plain' }) => (
  <div aria-hidden className={`relative ${side === 'right' ? 'hidden md:block md:rounded-r-xl' : 'rounded-xl md:rounded-l-xl md:rounded-r-none'}`}
    style={{
      backgroundImage: `linear-gradient(to bottom, transparent 31px, ${RULE} 31px, ${RULE} 32px), ${sheetOf(colour)}`,
      backgroundSize: '100% 32px, auto',
      boxShadow: SHEET_SHADOW,
    }}>
    <div className="pointer-events-none absolute inset-y-0 hidden w-12 md:block [html[data-mode=light]_&]:opacity-35"
      style={side === 'right' ? { left: 0, background: 'linear-gradient(to right, rgba(0,0,0,0.38), transparent)' } : { right: 0, background: 'linear-gradient(to left, rgba(0,0,0,0.38), transparent)' }} />
  </div>
);

// ---------- one page, open ----------

/**
 * Saving runs one request at a time: what changes while one is on its way is gathered and
 * sent after it, so the page is never written out of order. A new page only gets a row on
 * its first real change.
 */
function useSaver(entry, setEntry) {
  const id = useRef(entry.id || null);
  const pending = useRef({});
  const timer = useRef(null);
  const running = useRef(null);
  const [state, setState] = useState(entry.id ? 'saved' : 'new'); // new | waiting | saving | saved | error
  const [error, setError] = useState('');

  const run = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (running.current) return running.current;
    if (!Object.keys(pending.current).length) return undefined;
    running.current = (async () => {
      while (Object.keys(pending.current).length) {
        const patch = pending.current;
        pending.current = {};
        setState('saving');
        try {
          const saved = id.current ? await api.put(`/diary/${id.current}`, patch) : await api.post('/diary', patch);
          id.current = saved.id;
          setEntry((e) => ({ ...e, id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at }));
          setError('');
        } catch (e) {
          pending.current = { ...patch, ...pending.current }; // try again with the next change
          setError(e.message);
          setState('error');
          return;
        }
      }
      setState('saved');
    })().finally(() => { running.current = null; });
    return running.current;
  }, [setEntry]);

  const save = useCallback((patch, now = false) => {
    pending.current = { ...pending.current, ...patch };
    setState('waiting');
    clearTimeout(timer.current);
    if (now) return run();
    timer.current = setTimeout(run, SAVE_AFTER);
    return undefined;
  }, [run]);

  const flush = useCallback(async () => {
    await run();
    if (running.current) await running.current;
  }, [run]);

  return { save, flush, state, error, id };
}

function Editor({ start, onClose }) {
  const [entry, setEntry] = useState(start);
  const [mode, setMode] = useState(start.mode || (start.has_drawing && !start.body ? 'draw' : 'write'));
  const [loaded, setLoaded] = useState(!start.id); // an existing page fetches its drawing first
  const [drawing, setDrawing] = useState(null);
  const [copied, setCopied] = useState(false);
  const hasInk = useRef(!!start.has_drawing);
  const { save, flush, state, error, id } = useSaver(start, setEntry);
  const bodyRef = useRef(null);
  const thumbTimer = useRef(null);
  const colour = entry.color || 'plain';
  const born = entry.created_at ? day(entry.created_at) : new Date();

  useEffect(() => {
    if (!start.id) return;
    api.get(`/diary/${start.id}`).then((e) => {
      setEntry(e);
      try { setDrawing(e.drawing ? JSON.parse(e.drawing) : null); } catch { setDrawing(null); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [start.id]);

  // The text box grows with what is written, like a page.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 420)}px`;
  }, [entry.body, mode, loaded]);

  const edit = (patch) => { setEntry((e) => ({ ...e, ...patch })); save(patch); };

  const onDraw = (d) => {
    hasInk.current = d.strokes.length > 0;
    // The strokes go straight in; the small picture for the list is made once the pen rests.
    save({ drawing: d.strokes.length ? JSON.stringify(d) : null });
    clearTimeout(thumbTimer.current);
    thumbTimer.current = setTimeout(() => save({ thumb: makeThumb(d) }), SAVE_AFTER);
  };

  const close = async () => {
    clearTimeout(thumbTimer.current);
    await flush();
    // A page with nothing on it is not kept.
    const empty = !String(entry.title || '').trim() && !String(entry.body || '').trim() && !hasInk.current;
    if (empty && id.current) await api.del(`/diary/${id.current}`).catch(() => {});
    onClose();
  };

  const remove = async () => {
    if (!confirm('Delete this page? This cannot be undone.')) return;
    clearTimeout(thumbTimer.current);
    await flush();
    if (id.current) await api.del(`/diary/${id.current}`).catch(() => {});
    onClose();
  };

  const pinNow = () => { setEntry((e) => ({ ...e, pinned: !e.pinned })); save({ pinned: !entry.pinned }, true); };

  // The date and time of this moment, written into the page where the cursor is: a diary
  // is read back by when things happened.
  const stamp = () => {
    const el = bodyRef.current;
    const body = entry.body || '';
    const a = el ? el.selectionStart : body.length;
    const b = el ? el.selectionEnd : body.length;
    const text = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const put = `${a > 0 && body[a - 1] !== '\n' ? '\n' : ''}${text}\n`;
    edit({ body: body.slice(0, a) + put + body.slice(b) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + put.length, a + put.length); });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([entry.title, entry.body].filter((t) => String(t || '').trim()).join('\n\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the browser refused the clipboard */ }
  };

  const words = String(entry.body || '').trim() ? String(entry.body).trim().split(/\s+/).length : 0;
  const status = {
    new: '',
    waiting: 'Saving…',
    saving: 'Saving…',
    saved: 'Saved',
    error: error || 'Not saved',
  }[state];

  const tool = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition hover:bg-white/10';

  return (
    <Page title={<span className="text-sm text-mute">{entry.created_at ? fullDate(entry.created_at) : 'New page'}</span>} onBack={close}
      action={(
        <div className="flex items-center gap-1">
          <span className={`mr-1 hidden items-center gap-1 text-xs sm:flex ${state === 'error' ? 'text-bad' : 'text-mute'}`}>
            {state === 'saved' && <Check size={13} className="text-ok" />}
            {(state === 'saving' || state === 'waiting') && <Loader2 size={13} className="animate-spin" />}
            {status}
          </span>
          <button onClick={pinNow} aria-label={entry.pinned ? 'Unpin' : 'Pin to the top'} title={entry.pinned ? 'Unpin' : 'Pin to the top'}
            className={`grid size-10 place-items-center rounded-full hover:bg-white/10 ${entry.pinned ? 'text-red-400' : 'text-mute hover:text-txt'}`}>
            {entry.pinned ? <Pin size={18} fill="currentColor" /> : <Pin size={18} />}
          </button>
          <button onClick={remove} aria-label="Delete page" title="Delete page"
            className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
            <Trash2 size={18} />
          </button>
        </div>
      )}>
      {/* An open diary: the left page is the day, the right page is where it is written. */}
      <div className="mx-auto w-full max-w-5xl">
        <Book>
          <div className="grid gap-1 md:grid-cols-2 md:gap-0">

            {/* ----- the left page ----- */}
            <div className="relative flex flex-col overflow-hidden rounded-xl px-6 pb-6 pt-9 md:rounded-l-xl md:rounded-r-none md:pl-10 md:pr-12"
              style={{ background: sheetOf(colour), color: INK, boxShadow: SHEET_SHADOW }}>
              <Clip className="-left-1 top-1.5 rotate-[-28deg]" />
              <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-12 md:block [html[data-mode=light]_&]:opacity-35" style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.38), transparent)' }} />

              <div className="flex items-end gap-4">
                <div className="w-[4.5rem] shrink-0 overflow-hidden rounded-xl text-center" style={{ background: 'var(--color-surface)', boxShadow: '0 6px 14px -6px rgba(0,0,0,0.7)' }}>
                  <div className="bg-gradient-to-r from-p1 to-p2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">{born.toLocaleDateString([], { month: 'short' })}</div>
                  <div className="text-4xl font-bold leading-[3rem]" style={{ fontFamily: SERIF, color: INK }}>{born.getDate()}</div>
                </div>
                <div className="min-w-0 pb-1">
                  <p className="text-lg font-light">{born.toLocaleDateString([], { weekday: 'long' })}</p>
                  <p className="flex items-center gap-1.5 text-xs" style={{ color: INK_SOFT }}>
                    <CalendarDays size={12} /> {born.toLocaleDateString([], { month: 'long', year: 'numeric' })} · {born.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </p>
                </div>
              </div>

              <input value={entry.title || ''} onChange={(e) => edit({ title: e.target.value })} placeholder="Title this page" dir="auto" maxLength={200}
                className="mt-7 w-full border-b bg-transparent pb-2 text-2xl font-bold tracking-tight outline-none placeholder:opacity-40 md:text-3xl"
                style={{ fontFamily: SERIF, color: INK, borderColor: RULE }} />

              {/* Two ways onto the same page: switching keeps both. */}
              <div className="mt-5 inline-flex self-start rounded-full bg-white/[0.07] p-0.5">
                {[['write', 'Write', Type], ['draw', 'Draw', PenLine]].map(([k, label, I]) => (
                  <button key={k} onClick={() => setMode(k)} aria-pressed={mode === k}
                    className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition ${mode === k ? 'bg-p1 text-white shadow-md shadow-p1/30' : 'text-mute hover:text-txt'}`}>
                    <I size={14} /> {label}
                  </button>
                ))}
              </div>

              <div className="mt-6">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider" style={{ color: INK_SOFT }}>Paper</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(ACCENTS).map(([k, p]) => (
                    <button key={k} onClick={() => edit({ color: k })} aria-label={p.name} title={p.name} aria-pressed={colour === k}
                      className={`size-8 rounded-lg transition hover:scale-110 ${colour === k ? 'ring-2 ring-p1 ring-offset-2 ring-offset-surface' : 'ring-1 ring-white/20'}`}
                      style={{ background: swatchOf(k) }} />
                  ))}
                </div>
              </div>

              <div className="mt-6 space-y-1.5 text-xs" style={{ color: INK_SOFT }}>
                {entry.created_at && <p className="flex items-center gap-1.5"><CalendarClock size={12} /> Started {fullDate(entry.created_at)}</p>}
                {entry.updated_at && entry.updated_at !== entry.created_at && <p className="flex items-center gap-1.5"><Check size={12} /> Last written {fullDate(entry.updated_at)}</p>}
              </div>

              {state === 'error' && <p className="mt-4 text-sm text-bad sm:hidden">{status}</p>}

              <div className="mt-auto flex items-end justify-between pt-10">
                <p className="max-w-[11rem] text-xs italic leading-relaxed" style={{ color: INK_SOFT, fontFamily: SERIF }}>Only you can read this diary.</p>
                <CoffeeCup size={34} className="mb-1 mr-2" />
              </div>
            </div>

            {/* ----- the right page ----- */}
            <div className="relative overflow-hidden rounded-xl px-5 pb-4 pt-8 md:rounded-l-none md:rounded-r-xl md:pl-[4.9rem] md:pr-12"
              style={{ background: sheetOf(colour), color: INK, boxShadow: SHEET_SHADOW }}>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 hidden w-12 md:block [html[data-mode=light]_&]:opacity-35" style={{ background: 'linear-gradient(to right, rgba(0,0,0,0.38), transparent)' }} />
              {/* The red margin line, and a ribbon to mark the place. */}
              <div aria-hidden className="pointer-events-none absolute inset-y-0 hidden w-px md:block" style={{ left: '3.9rem', background: MARGIN }} />
              <div aria-hidden className="pointer-events-none absolute right-3 top-0 hidden h-[4.5rem] w-5 md:block"
                style={{ background: 'linear-gradient(180deg, var(--color-p2), color-mix(in srgb, var(--color-p2) 65%, black))', clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%)' }} />

              {!loaded ? (
                <Loader2 size={20} className="mx-auto my-16 animate-spin" style={{ color: INK_SOFT }} />
              ) : mode === 'write' ? (
                <textarea ref={bodyRef} value={entry.body || ''} onChange={(e) => edit({ body: e.target.value })} dir="auto" autoFocus={!start.id}
                  placeholder="Dear diary…"
                  className="mt-1 w-full resize-none bg-transparent text-[17px] outline-none placeholder:opacity-40"
                  // Ruled lines, one per line of text.
                  style={{
                    fontFamily: SERIF, color: INK, lineHeight: '32px', caretColor: 'var(--color-p1)',
                    backgroundImage: `linear-gradient(to bottom, transparent 31px, ${RULE} 31px, ${RULE} 32px)`, backgroundSize: '100% 32px', backgroundAttachment: 'local',
                  }} />
              ) : (
                <div className="-mx-2 mt-1 overflow-hidden rounded-md md:-mr-5">
                  <DiaryPad initial={drawing} onChange={(d) => { setDrawing(d); onDraw(d); }} />
                </div>
              )}

              {/* The foot of the page: how much is written, and two things a diary wants. */}
              <div className="mt-3 flex flex-wrap items-center gap-1 border-t pt-2" style={{ borderColor: RULE, color: INK_SOFT }}>
                <span className="mr-auto text-xs">{plural(words, 'word')} · {plural(String(entry.body || '').length, 'character')}</span>
                {mode === 'write' && (
                  <button onClick={stamp} className={tool} title="Write the date and time here"><CalendarClock size={14} /> Date &amp; time</button>
                )}
                <button onClick={copy} className={tool} title="Copy the text">
                  {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        </Book>
      </div>
    </Page>
  );
}

// ---------- the list of pages ----------

// One diary page as a line on the ruled paper: its colour, its words, when it was written.
function EntryRow({ e, onOpen }) {
  const text = (e.preview || '').trim();
  const title = e.title || (text ? text.split('\n')[0].slice(0, 70) : 'Drawing');
  return (
    <button onClick={() => onOpen(e)} className="group flex w-full items-start gap-3 rounded-lg border-b px-2 py-3 text-left transition hover:bg-white/[0.05] [break-inside:avoid]" style={{ borderColor: RULE, color: INK }}>
      <span aria-hidden className="mt-1.5 size-3.5 shrink-0 rounded-full ring-2 ring-white/25" style={{ background: swatchOf(e.color || 'plain') }} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 text-[16px] font-bold leading-snug ${e.title ? '' : 'opacity-70'}`} dir="auto" style={{ fontFamily: SERIF }}>{title}</span>
          {e.pinned && <Pin size={14} fill="currentColor" className="mt-1 shrink-0 text-red-400" />}
        </span>
        {text && e.title && <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-[13.5px] opacity-75" dir="auto" style={{ fontFamily: SERIF }}>{text}</span>}
        <span className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: INK_SOFT }}>
          {e.has_drawing ? <PenLine size={12} /> : <Type size={12} />}
          {e.has_drawing && text ? 'Writing and drawing' : e.has_drawing ? 'Drawing' : 'Note'}
          <span className="ml-auto">{when(e.updated_at)}</span>
        </span>
      </span>
      {e.thumb && <img src={e.thumb} alt="" className="mt-0.5 h-14 w-[4.5rem] shrink-0 rounded-md object-cover ring-1 ring-white/15" style={{ background: PAPER }} loading="lazy" />}
    </button>
  );
}

/** The heading of a day on the page: MON ⑨ November 2026, and how many pages it holds. */
function DayHead({ g }) {
  return (
    <div className="mb-1 mt-5 flex items-center gap-2 [break-after:avoid]" style={{ color: INK }}>
      {g.pinned ? (
        <span className="flex items-center gap-1.5 rounded-full border-2 px-3 py-0.5 text-xs font-bold tracking-widest" style={{ borderColor: 'color-mix(in srgb, var(--color-p2) 60%, transparent)', fontFamily: SERIF }}>
          <Pin size={13} fill="currentColor" className="text-red-400" /> PINNED
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1.5 rounded-full border-2 py-0.5 pl-3 pr-0.5" style={{ borderColor: 'color-mix(in srgb, var(--color-p1) 65%, transparent)' }}>
            <span className="text-[11px] font-bold tracking-[0.16em]" style={{ fontFamily: SERIF }}>{g.wd}</span>
            <span className="grid size-6 place-items-center rounded-full bg-p1 text-xs font-bold text-white">{g.num}</span>
          </span>
          <span className="text-[15px] italic" style={{ fontFamily: SERIF }}>{g.my}</span>
          {g.today && <span className="rounded-full bg-p2/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-p2">Today</span>}
        </>
      )}
      <span className="ml-auto text-xs" style={{ color: INK_SOFT }}>{plural(g.items.length, 'page')}</span>
    </div>
  );
}

const Tab = ({ on, onClick, children }) => (
  <button onClick={onClick} aria-pressed={on}
    className={`rounded-lg px-3 py-1.5 text-sm transition ${on ? 'bg-white/10 text-txt shadow-sm' : 'text-mute hover:text-txt'}`}>{children}</button>
);

const StatCard = ({ icon: I, label, value, tone = '' }) => (
  <div className="glass relative overflow-hidden rounded-2xl border border-stroke px-4 py-3">
    <I size={40} strokeWidth={1.2} aria-hidden className="absolute -right-1 top-2 text-white/[0.06]" />
    <p className="text-xs text-mute">{label}</p>
    <p className={`mt-1 text-3xl font-semibold ${tone}`}>{value}</p>
  </div>
);

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

export default function DiaryPage({ onBack }) {
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all'); // all | today | week | earlier | pinned | drawings
  const [tint, setTint] = useState(null); // a paper colour, or null for every colour
  // The quick "new diary entry" form.
  const [qTitle, setQTitle] = useState('');
  const [qBody, setQBody] = useState('');
  const [qColor, setQColor] = useState('plain');
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const load = useCallback(async (term = q) => {
    try {
      setEntries(await api.get(`/diary${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ''}`));
      setError('');
    } catch (e) { setError(e.message); }
  }, [q]);

  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // The numbers at the top: how much is written, how lately, and how many days in a row.
  const stats = useMemo(() => {
    const list = entries || [];
    const days = new Set(list.map((e) => dayKey(day(e.created_at))));
    let streak = 0;
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // not written yet today: the run still stands until tonight
    while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
    const weekAgo = Date.now() / 1000 - 7 * DAY_S;
    // Of the last seven days, on how many was something written?
    let weekDays = 0;
    const w = new Date();
    for (let i = 0; i < 7; i++) { if (days.has(dayKey(w))) weekDays++; w.setDate(w.getDate() - 1); }
    const today = startOf(new Date());
    return {
      pages: list.length, streak, weekDays,
      week: list.filter((e) => e.updated_at >= weekAgo).length,
      today: list.filter((e) => startOf(day(e.updated_at)) === today).length,
      pinned: list.filter((e) => e.pinned).length,
      drawings: list.filter((e) => e.has_drawing).length,
    };
  }, [entries]);

  const shown = useMemo(() => {
    const weekAgo = Date.now() / 1000 - 7 * DAY_S;
    const today = startOf(new Date());
    return (entries || []).filter((e) => (
      (filter === 'all'
        || (filter === 'today' && startOf(day(e.updated_at)) === today)
        || (filter === 'week' && e.updated_at >= weekAgo)
        || (filter === 'earlier' && e.updated_at < weekAgo)
        || (filter === 'pinned' && e.pinned)
        || (filter === 'drawings' && e.has_drawing))
      && (!tint || (e.color || 'plain') === tint)
    ));
  }, [entries, filter, tint]);

  // The pinned ones first, then a heading for each day, newest day first.
  const groups = useMemo(() => {
    const out = [];
    for (const e of shown) {
      if (e.pinned) {
        let g = out.find((x) => x.pinned);
        if (!g) out.unshift(g = { key: 'pinned', pinned: true, items: [] });
        g.items.push(e);
        continue;
      }
      const d = day(e.updated_at);
      const key = dayKey(d);
      let g = out.find((x) => x.key === key);
      if (!g) {
        out.push(g = {
          key, items: [], wd: d.toLocaleDateString([], { weekday: 'short' }).toUpperCase(), num: d.getDate(),
          my: d.toLocaleDateString([], { month: 'long', year: 'numeric' }), today: startOf(d) === startOf(new Date()),
        });
      }
      g.items.push(e);
    }
    return out;
  }, [shown]);

  const addEntry = async (ev) => {
    ev.preventDefault();
    if (adding || (!qTitle.trim() && !qBody.trim())) return;
    setAdding(true);
    setError('');
    try {
      await api.post('/diary', { title: qTitle, body: qBody, color: qColor });
      setQTitle(''); setQBody(''); setQColor('plain');
      setAdded(true);
      setTimeout(() => setAdded(false), 2000);
      await load();
    } catch (e) { setError(e.message); }
    setAdding(false);
  };

  if (open) return <Editor start={open} onClose={() => { setOpen(null); load(); }} />;

  const now = new Date();
  const empty = entries && !entries.length;

  return (
    <Page title="Diary" onBack={onBack}>
      <div className="mx-auto max-w-6xl space-y-5">

        {/* ----- the heading ----- */}
        <section className="relative overflow-hidden rounded-3xl px-5 pb-6 pt-7 md:px-9">
          <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(60% 90% at 82% 0%, color-mix(in srgb, var(--color-p1) 24%, transparent), transparent), radial-gradient(40% 70% at 0% 100%, color-mix(in srgb, var(--color-p2) 14%, transparent), transparent)' }} />
          <div className="relative flex flex-wrap items-end gap-x-8 gap-y-5">
            <div className="min-w-0 flex-1 basis-72">
              <h1 className="text-4xl font-bold tracking-tight md:text-[2.6rem]" style={{ fontFamily: SERIF }}>My Diary</h1>
              <p className="mt-1.5 max-w-md text-sm text-mute">A day-by-day journal of everything you write, draw and remember.</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-mute"><CalendarDays size={13} /> {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setOpen({ mode: 'write', color: 'plain' })}
                  className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition hover:brightness-110">
                  <Plus size={17} /> New note
                </button>
                <button onClick={() => setOpen({ mode: 'draw', color: 'plain' })}
                  className="glass flex items-center gap-1.5 rounded-full border border-stroke px-5 py-2.5 text-sm font-medium transition hover:border-p1/60">
                  <PenLine size={16} /> Draw
                </button>
              </div>
            </div>
            {/* The desk: a laptop, a mug and a pen. */}
            <div aria-hidden className="relative hidden h-32 w-72 shrink-0 lg:block">
              <Laptop className="absolute left-6 top-0 w-44 drop-shadow-xl" />
              <Mug className="absolute right-6 top-6 w-14 text-white drop-shadow-lg" />
              <Pen className="absolute -left-2 bottom-3 w-40 rotate-[-18deg] drop-shadow-md" />
            </div>
            <div className="w-full shrink-0 sm:w-56">
              <div className="mb-1.5 flex items-center justify-between text-xs"><span className="text-mute">This week</span><span className="font-medium">{stats.weekDays}/7 days</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-p1 to-p2 transition-all" style={{ width: `${(stats.weekDays / 7) * 100}%` }} /></div>
              {stats.streak > 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-400"><Flame size={13} /> {plural(stats.streak, 'day')} in a row</p>}
            </div>
          </div>
        </section>

        {/* ----- the numbers ----- */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard icon={BookOpen} label="Total pages" value={stats.pages} />
          <StatCard icon={CalendarDays} label="Written this week" value={stats.week} tone={stats.week ? 'text-ok' : ''} />
          <StatCard icon={Pin} label="Pinned" value={stats.pinned} tone={stats.pinned ? 'text-red-400' : ''} />
          <StatCard icon={PenLine} label="Drawings" value={stats.drawings} />
        </div>

        {/* ----- a quick new entry ----- */}
        <form onSubmit={addEntry} className="glass overflow-hidden rounded-2xl border border-stroke">
          <div className="flex items-center gap-2 border-b border-stroke px-5 py-3.5">
            <Sparkles size={16} className="text-p1" /><h2 className="font-medium">New diary entry</h2>
            {added && <span className="ml-auto flex items-center gap-1 text-xs text-ok"><Check size={13} /> Added to your diary</span>}
          </div>
          <div className="space-y-3 px-5 py-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="mb-1 block text-xs text-mute">Title</span>
                <input value={qTitle} onChange={(e) => setQTitle(e.target.value)} placeholder="e.g. A good day at the office" dir="auto" maxLength={200} className={FIELD} />
              </label>
              <div>
                <span className="mb-1 block text-xs text-mute">Paper</span>
                <div className="flex gap-2 pt-1">
                  {Object.entries(ACCENTS).map(([k, p]) => (
                    <button type="button" key={k} onClick={() => setQColor(k)} aria-label={p.name} title={p.name} aria-pressed={qColor === k}
                      className={`size-8 rounded-lg transition hover:scale-110 ${qColor === k ? 'ring-2 ring-p1 ring-offset-2 ring-offset-bg' : 'ring-1 ring-white/25'}`} style={{ background: swatchOf(k) }} />
                  ))}
                </div>
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-mute">What happened <span className="opacity-70">(optional)</span></span>
              <textarea value={qBody} onChange={(e) => setQBody(e.target.value)} rows={3} placeholder="Write a few lines…" dir="auto" className={`${FIELD} resize-y`} />
            </label>
            <div className="flex justify-end">
              <button disabled={adding || (!qTitle.trim() && !qBody.trim())}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition hover:brightness-110 disabled:opacity-50">
                {adding ? <Loader2 size={15} className="animate-spin" /> : <Plus size={16} />} Add entry
              </button>
            </div>
          </div>
        </form>

        {/* ----- the diary ----- */}
        <section className="glass overflow-hidden rounded-2xl border border-stroke">
          <div className="flex flex-wrap items-center gap-3 border-b border-stroke px-5 py-3.5">
            <h2 className="font-medium">Diary</h2>
            <div className="flex flex-wrap rounded-xl bg-white/[0.05] p-0.5">
              <Tab on={filter === 'all'} onClick={() => setFilter('all')}>All</Tab>
              <Tab on={filter === 'today'} onClick={() => setFilter('today')}>Today</Tab>
              <Tab on={filter === 'week'} onClick={() => setFilter('week')}>This week</Tab>
              <Tab on={filter === 'earlier'} onClick={() => setFilter('earlier')}>Earlier</Tab>
              {stats.pinned > 0 && <Tab on={filter === 'pinned'} onClick={() => setFilter('pinned')}>Pinned</Tab>}
              {stats.drawings > 0 && <Tab on={filter === 'drawings'} onClick={() => setFilter('drawings')}>Drawings</Tab>}
            </div>
            <label className="ml-auto flex min-w-[12rem] flex-1 items-center gap-2 rounded-xl border border-stroke bg-white/[0.04] px-3 py-1.5 focus-within:border-p1/70 sm:max-w-xs sm:flex-none">
              <Search size={15} className="text-mute" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your diary" dir="auto" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute" />
              {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-mute hover:text-txt"><X size={15} /></button>}
            </label>
          </div>

          <div className="relative px-3 pb-8 pt-8 md:px-8">
            {entries && Object.keys(ACCENTS).some((k) => k !== 'plain' && entries.some((e) => e.color === k)) && (
              <div className="mb-4 flex items-center gap-2 px-1">
                <span className="text-xs text-mute">Paper</span>
                {Object.entries(ACCENTS).filter(([k]) => entries.some((e) => (e.color || 'plain') === k)).map(([k, p]) => (
                  <button key={k} onClick={() => setTint(tint === k ? null : k)} aria-pressed={tint === k} aria-label={`${p.name} pages`} title={`${p.name} pages`}
                    className={`size-6 rounded-md transition hover:scale-110 ${tint === k ? 'ring-2 ring-p1 ring-offset-2 ring-offset-bg' : 'ring-1 ring-white/25'}`} style={{ background: swatchOf(k) }} />
                ))}
                {tint && <button onClick={() => setTint(null)} className="text-xs text-p1 underline">Show all</button>}
              </div>
            )}

            {error && <p className="mb-3 text-sm text-bad">{error}</p>}

            <div className="relative">
              {/* A sticky note on the corner of the book, and the pencil lying across it. */}
              <button onClick={() => setOpen({ mode: 'write', color: 'plain' })} title="Write today's page"
                className="absolute -top-[4.75rem] right-6 z-20 hidden w-36 rotate-[4deg] rounded-[3px] px-3 pb-3 pt-5 text-center shadow-xl transition hover:rotate-0 md:block"
                style={{ background: '#fde68a', color: '#3b2a1d', fontFamily: SERIF }}>
                <Pin size={20} fill="currentColor" className="absolute -top-2 left-1/2 -translate-x-1/2 text-red-500 drop-shadow" />
                <span className="block text-[13px] italic">Don&apos;t forget!</span>
                <span className="block text-3xl font-bold leading-tight">{stats.today}</span>
                <span className="block text-[12px]">{stats.today === 1 ? 'page' : 'pages'} written today</span>
                <span className="mt-0.5 block text-[11px] opacity-70">{stats.today ? 'Add another' : 'Write today’s page'}</span>
              </button>
              <Pencil className="pointer-events-none absolute -bottom-3 right-2 z-20 hidden w-60 rotate-[-62deg] drop-shadow-lg xl:block" />
              <Clip className="-left-3 top-24 hidden rotate-[-35deg] md:block" size={34} tone="text-p2" />
              <Clip className="-left-1 top-32 hidden rotate-[-20deg] md:block" size={34} tone="text-amber-300" />

              <Book>
                <div className="relative">
                  {/* The two sheets of paper the pages are written on. */}
                  <div aria-hidden className="absolute inset-0 grid md:grid-cols-2"><PageBg side="left" /><PageBg side="right" /></div>
                  <div className="relative min-h-[22rem] px-5 pb-8 pt-7 md:columns-2 md:px-10 md:[column-gap:6rem]">
                    {!entries && !error && <Loader2 size={20} className="mx-auto my-10 animate-spin text-mute" />}

                    {empty && !q && (
                      <div className="flex flex-col items-center gap-3 py-10 text-center [break-inside:avoid]" style={{ color: INK }}>
                        <NotebookPen size={40} strokeWidth={1.3} />
                        <p className="text-lg font-medium" style={{ fontFamily: SERIF }}>Your diary is empty</p>
                        <p className="max-w-xs text-sm" style={{ color: INK_SOFT }}>Write a quick note above, or pick up the pen and draw it out. Only you can see your diary.</p>
                        <CoffeeCup size={30} className="mt-2" />
                      </div>
                    )}
                    {empty && q && <p className="py-10 text-center text-sm" style={{ color: INK_SOFT }}>Nothing in your diary matches “{q}”.</p>}
                    {entries && entries.length > 0 && shown.length === 0 && (
                      <p className="py-10 text-center text-sm" style={{ color: INK_SOFT }}>
                        No pages match this filter. <button onClick={() => { setFilter('all'); setTint(null); }} className="text-p1 underline">Show all</button>
                      </p>
                    )}

                    {groups.map((g) => (
                      <div key={g.key}>
                        <DayHead g={g} />
                        {g.items.map((e) => <EntryRow key={e.id} e={e} onOpen={setOpen} />)}
                      </div>
                    ))}

                    {shown.length > 0 && (
                      <p className="mt-6 text-center text-sm italic [break-inside:avoid]" style={{ color: INK_SOFT, fontFamily: SERIF }}>Blank page — room for tomorrow</p>
                    )}
                  </div>
                </div>
              </Book>
              <Mug className="pointer-events-none absolute -bottom-6 -left-5 z-20 hidden w-14 -rotate-6 text-white drop-shadow-lg lg:block" />
            </div>
          </div>
        </section>
      </div>
    </Page>
  );
}
