import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BarChart3, BellRing, ChevronLeft, ChevronRight, ClipboardList, FileClock, Globe, Landmark, LayoutDashboard, Megaphone, MessagesSquare, Pause, Play, RotateCw, ScanEye, Sparkles, Users, Volume2, VolumeX, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/region';
import { can } from '../lib/modules';
import { createTourScene } from '../lib/tourScene';

// Tour: the whole app as a place that can be walked. Every screen the sidebar opens is a
// stop on a ring round Riley; one tapped is flown to, says what it is for and how it
// stands today, and is walked into from there. "Take the tour" goes round them all in turn,
// read aloud if Voice is on. Each stop has its name under it with its figure for today, and
// Riley in the middle opens a chat. Like the 3D View it is drawn over the page, in the theme's colours, and
// each stop wears the colours its disc has in the sidebar.
// Nothing is kept here: the figures are the Overview's, the Alerts' and Work orders' own,
// and going in is the sidebar's own way in (`onGo`). The drawing itself is lib/tourScene.js.
// Walking in does not leave: the screen opens as a window over the Tour (`inside`), which
// goes on moving behind it, and closing the window steps back out to the stop it was opened
// from. A place picked in the sidebar meanwhile is flown to the same way (`ask`).

const PANEL = 'rounded-2xl border border-stroke bg-surface/85 backdrop-blur';
const CHIP = 'rounded-full border px-3 py-1.5 text-xs transition';
const STAY = 7000; // how long the tour stands at each stop, in ms
const LIVE = ['open', 'assigned', 'in_progress']; // a repair not done yet
const VOICE_KEY = 'jarvis:tour-voice'; // whether the tour is read aloud, kept from one visit to the next
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
// A stop's name, hung under it by the scene.
const TAG = 'pointer-events-auto absolute left-0 top-0 flex flex-col items-center whitespace-nowrap rounded-xl px-2 py-1 text-center font-mono uppercase will-change-transform';
const keep = (key, v) => { try { localStorage.setItem(key, v); } catch { /* private browsing: it is not kept */ } };
const RILEY = { id: 'riley', label: 'Riley', hint: 'Ask anything. Tap to open a chat.' };

// The stops, in the order they are walked: the sidebar's places, in the sidebar's colours.
// `subs` are the ways in besides the front door.
const STOPS = [
  { id: 'overview', Ico: LayoutDashboard, label: 'Overview', tw: 'from-amber-300 to-orange-500', color: ['#fcd34d', '#f97316'],
    hint: 'Occupancy, rent and what needs attention', about: 'Where the day starts: how full the buildings are, the rent that came in this month, what is overdue and which leases are about to end.' },
  { id: 'chats', Ico: MessagesSquare, label: 'Chats', tw: 'from-cyan-400 to-blue-600', color: ['#22d3ee', '#2563eb'],
    hint: 'Riley, and your team chat', about: 'Ask Riley anything about the business, in words or by voice, and talk to the rest of the team in the same place.' },
  { id: 'leasing', Ico: ClipboardList, label: 'Leasing', tw: 'from-emerald-400 to-cyan-500', color: ['#34d399', '#06b6d4'],
    hint: 'Leases, the 3D view and the calendar', about: 'Every lease, from draft to move-out, with its payments and papers. The same units stand as a building in the 3D view, and by date on the calendar.',
    subs: [['bookings', 'Leases'], ['vacant', 'Vacant'], ['3d', '3D view'], ['calendar', 'Calendar']] },
  { id: 'tenants', Ico: Users, label: 'Tenants', tw: 'from-rose-400 to-pink-600', color: ['#fb7185', '#db2777'],
    hint: 'The people and companies renting', about: 'The people and companies renting from you, each with everything they have ever leased, paid and asked to be repaired.' },
  { id: 'workorders', Ico: Wrench, label: 'Work orders', tw: 'from-sky-400 to-cyan-600', color: ['#38bdf8', '#0891b2'],
    hint: 'Repairs: what is open, and who has it', about: 'Repairs from the moment they are reported until they are done: what is open, how urgent it is, and who has it.' },
  { id: 'reports', Ico: BarChart3, label: 'Reports', tw: 'from-violet-400 to-fuchsia-500', color: ['#a78bfa', '#d946ef'],
    hint: 'Daily, rent roll, overdue, collections', about: 'The figures, ready to print or send: the day as it went, the rent roll, what is overdue by age, and what has been collected.' },
  { id: 'alerts', Ico: BellRing, label: 'Alerts', tw: 'from-orange-400 to-red-500', color: ['#fb923c', '#ef4444'],
    hint: 'What needs attention today', about: 'Everything that needs someone today: rent due and overdue, leases ending, contracts missing. Each one opens the screen that deals with it.' },
  { id: 'documents', Ico: FileClock, label: 'Documents', tw: 'from-lime-400 to-green-600', color: ['#a3e635', '#16a34a'],
    hint: 'Policies, licences and certificates', about: 'Policies, licences and certificates, each with the day it runs out, so a renewal is started before it is late.' },
  { id: 'properties', Ico: Landmark, label: 'Properties', tw: 'from-slate-400 to-slate-600', color: ['#94a3b8', '#475569'],
    hint: 'Companies, buildings, units, documents', about: 'What you own and manage: the companies, their buildings, and every unit in them. Everything else in the app is built on this.' },
  { id: 'sources', Ico: Megaphone, label: 'Sources', tw: 'from-emerald-400 to-teal-600', color: ['#34d399', '#0d9488'],
    hint: 'Where tenants come from', about: 'Where tenants hear of you: the agents, the listings and the word of mouth, so you know which of them is worth the money.' },
  { id: 'region', Ico: Globe, label: 'Region', tw: 'from-indigo-400 to-purple-600', color: ['#818cf8', '#9333ea'], master: true,
    hint: 'Currency, time zone, phone code', about: 'The currency every amount is shown in, the time zone the days are counted in, and the country code for phone numbers.' },
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
const pct = (x) => `${Math.round(x * 100)}%`;
const typing = (el) => el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable);

