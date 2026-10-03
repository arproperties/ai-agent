import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { listBuildings } from './buildings.js';
import { askSaifsys } from './saifsys/client.js';

// Inventory: the things that stay in a place - the AC, the fridge, the furniture, the keys.
//
// A place is a unit of a building or an area of it (lobby, store room, roof). The units
// are saifsys's own, read through its Real Estate module and never typed here; the areas
// are added per building. Each item has a name, how many, what it is counted in, its
// condition, a photo and a note, and every change is written down with who made it.
//
// The master keeps every building's inventory, an administrator their own building's
// (the same rule as server/buildings.js). Nothing here is written to saifsys.

const MAX_NAME = 80;
const MAX_NOTES = 500;
const MAX_QUANTITY = 1_000_000;
const NOW = 'extract(epoch from now())::bigint';
const DIR = `${DATA_DIR}/inventory`;

export const CONDITIONS = ['good', 'damaged', 'missing'];
// What an item is counted in. The value is what is shown next to the quantity.
export const COUNTED_IN = [
  ['Count', [['pcs', 'pieces'], ['set', 'sets'], ['pair', 'pairs'], ['box', 'boxes'], ['pack', 'packs'], ['roll', 'rolls'], ['bottle', 'bottles'], ['can', 'cans']]],
  ['Weight', [['kg', 'kilograms'], ['g', 'grams']]],
  ['Length', [['m', 'metres'], ['cm', 'centimetres']]],
  ['Volume', [['L', 'litres'], ['ml', 'millilitres'], ['gal', 'gallons']]],
].flatMap(([group, list]) => list.map(([value, name]) => ({ value, label: `${value} — ${name}`, group })));
const UNITS_OF_COUNT = new Set(COUNTED_IN.map((c) => c.value));

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const has = (text, part) => String(text).toLowerCase().includes(String(part ?? '').trim().toLowerCase());
const amount = (i) => [i.quantity, i.counted_in].filter((x) => x !== null && x !== '').join(' ');

/** The building, if this person keeps its inventory. */
const building = async (user, id) => (await listBuildings(user)).find((b) => b.id === Number(id)) || null;

// ---------- the units, from saifsys ----------

const UNITS_FOR = 10 * 60_000;
let cached = { at: 0, buildings: null };

/**
 * The unit numbers of a building, as saifsys has them. Where the office's name covers
 * several saifsys buildings the unit carries which one, since two can both have a "101".
 */
export async function unitsOf(b, ask = askSaifsys) {
  if (!b.sites.length) return [];
  // Only the real saifsys is remembered; a stand-in in a test answers every time.
  const keep = ask === askSaifsys;
  let all = keep && Date.now() - cached.at < UNITS_FOR ? cached.buildings : null;
  if (!all) {
    all = (await ask('realestate', 'directory')).buildings || [];
    if (keep) cached = { at: Date.now(), buildings: all };
  }
  const several = b.sites.length > 1;
  const out = [];
  for (const s of b.sites) {
    const found = all.find((x) => String(x.name).trim().toLowerCase() === s.name.trim().toLowerCase());
    for (const u of found?.units || []) out.push(several ? `${s.name} · ${u}` : String(u));
  }
  return out.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
}

// ---------- reading ----------

const ITEM = `SELECT i.id, i.building_id, i.unit, i.area_id, a.name AS area, i.name, i.counted_in, i.quantity, i.condition,
    i.notes, i.photo, i.updated_at, u.name AS updated_by
  FROM inventory_items i LEFT JOIN inventory_areas a ON a.id = i.area_id LEFT JOIN users u ON u.id = i.updated_by`;

const placeOf = (r) => (r.area_id ? { key: `a:${r.area_id}`, label: r.area } : { key: `u:${r.unit}`, label: `Unit ${r.unit}` });
const shape = (r) => ({
  id: r.id, name: r.name, place: placeOf(r), counted_in: r.counted_in, quantity: r.quantity, condition: r.condition,
  notes: r.notes, photo: !!r.photo, updated_at: r.updated_at, updated_by: r.updated_by,
});

const itemsOf = async (buildingId) => (await db.prepare(`${ITEM} WHERE i.building_id = ? ORDER BY lower(i.name), i.id`).all(buildingId));
const areasOf = (buildingId) => db.prepare('SELECT id, name FROM inventory_areas WHERE building_id = ? ORDER BY lower(name)').all(buildingId);

