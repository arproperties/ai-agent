import { db, tx } from './db.js';
import { projectRole } from './access.js';
import { bad, line, has, canRecord, canDecide, pickProject, saveCard, stockOf } from './projects.js';

// Areas on a project: the rooms of each floor with the material each needs - the block
// take-off. They make three things possible: material given out can name the room it went
// to ("900 blocks to the pump room"), each room's blockwork can be reported done or at a %,
// and Stock can say how much is still to order and warn before a room runs short.
//
// The JVC basement's quantities come from the take-off on the JVC School site tracker
// (2026-11-02). They are an estimate from the drawings: managers correct them on the screen.

const MAX_NEEDED = 10_000_000;
const MAX_WEEK = 260;
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

// [area, item, unit, needed, weeks]. Item names as the deliveries are asked to name them,
// so a delivery of "Hollow block 200mm" counts against these.
const BASEMENT = [
  ['Generator room', 'Hollow block 200mm', 'pcs', 680, [1, 2]],
  ['Store, left', 'Hollow block 200mm', 'pcs', 1050, [2, 3]],
  ['Pump room', 'Hollow block 200mm', 'pcs', 1070, [1, 2]],
  ['Garbage + recycle room', 'Hollow block 200mm', 'pcs', 1710, [1, 2]],
  ['Store, right', 'Hollow block 200mm', 'pcs', 990, [2, 3]],
  ['Equipment store + lobby', 'Hollow block 200mm', 'pcs', 1780, [2, 3]],
  ['Lift lobbies (3)', 'Hollow block 200mm', 'pcs', 390, [4, 4]],
  ['Changing rooms, outer walls', 'Hollow block 200mm', 'pcs', 1230, [4, 4]],
  ['Changing rooms, WC cubicles', 'Hollow block 100mm', 'pcs', 940, [4, 4]],
  ['2 stores, bottom right', 'Hollow block 200mm', 'pcs', 920, [5, 5]],
  ['Mortar, whole floor', 'Cement OPC', 'bags', 121, [1, 6]],
  ['Mortar, whole floor', 'Washed sand', 'm3', 16.6, [1, 6]],
];
// The words that make a stock name the same material, when it was recorded before areas existed.
const SAME = { 'Hollow block 200mm': ['block', '200'], 'Hollow block 100mm': ['block', '100'], 'Cement OPC': ['cement'], 'Washed sand': ['sand'] };

/**
 * A JVC project's first floor gets the basement take-off, once; a manager edits from there.
 * The quantities are that building's, so any other project starts with no areas.
 */