/** How each stop stands today: the lines on its card, the figure on its name tag, and the count on its badge. */
function standing(d, alerts, repairs, unread) {
  const urgent = repairs.filter((w) => w.priority === 'urgent').length;
  const units = d?.units;
  return {
    overview: d && { lines: [['Occupancy', pct(d.occupancy)], ['Collected this month', money(Math.round(d.collection.collected))], d.overdue.total > 0 && ['Overdue', money(Math.round(d.overdue.total)), 'bad']], fig: `${pct(d.occupancy)} full` },
    chats: { lines: [['Unread messages', unread || 'None']], badge: unread, fig: unread ? `${unread} unread` : null },
    leasing: d && { lines: [['Units let', `${units.let} of ${units.total}`], ['Vacant', units.vacant], ['Ending soon', units.ending]], fig: `${units.let}/${units.total} let` },
    tenants: d && { lines: [['Units with a tenant', units.let], units.overdue > 0 && ['Behind on rent', units.overdue, 'bad']], fig: units.overdue > 0 ? `${units.overdue} behind` : null },
    workorders: { lines: [['Open repairs', repairs.length || 'None'], urgent > 0 && ['Urgent', urgent, 'bad']], badge: repairs.length, fig: repairs.length ? `${repairs.length} open` : null },
    alerts: { lines: [['Need attention', alerts.count || 'Nothing']], badge: alerts.count, fig: alerts.count ? `${alerts.count} waiting` : null },
    documents: { lines: [['To renew', alerts.rules.document || 'None']], badge: alerts.rules.document, fig: alerts.rules.document ? `${alerts.rules.document} to renew` : null },
    properties: d && { lines: [['Buildings', d.buildings.length], ['Units', units.total]], fig: `${d.buildings.length} building${d.buildings.length === 1 ? '' : 's'}` },
  };
}

