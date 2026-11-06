import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Loader2, RotateCw, ScanEye, X } from 'lucide-react';
import { api } from '../lib/api';
import { createBuildingScene } from '../lib/buildingScene';
import Page from './Page';
import Picker from './Picker';

// 3D Buildings: one saifsys building as a tower that can be turned, pulled apart floor by
// floor and tapped, each unit coloured by how it stands today. Nothing is kept in Reem:
// the floors, units and leases are read live from saifsys each time (server/buildings3d.js).
// The drawing itself is lib/buildingScene.js, the same one the Leasing branch uses.
// saifsys has no floor plans, so units are equal boxes in rows: where a unit is on its
// floor is only its order by number, not where it really stands.

const CHIP = 'rounded-full border px-3 py-1.5 text-xs transition';
const PANEL = 'rounded-2xl border border-stroke bg-surface/85 backdrop-blur';
// What each colour means, and the theme colour it is drawn in.
const STATUS = { occupied: ['Occupied', 'chart'], ending: ['Ending soon', 'warn'], vacant: ['Vacant', 'mute'], reserved: ['Reserved', 'p3'], maintenance: ['Maintenance', 'bad'] };
const MODES = [['status', 'Status'], ['rent', 'Rent'], ['ending', 'Lease end']];
const TYPES = { studio: 'Studio', '1br': '1 bedroom', '2br': '2 bedrooms', '3br': '3 bedrooms', '4br': '4 bedrooms', penthouse: 'Penthouse', commercial: 'Commercial' };
const FAR = 365;
// Let, as saifsys has it: a unit on an active lease, or marked occupied (a camp room often has no lease of its own).
const isLet = (u) => u.state === 'occupied' || u.state === 'ending'; // a lease with this long left, or longer, is as green as it gets

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
const hex = (c) => { const n = parseInt(c.replace('#', '').slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
/** The colour a share of the way from one to another, both #rrggbb. */
const blend = (a, b, t) => { const [x, y] = [hex(a), hex(b)]; return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };
const money = (n) => `AED ${Math.round(n).toLocaleString('en-US')}`;
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const dateText = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** A unit's rent a month: the lease's, or what saifsys asks for it when it is empty. */
const rentOf = (u) => (u.lease ? u.lease.annual_rent : u.annual_rent || 0) / 12;
const daysLeft = (u, today) => (u.lease ? Math.round((Date.parse(u.lease.end_date) - Date.parse(today)) / 86_400_000) : null);
const typeOf = (t) => TYPES[t] || (t ? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

let lastBuilding = ''; // the building last looked at, so opening the screen again returns to it

export default function Buildings3DPage({ onBack }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [buildingId, setBuildingId] = useState(lastBuilding);
  const [d, setD] = useState(null); // the building on screen, as server/buildings3d.js shapes it
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('status');
  const [only, setOnly] = useState(null); // the one state the legend is narrowed to
  const [explode, setExplode] = useState(false);
  const [floor, setFloor] = useState(null); // the floor looked at alone, counted from the bottom
  const [spin, setSpin] = useState(true);
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null); // { id, x, y }
  const stage = useRef(null);
  const scene = useRef(null);

  useEffect(() => {
    api.get('/buildings-3d').then((b) => {
      setList(b);
      setBuildingId((now) => (b.some((x) => String(x.id) === now) ? now : String(b.find((x) => x.units > 0)?.id ?? b[0]?.id ?? '')));
    }).catch((e) => setError(e.message));
  }, []);

  // Each building is read again when chosen, so its colours are today's.
  useEffect(() => {
    if (!buildingId) return undefined;
    let here = true;
    lastBuilding = buildingId;
    setLoading(true); setError('');
    api.get(`/buildings-3d/${buildingId}`)
      .then((b) => { if (here) setD(b); })
      .catch((e) => { if (here) setError(e.message); })
      .finally(() => { if (here) setLoading(false); });
    return () => { here = false; };
  }, [buildingId]);

  const floors = d?.floors || [];
  const units = useMemo(() => floors.flatMap((f) => f.units), [floors]);
  const unit = units.find((u) => u.id === selected);
  const rents = units.filter((u) => u.lease).map(rentOf);
  const [low, high] = [Math.min(...rents), Math.max(...rents)];

  // The scene lives as long as the screen does; a building is drawn into it when it comes.
  useEffect(() => {
    const light = document.documentElement.dataset.mode === 'light';
    const s = createBuildingScene(stage.current, {
      light, ink: '#ffffff', tagInk: css('txt'), line: css('p1'),
      onHover: (id, x, y) => setHover(id == null ? null : { id, x, y }),
      onPick: (id) => { setSelected(id); if (id != null) setSpin(false); },
      onTurn: () => setSpin(false),
    });
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []);

  useEffect(() => {
    if (!d) return;
    setSelected(null); setFloor(null); setOnly(null); setExplode(false);
    scene.current?.setData(floors.map((f) => ({ label: f.label, units: f.units.map((u) => ({ id: u.id, label: u.unit })) })));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  // How each unit is painted: by its state, by its rent, or by how long its lease has left.
  useEffect(() => {
    if (!d) return;
    const c = Object.fromEntries(['chart', 'warn', 'bad', 'ok', 'mute', 'p2', 'p3'].map((k) => [k, css(k)]));
    const paint = new Map();
    for (const u of units) {
      let color = c[STATUS[u.state][1]];
      let dim = u.state === 'vacant';
      const left = daysLeft(u, d.today);
      if (mode === 'rent' && u.lease) color = blend(c.p3, c.p2, high > low ? (rentOf(u) - low) / (high - low) : 0.5);
      if (mode === 'ending' && u.lease) color = left <= 90 ? blend(c.bad, c.warn, Math.max(0, left) / 90) : blend(c.warn, c.ok, Math.min(1, (left - 90) / (FAR - 90)));
      if (mode !== 'status' && !u.lease) dim = true;
      if (only) dim = u.state !== only;
      paint.set(u.id, { color, dim, pulse: mode === 'status' && u.state === 'maintenance' && !dim });
    }
    scene.current?.setPaint(paint);
  }, [d, units, mode, only, low, high]);

  useEffect(() => { scene.current?.setView({ explode, floor, selected }); }, [explode, floor, selected, d]);
  useEffect(() => { scene.current?.setSpin(spin); }, [spin, d]);

  const count = (s) => units.filter((u) => u.state === s).length;
  const let_ = units.filter(isLet).length;
  const rentRoll = units.reduce((t, u) => t + (u.lease ? rentOf(u) : 0), 0);
  const tip = hover && units.find((u) => u.id === hover.id);
  const toggle = (on) => `${CHIP} flex items-center gap-1.5 ${on ? 'border-p1/60 bg-p1/20 text-p1' : 'border-stroke bg-surface/80 text-mute hover:text-txt'}`;
  const options = useMemo(() => (list || []).map((b) => ({ value: String(b.id), label: b.name, hint: `${b.units} unit${b.units === 1 ? '' : 's'}` })), [list]);

  return (
    <Page title="3D Buildings" onBack={onBack}>
      <div className="relative h-[calc(100dvh-6.5rem)] min-h-[30rem] overflow-hidden rounded-2xl border border-stroke">
        <div ref={stage} className="absolute inset-0" />

        {/* Which building, and how it is doing. */}
        <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2">
            {list && <Picker value={buildingId} onChange={(v) => setBuildingId(v)} options={options} placeholder="Building" searchPlaceholder="Find a building" className="min-w-[12rem]" />}
            {d && units.length > 0 && (
              <div className={`${PANEL} flex gap-4 px-3.5 py-2 text-xs`}>
                <span><span className="block text-mute">Occupancy</span><span className="text-sm font-medium tabular-nums">{Math.round((let_ / units.length) * 100)}%</span></span>
                <span><span className="block text-mute">Units let</span><span className="text-sm font-medium tabular-nums">{let_} / {units.length}</span></span>
                <span className="hidden sm:block"><span className="block text-mute">Rent a month</span><span className="text-sm font-medium tabular-nums">{money(rentRoll)}</span></span>
              </div>
            )}
            {loading && <Loader2 size={16} className="animate-spin text-p1" />}
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
          </div>
        </div>

        {/* The floors, top first: one tapped is looked at alone. */}
        {floors.length > 1 && (
          <div className={`${PANEL} absolute left-3 top-1/2 flex max-h-[55%] -translate-y-1/2 flex-col max-md:top-auto max-md:bottom-28 max-md:max-h-[38%] max-md:translate-y-0 gap-0.5 overflow-y-auto p-1 text-xs`}>
            <button onClick={() => setFloor(null)} aria-pressed={floor == null} className={`rounded-lg px-2.5 py-1.5 text-left ${floor == null ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>All</button>
            {floors.map((f, i) => [f, i]).reverse().map(([f, i]) => (
              <button key={i} onClick={() => { setFloor(floor === i ? null : i); setSpin(false); }} aria-pressed={floor === i}
                className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left ${floor === i ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>
                <span className="max-w-[6rem] truncate max-md:max-w-[4.5rem]">{f.label}</span>
                <span className="tabular-nums opacity-70 max-md:hidden">{f.units.filter(isLet).length}/{f.units.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* What the colours mean. In Status, a row tapped picks those units out. */}
        {d && units.length > 0 && (
          <div className={`${PANEL} absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] px-3 py-2 text-xs ${unit ? 'max-md:hidden' : ''}`}>
            {mode === 'status' ? (
              <div className="flex flex-wrap gap-x-1 gap-y-0.5">
                {Object.entries(STATUS).map(([k, [label, tone]]) => (
                  <button key={k} onClick={() => setOnly(only === k ? null : k)} aria-pressed={only === k}
                    className={`flex items-center gap-1.5 rounded-full px-2 py-1 ${only === k ? 'bg-white/10 text-txt' : 'text-mute hover:text-txt'}`}>
                    <span className="size-2.5 rounded-[3px]" style={{ background: `var(--color-${tone})`, opacity: k === 'vacant' ? 0.4 : 1 }} />{label} <span className="tabular-nums">{count(k)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="w-56 max-w-full">
                <div className="h-2 rounded-full" style={{ background: mode === 'rent' ? 'linear-gradient(90deg, var(--color-p3), var(--color-p2))' : 'linear-gradient(90deg, var(--color-bad), var(--color-warn) 25%, var(--color-ok))' }} />
                <div className="mt-1 flex justify-between text-mute">
                  {mode === 'rent' ? (rents.length ? <><span>{money(low)}</span><span>{money(high)} a month</span></> : <span>No unit is let</span>)
                    : <><span>Ends now</span><span>3 months</span><span>A year or more</span></>}
                </div>
              </div>
            )}
          </div>
        )}

        {tip && (
          <div className="pointer-events-none fixed z-30 -translate-x-1/2 -translate-y-full rounded-xl border border-stroke bg-surface px-3 py-2 text-xs shadow-xl" style={{ left: hover.x, top: hover.y - 14 }}>
            <p className="font-medium">Unit {tip.unit}<span className="font-normal text-mute"> · {STATUS[tip.state][0]}</span></p>
            {tip.lease && <p className="text-mute">{tip.lease.tenant} · {money(rentOf(tip))} a month</p>}
          </div>
        )}

        {/* The unit that was tapped. */}
        {unit && (
          <div className={`${PANEL} absolute inset-x-3 bottom-3 max-h-[60%] overflow-y-auto p-4 text-sm md:inset-x-auto md:bottom-auto md:right-3 md:top-28 md:w-72`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-base font-medium">Unit {unit.unit}</p>
                <p className="truncate text-xs text-mute">{[floors.find((f) => f.units.includes(unit))?.label, typeOf(unit.type), unit.area_sqm ? `${unit.area_sqm} m²` : ''].filter(Boolean).join(' · ')}</p>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close" className="-mr-1.5 -mt-1.5 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={16} /></button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-xs">
              <span className="size-2.5 rounded-[3px]" style={{ background: `var(--color-${STATUS[unit.state][1]})` }} />{STATUS[unit.state][0]}
            </p>
            {unit.lease ? (
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-mute">Tenant</dt><dd className="truncate text-right">{unit.lease.tenant}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-mute">Rent</dt><dd className="tabular-nums">{money(rentOf(unit))} a month</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-mute">Lease ends</dt><dd className="text-right">{dateText(unit.lease.end_date)} · {(() => { const n = daysLeft(unit, d.today); return n > 0 ? `in ${days(n)}` : n === 0 ? 'today' : `${days(-n)} ago`; })()}</dd></div>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-mute">
                {unit.state === 'maintenance' ? 'Under maintenance in saifsys.' : unit.state === 'reserved' ? 'Reserved in saifsys, no lease yet.' : unit.state === 'occupied' ? 'Marked occupied in saifsys, but it has no active lease there.' : 'No active lease.'}
                {unit.annual_rent > 0 && <span className="mt-1 block">Asking {money(unit.annual_rent)} a year.</span>}
              </p>
            )}
          </div>
        )}

        {error && <p className={`${PANEL} absolute inset-x-3 top-28 mx-auto max-w-sm p-4 text-sm text-bad`}>{error}</p>}
        {!error && list && list.length === 0 && <p className="pointer-events-none absolute inset-x-0 top-1/2 px-6 text-center text-sm text-mute">saifsys has no active buildings.</p>}
        {!error && d && units.length === 0 && !loading && <p className="pointer-events-none absolute inset-x-0 bottom-24 px-6 text-center text-sm text-mute">This building has no units in saifsys yet.</p>}
        {!list && !error && <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-mute">Loading…</p>}
      </div>
    </Page>
  );
}