/** The buildings whose inventory this person keeps, with how much is in each. */
export async function overview(user) {
  const mine = await listBuildings(user);
  if (!mine.length) return [];
  const counts = new Map((await db.prepare(`SELECT building_id, count(*)::int AS items,
      count(*) FILTER (WHERE condition = 'damaged')::int AS damaged, count(*) FILTER (WHERE condition = 'missing')::int AS missing
    FROM inventory_items WHERE building_id = ANY(?::int[]) GROUP BY building_id`).all(mine.map((b) => b.id))).map((c) => [c.building_id, c]));
  return mine.map((b) => ({ id: b.id, name: b.name, items: counts.get(b.id)?.items || 0, damaged: counts.get(b.id)?.damaged || 0, missing: counts.get(b.id)?.missing || 0 }));
}

/**
 * One building's inventory: its units and areas, and everything in them. When saifsys
 * does not answer the items are still shown; only the unit list is missing, and why.
 * null: not their building.
 */
export async function getInventory(user, buildingId, ask = askSaifsys) {
  const b = await building(user, buildingId);
  if (!b) return null;
  let units = [];
  let unitsError = null;
  try { units = await unitsOf(b, ask); } catch (e) { unitsError = e.message; }
  return {
    building: { id: b.id, name: b.name },
    units, units_error: unitsError,
    areas: await areasOf(b.id),
    items: (await itemsOf(b.id)).map(shape),
    counted_in: COUNTED_IN,
    conditions: CONDITIONS,
  };
}

// ---------- writing ----------

const log = (buildingId, item, userId, what) => db.prepare(
  'INSERT INTO inventory_log (building_id, item_id, item_name, place, user_id, what) VALUES (?, ?, ?, ?, ?, ?)',
).run(buildingId, item.id, item.name, placeOf(item).label, userId, what);

export async function addArea(user, buildingId, input) {
  const b = await building(user, buildingId);
  if (!b) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the area a name, like Lobby or Store room');
  if (await db.prepare('SELECT 1 FROM inventory_areas WHERE building_id = ? AND lower(name) = lower(?)').get(b.id, name)) {
    throw bad(`${b.name} already has an area called ${name}`);
  }
  const { id } = await db.prepare('INSERT INTO inventory_areas (building_id, name) VALUES (?, ?) RETURNING id').run(b.id, name);
  return { id, name };
}

/** Removes the area and everything listed in it. */
export async function deleteArea(user, buildingId, areaId) {
  const b = await building(user, buildingId);
  const area = b && await db.prepare('SELECT id, name FROM inventory_areas WHERE id = ? AND building_id = ?').get(Number(areaId) || 0, b.id);
  if (!area) return null;
  const inside = await db.prepare(`${ITEM} WHERE i.area_id = ?`).all(area.id);
  for (const i of inside) { await log(b.id, i, user.id, 'Removed'); dropPhoto(i.photo); }
  await db.prepare('DELETE FROM inventory_areas WHERE id = ?').run(area.id);
  return { ok: true, removed: inside.length };
}

/** Where an item is to go: a unit saifsys has for this building, or one of its areas. */
async function readPlace(b, key, ask) {
  const [kind, ...rest] = String(key ?? '').split(':');
  const value = rest.join(':').trim();
  if (kind === 'a') {
    const area = await db.prepare('SELECT id, name FROM inventory_areas WHERE id = ? AND building_id = ?').get(Number(value) || 0, b.id);
    if (!area) throw bad('Pick the area from the list');
    return { unit: null, area_id: area.id };
  }
  if (kind !== 'u' || !value) throw bad('Say where it is: pick a unit or an area');
  if (!b.sites.length) throw bad(`${b.name} has no saifsys building set, so it has no units yet. Add an area instead.`);
  if (!(await unitsOf(b, ask)).includes(value)) throw bad(`${b.name} has no unit ${value} in saifsys.`);
  return { unit: value, area_id: null };
}