export default function Tour3D({ user, unread = 0, inside = false, ask, onGo, onBack }) {
  // The master's stops, and for everyone else the stops of the modules they hold: a stop's id is its module.
  const stops = useMemo(() => STOPS.filter((s) => (s.master ? user.role === 'master' : can(s.id))), [user.role, user.modules]);
  const [at, setAt] = useState(null); // the stop stood before, or null for the whole ring
  const [touring, setTouring] = useState(false); // being taken round, a stop at a time
  const [spin, setSpin] = useState(true);
  const [hover, setHover] = useState(null); // { id, x, y }
  const [leaving, setLeaving] = useState(false); // walking into a stop, or inside the window it opened
  const [voice, setVoice] = useState(() => { try { return canSpeak && localStorage.getItem(VOICE_KEY) === '1'; } catch { return false; } }); // the tour is read aloud
  const [d, setD] = useState(null);
  const [alerts, setAlerts] = useState({ count: 0, rules: {} });
  const [repairs, setRepairs] = useState([]);
  const stage = useRef(null);
  const marks = useRef(null); // the stops' icons, drawn out of sight for the scene to copy onto its tiles
  const scene = useRef(null);
  const tags = useRef(new Map()); // each stop's name tag, for the scene to hold over its landmark
  const now = useRef({}); // what the scene, made once, is to call back with: a tap, as it is taken today
  const pin = (id) => (node) => { if (node) tags.current.set(id, node); else tags.current.delete(id); };

  // Read on the way in, and again each time a window is closed: what was done in it shows on the stops.
  useEffect(() => {
    if (inside) return;
    // Each figure is asked for only by someone the server would answer.
    if (can('overview') || can('leasing')) api.get('/leasing/overview?company_id=&building_id=&months=1').then(setD).catch(() => {});
    if (can('alerts') || can('documents')) api.get('/leasing/alerts/count').then(setAlerts).catch(() => {});
    if (can('workorders') || can('leasing')) api.get('/leasing/work-orders?status=active').then((r) => setRepairs(r.work_orders.filter((w) => LIVE.includes(w.status)))).catch(() => {});
  }, [inside]);
  const state = useMemo(() => standing(d, alerts, repairs, unread), [d, alerts, repairs, unread]);

  const index = stops.findIndex((s) => s.id === at);
  const stop = stops[index];
  const stand = (id) => { setAt(id); if (id) setSpin(false); };
  const move = (by) => stand(stops[(index + by + stops.length) % stops.length].id);
  // `through` is what is walked into on screen, when it is not the stop itself: Riley, for the chats.
  const walk = (id, sub, through = id) => {
    setLeaving(true); setTouring(false);
    scene.current ? scene.current.enter(through, () => onGo(id, sub)) : onGo(id, sub);
  };
  const go = (id, sub, through) => { if (!leaving) walk(id, sub, through); };
  // A tap on a stop goes to it; on the one already stood before, in; on Riley, to the chats; on the open ground, back out.
  const pick = (id) => {
    if (id === 'riley') return go('chats', undefined, 'riley');
    if (id && id === at) return go(id);
    setTouring(false);
    return stand(id);
  };

  useEffect(() => {
    const s = createTourScene(stage.current, {
      light: document.documentElement.dataset.mode === 'light',
      colors: Object.fromEntries(['p1', 'p2', 'p3', 'chart', 'warn', 'bad', 'mute', 'txt'].map((k) => [k, css(k)])),
      still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onHover: (id, x, y) => setHover(id == null ? null : { id, x, y }),
      onPick: (id) => now.current.pick(id),
      onTurn: () => { setSpin(false); setTouring(false); },
    });
    s.setLabels(tags.current);
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []);
  now.current = { pick };
  // Each stop as the scene takes it: its two colours, and its icon as it is drawn here, in white.
  useEffect(() => {
    const drawn = marks.current.querySelectorAll('svg');
    scene.current?.setStops(stops.map((s, i) => ({ id: s.id, color: s.color, icon: new XMLSerializer().serializeToString(drawn[i]) })));
  }, [stops]);
  useEffect(() => { scene.current?.setBadges(new Map(stops.map((s) => [s.id, Number(state[s.id]?.badge) || 0]))); }, [stops, state]);
  // Not while walking in, which has the camera: once the window is closed it is stood back before the stop.
  useEffect(() => { if (!leaving) scene.current?.setFocus(at); }, [at, leaving]);
  // The window closed: out again. Before the next effect, so a place asked for as it closes is still walked into.
  useEffect(() => { if (!inside) setLeaving(false); }, [inside]);
  // A place picked in the sidebar: gone to, and walked into.
  useEffect(() => {
    if (!ask) return;
    const known = stops.some((s) => s.id === ask.stop);
    if (known) stand(ask.stop);
    walk(ask.stop, ask.sub, ask.stop === 'chats' ? 'riley' : ask.stop);
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scene.current?.setSpin(spin && !at); }, [spin, at]);

  // The tour: on to the next stop after a while, or once it has been read out, and back out
  // to the whole ring after the last.
  useEffect(() => {
    if (!touring || !at) return undefined;
    const on = () => { if (index === stops.length - 1) { setTouring(false); setAt(null); setSpin(true); } else move(1); };
    let t;
    if (!voice) { t = setTimeout(on, STAY); return () => clearTimeout(t); }
    const say = new SpeechSynthesisUtterance(`${stop.label}. ${stop.about}`);
    say.onend = () => { t = setTimeout(on, 900); };
    say.onerror = () => { t = setTimeout(on, STAY); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(say);
    return () => { say.onend = null; say.onerror = null; window.speechSynthesis.cancel(); clearTimeout(t); };
  }, [touring, at, voice]); // eslint-disable-line react-hooks/exhaustive-deps
  const speak = () => { const on = !voice; setVoice(on); keep(VOICE_KEY, on ? '1' : '0'); };

  // The arrows walk the ring, Enter goes in, Escape steps back.
  useEffect(() => {
    const key = (e) => {
      if (inside || leaving || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') { setTouring(false); move(1); } else if (e.key === 'ArrowLeft') { setTouring(false); move(index < 0 ? 0 : -1); } else if (e.key === 'Enter' && stop && !typing(document.activeElement) && document.activeElement?.tagName !== 'BUTTON') go(stop.id);
      else if (e.key === 'Escape' && at) { setTouring(false); setAt(null); } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const tip = hover && hover.id !== at && (hover.id === 'riley' ? RILEY : stops.find((s) => s.id === hover.id));
  const toggle = (on) => `${CHIP} flex items-center gap-1.5 ${on ? 'border-p1/60 bg-p1/20 text-p1' : 'border-stroke bg-surface/80 text-mute hover:text-txt'}`;
  const lines = (stop && state[stop.id]?.lines?.filter(Boolean)) || [];

  return (
    <div className="sky absolute inset-0 z-20 overflow-hidden">
      <div ref={stage} className="absolute inset-0" />
      <div ref={marks} hidden>{stops.map((s) => <s.Ico key={s.id} size={256} color="#ffffff" strokeWidth={1.6} />)}</div>

      {/* The names: the scene keeps each under its tile. A stop's says how it stands today. */}
      <div className={`pointer-events-none absolute inset-0 isolate overflow-hidden transition-opacity duration-300 ${leaving ? 'opacity-0' : ''}`}>
        <button ref={pin('riley')} onClick={() => pick('riley')} onPointerEnter={() => scene.current?.setOver('riley')} onPointerLeave={() => scene.current?.setOver(null)}
          title={RILEY.hint} className={TAG} style={{ opacity: 0 }}>
          <span className="flex items-center gap-1.5 text-xs font-medium tracking-[0.22em]"><Sparkles size={12} className="text-p1" />Riley</span>
          <span className="text-[10px] tracking-[0.12em] text-mute">Ask anything</span>
        </button>
        {stops.map((s) => (
          <button key={s.id} ref={pin(s.id)} onClick={() => pick(s.id)} onPointerEnter={() => scene.current?.setOver(s.id)} onPointerLeave={() => scene.current?.setOver(null)}
            className={TAG} style={{ opacity: 0 }}>
            <span className="flex items-center gap-1.5 text-xs font-medium tracking-[0.22em]">{s.label}
              {state[s.id]?.badge > 0 && <span className="rounded-full bg-bad px-1.5 font-sans text-[10px] font-semibold leading-4 tracking-normal text-white">{state[s.id].badge > 99 ? '99+' : state[s.id].badge}</span>}
            </span>
            {state[s.id]?.fig && !(state[s.id]?.badge > 0) && <span className="text-[10px] tracking-[0.12em] text-mute">{state[s.id].fig}</span>}
          </button>
        ))}
      </div>

      <header className={`pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 px-4 pb-3 pt-safe transition-opacity duration-300 md:px-8 ${leaving ? 'invisible opacity-0' : ''}`}>
        <div className="pointer-events-auto flex items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronLeft size={22} /></button>
          <h1 className="text-lg font-light">Tour</h1>
        </div>
        <div className="pointer-events-auto ml-auto flex flex-wrap items-center justify-end gap-2 pt-1">
          <button onClick={() => { if (touring) return setTouring(false); setTouring(true); if (!at) stand(stops[0].id); return undefined; }} aria-pressed={touring}
            className={`${CHIP} flex items-center gap-1.5 ${touring ? 'border-p1/60 bg-p1/20 text-p1' : 'border-transparent bg-gradient-to-br from-p1 to-p2 font-medium text-white shadow-lg shadow-p1/25'}`}>
            {touring ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Take the tour</>}
          </button>
          {canSpeak && <button onClick={speak} aria-pressed={voice} title="Read the tour aloud" className={toggle(voice)}>{voice ? <Volume2 size={14} /> : <VolumeX size={14} />} Voice</button>}
          <button onClick={() => setSpin(!spin)} aria-pressed={spin && !at} disabled={!!at} className={`${toggle(spin && !at)} disabled:opacity-50`}><RotateCw size={14} /> Turn</button>
          <button onClick={() => { setTouring(false); setAt(null); scene.current?.setFocus(null); }} className={toggle(false)}><ScanEye size={14} /> See all</button>
        </div>
      </header>

      {tip && (
        <div className="pointer-events-none fixed z-30 -translate-x-1/2 -translate-y-full rounded-xl border border-stroke bg-surface px-3 py-2 text-xs shadow-xl" style={{ left: hover.x, top: hover.y - 14 }}>
          <p className="font-medium">{tip.label}</p>
          <p className="text-mute">{tip.hint}</p>
        </div>
      )}

      {/* The stop stood before: what it is for, how it stands today, and the ways in. */}
      {stop && !leaving && (
        <div key={stop.id} className={`${PANEL} absolute inset-x-3 bottom-3 max-h-[58%] animate-[rise_0.35s_ease-out] overflow-y-auto p-4 text-sm md:inset-x-auto md:bottom-auto md:right-6 md:top-24 md:w-80`}>
          {touring && !voice && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-full bg-white/10"><div className="h-full origin-left bg-gradient-to-r from-p1 to-p2" style={{ animation: `tour-fill ${STAY}ms linear both` }} /></div>}
          <div className="flex items-start gap-3">
            <span className={`grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white shadow-lg ${stop.tw}`}><stop.Ico size={19} strokeWidth={1.75} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{stop.label}</p>
              <p className="text-xs text-mute">Stop {index + 1} of {stops.length}</p>
            </div>
            <button onClick={() => { setTouring(false); setAt(null); }} aria-label="Step back" className="-mr-1.5 -mt-1.5 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-txt/85">{stop.about}</p>
          {lines.length > 0 && (
            <dl className="mt-3 space-y-1.5 border-t border-stroke pt-3 text-xs">
              {lines.map(([k, v, tone]) => <div key={k} className="flex justify-between gap-3"><dt className="text-mute">{k}</dt><dd className={`tabular-nums ${tone === 'bad' ? 'text-bad' : ''}`}>{v}</dd></div>)}
            </dl>
          )}
          {stop.subs && (
            <div className="mt-3 flex flex-wrap gap-2">
              {stop.subs.map(([k, l]) => <button key={k} onClick={() => go(stop.id, k)} className={toggle(false)}>{l}</button>)}
            </div>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => { setTouring(false); move(-1); }} aria-label="The stop before" className="grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute hover:text-txt"><ChevronLeft size={16} /></button>
            <button onClick={() => go(stop.id)} className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98]">Open {stop.label} <ArrowRight size={15} /></button>
            <button onClick={() => { setTouring(false); move(1); }} aria-label="The next stop" className="grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute hover:text-txt"><ChevronRight size={16} /></button>
          </div>
        </div>
      )}

      {/* Every stop, to go straight to: on a phone it gives way to the card. */}
      <div className={`absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3 ${stop ? 'max-md:hidden' : ''} ${leaving ? 'hidden' : ''}`}>
        {!stop && <p className="pointer-events-none text-center text-xs text-mute">Tap a place to fly to it, drag to look around, or take the tour. Riley, in the middle, opens a chat.</p>}
        <nav aria-label="Stops" className={`${PANEL} flex max-w-full gap-1 overflow-x-auto p-1.5`}>
          {stops.map((s) => (
            <button key={s.id} onClick={() => { setTouring(false); stand(s.id); }} aria-label={s.label} title={s.label} aria-current={s.id === at ? 'true' : undefined}
              className={`relative grid size-10 shrink-0 place-items-center rounded-full transition ${s.id === at ? 'bg-white/15' : 'hover:bg-white/10'}`}>
              <span className={`grid size-7 place-items-center rounded-full bg-gradient-to-br text-white transition ${s.tw} ${s.id === at ? 'scale-110' : at ? 'opacity-60' : ''}`}><s.Ico size={14} strokeWidth={1.75} /></span>
              {state[s.id]?.badge > 0 && <span className="absolute right-0.5 top-0.5 size-2.5 rounded-full bg-bad ring-2 ring-surface" />}
            </button>
          ))}
        </nav>
      </div>

      {/* Walking in: the place dims as the screen opens over it, and goes on moving behind. */}
      <div className={`absolute inset-0 z-40 bg-bg transition-opacity duration-500 ${leaving ? 'opacity-45' : 'pointer-events-none opacity-0'}`} />
    </div>
  );
}
