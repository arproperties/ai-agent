import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotebookPen, PenLine, Type, Search, Pin, Trash2, Loader2, Check, Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import DiaryPad, { makeThumb, PAPER } from './DiaryPad';

// Diary: the person's own notebook. A page is some writing, a pen drawing, or both, kept
// to read back later. There is no Save button: a page saves itself a moment after each
// change, and a page left empty is not kept. Private to them - see server/diary.js.

const COLORS = {
  plain: { dot: 'bg-white/30', card: '' },
  yellow: { dot: 'bg-amber-300', card: 'bg-amber-300/[0.09] ring-amber-300/25' },
  green: { dot: 'bg-emerald-400', card: 'bg-emerald-400/[0.09] ring-emerald-400/25' },
  blue: { dot: 'bg-sky-400', card: 'bg-sky-400/[0.09] ring-sky-400/25' },
  pink: { dot: 'bg-pink-400', card: 'bg-pink-400/[0.09] ring-pink-400/25' },
  purple: { dot: 'bg-violet-400', card: 'bg-violet-400/[0.10] ring-violet-400/25' },
};
const SAVE_AFTER = 700; // ms of quiet before a change is saved

const day = (secs) => new Date(secs * 1000);
const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function groupName(secs) {
  const d = day(secs);
  const today = startOf(new Date());
  const t = startOf(d);
  if (t === today) return 'Today';
  if (t === today - 864e5) return 'Yesterday';
  if (t > today - 7 * 864e5) return 'This week';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}
