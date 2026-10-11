import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, Check, ClipboardCheck, FileText, Layers, Loader2, Plus, RotateCw, ScanEye, Upload, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../lib/region';
import { createBuildingScene } from '../lib/buildingScene';
import Select from './Select';
import QuickLease from './QuickLease';

// 3D View: one building as a tower that can be turned, pulled apart floor by floor and
// tapped, each unit coloured by how it stands today. Nothing is kept here: the units and
// their state are the Overview's (/leasing/overview), the repairs are Work orders'.
// A building with a floor plan (/properties/plans) is drawn as it is built: each unit where
// it is and as big as it is, with the corridor, the stairs and the lobby between them.
// The master gives a building its plan by uploading the drawings: Riley reads them, the
// reading is shown here as it would be drawn, and it is kept only when the master says so.
// A vacant unit is leased where it stands (QuickLease), with the building still in view.
// The drawing itself is lib/buildingScene.js.

const SELECT = 'glass rounded-xl bg-surface px-3.5 py-2 text-sm outline-none focus:border-p1/70';
const CHIP = 'rounded-full border px-3 py-1.5 text-xs transition';
const PANEL = 'rounded-2xl border border-stroke bg-surface/85 backdrop-blur';
// The same colours the Overview gives each state.
const STATUS = { occupied: ['Occupied', 'chart'], ending: ['Ending soon', 'warn'], overdue: ['Overdue', 'bad'], vacant: ['Vacant', 'mute'], blocked: ['Blocked', 'mute'] };
const MODES = [['status', 'Status'], ['rent', 'Rent'], ['ending', 'Lease end']];
const LIVE = ['open', 'assigned', 'in_progress']; // a repair not done yet
const FAR = 365; // a lease with this long left, or longer, is as green as it gets

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
const hex = (c) => { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
/** The colour a share of the way from one to another, both #rrggbb. */
const blend = (a, b, t) => { const [x, y] = [hex(a), hex(b)]; return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const floorName = (f) => (f == null || f === '' ? 'No floor' : /^\d+$/.test(String(f).trim()) ? `Floor ${f}` : /^g$/i.test(String(f).trim()) ? 'Ground' : String(f));

// A unit saved with no floor takes it from its number: 601 is on floor 6, 1001 on floor 10.
const floorOf = (u) => (u.floor != null && u.floor !== '' ? u.floor : /^[1-9]\d{2,3}$/.test(u.unit_no) ? u.unit_no.slice(0, -2) : null);
const level = (f) => { const n = String(f ?? '').replace(/\D/g, ''); return n ? Number(n) : -1; }; // those with no number (G, or none) go under floor 1

// A plan is in metres from the south-west corner; the drawing is a storey to the unit, from the middle, the south side in front.
const placer = (p) => (r) => ({ x: (r.x + r.w / 2 - p.width / 2) / p.storey, z: (p.depth / 2 - r.y - r.d / 2) / p.storey, w: r.w / p.storey, d: r.d / p.storey });
/** A unit as the drawing takes it: where it is, and its rooms from its own middle. */
const placed = (at, r) => {
  const me = at(r);
  return { rect: me, rooms: (r.rooms || []).map((room) => { const p = at(room); return { label: room.label, x: p.x - me.x, z: p.z - me.z, w: p.w, d: p.d }; }) };
};

let lastBuilding = ''; // the building last looked at, so coming back from a lease or a repair returns to it

export default function Building3D({ onPay, onLease, onNew, onInspect, onWork }) {
  const [d, setD] = useState(null);
  const [repairs, setRepairs] = useState([]);
  const [plans, setPlans] = useState({});
  const [error, setError] = useState('');
  const [buildingId, setBuildingId] = useState(lastBuilding);
  const [mode, setMode] = useState('status');
  const [only, setOnly] = useState(null); // the one state the legend is narrowed to
  const [explode, setExplode] = useState(false);
  const [floor, setFloor] = useState(null); // the floor looked at alone, counted from the bottom
  const [spin, setSpin] = useState(true);
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null); // { id, x, y }
  const [master, setMaster] = useState(false);
  const [reading, setReading] = useState(false); // Riley is reading an uploaded floor plan
  const [draft, setDraft] = useState(null); // what was read, shown before it is kept
  const [planError, setPlanError] = useState('');
  const [saving, setSaving] = useState(false);
  const [leasing, setLeasing] = useState(null); // the vacant unit a new lease is being written for
  const [drafted, setDrafted] = useState({}); // leases drafted here and not yet inspected in, by unit: such a unit is still vacant
  const stage = useRef(null);
  const scene = useRef(null);
  const file = useRef(null);
  const here = useRef(true);
  useEffect(() => () => { here.current = false; }, []);

  const load = () => {
    api.get('/leasing/overview?company_id=&building_id=&months=1').then(setD).catch((e) => setError(e.message));
    api.get('/properties/plans').then(setPlans).catch(() => {});
    api.get('/leasing/work-orders?status=active').then((r) => { setMaster(!!r.master); setRepairs(r.work_orders.filter((w) => LIVE.includes(w.status))); }).catch(() => {});
  };
  useEffect(load, []);

  const building = d?.buildings.find((b) => String(b.id) === String(buildingId)) || d?.buildings[0];
  // Bottom floor first, as the tower is built.
  const floors = useMemo(() => {
    if (!building) return [];
    const all = building.floors.flat().map((u) => ({ ...u, floor: floorOf(u) }));
    return [...new Set(all.map((u) => u.floor))].sort((a, b) => level(a) - level(b))
      .map((f) => all.filter((u) => u.floor === f).sort((a, b) => a.unit_no.localeCompare(b.unit_no, undefined, { numeric: true })));
  }, [building]);
  const units = useMemo(() => floors.flat(), [floors]);
  const repairsOf = useMemo(() => {
    const m = new Map();
    for (const w of repairs) m.set(w.unit_id, [...(m.get(w.unit_id) || []), w]);
    return m;
  }, [repairs]);
  const unit = units.find((u) => u.unit_id === selected);
  const rents = units.filter((u) => u.rent > 0).map((u) => u.rent);
  const [low, high] = [Math.min(...rents), Math.max(...rents)];

  // The scene lives as long as the screen does; a building is drawn into it when chosen.
  const has = !!building;
  useEffect(() => {
    if (!has) return undefined;
    const light = document.documentElement.dataset.mode === 'light';
    const s = createBuildingScene(stage.current, {
      light, ink: '#ffffff', tagInk: css('txt'), line: css('p1'),
      onHover: (id, x, y) => setHover(id == null ? null : { id, x, y }),
      onPick: (id) => { setSelected(id); if (id != null) setSpin(false); },
      onTurn: () => setSpin(false),
    });
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, [has]);

  useEffect(() => {
    if (!building) return;
    lastBuilding = String(building.id);
    setSelected(null); setFloor(null); setOnly(null); setLeasing(null);
    if (draft) { // the reading, drawn as it would be kept
      const at = placer(draft);
      scene.current?.setData(draft.floors.map((f) => ({
        label: floorName(f.floor),
        units: f.units.map((no) => ({ id: `plan:${no}`, label: no, ...placed(at, draft.units[no]) })),
        commons: (draft.commons[f.floor] || []).map((c) => ({ kind: c.kind, label: c.label, ...at(c) })),
      })), { W: draft.width / draft.storey, D: draft.depth / draft.storey });
      return;
    }
    const plan = plans[building.id];
    const real = plan && units.length > 0 && units.every((u) => plan.units[u.unit_id]) ? plan : null;
    const place = real && placer(real);
    scene.current?.setData(floors.map((f) => ({
      label: floorName(f[0]?.floor),
      units: f.map((u) => ({ id: u.unit_id, label: u.unit_no, ...(real ? placed(place, real.units[u.unit_id]) : {}) })),
      commons: real ? (real.commons[f[0]?.floor] || real.commons['*'] || []).map((c) => ({ kind: c.kind, label: c.label, ...place(c) })) : [],
    })), real && { W: real.width / real.storey, D: real.depth / real.storey });
  }, [building?.id, floors, plans, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // How each unit is painted: by its state, by its rent, or by how long its lease has left.
  useEffect(() => {
    const c = { chart: css('chart'), warn: css('warn'), bad: css('bad'), ok: css('ok'), mute: css('mute'), p2: css('p2'), p3: css('p3') };
    const paint = new Map();
    if (draft) { // units the building has already, and in blue the ones the plan would add
      const fresh = new Set(draft.add.map((u) => u.unit_no));
      for (const no of Object.keys(draft.units)) paint.set(`plan:${no}`, { color: fresh.has(no) ? c.p3 : c.chart });
      scene.current?.setPaint(paint);
      return;
    }
    for (const u of units) {
      const let_ = !!u.tenant;
      let color = c[STATUS[u.status][1]];
      let dim = !let_;
      if (mode === 'rent' && let_) color = blend(c.p3, c.p2, high > low ? (u.rent - low) / (high - low) : 0.5);
      if (mode === 'ending' && let_) color = u.days_left <= 90 ? blend(c.bad, c.warn, Math.max(0, u.days_left) / 90) : blend(c.warn, c.ok, Math.min(1, (u.days_left - 90) / (FAR - 90)));
      if (only && (only === 'repair' ? !repairsOf.has(u.unit_id) : u.status !== only)) dim = true;
      else if (only) dim = false;
      paint.set(u.unit_id, { color, dim, pulse: mode === 'status' && u.status === 'overdue' && !dim, beacon: repairsOf.has(u.unit_id) });
    }
    scene.current?.setPaint(paint);
  }, [units, mode, only, repairsOf, low, high, draft]);

  useEffect(() => { scene.current?.setView({ explode, floor, selected }); }, [explode, floor, selected, building?.id]);
  useEffect(() => { scene.current?.setSpin(spin); }, [spin, building?.id]);

  if (!d) return <p className="py-10 text-center text-sm text-mute">{error || 'Loading…'}</p>;
  if (!building) return <p className="rounded-2xl border border-stroke p-4 text-sm text-mute">No buildings yet. Add companies, buildings and units under Properties and they appear here.</p>;

  const count = (s) => units.filter((u) => u.status === s).length;
  const withRepairs = units.filter((u) => repairsOf.has(u.unit_id)).length;
  const owed = units.reduce((t, u) => t + (u.owed || 0), 0);
  const rentRoll = units.reduce((t, u) => t + (u.rent || 0), 0);
  const tip = hover && units.find((u) => u.unit_id === hover.id);
  const company = d.filters.buildings.find((b) => b.id === building.id)?.company_id;
  // Riley reads the uploaded drawings on the server, which takes a minute or so: asked after until it is done.
  const read = async (f) => {
    if (!f) return;
    setPlanError(''); setDraft(null); setReading(true); setSpin(false);
    try {
      const form = new FormData();
      form.append('file', f);
      const { id } = await api.upload(`/properties/buildings/${building.id}/plan/read`, form);
      while (here.current) {
        await new Promise((done) => setTimeout(done, 2500));
        const r = await api.get(`/properties/plan-readings/${id}`);
        if (r.status === 'failed') throw new Error(r.error);
        if (r.status === 'done') { setDraft(r.plan); setExplode(false); break; }
      }
    } catch (e) { setPlanError(e.message); } finally { setReading(false); }
  };
  const keep = async () => {
    setSaving(true); setPlanError('');
    try {
      const { floors: shown, unplaced, ...body } = draft;
      await api.put(`/properties/buildings/${building.id}/plan`, body);
      setDraft(null);
      load();
    } catch (e) { setPlanError(e.message); } finally { setSaving(false); }
  };
  const toggle = (on) => `${CHIP} flex items-center gap-1.5 ${on ? 'border-p1/60 bg-p1/20 text-p1' : 'border-stroke bg-surface/80 text-mute hover:text-txt'}`;

  return (
    <div className="relative h-[calc(100dvh-6.5rem)] min-h-[30rem] overflow-hidden rounded-2xl border border-stroke">
      <div ref={stage} className="absolute inset-0" />

      {/* Which building, and how it is doing. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start gap-2">
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2">
          <Select value={building.id} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building" className={SELECT} wrap="min-w-[11rem]"
            options={d.buildings.map((b) => [b.id, b.name])} />
          <div className={`${PANEL} flex gap-4 px-3.5 py-2 text-xs`}>
            <span><span className="block text-mute">Occupancy</span><span className="text-sm font-medium tabular-nums">{pct(building.occupancy)}</span></span>
            <span><span className="block text-mute">Units let</span><span className="text-sm font-medium tabular-nums">{units.filter((u) => u.tenant).length} / {units.length}</span></span>
            <span className="hidden sm:block"><span className="block text-mute">Rent a month</span><span className="text-sm font-medium tabular-nums">{money(Math.round(rentRoll))}</span></span>
            {owed > 0 && <span><span className="block text-mute">Overdue</span><span className="text-sm font-medium tabular-nums text-bad">{money(Math.round(owed))}</span></span>}
          </div>
        </div>
        <div className="pointer-events-auto ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className="flex rounded-full border border-stroke bg-surface/80 p-0.5">
            {MODES.map(([k, l]) => (
              <button key={k} onClick={() => { setMode(k); setOnly(null); }} aria-pressed={mode === k}
                className={`rounded-full px-3 py-1.5 text-xs ${mode === k ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{l}</button>
            ))}
          </span>
          <button onClick={() => setExplode(!explode)} aria-pressed={explode} className={toggle(explode)}><Layers size={14} /> Open up</button>
          <button onClick={() => setSpin(!spin)} aria-pressed={spin} className={toggle(spin)}><RotateCw size={14} /> Turn</button>
          <button onClick={() => { setFloor(null); setSelected(null); scene.current?.reset(); }} className={toggle(false)}><ScanEye size={14} /> Reset</button>
          {master && (
            <>
              <button onClick={() => file.current.click()} disabled={reading || saving} className={`${toggle(false)} disabled:opacity-60`}><Upload size={14} /> Floor plan</button>
              <input ref={file} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={(e) => { read(e.target.files[0]); e.target.value = ''; }} />
            </>
          )}
        </div>
      </div>

      {/* The floors, top first: one tapped is looked at alone. */}
      {floors.length > 1 && !draft && (
        <div className={`${PANEL} absolute left-3 top-1/2 flex max-h-[55%] -translate-y-1/2 flex-col gap-0.5 overflow-y-auto p-1 text-xs`}>
          <button onClick={() => setFloor(null)} aria-pressed={floor == null} className={`rounded-lg px-2.5 py-1.5 text-left ${floor == null ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>All</button>
          {floors.map((f, i) => [f, i]).reverse().map(([f, i]) => (
            <button key={i} onClick={() => { setFloor(floor === i ? null : i); setSpin(false); }} aria-pressed={floor === i}
              className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left ${floor === i ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>
              <span className="max-w-[6rem] truncate">{floorName(f[0]?.floor)}</span>
              <span className="tabular-nums opacity-70">{f.filter((u) => u.tenant).length}/{f.length}</span>
            </button>
          ))}
        </div>
      )}

      {/* What the colours mean. In Status, a row tapped picks those units out. */}
      <div className={`${PANEL} absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] px-3 py-2 text-xs ${unit ? 'max-md:hidden' : ''} ${draft ? 'hidden' : ''}`}>
        {mode === 'status' ? (
          <div className="flex flex-wrap gap-x-1 gap-y-0.5">
            {Object.entries(STATUS).map(([k, [label, tone]]) => (
              <button key={k} onClick={() => setOnly(only === k ? null : k)} aria-pressed={only === k}
                className={`flex items-center gap-1.5 rounded-full px-2 py-1 ${only === k ? 'bg-white/10 text-txt' : 'text-mute hover:text-txt'}`}>
                <span className="size-2.5 rounded-[3px]" style={{ background: `var(--color-${tone})`, opacity: k === 'vacant' || k === 'blocked' ? 0.4 : 1 }} />{label} <span className="tabular-nums">{count(k)}</span>
              </button>
            ))}
            <button onClick={() => setOnly(only === 'repair' ? null : 'repair')} aria-pressed={only === 'repair'}
              className={`flex items-center gap-1.5 rounded-full px-2 py-1 ${only === 'repair' ? 'bg-white/10 text-txt' : 'text-mute hover:text-txt'}`}>
              <span className="size-2.5 rounded-full bg-p3" />Repair open <span className="tabular-nums">{withRepairs}</span>
            </button>
          </div>
        ) : (
          <div className="w-56 max-w-full">
            <div className="h-2 rounded-full" style={{ background: mode === 'rent' ? 'linear-gradient(90deg, var(--color-p3), var(--color-p2))' : 'linear-gradient(90deg, var(--color-bad), var(--color-warn) 25%, var(--color-ok))' }} />
            <div className="mt-1 flex justify-between text-mute">
              {mode === 'rent' ? (rents.length ? <><span>{money(Math.round(low))}</span><span>{money(Math.round(high))} a month</span></> : <span>No unit is let</span>)
                : <><span>Ends now</span><span>3 months</span><span>A year or more</span></>}
            </div>
          </div>
        )}
      </div>

      {tip && (
        <div className="pointer-events-none fixed z-30 -translate-x-1/2 -translate-y-full rounded-xl border border-stroke bg-surface px-3 py-2 text-xs shadow-xl" style={{ left: hover.x, top: hover.y - 14 }}>
          <p className="font-medium">Unit {tip.unit_no}<span className="font-normal text-mute"> · {STATUS[tip.status][0]}</span></p>
          {tip.tenant && <p className="text-mute">{tip.tenant} · {money(Math.round(tip.rent))} a month</p>}
        </div>
      )}

      {/* The unit that was tapped. */}
      {unit && !draft && leasing === unit.unit_id && (
        <div className={`${PANEL} absolute inset-x-3 bottom-3 max-h-[75%] overflow-y-auto p-4 md:inset-x-auto md:bottom-3 md:right-3 md:top-28 md:max-h-none md:w-80`}>
          <QuickLease key={unit.unit_id} unit={unit} where={[floorName(unit.floor), building.name].join(' · ')}
            preset={{ company_id: company, building_id: building.id, unit_id: unit.unit_id }}
            onSaved={(made, inspect) => { if (inspect) return onInspect(made); setDrafted((now) => ({ ...now, [unit.unit_id]: made })); setLeasing(null); }}
            onFull={onNew} onCancel={() => setLeasing(null)} />
        </div>
      )}
      {unit && !draft && leasing !== unit.unit_id && (
        <div className={`${PANEL} absolute inset-x-3 bottom-3 max-h-[60%] overflow-y-auto p-4 text-sm md:inset-x-auto md:bottom-auto md:right-3 md:top-28 md:w-72`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-base font-medium">Unit {unit.unit_no}</p>
              <p className="truncate text-xs text-mute">{[floorName(unit.floor), unit.type].filter(Boolean).join(' · ')}</p>
            </div>
            <button onClick={() => setSelected(null)} aria-label="Close" className="-mr-1.5 -mt-1.5 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-xs">
            <span className="size-2.5 rounded-[3px]" style={{ background: `var(--color-${STATUS[unit.status][1]})` }} />{STATUS[unit.status][0]}
            {unit.status === 'overdue' && <span className="text-bad">· {money(Math.round(unit.owed))} owed, {days(unit.days_overdue)} late</span>}
          </p>
          {unit.tenant ? (
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3"><dt className="text-mute">Tenant</dt><dd className="truncate text-right">{unit.tenant}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-mute">Rent</dt><dd className="tabular-nums">{money(Math.round(unit.rent))} a month</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-mute">Lease ends</dt><dd>{unit.days_left > 0 ? `in ${days(unit.days_left)}` : 'today'} · {unit.renewal}</dd></div>
            </dl>
          ) : (
            <p className="mt-3 text-xs text-mute">{unit.status === 'blocked' ? 'Blocked: it is not being let.' : unit.days_vacant != null ? `Empty for ${days(unit.days_vacant)}.` : 'Never let.'}
              {drafted[unit.unit_id] && <span className="mt-1 block text-txt">Lease {drafted[unit.unit_id].ref} is drafted for {drafted[unit.unit_id].tenant}. It is confirmed after the move-in inspection.</span>}</p>
          )}
          {(repairsOf.get(unit.unit_id) || []).map((w) => (
            <p key={w.id} className="mt-2 flex items-start gap-1.5 rounded-lg bg-p3/10 px-2.5 py-1.5 text-xs">
              <Wrench size={13} className="mt-0.5 shrink-0 text-p3" />
              <span className="min-w-0"><span className="font-medium">{w.ref}</span>{w.priority === 'urgent' && <span className="text-bad"> · Urgent</span>}<span className="block truncate text-mute">{w.category ? `${w.category}: ` : ''}{w.detail}</span></span>
            </p>
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            {unit.booking_id && <button onClick={() => onPay(unit.booking_id)} className={toggle(true)}><Banknote size={14} /> Payments</button>}
            {unit.booking_id && <button onClick={() => onLease(unit.booking_id)} className={toggle(false)}><FileText size={14} /> Lease</button>}
            {unit.status === 'vacant' && (drafted[unit.unit_id]
              ? <button onClick={() => onInspect(drafted[unit.unit_id])} className={toggle(true)}><ClipboardCheck size={14} /> Move-in inspection</button>
              : <button onClick={() => { setLeasing(unit.unit_id); setSpin(false); }} className={toggle(true)}><Plus size={14} /> New lease</button>)}
            <button onClick={() => onWork(unit)} className={toggle(false)}><Wrench size={14} /> Work orders</button>
          </div>
        </div>
      )}

      {(reading || (planError && !draft)) && (
        <div className={`${PANEL} absolute inset-x-3 top-28 mx-auto flex max-w-sm items-start gap-2.5 p-4 text-sm`}>
          {reading ? <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-p1" /> : <X size={16} className="mt-0.5 shrink-0 text-bad" />}
          <p className="min-w-0 flex-1">{reading ? <>Riley is reading the floor plan.<span className="block text-xs text-mute">This takes a minute or two. You can keep looking around.</span></> : planError}</p>
          {!reading && <button onClick={() => setPlanError('')} aria-label="Close" className="-mr-1.5 -mt-1.5 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>}
        </div>
      )}

      {/* What Riley read off the drawings, to be kept or not. Nothing here is typed. */}
      {draft && (
        <div className={`${PANEL} absolute inset-x-3 bottom-3 max-h-[60%] overflow-y-auto p-4 text-sm md:inset-x-auto md:bottom-auto md:right-3 md:top-28 md:w-72`}>
          <p className="text-base font-medium">Floor plan read</p>
          <p className="text-xs text-mute">This is how {building.name} would be drawn. Nothing is saved yet.</p>
          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-mute">Building</dt><dd className="tabular-nums">{draft.width} m × {draft.depth} m</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">Floors</dt><dd className="tabular-nums">{draft.floors.length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">Units on the plan</dt><dd className="tabular-nums">{Object.keys(draft.units).length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="flex items-center gap-1.5 text-mute"><span className="size-2.5 rounded-[3px] bg-chart" />Already in this building</dt><dd className="tabular-nums">{Object.keys(draft.units).length - draft.add.length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="flex items-center gap-1.5 text-mute"><span className="size-2.5 rounded-[3px] bg-p3" />New, to be added</dt><dd className="tabular-nums">{draft.add.length}</dd></div>
          </dl>
          {draft.unplaced.length > 0 && (
            <p className="mt-3 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs">
              {draft.unplaced.length === 1 ? 'Unit' : 'Units'} {draft.unplaced.slice(0, 8).join(', ')}{draft.unplaced.length > 8 ? ` and ${draft.unplaced.length - 8} more` : ''} {draft.unplaced.length === 1 ? 'is' : 'are'} not on this plan. Until every unit is, the building is drawn the plain way.
            </p>
          )}
          {planError && <p className="mt-3 text-xs text-bad">{planError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={keep} disabled={saving} className={`${toggle(true)} disabled:opacity-60`}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Use this plan</button>
            <button onClick={() => { setDraft(null); setPlanError(''); }} disabled={saving} className={toggle(false)}><X size={14} /> Discard</button>
          </div>
        </div>
      )}

      {units.length === 0 && !draft && !reading && <p className="pointer-events-none absolute inset-x-0 bottom-24 px-6 text-center text-sm text-mute">This building has no units yet. {master ? 'Upload its floor plan above, or add them under Properties.' : 'Add them under Properties.'}</p>}
    </div>
  );
}
