import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ScanEye } from 'lucide-react';
import { createBuildingScene } from '../lib/buildingScene';

// The units of one building as a tower, to pick the unit a notice is about: turned with a
// finger, a floor opened alone from the row above it, a unit tapped and then taken.
// saifsys gives a unit its number and nothing more, so the floor is read from the number.
// The drawing itself is lib/buildingScene.js.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
// 601 is on floor 6, 1001 on floor 10, 304A on floor 3. One that says nothing of its floor goes under them all.
const floorOf = (number) => /^[1-9]\d{2,3}[a-z]?$/i.test(number) ? number.replace(/\D/g, '').slice(0, -2) : null;
const floorName = (f) => (f == null ? 'Other' : `Floor ${f}`);
const CHIP = 'shrink-0 rounded-full border px-3 py-1.5 text-xs';

export default function NoticeTower({ units, onPick }) {
  const [floor, setFloor] = useState(null); // the floor looked at alone, counted from the bottom
  const [selected, setSelected] = useState(null);
  const [broken, setBroken] = useState(false); // a phone that cannot draw it
  const stage = useRef(null);
  const scene = useRef(null);

  // Bottom floor first, as the tower is built.
  const floors = useMemo(() => {
    const all = units.map((u) => ({ ...u, floor: floorOf(u.number) }));
    return [...new Set(all.map((u) => u.floor))].sort((a, b) => (a == null ? -1 : Number(a)) - (b == null ? -1 : Number(b)))
      .map((f) => all.filter((u) => u.floor === f).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })));
  }, [units]);
  const unit = units.find((u) => u.number === selected);

  useEffect(() => {
    let s;
    try {
      s = createBuildingScene(stage.current, {
        light: document.documentElement.dataset.mode === 'light', ink: '#ffffff', tagInk: css('txt'), line: css('p1'),
        onPick: (id) => setSelected(id),
      });
    } catch { setBroken(true); return undefined; }
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []);

  useEffect(() => {
    setSelected(null); setFloor(null);
    scene.current?.setData(floors.map((f) => ({ label: floorName(f[0].floor), units: f.map((u) => ({ id: u.number, label: u.number })) })));
    // A unit with no tenant email is there but faint, as its dashed edge is in the list.
    scene.current?.setPaint(new Map(units.map((u) => [u.number, u.tenant ? { color: css('p1') } : { color: css('mute'), dim: true }])));
  }, [floors, units]);

  useEffect(() => { scene.current?.setView({ floor, selected }); }, [floor, selected, floors]);

  if (broken) return <p className="text-sm text-mute">This device cannot draw the building. Pick the unit from the list.</p>;

  return (
    <div className="space-y-2">
      {/* The floors, top first: one tapped is looked at alone, its units big enough for a thumb. */}
      {floors.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          <button type="button" onClick={() => { setFloor(null); setSelected(null); }} aria-pressed={floor == null}
            className={`${CHIP} ${floor == null ? 'border-p1/50 bg-p1/15 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>All</button>
          {floors.map((f, i) => [f, i]).reverse().map(([f, i]) => (
            <button type="button" key={i} onClick={() => { setFloor(floor === i ? null : i); setSelected(null); }} aria-pressed={floor === i}
              className={`${CHIP} ${floor === i ? 'border-p1/50 bg-p1/15 text-txt' : 'border-stroke text-mute hover:text-txt'}`}>{floorName(f[0].floor)}</button>
          ))}
        </div>
      )}
      <div className="relative h-[60svh] max-h-[34rem] min-h-72 overflow-hidden rounded-2xl border border-stroke bg-black/20">
        <div ref={stage} className="absolute inset-0" />
        <button type="button" onClick={() => { setFloor(null); setSelected(null); scene.current?.reset(); }}
          className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-stroke bg-surface/80 px-3 py-1.5 text-xs text-mute backdrop-blur hover:text-txt">
          <ScanEye size={14} /> Reset
        </button>
        {unit ? (
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-2xl border border-stroke bg-surface/90 p-2 pl-3 backdrop-blur">
            <p className="min-w-0 flex-1 text-sm">
              <span className="block truncate font-medium">Unit {unit.number}</span>
              <span className="block truncate text-xs text-mute">{unit.tenant ? floorName(floorOf(unit.number)) : 'No tenant email in saifsys'}</span>
            </p>
            <button type="button" onClick={() => onPick(unit.number)}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2.5 text-sm font-medium text-white">
              <Check size={15} /> Use this unit
            </button>
          </div>
        ) : (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 px-4 text-center text-xs text-mute">Drag to turn, pinch to zoom, tap a unit.</p>
        )}
      </div>
      <p className="text-xs text-mute">A faint unit has no tenant email in saifsys.</p>
    </div>
  );
}