const when = (secs) => {
  const d = day(secs);
  return startOf(d) === startOf(new Date())
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const fullDate = (secs) => day(secs).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

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
  const [showColors, setShowColors] = useState(false);
  const hasInk = useRef(!!start.has_drawing);
  const { save, flush, state, error, id } = useSaver(start, setEntry);
  const bodyRef = useRef(null);
  const thumbTimer = useRef(null);

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
    el.style.height = `${Math.max(el.scrollHeight, 320)}px`;
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

  const status = {
    new: '',
    waiting: 'Saving…',
    saving: 'Saving…',
    saved: 'Saved',
    error: error || 'Not saved',
  }[state];

  return (
    <Page title={<span className="text-sm text-mute">{entry.created_at ? fullDate(entry.created_at) : 'New page'}</span>} onBack={close}
      action={(
        <div className="flex items-center gap-1">
          <span className={`mr-1 hidden items-center gap-1 text-xs sm:flex ${state === 'error' ? 'text-bad' : 'text-mute'}`}>
            {state === 'saved' && <Check size={13} className="text-ok" />}
            {(state === 'saving' || state === 'waiting') && <Loader2 size={13} className="animate-spin" />}
            {status}
          </span>
          <div className="relative">
            <button onClick={() => setShowColors((v) => !v)} aria-label="Page colour" title="Page colour"
              className="grid size-10 place-items-center rounded-full hover:bg-white/10">
              <span className={`size-4 rounded-full ring-2 ring-white/20 ${COLORS[entry.color || 'plain'].dot}`} />
            </button>
            {showColors && (
              <div className="glass absolute right-0 top-11 z-30 flex gap-2 rounded-2xl border border-stroke p-2.5 shadow-xl backdrop-blur-xl">
                {Object.entries(COLORS).map(([k, c]) => (
                  <button key={k} onClick={() => { edit({ color: k }); setShowColors(false); }} aria-label={k}
                    className={`size-7 rounded-full transition hover:scale-110 ${c.dot} ${entry.color === k ? 'ring-2 ring-p1 ring-offset-2 ring-offset-bg' : ''}`} />
                ))}
              </div>
            )}
          </div>
          <button onClick={pinNow} aria-label={entry.pinned ? 'Unpin' : 'Pin to the top'} title={entry.pinned ? 'Unpin' : 'Pin to the top'}
            className={`grid size-10 place-items-center rounded-full hover:bg-white/10 ${entry.pinned ? 'text-p1' : 'text-mute hover:text-txt'}`}>
            {entry.pinned ? <Pin size={18} fill="currentColor" /> : <Pin size={18} />}
          </button>
          <button onClick={remove} aria-label="Delete page" title="Delete page"
            className="grid size-10 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
            <Trash2 size={18} />
          </button>
        </div>
      )}>
      <div className="mx-auto max-w-3xl space-y-4">
        <input value={entry.title || ''} onChange={(e) => edit({ title: e.target.value })} placeholder="Title" dir="auto" maxLength={200}
          className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-mute/50 md:text-3xl" />

        {/* Two ways onto the same page: switching keeps both. */}
        <div className="glass inline-flex rounded-full border border-stroke p-1">
          {[['write', 'Write', Type], ['draw', 'Draw', PenLine]].map(([k, label, I]) => (
            <button key={k} onClick={() => setMode(k)} aria-pressed={mode === k}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition ${mode === k ? 'bg-p1 text-white shadow-md shadow-p1/30' : 'text-mute hover:text-txt'}`}>
              <I size={15} /> {label}
            </button>
          ))}
        </div>

        {state === 'error' && <p className="text-sm text-bad sm:hidden">{status}</p>}

        {!loaded ? (
          <Loader2 size={20} className="mx-auto my-10 animate-spin text-mute" />
        ) : mode === 'write' ? (
          <textarea ref={bodyRef} value={entry.body || ''} onChange={(e) => edit({ body: e.target.value })} dir="auto" autoFocus={!start.id}
            placeholder="Start writing…"
            className="w-full resize-none bg-transparent text-[16px] leading-8 outline-none placeholder:text-mute/50"
            // Faint ruled lines, one per line of text.
            style={{ backgroundImage: 'linear-gradient(to bottom, transparent 31px, var(--color-stroke) 31px, var(--color-stroke) 32px)', backgroundSize: '100% 32px', backgroundAttachment: 'local' }} />
        ) : (
          <DiaryPad initial={drawing} onChange={(d) => { setDrawing(d); onDraw(d); }} />
        )}
      </div>
    </Page>
  );
}

// ---------- the list of pages ----------

function Card({ e, onOpen }) {
  const c = COLORS[e.color] || COLORS.plain;
  const text = (e.preview || '').trim();
  return (
    <button onClick={() => onOpen(e)}
      className={`group flex w-full flex-col overflow-hidden rounded-2xl bg-white/5 text-left ring-1 ring-white/[0.06] transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/20 ${c.card}`}>
      {e.thumb && <img src={e.thumb} alt="" className="max-h-56 w-full object-contain" style={{ background: PAPER }} loading="lazy" />}
      <div className="w-full space-y-1 px-4 py-3">
        <div className="flex items-start gap-2">
          <p className={`min-w-0 flex-1 font-medium leading-snug ${e.title ? '' : 'text-mute'}`} dir="auto">
            {e.title || (text ? text.split('\n')[0].slice(0, 60) : 'Drawing')}
          </p>
          {e.pinned && <Pin size={14} className="mt-1 shrink-0 text-p1" fill="currentColor" />}
        </div>
        {text && e.title && <p className="line-clamp-4 whitespace-pre-line text-sm leading-relaxed text-txt/70" dir="auto">{text}</p>}
        <p className="flex items-center gap-1.5 pt-0.5 text-[11px] text-mute">
          {e.has_drawing && <PenLine size={11} />} {when(e.updated_at)}
        </p>
      </div>
    </button>
  );
}

export default function DiaryPage({ onBack }) {
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async (term = q) => {
    try {
      setEntries(await api.get(`/diary${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ''}`));
      setError('');
    } catch (e) { setError(e.message); }
  }, [q]);

  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pinned on top, then the rest by when they were last written.
  const groups = useMemo(() => {
    if (!entries) return [];
    const out = [];
    const add = (name, e) => {
      let g = out.find((x) => x.name === name);
      if (!g) out.push(g = { name, items: [] });
      g.items.push(e);
    };
    for (const e of entries) add(e.pinned ? 'Pinned' : groupName(e.updated_at), e);
    return out;
  }, [entries]);

  if (open) return <Editor start={open} onClose={() => { setOpen(null); load(); }} />;

  return (
    <Page title="Diary" onBack={onBack}>
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="glass flex flex-1 items-center gap-2 rounded-full border border-stroke px-4 py-2.5 focus-within:border-p1/70">
            <Search size={17} className="text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your diary" dir="auto"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-mute" />
            {q && <button onClick={() => setQ('')} aria-label="Clear search" className="text-mute hover:text-txt"><X size={16} /></button>}
          </label>
          <div className="flex gap-2">
            <button onClick={() => setOpen({ mode: 'write', color: 'plain' })}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-p1/25 transition hover:brightness-110 sm:flex-none">
              <Plus size={17} /> New note
            </button>
            <button onClick={() => setOpen({ mode: 'draw', color: 'plain' })}
              className="glass flex flex-1 items-center justify-center gap-1.5 rounded-full border border-stroke px-5 py-2.5 text-sm font-medium transition hover:border-p1/60 sm:flex-none">
              <PenLine size={16} /> Draw
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-bad">{error}</p>}
        {!entries && !error && <Loader2 size={20} className="mx-auto my-10 animate-spin text-mute" />}

        {entries && !entries.length && (
          q ? <p className="py-10 text-center text-sm text-mute">Nothing in your diary matches “{q}”.</p> : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/30 to-p2/30 text-p1 ring-1 ring-white/10">
                <NotebookPen size={36} strokeWidth={1.5} />
              </div>
              <p className="text-lg font-medium">Your diary is empty</p>
              <p className="max-w-xs text-sm text-mute">Write a quick note, or pick up the pen and draw it out. Only you can see your diary.</p>
            </div>
          )
        )}

        {groups.map((g) => (
          <section key={g.name} className="space-y-2.5">
            <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-mute">{g.name}</h2>
            <div className="columns-1 gap-3 sm:columns-2 lg:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
              {g.items.map((e) => <Card key={e.id} e={e} onOpen={setOpen} />)}
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}