/** Add an item (id null) or change one. null: not their building, or no such item. */
export async function saveItem(user, buildingId, id, input, ask = askSaifsys) {
  const b = await building(user, buildingId);
  if (!b) return null;
  const old = id ? await db.prepare(`${ITEM} WHERE i.id = ? AND i.building_id = ?`).get(Number(id) || 0, b.id) : null;
  if (id && !old) return null;

  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Say what it is');
  const countedIn = line(input.counted_in, 10) || null;
  if (countedIn && !UNITS_OF_COUNT.has(countedIn)) throw bad('Pick what it is counted in from the list');
  const quantity = input.quantity === undefined || input.quantity === null || input.quantity === '' ? 1 : Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) throw bad('How many must be a number, 0 or more');
  const condition = input.condition || 'good';
  if (!CONDITIONS.includes(condition)) throw bad('The condition is good, damaged or missing');
  const notes = String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null;
  // A place that has not moved was checked when the item was put there.
  const place = old && input.place === placeOf(old).key ? { unit: old.unit, area_id: old.area_id } : await readPlace(b, input.place, ask);
  const qty = Math.round(quantity * 100) / 100;

  if (!old) {
    const { id: newId } = await db.prepare(`INSERT INTO inventory_items (building_id, unit, area_id, name, counted_in, quantity, condition, notes, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(b.id, place.unit, place.area_id, name, countedIn, qty, condition, notes, user.id, user.id);
    const row = await db.prepare(`${ITEM} WHERE i.id = ?`).get(newId);
    await log(b.id, row, user.id, 'Added');
    return shape(row);
  }

  await db.prepare(`UPDATE inventory_items SET unit = ?, area_id = ?, name = ?, counted_in = ?, quantity = ?, condition = ?, notes = ?,
    updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(place.unit, place.area_id, name, countedIn, qty, condition, notes, user.id, old.id);
  const row = await db.prepare(`${ITEM} WHERE i.id = ?`).get(old.id);
  const said = [
    old.name !== row.name && `Renamed from ${old.name}`,
    placeOf(old).key !== placeOf(row).key && `Moved from ${placeOf(old).label} to ${placeOf(row).label}`,
    amount(old) !== amount(row) && `Quantity ${amount(old)} → ${amount(row)}`,
    old.condition !== row.condition && `Condition ${old.condition} → ${row.condition}`,
    (old.notes || '') !== (row.notes || '') && 'Notes changed',
  ].filter(Boolean);
  if (said.length) await log(b.id, row, user.id, said.join(' · '));
  return shape(row);
}

export async function deleteItem(user, buildingId, id) {
  const b = await building(user, buildingId);
  const row = b && await db.prepare(`${ITEM} WHERE i.id = ? AND i.building_id = ?`).get(Number(id) || 0, b.id);
  if (!row) return null;
  await log(b.id, row, user.id, 'Removed');
  await db.prepare('DELETE FROM inventory_items WHERE id = ?').run(row.id);
  dropPhoto(row.photo);
  return { ok: true };
}

/** Everything that happened to one item, newest first. */
export async function history(user, buildingId, id) {
  const b = await building(user, buildingId);
  if (!b) return null;
  return db.prepare(`SELECT l.what, l.at, u.name AS by FROM inventory_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.building_id = ? AND l.item_id = ? ORDER BY l.id DESC LIMIT 50`).all(b.id, Number(id) || 0);
}

// ---------- the photo ----------

const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const dropPhoto = (path) => { if (path) rmSync(path, { force: true }); };

/** Give an item its photo, or take it away (file null). */
export async function setPhoto(user, buildingId, id, file) {
  const b = await building(user, buildingId);
  const row = b && await db.prepare(`${ITEM} WHERE i.id = ? AND i.building_id = ?`).get(Number(id) || 0, b.id);
  if (!row) return null;
  let path = null;
  if (file) {
    const ext = PHOTO_TYPES[file.mimetype];
    if (!ext || !file.buffer?.length) throw bad('The photo must be a JPG or PNG picture');
    mkdirSync(DIR, { recursive: true });
    path = `${DIR}/${row.id}-${Date.now()}.${ext}`;
    await writeFile(path, file.buffer);
  } else if (!row.photo) return shape(row);
  await db.prepare(`UPDATE inventory_items SET photo = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(path, user.id, row.id);
  dropPhoto(row.photo);
  await log(b.id, row, user.id, path ? (row.photo ? 'Photo changed' : 'Photo added') : 'Photo removed');
  return shape(await db.prepare(`${ITEM} WHERE i.id = ?`).get(row.id));
}

async function photoPath(user, buildingId, id) {
  const b = await building(user, buildingId);
  return (b && (await db.prepare('SELECT photo FROM inventory_items WHERE id = ? AND building_id = ?').get(Number(id) || 0, b.id))?.photo) || null;
}

// ---------- Reem in chat ----------

const DEF = {
  name: 'inventory',
  description: 'The inventory of the buildings this user looks after: the things kept in each unit and area (AC, fridge, furniture, keys...), ' +
    'with how many, the condition (good, damaged or missing), notes, and who last changed it. ' +
    'Use for "what is in unit 204?", "which units have a damaged AC?", "what is missing at Park Place?", "how many fridges do we have?". ' +
    'Every filter is optional; leave them all empty for everything. ' +
    'View only: items are added and changed on the Inventory page, not from chat - say so if asked.',
  input_schema: {
    type: 'object',
    properties: {
      building: { type: 'string', description: 'A building name, or part of it.' },
      place: { type: 'string', description: 'A unit number ("204") or an area name ("lobby").' },
      item: { type: 'string', description: 'Part of an item\'s name, e.g. "AC".' },
      condition: { type: 'string', enum: CONDITIONS },
    },
  },
};
const MAX_LINES = 300;

async function inventoryForChat(user, input) {
  const mine = (await listBuildings(user)).filter((b) => !input.building || has(b.name, input.building));
  if (!mine.length) return input.building ? `No building of yours matches "${input.building}".` : 'This user has no buildings.';
  const out = [];
  let total = 0;
  for (const b of mine) {
    const rows = (await itemsOf(b.id)).filter((r) => (!input.place || has(placeOf(r).label, input.place))
      && (!input.item || has(r.name, input.item)) && (!input.condition || r.condition === input.condition));
    if (!rows.length) continue;
    total += rows.length;
    const places = new Map();
    for (const r of rows) places.set(placeOf(r).label, [...(places.get(placeOf(r).label) || []), r]);
    const text = [...places].sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true })).map(([label, list]) => `  ${label}\n${list.map((r) =>
      `    - ${r.name}: ${amount(r)}, ${r.condition}${r.notes ? ` (${r.notes})` : ''}${r.updated_by ? ` [last changed by ${r.updated_by}]` : ''}`).join('\n')}`).join('\n');
    out.push(`${b.name}\n${text}`);
  }
  if (!out.length) return 'Nothing in the inventory matches that.';
  const lines = out.join('\n\n').split('\n');
  return lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join('\n')}\n(${total} items in all; ask for one building or place to see the rest.)` : lines.join('\n');
}

/** The inventory tool, same shape as buildingKit(). Only for the master and administrators. */
export async function inventoryKit(user) {
  const keeps = (await listBuildings(user)).length > 0;
  return {
    definitions: keeps ? [DEF] : [],
    status: () => 'Looking at the inventory…',
    run: async (block) => {
      try {
        if (!keeps || block.name !== DEF.name) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await inventoryForChat(user, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const inventoryRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

inventoryRoutes.get('/', wrap(async (req, res) => res.json(await overview(req.user))));
inventoryRoutes.get('/:b', wrap(async (req, res) => send(res, await getInventory(req.user, req.params.b))));
inventoryRoutes.post('/:b/areas', wrap(async (req, res) => send(res, await addArea(req.user, req.params.b, req.body))));
inventoryRoutes.delete('/:b/areas/:area', wrap(async (req, res) => send(res, await deleteArea(req.user, req.params.b, req.params.area))));
inventoryRoutes.post('/:b/items', wrap(async (req, res) => send(res, await saveItem(req.user, req.params.b, null, req.body || {}))));
inventoryRoutes.put('/:b/items/:id', wrap(async (req, res) => send(res, await saveItem(req.user, req.params.b, req.params.id, req.body || {}))));
inventoryRoutes.delete('/:b/items/:id', wrap(async (req, res) => send(res, await deleteItem(req.user, req.params.b, req.params.id))));
inventoryRoutes.get('/:b/items/:id/history', wrap(async (req, res) => send(res, await history(req.user, req.params.b, req.params.id))));
inventoryRoutes.post('/:b/items/:id/photo', upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) throw bad('No photo came through');
  send(res, await setPhoto(req.user, req.params.b, req.params.id, req.file));
}));
inventoryRoutes.delete('/:b/items/:id/photo', wrap(async (req, res) => send(res, await setPhoto(req.user, req.params.b, req.params.id, null))));
inventoryRoutes.get('/:b/items/:id/photo', wrap(async (req, res) => {
  const path = await photoPath(req.user, req.params.b, req.params.id);
  if (!path) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').sendFile(path);
}));
