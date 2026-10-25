import { useEffect, useRef, useState } from 'react';
import { currentJobs, onJobs, dismissJob } from '../lib/jobs';
import { importState, onImport } from '../lib/importer';
import { sendToShelf } from '../lib/shelf';
import './pet.css';

// The helper in the bottom-right corner. It says what needs the person (to-dos due, papers
// running out, unread messages), shows long jobs while they run (the dog carries the file
// across), takes files dropped on it to the Shelf, and dozes off when nobody is around.

const CHAR_KEY = 'jarvis:pet';
const HIDE_KEY = 'jarvis:pet-hidden';
const SLEEP_AFTER = 2 * 60 * 1000;
const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
const write = (store, key, v) => { try { if (v == null) store.removeItem(key); else store.setItem(key, v); } catch { /* private mode */ } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- the four characters: same parts on each (.pupil follows the pointer, .lids blink) ----------
const eyes = (lx, rx, y, r, fill, pupil, lid) => `<g><circle cx="${lx}" cy="${y}" r="${r}" fill="${fill}"/><circle cx="${rx}" cy="${y}" r="${r}" fill="${fill}"/>
 <g class="pupil"><circle cx="${lx}" cy="${y}" r="${r * 0.5}" fill="${pupil}"/><circle cx="${rx}" cy="${y}" r="${r * 0.5}" fill="${pupil}"/><circle cx="${lx + 1.5}" cy="${y - 1.5}" r="${r * 0.18}" fill="#fff"/><circle cx="${rx + 1.5}" cy="${y - 1.5}" r="${r * 0.18}" fill="#fff"/></g>
 <g class="lids"><rect x="${lx - r - 1}" y="${y - r - 1}" width="${r * 2 + 2}" height="${r * 2 + 2}" rx="${r}" fill="${lid}"/><rect x="${rx - r - 1}" y="${y - r - 1}" width="${r * 2 + 2}" height="${r * 2 + 2}" rx="${r}" fill="${lid}"/></g></g>`;
const mouthPath = (d, big, ink) => `<path d="${d}" stroke="${ink}" stroke-width="3" stroke-linecap="round" fill="${big ? ink : 'none'}"/>`;

const CHARS = {
  buddy: {
    name: 'Buddy',
    mouths: { smile: 'M42 71q6 5 12 0', o: 'M45 72a3 3 0 1 0 6 0a3 3 0 1 0-6 0', flat: 'M43 72h10', big: 'M41 70q7 10 14 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M78 78q16-4 13-22" stroke="#c98a52" stroke-width="8" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" values="-12 78 78;22 78 78;-12 78 78" dur=".45s" repeatCount="indefinite"/></path>
      <ellipse cx="48" cy="56" rx="34" ry="31" fill="#c98a52"/><ellipse cx="62" cy="48" rx="11" ry="10" fill="#8a5a32"/><ellipse cx="48" cy="70" rx="17" ry="12" fill="#f3dcc2"/>
      ${eyes(35, 61, 49, 7, '#fff', '#2b1d12', '#c98a52')}<ellipse cx="48" cy="63" rx="5.5" ry="4" fill="#2b1d12"/>${mouthPath(m, big, '#2b1d12')}
      <ellipse cx="16" cy="52" rx="9" ry="19" fill="#8a5a32" transform="rotate(18 16 52)"/><ellipse cx="80" cy="52" rx="9" ry="19" fill="#8a5a32" transform="rotate(-18 80 52)"/></g>`,
  },
  jelly: {
    name: 'Jelly',
    mouths: { smile: 'M41 66q7 6 14 0', o: 'M44 66a4 4 0 1 0 8 0a4 4 0 1 0-8 0', flat: 'M42 67h12', big: 'M39 64q9 11 18 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M10 82C6 50 22 18 48 18s42 32 38 64c-1 6-6 8-12 8H22c-6 0-11-2-12-8z" fill="#4fd1b5"/><path d="M24 34c4-7 10-10 16-10" stroke="#fff" stroke-opacity=".55" stroke-width="5" stroke-linecap="round" fill="none"/>
      ${eyes(36, 60, 52, 8, '#fff', '#1a1f2b', '#4fd1b5')}<ellipse cx="26" cy="64" rx="5" ry="3" fill="#ff8a8a" opacity=".6"/><ellipse cx="70" cy="64" rx="5" ry="3" fill="#ff8a8a" opacity=".6"/>${mouthPath(m, big, '#1a1f2b')}</g>`,
  },
  bolt: {
    name: 'Bolt',
    mouths: { smile: 'M41 60q7 5 14 0', o: 'M44 60a4 4 0 1 0 8 0a4 4 0 1 0-8 0', flat: 'M42 61h12', big: 'M39 58q9 10 18 0z' },
    svg: (m, big, mood) => `<g class="body-g"><line x1="48" y1="20" x2="48" y2="8" stroke="#8b93a8" stroke-width="3"/><circle cx="48" cy="7" r="5" fill="${mood === 'alert' ? '#ff5a5f' : mood === 'working' ? '#5ff2ff' : '#ffc94d'}"/>
      <rect x="12" y="20" width="72" height="62" rx="20" fill="#c8cfdc"/><rect x="20" y="30" width="56" height="40" rx="13" fill="#3a4256"/>
      ${eyes(37, 59, 48, 7, '#2a3142', '#5ff2ff', '#3a4256')}${mouthPath(m, big, '#5ff2ff')}
      <rect x="6" y="44" width="8" height="18" rx="4" fill="#8b93a8"/><rect x="82" y="44" width="8" height="18" rx="4" fill="#8b93a8"/><rect x="28" y="82" width="40" height="8" rx="4" fill="#8b93a8"/></g>`,
  },
  miso: {
    name: 'Miso',
    mouths: { smile: 'M42 69q3 3 6 0q3 3 6 0', o: 'M45 70a3 3 0 1 0 6 0a3 3 0 1 0-6 0', flat: 'M43 70h10', big: 'M41 68q7 9 14 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M80 80q16-6 10-26" stroke="#f4a24c" stroke-width="8" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" values="0 80 80;12 80 80;0 80 80" dur="1.6s" repeatCount="indefinite"/></path>
      <path d="M16 36L20 10l20 16zM80 36L76 10 56 26z" fill="#f4a24c"/><path d="M21 18l3 12 9-6zM75 18l-3 12-9-6z" fill="#ffc9a8"/>
      <ellipse cx="48" cy="58" rx="38" ry="32" fill="#f4a24c"/><ellipse cx="48" cy="70" rx="18" ry="12" fill="#ffe2cc"/>
      ${eyes(34, 62, 52, 7.5, '#fff', '#2b1d12', '#f4a24c')}<path d="M45 64h6l-3 3z" fill="#e0607a"/>${mouthPath(m, big, '#2b1d12')}
      <path d="M18 64h12M18 70l12-2M78 64H66M78 70l-12-2" stroke="#2b1d12" stroke-width="1.5" stroke-linecap="round"/></g>`,
  },
};
const MOUTH_FOR = { working: 'o', eat: 'o', alert: 'o', sleep: 'flat', happy: 'big' };
function charSvg(id, mood) {
  const c = CHARS[id] || CHARS.buddy;
  const key = MOUTH_FOR[mood] || 'smile';
  return c.svg(c.mouths[key], key === 'big', mood);
}

// ---------- "Fetch!": the dog carries the file to the folder-house as the job runs ----------
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
function drawFetch(c, p, t, K, done) {
  const circ = (x, y, r, f) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = f; c.fill(); };
  c.fillStyle = K('--color-stroke'); c.fillRect(0, 92, 320, 18);
  c.fillStyle = '#f2b43c'; c.fillRect(262, 58, 44, 34);
  c.beginPath(); c.moveTo(256, 60); c.lineTo(284, 36); c.lineTo(312, 60); c.fill();
  c.fillStyle = K('--color-surface-2'); c.fillRect(276, 70, 16, 22);
  const run = !done, x = 24 + ease(p) * 212, b = run ? Math.abs(Math.sin(t * 14)) * 4 : 0, y = 72 - b;
  for (let px = 34; px < x - 14; px += 22) {
    c.globalAlpha = Math.max(0.15, 1 - (x - px) / 220);
    circ(px, 99, 2.2, K('--color-mute')); circ(px + 6, 103, 2.2, K('--color-mute'));
  }
  c.globalAlpha = 1;
  const leg = run ? Math.sin(t * 14) * 5 : 0;
  c.strokeStyle = '#8a5a32'; c.lineWidth = 3.5; c.lineCap = 'round'; c.beginPath();
  [[-9, leg], [-4, -leg], [6, leg], [11, -leg]].forEach(([dx, o]) => { c.moveTo(x + dx, y + 5); c.lineTo(x + dx + o, y + 19); });
  c.stroke();
  c.beginPath(); c.moveTo(x - 15, y - 3); c.lineTo(x - 25, y - 12 + Math.sin(t * 30) * 4); c.stroke();
  c.fillStyle = '#c98a52'; c.beginPath(); c.ellipse(x, y, 17, 9, 0, 0, Math.PI * 2); c.fill(); circ(x + 16, y - 9, 10, '#c98a52');
  c.fillStyle = '#8a5a32'; c.beginPath(); c.ellipse(x + 11, y - 8, 4, 8, 0.4, 0, Math.PI * 2); c.fill();
  circ(x + 19, y - 11, 1.8, '#2b1d12'); circ(x + 26, y - 6, 2.4, '#2b1d12');
  if (run) {
    c.save(); c.translate(x + 29, y - 2); c.rotate(-0.2 + Math.sin(t * 14) * 0.08);
    c.fillStyle = '#fff'; c.fillRect(-2, -6, 14, 10); c.strokeStyle = '#9aa2b6'; c.lineWidth = 1; c.strokeRect(-2, -6, 14, 10); c.restore();
  } else {
    c.fillStyle = K('--color-p2'); c.font = '800 20px sans-serif'; c.fillText('♥', x + 10, y - 22 - ((t * 20) % 14));
  }
}

function JobCard({ job, onHide }) {
  const canvas = useRef(null);
  const live = useRef(job);
  live.current = job;
  const [shown, setShown] = useState(job.progress);
  useEffect(() => {
    const cv = canvas.current;
    const d = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d;
    const css = getComputedStyle(document.documentElement);
    const K = (name) => css.getPropertyValue(name).trim();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let p = live.current.progress, raf, last = 0;
    const frame = (now) => {
      const j = live.current;
      const done = j.state === 'done';
      // creep towards where the current request will leave the bar, never past it
      const target = done ? 1 : j.next != null ? Math.max(j.progress, j.next * 0.97) : j.progress;
      p = Math.max(j.progress, p + (target - p) * (done ? 0.08 : 0.012));
      const c = cv.getContext('2d'), k = cv.width / 320;
      c.setTransform(k, 0, 0, k, 0, 0); c.clearRect(0, 0, 320, 110);
      drawFetch(c, p, still ? 0 : now / 1000, K, done);
      if (now - last > 200) { setShown(p); last = now; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const done = job.state === 'done', failed = job.state === 'failed';
  const step = Math.min(job.step, job.steps.length - 1);
  return (
    <div role="status" aria-live="polite"
      className="pet-card pet-pop flex flex-col gap-2.5 rounded-2xl border border-stroke bg-surface p-3.5 text-txt shadow-xl shadow-black/30">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{job.name}</p>
          <p className={`truncate text-xs ${failed ? 'text-bad' : 'text-mute'}`}>{failed ? 'Stopped' : done ? 'Finished' : `${job.steps[step]}…`}</p>
        </div>
        <span className={`text-xl font-extrabold tabular-nums ${done ? 'text-ok' : failed ? 'text-bad' : 'text-p1'}`}>
          {done ? '✓' : failed ? '!' : `${Math.floor(shown * 100)}%`}
        </span>
      </div>
      <canvas ref={canvas} className="pet-scene" aria-hidden="true" />
      <div className="flex gap-1">
        {job.steps.map((s, i) => (
          <span key={s} className={`h-1 flex-1 rounded-full transition-colors ${done || i < step ? 'bg-ok' : i === step ? (failed ? 'bg-bad' : 'bg-p1') : 'bg-white/10'}`} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-mute">
        <span>{done || failed ? job.message || '' : `Step ${step + 1} of ${job.steps.length}`}</span>
        {onHide && <button onClick={onHide} className="shrink-0 pl-2 font-semibold hover:text-txt">Hide</button>}
      </div>
    </div>
  );
}

export default function Pet({ me, due, expiring, unread, canShelf, onOpen }) {
  const [char, setChar] = useState(() => (CHARS[read(localStorage, CHAR_KEY)] ? read(localStorage, CHAR_KEY) : 'buddy'));
  const [hidden, setHidden] = useState(() => read(sessionStorage, HIDE_KEY) === '1');
  const [jobs, setJobs] = useState(currentJobs());
  const [imp, setImp] = useState(importState());
  const [menu, setMenu] = useState(false);
  const [bubble, setBubble] = useState(null); // { text, actions: [[label, fn]] }
  const [flash, setFlash] = useState(null); // a passing mood: 'happy' | 'eat' | 'alert'
  const [sleeping, setSleeping] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [sparks, setSparks] = useState([]);
  const [hiddenCards, setHiddenCards] = useState([]); // job cards the person tucked away
  const art = useRef(null);
  const lastActive = useRef(Date.now());

  useEffect(() => onJobs(setJobs), []);
  useEffect(() => onImport(setImp), []);

  const name = CHARS[char].name;
  const todoCount = due.todos.length + due.routines.length;
  const attention = todoCount + expiring.length + unread;

  // A folder or ZIP import is a job too, it just lives in the importer.
  const importJob = imp && (imp.phase === 'reading' || imp.phase === 'uploading') ? {
    id: 'import', name: `Importing ${imp.name}`, steps: ['Opening', 'Uploading', 'Handing over'],
    step: imp.phase === 'reading' ? 0 : 1, progress: imp.total ? imp.sent / imp.total : 0, state: 'running',
  } : null;
  const allJobs = importJob ? [importJob, ...jobs] : jobs;
  const card = allJobs.find((j) => !hiddenCards.includes(j.id));
  const running = allJobs.some((j) => j.state === 'running');
  const mood = flash || (running ? 'working' : sleeping ? 'sleep' : 'idle');

  const say = (text, actions = [], ms = 8000) => {
    setBubble({ text, actions, key: Date.now() });
    if (ms && !actions.length) setTimeout(() => setBubble((b) => (b?.text === text ? null : b)), ms);
  };
  const doFlash = (m, ms = 2200) => { setFlash(m); setTimeout(() => setFlash((f) => (f === m ? null : f)), ms); };
  const burst = (ch = '✦') => {
    const add = Array.from({ length: 7 }, (_, i) => ({ id: `${Date.now()}-${i}`, ch, dx: Math.random() * 90 - 45, dy: -30 - Math.random() * 50 }));
    setSparks((s) => [...s, ...add]);
    setTimeout(() => setSparks((s) => s.filter((x) => !add.includes(x))), 1000);
  };

  // eyes follow the pointer; any movement keeps it awake
  useEffect(() => {
    const move = (e) => {
      lastActive.current = Date.now();
      const r = art.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1, k = Math.min(3, d / 60);
      art.current.querySelectorAll('.pupil').forEach((p) => p.setAttribute('transform', `translate(${(dx / d) * k} ${(dy / d) * k})`));
    };
    const wake = () => { lastActive.current = Date.now(); setSleeping(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    const t = setInterval(() => { if (Date.now() - lastActive.current > SLEEP_AFTER) setSleeping(true); else setSleeping(false); }, 5000);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); clearInterval(t); };
  }, []);

  // Once a session, say what is waiting, if anything is.
  const greeted = useRef(false);
  useEffect(() => {
    if (greeted.current || !attention) return undefined;
    const t = setTimeout(() => {
      greeted.current = true;
      const parts = [todoCount && plural(todoCount, 'to-do') + ' due', expiring.length && plural(expiring.length, 'document') + ' running out', unread && plural(unread, 'unread message')].filter(Boolean);
      say(`Hi ${me.name?.split(' ')[0] || 'there'}! You have ${parts.join(', ')}. Click me to see them.`, [], 9000);
    }, 2500);
    return () => clearTimeout(t);
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new message: a little hop
  const prevUnread = useRef(unread);
  useEffect(() => { if (unread > prevUnread.current) doFlash('alert', 1900); prevUnread.current = unread; }, [unread]);

  // a job that has just finished or failed says so
  const reported = useRef(new Set());
  useEffect(() => {
    for (const j of jobs) {
      if (j.state === 'running' || reported.current.has(j.id)) continue;
      reported.current.add(j.id);
      if (j.state === 'done') { doFlash('happy'); burst(); say(j.message || 'Done!', [], 8000); }
      else say(j.message || 'That job stopped.', [], 10000);
    }
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevImp = useRef(imp?.phase);
  useEffect(() => {
    if (prevImp.current === 'uploading' && !imp) { doFlash('happy'); burst(); say('Import sent. Filing carries on by itself; the Shelf shows how far it has got.', [], 9000); }
    if (imp?.phase === 'error' && prevImp.current !== 'error') say(`Could not import ${imp.name}: ${imp.error}`, [], 10000);
    prevImp.current = imp?.phase;
  }, [imp]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (panel) => { setMenu(false); onOpen(panel); };
  const pick = (id) => { setChar(id); write(localStorage, CHAR_KEY, id); burst(); doFlash('happy', 1500); };
  const hide = () => { setMenu(false); setBubble(null); setHidden(true); write(sessionStorage, HIDE_KEY, '1'); };
  const show = () => { setHidden(false); write(sessionStorage, HIDE_KEY, null); };

  const drop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDropping(false);
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (!canShelf) { say('Files are not turned on for you, so I cannot file that.', [], 6000); return; }
    setMenu(false); setBubble(null); doFlash('eat', 1300);
    sendToShelf(files).catch(() => {}); // the job card and the bubble say how it went
  };

  if (hidden) {
    return (
      <div className="pet-dock">
        <button onClick={show} aria-label={`Show ${name}`} title={`Show ${name}`}
          className="pet-tab grid place-items-center border border-r-0 border-stroke bg-surface text-mute shadow-lg hover:text-txt">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="7" cy="9" r="2"/><circle cx="12" cy="6.5" r="2"/><circle cx="17" cy="9" r="2"/><ellipse cx="12" cy="15" rx="5" ry="4"/></svg>
          {attention > 0 && <span className="absolute -mt-8 ml-3 size-2.5 rounded-full bg-bad" />}
        </button>
      </div>
    );
  }

  const todos = [...due.todos, ...due.routines].slice(0, 3);
  return (
    <div className="pet-dock">
      {card && <JobCard key={card.id} job={card} onHide={card.state === 'running' ? () => setHiddenCards((h) => [...h, card.id]) : () => dismissJob(card.id)} />}

      {menu ? (
        <div role="dialog" aria-label={name} className="pet-pop pet-card overflow-hidden rounded-2xl border border-stroke bg-surface text-sm text-txt shadow-xl shadow-black/30">
          <div className="flex items-baseline justify-between px-4 pb-2 pt-3.5">
            <b className="text-base font-bold">Hi, I'm {name}</b>
            <span className="text-xs text-mute">{running ? 'busy' : attention ? `${attention} for you` : 'all good'}</span>
          </div>
          {allJobs.filter((j) => j.state === 'running').map((j) => (
            <div key={j.id} className="border-t border-stroke px-4 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-mute">Running now</p>
              <p className="mt-1 truncate">{j.name}</p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-p1 transition-all" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
            </div>
          ))}
          <div className="flex flex-col border-t border-stroke py-1">
            <button onClick={() => open('todos')} className="flex items-start gap-3 px-4 py-2 text-left hover:bg-white/5">
              <span className={`mt-0.5 min-w-6 rounded-full px-1.5 text-center text-xs font-bold ${todoCount ? 'bg-warn/20 text-warn' : 'bg-white/10 text-mute'}`}>{todoCount}</span>
              <span className="min-w-0 flex-1">To-dos due{todos.map((t, i) => <small key={i} className="block truncate text-xs text-mute">{t.text}</small>)}</span>
            </button>
            <button onClick={() => open('files')} className="flex items-start gap-3 px-4 py-2 text-left hover:bg-white/5">
              <span className={`mt-0.5 min-w-6 rounded-full px-1.5 text-center text-xs font-bold ${expiring.length ? 'bg-bad/20 text-bad' : 'bg-white/10 text-mute'}`}>{expiring.length}</span>
              <span className="min-w-0 flex-1">Documents running out{expiring[0] && <small className="block truncate text-xs text-mute">{expiring[0].title || expiring[0].name}</small>}</span>
            </button>
            <button onClick={() => open('messages')} className="flex items-start gap-3 px-4 py-2 text-left hover:bg-white/5">
              <span className={`mt-0.5 min-w-6 rounded-full px-1.5 text-center text-xs font-bold ${unread ? 'bg-ok/20 text-ok' : 'bg-white/10 text-mute'}`}>{unread}</span>
              <span className="min-w-0 flex-1">Unread messages</span>
            </button>
          </div>
          {canShelf && <p className="border-t border-stroke px-4 py-2.5 text-xs text-mute">Drop any file on me and I'll put it on your Shelf.</p>}
          <div className="border-t border-stroke px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-mute">Pick a friend</p>
            <div className="mt-1.5 flex gap-1 rounded-xl bg-white/5 p-1">
              {Object.entries(CHARS).map(([id, c]) => (
                <button key={id} onClick={() => pick(id)} aria-pressed={char === id}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${char === id ? 'bg-surface-2 text-txt shadow' : 'text-mute hover:text-txt'}`}>{c.name}</button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 border-t border-stroke px-4 py-3">
            <button onClick={hide} className="flex-1 rounded-xl border border-stroke py-2 text-xs font-semibold text-mute hover:text-txt">Hide for now</button>
            <button onClick={() => setMenu(false)} className="flex-1 rounded-xl border border-stroke py-2 text-xs font-semibold hover:bg-white/5">Close</button>
          </div>
        </div>
      ) : bubble && (
        <div key={bubble.key} role="status" className="pet-pop pet-bubble border border-stroke bg-surface px-3.5 py-3 text-sm leading-snug text-txt shadow-xl shadow-black/30">
          <button onClick={() => setBubble(null)} aria-label="Dismiss" className="float-right -mr-1 -mt-1 ml-2 text-base leading-none text-mute hover:text-txt">×</button>
          {bubble.text}
        </div>
      )}

      <button ref={art} onClick={() => { setBubble(null); setMenu((m) => !m); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropping(true); }} onDragLeave={() => setDropping(false)} onDrop={drop}
        aria-label={attention ? `${name}: ${attention} things for you` : name} title={name}
        className={`pet ${mood} ${dropping ? 'dropping' : ''}`}>
        <svg viewBox="0 0 96 96" dangerouslySetInnerHTML={{ __html: charSvg(char, mood) }} />
        <span className="pet-zz">z</span>
        {attention > 0 && !menu && <span className="pet-badge">{attention > 99 ? '99+' : attention}</span>}
        {sparks.map((s) => <span key={s.id} className="pet-spark" style={{ '--dx': `${s.dx}px`, '--dy': `${s.dy}px` }}>{s.ch}</span>)}
      </button>
    </div>
  );
}
