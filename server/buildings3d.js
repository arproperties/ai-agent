import { Router } from 'express';
import { needsModule } from './modules.js';
import { askSaifsys, dubaiDate } from './saifsys/client.js';

// 3D Buildings: each saifsys building drawn as a tower of floors and units, coloured by
// how each unit stands today. Nothing is kept in Reem: every look is read live from
// saifsys (realestate buildings_3d / building_3d), so it is always what saifsys says.

const SOON = 90; // a lease ending within this many days is "ending soon"

/** What the unit's colour says: the lease on it first, then what saifsys marks it as. */
export function unitState(unit, today) {
  if (unit.status === 'maintenance') return 'maintenance';
  if (unit.lease) {
    const left = Math.round((Date.parse(unit.lease.end_date) - Date.parse(today)) / 86_400_000);
    if (Number.isFinite(left) && left <= SOON) return 'ending';
    return 'occupied';
  }
  if (unit.status === 'reserved') return 'reserved';
  // Marked occupied in saifsys but no active lease: still shown as taken, as saifsys has it.
  if (unit.status === 'occupied') return 'occupied';
  return 'vacant';
}

/** A floor's name as people say it: Ground, Floor 3, or the name saifsys gives it (Podium). */
const floorLabel = (n, name) => (name && name.trim() ? name.trim() : n === 0 ? 'Ground' : n < 0 ? `Basement ${-n}` : `Floor ${n}`);

// A unit with no floor set takes it from its number: 601 is on floor 6, 1204 on floor 12.
const floorFromNumber = (no) => (/^[1-9]\d{2,3}$/.test(no) ? Number(no.slice(0, -2)) : null);

/** saifsys's answer, shaped as the drawing wants it: bottom floor first, each with its units. */
export function shapeBuilding(body, today = dubaiDate()) {
  const names = new Map(body.floors.map((f) => [f.number, f.name]));
  const byFloor = new Map();
  for (const f of body.floors) byFloor.set(f.number, []);
  for (const u of body.units) {
    const n = u.floor ?? floorFromNumber(u.unit) ?? null;
    const key = n === null ? 'none' : n;
    if (!byFloor.has(key)) byFloor.set(key, []);
    byFloor.get(key).push({ ...u, state: unitState(u, today) });
  }
  const floors = [...byFloor.entries()]
    // Units with no floor at all stand under the lowest one.
    .sort(([a], [b]) => (a === 'none' ? -Infinity : a) - (b === 'none' ? -Infinity : b))
    .map(([n, units]) => ({
      number: n === 'none' ? null : n,
      label: n === 'none' ? 'No floor' : floorLabel(n, names.get(n)),
      units: units.sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true })),
    }))
    // An empty floor between two used ones is kept (the tower would have a gap); empty ones on top are not.
    .filter((f, i, all) => f.units.length || all.slice(i + 1).some((g) => g.units.length));
  return { building: body.building, today, floors };
}

export const buildings3dRoutes = Router();
buildings3dRoutes.use(needsModule('buildings_3d'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

buildings3dRoutes.get('/', wrap(async (_req, res) => {
  const body = await askSaifsys('realestate', 'buildings_3d');
  res.json(body.buildings);
}));

buildings3dRoutes.get('/:id', wrap(async (req, res) => {
  const body = await askSaifsys('realestate', 'building_3d', { id: Number(req.params.id) || 0 });
  res.json(shapeBuilding(body));
}));