export async function ensureAreas(projectId) {
  if ((await db.prepare('SELECT areas_seeded FROM projects WHERE id = ?').get(projectId))?.areas_seeded) return;
  await tx(async () => {
    const p = await db.prepare('UPDATE projects SET areas_seeded = true WHERE id = ? AND NOT areas_seeded RETURNING name, floors').get(projectId);
    if (!p?.floors.length || !/jvc/i.test(p.name)) return;
    const names = (await db.prepare('SELECT DISTINCT item FROM project_moves WHERE project_id = ?').all(projectId)).map((r) => r.item);
    for (const [pos, [area, item, unit, needed, weeks]] of BASEMENT.entries()) {
      // A name already used in stock wins, so the two are one material.
      const words = SAME[item];
      const used = names.find((n) => n.toLowerCase() === item.toLowerCase()) || names.find((n) => words.every((w) => n.toLowerCase().includes(w)));
      await db.prepare(`INSERT INTO project_areas (project_id, floor, position, name, item, counted_in, needed, week_from, week_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, p.floors[0], pos, area, used || item, unit, needed, ...weeks);
    }
  });
}

/** Every area with what has gone out to it so far. */
export async function areasOf(projectId) {
  return db.prepare(`SELECT a.id, a.floor, a.name, a.item, a.counted_in, a.needed, a.week_from, a.week_to, a.percent, a.note,
      coalesce((SELECT sum(m.quantity) FROM project_moves m WHERE m.project_id = a.project_id AND m.kind = 'out'
        AND lower(m.area) = lower(a.name) AND lower(m.item) = lower(a.item) AND m.counted_in = a.counted_in
        AND (m.floor IS NULL OR lower(m.floor) = lower(a.floor))), 0) AS given
    FROM project_areas a WHERE a.project_id = ? ORDER BY a.position, a.id`).all(projectId);
}

/** Stock with what the areas need: needed, and still to order (needed - received, never below 0). */
export async function stockWithNeeds(projectId) {
  const stock = await stockOf(projectId);
  const needs = await db.prepare(`SELECT min(item) AS item, counted_in, sum(needed) AS needed FROM project_areas
    WHERE project_id = ? GROUP BY lower(item), counted_in`).all(projectId);
  const key = (r) => `${r.item.toLowerCase()}|${r.counted_in}`;
  const byKey = new Map(needs.map((n) => [key(n), n.needed]));
  const rows = stock.map((s) => ({ ...s, needed: byKey.get(key(s)) ?? null }));
  for (const n of needs) if (!stock.some((s) => key(s) === key(n))) rows.push({ item: n.item, counted_in: n.counted_in, received: 0, given: 0, on_site: 0, needed: n.needed });
  return rows.map((r) => ({ ...r, to_order: r.needed === null ? null : Math.max(0, Math.round((r.needed - r.received) * 1000) / 1000) }))
    .sort((a, b) => a.item.toLowerCase().localeCompare(b.item.toLowerCase()));
}

/**
 * What runs short soon: for each material, what the areas planned up to next week still
 * need (needed less what went out to them, for areas not finished) against what is on site.
 */
export async function shortages(projectId, week) {
  if (!week) return [];
  const soon = (await areasOf(projectId)).filter((a) => a.percent < 100 && a.week_from && a.week_from <= week + 1);
  const stock = await stockOf(projectId);
  const out = new Map();
  for (const a of soon) {
    const k = `${a.item.toLowerCase()}|${a.counted_in}`;
    const o = out.get(k) || { item: a.item, counted_in: a.counted_in, need: 0, areas: [] };
    o.need += Math.max(0, a.needed - a.given);
    o.areas.push(a.name);
    out.set(k, o);
  }
  return [...out.values()].map((o) => {
    const s = stock.find((x) => x.item.toLowerCase() === o.item.toLowerCase() && x.counted_in === o.counted_in);
    const onSite = Math.max(0, s?.on_site || 0);
    return { ...o, on_site: onSite, short: Math.round((o.need - onSite) * 1000) / 1000 };
  }).filter((o) => o.short > 0);
}

export const shortageLines = (list, week) => (list.length
  ? [`Running short (areas planned up to week ${week + 1}, against what is on site):`,
    ...list.map((o) => `  - ${o.item}: about ${num(o.need)} ${o.counted_in} still needed for ${o.areas.join(', ')}; ${num(o.on_site)} on site; order about ${num(o.short)}`)]
  : []);

export const areaLine = (a) => `  - ${a.name}: ${a.percent}% done; ${a.item} ${num(a.given)} of ${num(a.needed)} ${a.counted_in} given out` +
  `${a.week_from ? `; planned wk ${a.week_from}${a.week_to !== a.week_from ? `-${a.week_to}` : ''}` : ''}${a.note ? `; note: ${a.note}` : ''}`;

// ---------- a manager edits the take-off (the screen) ----------

async function managerOf(user, projectId) {
  const role = await projectRole(user, projectId);
  if (!role) return null;
  if (!canDecide(role)) throw bad('Only a manager on this project can change its areas and quantities.', 403);
  return role;
}

const weekNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!(n >= 1 && n <= MAX_WEEK)) throw bad(`A week is a number from 1 to ${MAX_WEEK}.`);
  return n;
};

/** Add an area (areaId null) or change one. Returns the project's areas. */
export async function saveArea(user, projectId, areaId, body = {}) {
  let pid = Number(projectId) || 0;
  let was = null;
  if (areaId) {
    was = await db.prepare('SELECT * FROM project_areas WHERE id = ?').get(Number(areaId) || 0);
    if (!was) return null;
    pid = was.project_id;
  }
  if (!(await managerOf(user, pid))) return null;
  const name = line(body.name, 120);
  const item = line(body.item, 80);
  const floor = line(body.floor, 40) || was?.floor;
  if (!name || !item || !floor) throw bad('Give the area a floor, a name and the material it needs.');
  const needed = Math.round(Number(body.needed) * 1000) / 1000;
  if (!(needed >= 0) || needed > MAX_NEEDED) throw bad('Give how much it needs as a number.');
  const from = weekNum(body.week_from);
  const to = weekNum(body.week_to);
  if (from && to && to < from) throw bad('The last week cannot be before the first.');
  const unit = line(body.counted_in, 20) || 'pcs';
  if (was) {
    await db.prepare(`UPDATE project_areas SET floor = ?, name = ?, item = ?, counted_in = ?, needed = ?, week_from = ?, week_to = ?,
      updated_by = ?, updated_at = extract(epoch from now())::bigint WHERE id = ?`).run(floor, name, item, unit, needed, from, to, user.id, was.id);
  } else {
    const last = await db.prepare('SELECT coalesce(max(position), -1) AS n FROM project_areas WHERE project_id = ?').get(pid);
    await db.prepare(`INSERT INTO project_areas (project_id, floor, position, name, item, counted_in, needed, week_from, week_to, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, extract(epoch from now())::bigint)`).run(pid, floor, last.n + 1, name, item, unit, needed, from, to, user.id);
  }
  return areasOf(pid);
}

export async function deleteArea(user, areaId) {
  const a = await db.prepare('SELECT project_id FROM project_areas WHERE id = ?').get(Number(areaId) || 0);
  if (!a || !(await managerOf(user, a.project_id))) return null;
  await db.prepare('DELETE FROM project_areas WHERE id = ?').run(Number(areaId));
  return areasOf(a.project_id);
}

// ---------- from chat ----------

/** The area a chat means, on a floor if one was said. Unclear is asked about, not guessed. */
export async function findArea(projectId, floorSaid, areaSaid) {
  const want = line(areaSaid, 120);
  if (!want) throw bad('Say which room or area.');
  const floor = line(floorSaid, 40).toLowerCase();
  const all = (await areasOf(projectId)).filter((a) => !floor || a.floor.toLowerCase() === floor);
  if (!all.length) throw bad(floor ? `No areas on ${floorSaid}. A manager adds them on the Projects screen.` : 'This project has no areas yet.');
  const exact = all.filter((a) => a.name.toLowerCase() === want.toLowerCase());
  const hits = exact.length ? exact : all.filter((a) => has(a.name, want));
  // One room can need two materials (mortar: cement and sand): the same room is one answer.
  if (!hits.length || new Set(hits.map((a) => `${a.floor}|${a.name.toLowerCase()}`)).size > 1) {
    throw bad(`${hits.length ? `"${want}" could be more than one area` : `No area called "${want}"`}. ` +
      `Areas: ${[...new Set((hits.length ? hits : all).map((a) => `${a.name} (${a.floor})`))].join('; ')}. Ask which one if it is not clear.`);
  }
  return hits;
}

/** A room's progress ("pump room walls done", "generator room 50%"), ready on a card. */
export async function proposeArea(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await pickProject(user, input.project, agentId);
  if (!canRecord(p.role)) throw bad(`This user is not the store keeper or a manager on ${p.name}, so they cannot record for it.`);
  await ensureAreas(p.id);
  const [a] = await findArea(p.id, input.floor, input.area);
  const pct = input.done ? 100 : Math.round(Number(input.percent));
  if (!(pct >= 0 && pct <= 100)) throw bad('Say how far it is: a % from 0 to 100, or done.');
  return saveCard(user, p, 'area', {
    floor: a.floor, area: a.name, percent: pct, note: line(input.note, 400) || null, was: a.percent,
  }, conversationId);
}

/** The tap on Confirm for an area card: every row of that room (one per material) moves together. */
export async function applyAreaCard(user, card) {
  const d = card.data;
  const { changes } = await db.prepare(`UPDATE project_areas SET percent = ?, note = ?, updated_by = ?, updated_at = extract(epoch from now())::bigint
    WHERE project_id = ? AND lower(floor) = lower(?) AND lower(name) = lower(?)`).run(d.percent, d.note, user.id, card.project_id, d.floor, d.area);
  if (!changes) throw bad('That area was removed from the project.', 409);
}

export const AREA_DEF = {
  name: 'log_area',
  description: 'Get a room\'s (area\'s) progress ready on a card: "pump room walls done", "generator room 50%", "changing room cubicles started, about 20%". ' +
    'The areas and what each needs are listed by project_progress. One room per call. ' +
    'This only shows a card: nothing changes until they tap Confirm. Never say it was recorded.',
  input_schema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Leave out unless the user names a project.' },
      floor: { type: 'string', description: 'The floor, if said.' },
      area: { type: 'string', description: 'The room or area, e.g. "Pump room".' },
      percent: { type: 'integer', description: '0-100.' },
      done: { type: 'boolean', description: 'True when they say it is finished.' },
      note: { type: 'string' },
    },
    required: ['area'],
  },
};
