import { Router } from 'express';
import { db, tx } from './db.js';
import { requireMaster } from './auth.js';
import { bad } from './leasing.js';

// Floor plans: where each unit really is on its floor, read off the building's drawings, so
// the 3D View can draw the building as it is built and not as a row of equal boxes.
//
// Everything is a rectangle in metres from the building's south-west corner: x runs east,
// y runs north, w is its width (east-west) and d its depth (north-south).
//   prop_units.plan: { x, y, w, d }, the unit.
//   prop_buildings.plan: { width, depth, storey, commons }. `storey` is the floor-to-floor
//     height. `commons` is what is on a floor besides the units, by the floor's name as its
//     units have it, with '*' for every floor that has none of its own:
//     { G: [{ kind, label, x, y, w, d }], '*': [...] }.
// A building with no plan, or with a unit the plan leaves out, is drawn the plain way.

const KINDS = ['corridor', 'core', 'lobby', 'service', 'open']; // open: a balcony or terrace, with no walls
const EDGE = 0.01; // a centimetre over the line is the drawing's rounding

function rect(r, plan, what) {
  const out = {};
  for (const f of ['x', 'y', 'w', 'd']) {
    out[f] = Number(r?.[f]);
    if (!Number.isFinite(out[f])) throw bad(`${what}: ${f} is not a number.`);
  }
  if (out.w <= 0 || out.d <= 0) throw bad(`${what} has no size.`);
  if (out.x < -EDGE || out.y < -EDGE || out.x + out.w > plan.width + EDGE || out.y + out.d > plan.depth + EDGE) throw bad(`${what} is outside the building.`);
  return out;
}

/**
 * Keep a building's plan. `units` is each unit's rectangle by its number; a number the
 * building has no unit for is refused, so a plan is never half kept.
 */
export async function savePlan(buildingId, body = {}) {
  const plan = { width: Number(body.width), depth: Number(body.depth), storey: Number(body.storey) || 3 };
  if (!(plan.width > 0) || !(plan.depth > 0)) throw bad('Give the building its width and depth, in metres.');
  plan.commons = {};
  for (const [floor, list] of Object.entries(body.commons || {})) {
    plan.commons[floor] = (Array.isArray(list) ? list : []).map((c) => {
      if (!KINDS.includes(c?.kind)) throw bad(`Unknown kind of common area: ${c?.kind}.`);
      return { kind: c.kind, label: String(c.label ?? '').trim().slice(0, 40), ...rect(c, plan, c.label || c.kind) };
    });
  }
  return tx(async () => {
    const id = Number(buildingId);
    if (!(await db.prepare('SELECT 1 FROM prop_buildings WHERE id = ?').get(id))) throw bad('Not found', 404);
    const units = await db.prepare('SELECT id, unit_no FROM prop_units WHERE building_id = ?').all(id);
    for (const [no, r] of Object.entries(body.units || {})) {
      const u = units.find((x) => x.unit_no === no);
      if (!u) throw bad(`This building has no unit ${no}.`);
      await db.prepare('UPDATE prop_units SET plan = ? WHERE id = ?').run(JSON.stringify(rect(r, plan, `Unit ${no}`)), u.id);
    }
    await db.prepare('UPDATE prop_buildings SET plan = ? WHERE id = ?').run(JSON.stringify(plan), id);
    return (await plans())[id];
  });
}

/** Every building that has a plan: the plan, and each unit's rectangle by the unit's id. */
export async function plans() {
  const out = {};
  for (const b of await db.prepare('SELECT id, plan FROM prop_buildings WHERE plan IS NOT NULL').all()) out[b.id] = { ...JSON.parse(b.plan), units: {} };
  for (const u of await db.prepare('SELECT id, building_id, plan FROM prop_units WHERE plan IS NOT NULL').all()) if (out[u.building_id]) out[u.building_id].units[u.id] = JSON.parse(u.plan);
  return out;
}

export const planRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
planRoutes.get('/plans', wrap(async (req, res) => res.json(await plans())));
planRoutes.put('/buildings/:id/plan', requireMaster, wrap(async (req, res) => res.json(await savePlan(req.params.id, req.body))));
