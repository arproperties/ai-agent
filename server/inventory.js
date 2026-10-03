import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile, copyFile } from 'node:fs/promises';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { listBuildings } from './buildings.js';
import { askSaifsys } from './saifsys/client.js';

// Inventory: the things that stay in a place - the AC, the fridge, the furniture, the keys.
//
// A building here is one real saifsys building, under its own name. The Buildings screen
// lets one entry cover several of them (one administrator, one set of staff); here each
// of those is its own building with its own units, areas and items, and no group name is
// shown. Inventory rows carry site_id, the saifsys building id, so they stay with the
// real building when the grouping on that screen is changed.
//
// A place is a unit of a building or an area of it (lobby, store room, roof). The units
// are saifsys's own, read through its Real Estate module and never typed here; the areas
// are added per building. Each item has a name, how many, what it is counted in, its
// condition, a photo and a note, and every change is written down with who made it.
//
// The master keeps every building's inventory, an administrator that of the saifsys
// buildings ticked on the entries they run (the same rule as server/buildings.js).
// Nothing here is written to saifsys.

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

/**
 * The buildings whose inventory this person keeps: every saifsys building ticked on the
 * entries they run, each once, by name. Shaped like a listBuildings() row with that one
 * site, so unitsOf() gives its units plain ("101", never "Name · 101").
 */
export async function keptBuildings(user) {
  const out = new Map();
  for (const b of await listBuildings(user)) {
    for (const s of b.sites) if (!out.has(s.id)) out.set(s.id, { id: s.id, name: s.name, sites: [s] });
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) || x.id - y.id);
}

/** The building, if this person keeps its inventory. */
const building = async (user, id) => (await keptBuildings(user)).find((b) => b.id === Number(id)) || null;

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

const ITEM = `SELECT i.id, i.site_id, i.unit, i.area_id, a.name AS area, i.name, i.counted_in, i.quantity, i.condition,
    i.notes, i.photo, i.updated_at, u.name AS updated_by
  FROM inventory_items i LEFT JOIN inventory_areas a ON a.id = i.area_id LEFT JOIN users u ON u.id = i.updated_by`;

const placeOf = (r) => (r.area_id ? { key: `a:${r.area_id}`, label: r.area } : { key: `u:${r.unit}`, label: `Unit ${r.unit}` });
const shape = (r) => ({
  id: r.id, name: r.name, place: placeOf(r), counted_in: r.counted_in, quantity: r.quantity, condition: r.condition,
  notes: r.notes, photo: !!r.photo, updated_at: r.updated_at, updated_by: r.updated_by,
});

const itemsOf = async (buildingId) => (await db.prepare(`${ITEM} WHERE i.site_id = ? ORDER BY lower(i.name), i.id`).all(buildingId));
const areasOf = (buildingId) => db.prepare('SELECT id, name FROM inventory_areas WHERE site_id = ? ORDER BY lower(name)').all(buildingId);

/** The buildings whose inventory this person keeps, with how much is in each. */
export async function overview(user) {
  const mine = await keptBuildings(user);
  if (!mine.length) return [];
  const counts = new Map((await db.prepare(`SELECT site_id, count(*)::int AS items,
      count(*) FILTER (WHERE condition = 'damaged')::int AS damaged, count(*) FILTER (WHERE condition = 'missing')::int AS missing
    FROM inventory_items WHERE site_id = ANY(?::int[]) GROUP BY site_id`).all(mine.map((b) => b.id))).map((c) => [c.site_id, c]));
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
  'INSERT INTO inventory_log (site_id, item_id, item_name, place, user_id, what) VALUES (?, ?, ?, ?, ?, ?)',
).run(buildingId, item.id, item.name, placeOf(item).label, userId, what);

export async function addArea(user, buildingId, input) {
  const b = await building(user, buildingId);
  if (!b) return null;
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Give the area a name, like Lobby or Store room');
  if (await db.prepare('SELECT 1 FROM inventory_areas WHERE site_id = ? AND lower(name) = lower(?)').get(b.id, name)) {
    throw bad(`${b.name} already has an area called ${name}`);
  }
  const { id } = await db.prepare('INSERT INTO inventory_areas (site_id, name) VALUES (?, ?) RETURNING id').run(b.id, name);
  return { id, name };
}

/** Removes the area and everything listed in it. */
export async function deleteArea(user, buildingId, areaId) {
  const b = await building(user, buildingId);
  const area = b && await db.prepare('SELECT id, name FROM inventory_areas WHERE id = ? AND site_id = ?').get(Number(areaId) || 0, b.id);
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
    const area = await db.prepare('SELECT id, name FROM inventory_areas WHERE id = ? AND site_id = ?').get(Number(value) || 0, b.id);
    if (!area) throw bad('Pick the area from the list');
    return { unit: null, area_id: area.id };
  }
  if (kind !== 'u' || !value) throw bad('Say where it is: pick a unit or an area');
  if (!b.sites.length) throw bad(`${b.name} has no saifsys building set, so it has no units yet. Add an area instead.`);
  if (!(await unitsOf(b, ask)).includes(value)) throw bad(`${b.name} has no unit ${value} in saifsys.`);
  return { unit: value, area_id: null };
}

/** What was typed or said about one item, checked. */
function readFields(input) {
  const name = line(input?.name, MAX_NAME);
  if (!name) throw bad('Say what it is');
  const countedIn = line(input.counted_in, 10) || null;
  if (countedIn && !UNITS_OF_COUNT.has(countedIn)) throw bad('Pick what it is counted in from the list');
  const quantity = input.quantity === undefined || input.quantity === null || input.quantity === '' ? 1 : Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) throw bad('How many must be a number, 0 or more');
  const condition = input.condition || 'good';
  if (!CONDITIONS.includes(condition)) throw bad('The condition is good, damaged or missing');
  const notes = String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null;
  return { name, counted_in: countedIn, quantity: Math.round(quantity * 100) / 100, condition, notes };
}

/** Put one checked item in one checked place, and write down who did. */
async function insertItem(buildingId, place, f, userId) {
  const { id } = await db.prepare(`INSERT INTO inventory_items (site_id, unit, area_id, name, counted_in, quantity, condition, notes, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(buildingId, place.unit, place.area_id, f.name, f.counted_in, f.quantity, f.condition, f.notes, userId, userId);
  const row = await db.prepare(`${ITEM} WHERE i.id = ?`).get(id);
  await log(buildingId, row, userId, 'Added');
  return row;
}

/** Add an item (id null) or change one. null: not their building, or no such item. */
export async function saveItem(user, buildingId, id, input, ask = askSaifsys) {
  const b = await building(user, buildingId);
  if (!b) return null;
  const old = id ? await db.prepare(`${ITEM} WHERE i.id = ? AND i.site_id = ?`).get(Number(id) || 0, b.id) : null;
  if (id && !old) return null;

  const f = readFields(input);
  // A place that has not moved was checked when the item was put there.
  const place = old && input.place === placeOf(old).key ? { unit: old.unit, area_id: old.area_id } : await readPlace(b, input.place, ask);
  if (!old) return shape(await insertItem(b.id, place, f, user.id));

  await db.prepare(`UPDATE inventory_items SET unit = ?, area_id = ?, name = ?, counted_in = ?, quantity = ?, condition = ?, notes = ?,
    updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(place.unit, place.area_id, f.name, f.counted_in, f.quantity, f.condition, f.notes, user.id, old.id);
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
  const row = b && await db.prepare(`${ITEM} WHERE i.id = ? AND i.site_id = ?`).get(Number(id) || 0, b.id);
  if (!row) return null;
  await log(b.id, row, user.id, 'Removed');
  await db.prepare('DELETE FROM inventory_items WHERE id = ?').run(row.id);
  dropPhoto(row.photo);
  return { ok: true };
}

// ---------- taking out for a job ----------
//
// The office hands a material to a saifsys Operations job: the count of the item goes
// down by that much, and one log line says how much, for which job and who gave it. The
// job page in saifsys lists those lines; the item's own history shows the same ones.

const MAX_NOTE = 200;

/** Take some of an item out for a saifsys job. null: not their building, or no such item. */
export async function takeItem(user, buildingId, id, input) {
  const b = await building(user, buildingId);
  const row = b && await db.prepare(`${ITEM} WHERE i.id = ? AND i.site_id = ?`).get(Number(id) || 0, b.id);
  if (!row) return null;
  const jobId = Number(input?.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) throw bad('Say which job it is for');
  const taken = Math.round(Number(input?.quantity) * 100) / 100;
  if (!Number.isFinite(taken) || taken <= 0 || taken > MAX_QUANTITY) throw bad('Say how much was taken: a number above 0');
  const note = line(input?.note, MAX_NOTE) || null;

  // One statement decides it, so two people taking the last one cannot both get it.
  const done = await db.prepare(`UPDATE inventory_items SET quantity = quantity - ?, updated_by = ?, updated_at = ${NOW}
    WHERE id = ? AND quantity >= ? RETURNING id`).get(taken, user.id, row.id, taken);
  if (!done) throw bad(`Only ${amount(row)} of ${row.name} left in ${placeOf(row).label}`);
  const after = await db.prepare(`${ITEM} WHERE i.id = ?`).get(row.id);
  await db.prepare(`INSERT INTO inventory_log (site_id, item_id, item_name, place, user_id, what, job_id, taken, counted_in, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.id, row.id, row.name, placeOf(row).label, user.id,
    `Taken for job #${jobId}${note ? ` (${note})` : ''} · Quantity ${amount(row)} → ${amount(after)}`, jobId, taken, row.counted_in, note);
  return shape(after);
}

/** What has been taken for one job, oldest first - from the buildings this person keeps. */
export async function takenForJob(user, jobId) {
  const mine = await keptBuildings(user);
  if (!mine.length) return [];
  const names = new Map(mine.map((b) => [b.id, b.name]));
  const rows = await db.prepare(`SELECT l.id, l.site_id, l.item_id, l.item_name, l.place, l.taken, l.counted_in, l.note, l.at, u.name AS by
    FROM inventory_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.job_id = ? AND l.site_id = ANY(?::int[]) ORDER BY l.id`).all(Number(jobId) || 0, mine.map((b) => b.id));
  return rows.map((r) => ({
    id: r.id, building: { id: r.site_id, name: names.get(r.site_id) }, item_id: r.item_id, item: r.item_name, place: r.place,
    quantity: r.taken, counted_in: r.counted_in, note: r.note, at: r.at, by: r.by,
  }));
}

/** Everything that happened to one item, newest first. */
export async function history(user, buildingId, id) {
  const b = await building(user, buildingId);
  if (!b) return null;
  return db.prepare(`SELECT l.what, l.at, u.name AS by FROM inventory_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.site_id = ? AND l.item_id = ? ORDER BY l.id DESC LIMIT 50`).all(b.id, Number(id) || 0);
}

// ---------- the photo ----------

const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const dropPhoto = (path) => { if (path) rmSync(path, { force: true }); };

/** Give an item its photo, or take it away (file null). */
export async function setPhoto(user, buildingId, id, file) {
  const b = await building(user, buildingId);
  const row = b && await db.prepare(`${ITEM} WHERE i.id = ? AND i.site_id = ?`).get(Number(id) || 0, b.id);
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
  return (b && (await db.prepare('SELECT photo FROM inventory_items WHERE id = ? AND site_id = ?').get(Number(id) || 0, b.id))?.photo) || null;
}

// ---------- adding from chat ----------
//
// "Unit 206 has a fridge, 2 ACs and a bed", typed or said, or "add a fridge to units 201
// to 210". Reem never writes it straight in: it gets a card ready that lists every place
// and item as it understood them, and only Add on the card puts them in the inventory -
// a misheard unit is caught on the card, not found in the list a month later.

const MAX_LINES = 600; // one card: 60 units with 10 things each
const tail = (unit) => unit.split(' · ').pop(); // "Townhouse A · 12" → "12"
const numberOf = (unit) => { const m = tail(unit).match(/\d+/); return m ? Number(m[0]) : null; };
const same = (x, y) => String(x).trim().toLowerCase() === String(y).trim().toLowerCase();
const keyOf = (place) => (place.new_area ? `n:${place.new_area.toLowerCase()}` : place.area_id ? `a:${place.area_id}` : `u:${place.unit}`);

/** The places a request names, each checked: units saifsys has, this building's areas, or areas to be made. */
async function findPlaces(b, input, ask) {
  const areas = await areasOf(b.id);
  const named = (Array.isArray(input.places) ? input.places : []).map((x) => line(x, MAX_NAME)).filter(Boolean);
  const range = input.unit_range && input.unit_range.from !== undefined ? input.unit_range : null;
  const units = named.length || range ? await unitsOf(b, ask).catch((e) => { if (areas.length && !range) return []; throw e; }) : [];
  const unit = (u) => ({ unit: u, area_id: null, label: `Unit ${u}` });
  const area = (a) => ({ unit: null, area_id: a.id, label: a.name });
  const out = new Map();
  const put = (place) => out.set(keyOf(place), place);

  for (const raw of named) {
    const want = raw.replace(/^(unit|flat|apt|apartment|room|villa|office|shop)\s*(no\.?|number|#)?\s*/i, '') || raw;
    const exactArea = areas.find((a) => same(a.name, raw) || same(a.name, want));
    if (exactArea) { put(area(exactArea)); continue; }
    const exact = units.filter((u) => same(u, want));
    // "103" is "103 (Staff Accommodation)", and "12" is "Townhouse A · 12" - if only one is.
    const loose = exact.length ? exact : units.filter((u) => same(tail(u), want) || same(tail(u).split(/\s+/)[0], want));
    if (loose.length === 1) { put(unit(loose[0])); continue; }
    if (loose.length > 1) throw bad(`"${raw}" could be ${loose.slice(0, 8).map((u) => `unit ${u}`).join(' or ')} in ${b.name}. Ask which one.`);
    const likeArea = areas.filter((a) => has(a.name, raw));
    if (likeArea.length === 1) { put(area(likeArea[0])); continue; }
    throw bad(`${b.name} has no unit or area called "${raw}".${areas.length ? ` Its areas: ${areas.map((a) => a.name).join(', ')}.` : ''} ` +
      'If the user means a new area, ask them, then pass it in new_areas. If it is a unit, tell them saifsys has no such unit in this building.');
  }
  if (range) {
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw bad('unit_range needs two numbers, from the lower to the higher');
    const inside = units.filter((u) => numberOf(u) !== null && numberOf(u) >= from && numberOf(u) <= to);
    if (!inside.length) throw bad(`${b.name} has no units numbered ${from} to ${to} in saifsys.`);
    inside.forEach((u) => put(unit(u)));
  }
  for (const raw of Array.isArray(input.new_areas) ? input.new_areas : []) {
    const name = line(raw, MAX_NAME);
    if (!name) continue;
    const there = areas.find((a) => same(a.name, name));
    put(there ? area(there) : { unit: null, area_id: null, new_area: name, label: `${name} (new area)` });
  }
  if (!out.size) throw bad('Say where: a unit, several units, or an area.');
  return [...out.values()];
}

/**
 * A picture sent in chat, by the name Reem was shown for it. Chat keeps every attachment
 * as one of the user's documents; the newest of that name wins, this chat's first.
 */
async function chatPhoto(userId, conversationId, name) {
  const want = line(name, 200).toLowerCase();
  const doc = await db.prepare(`SELECT id, name, mime, path FROM documents WHERE user_id = ? AND path IS NOT NULL AND lower(name) = ?
    ORDER BY (conversation_id IS NOT DISTINCT FROM ?) DESC, id DESC LIMIT 1`).get(userId, want, conversationId);
  if (!doc) throw bad(`There is no picture called "${name}" in this chat. Use the name from its <image name="…" /> tag, or leave the photo out.`);
  if (!PHOTO_TYPES[doc.mime]) throw bad(`${doc.name} cannot be an item's photo: it must be a JPG or PNG picture. Leave the photo out and say so.`);
  return doc;
}

const proposalRow = (userId, id) => db.prepare(`SELECT p.*, (SELECT s.name FROM building_sites s WHERE s.site_id = p.site_id LIMIT 1) AS building
  FROM inventory_proposals p WHERE p.id = ? AND p.user_id = ?`).get(Number(id) || 0, userId);

/** The card: places that are getting the same things are said once, together. */
function card(p) {
  const places = new Map();
  for (const l of p.lines) places.set(l.place.label, [...(places.get(l.place.label) || []), l]);
  const groups = new Map();
  for (const [label, list] of places) {
    const items = list.map(({ place, ...item }) => item);
    const sig = JSON.stringify(items);
    groups.set(sig, { places: [...(groups.get(sig)?.places || []), label], items });
  }
  return {
    id: p.id, conversation_id: p.conversation_id, status: p.status, building: p.building || 'A deleted building', building_id: p.site_id,
    groups: [...groups.values()], total: p.lines.filter((l) => !l.exists).length, skipped: p.lines.filter((l) => l.exists).length, added: p.added,
  };
}

export const getProposal = async (user, id) => { const p = await proposalRow(user.id, id); return p ? card(p) : null; };

/** Get a card ready. Nothing is added. */
export async function propose(user, input, { conversationId = null } = {}, ask = askSaifsys) {
  const mine = await keptBuildings(user);
  if (!mine.length) throw bad('This user keeps no building\'s inventory.');
  const hits = input.building ? mine.filter((b) => has(b.name, input.building)) : mine;
  const exact = hits.filter((b) => same(b.name, input.building || ''));
  const b = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (!b) {
    throw bad(hits.length > 1
      ? `Which building? ${input.building ? `"${input.building}" could be` : 'This user has'} ${hits.map((x) => x.name).join(', ')}. Ask which one.`
      : `No building of this user matches "${input.building}". Theirs: ${mine.map((x) => x.name).join(', ')}.`);
  }
  const items = [];
  for (const raw of Array.isArray(input.items) ? input.items : []) {
    const photo = raw?.photo ? await chatPhoto(user.id, conversationId, raw.photo) : null;
    items.push({ ...readFields(raw), ...(photo && { photo_doc: photo.id }) });
  }
  if (!items.length) throw bad('Say what to add.');
  const places = await findPlaces(b, input, ask);
  if (places.length * items.length > MAX_LINES) throw bad(`That is ${places.length * items.length} items in one go; ${MAX_LINES} is the most for one card. Do it in parts.`);

  // What is already listed in a place is not added a second time: saying the same units
  // again, or a range that overlaps the last one, must not double the inventory.
  const have = new Set((await itemsOf(b.id)).map((r) => `${r.area_id ? `a:${r.area_id}` : `u:${r.unit}`}|${r.name.toLowerCase()}`));
  const lines = places.flatMap((place) => items.map((f) => ({ place, ...f, exists: have.has(`${keyOf(place)}|${f.name.toLowerCase()}`) })));
  const { id } = await db.prepare('INSERT INTO inventory_proposals (user_id, conversation_id, site_id, lines) VALUES (?, ?, ?, ?::jsonb) RETURNING id')
    .run(user.id, conversationId, b.id, JSON.stringify(lines));
  return getProposal(user, id);
}

/** Add or Cancel on the card. The status change is the lock, so a double tap adds once. */
export async function decide(user, id, add) {
  const p = await proposalRow(user.id, id);
  if (!p) return null;
  if (p.status !== 'pending') throw bad(`This was already ${p.status}.`, 409);
  const { changes } = await db.prepare(`UPDATE inventory_proposals SET status = ?, decided_at = ${NOW} WHERE id = ? AND status = 'pending'`)
    .run(add ? 'added' : 'cancelled', p.id);
  if (!changes) throw bad('This was already decided.', 409);
  if (add) {
    const copied = [];
    try {
      const b = await building(user, p.site_id);
      if (!b) throw bad('You no longer keep this building\'s inventory.', 403);
      const added = await tx(async () => {
        const areas = await areasOf(b.id);
        const have = new Set((await itemsOf(b.id)).map((r) => `${r.area_id ? `a:${r.area_id}` : `u:${r.unit}`}|${r.name.toLowerCase()}`));
        let n = 0;
        for (const { place, exists, photo_doc: docId, ...f } of p.lines) {
          let at = place;
          if (place.new_area) {
            let a = areas.find((x) => same(x.name, place.new_area));
            if (!a) {
              a = { id: (await db.prepare('INSERT INTO inventory_areas (site_id, name) VALUES (?, ?) RETURNING id').run(b.id, place.new_area)).id, name: place.new_area };
              areas.push(a);
            }
            at = { unit: null, area_id: a.id };
          } else if (place.area_id && !areas.some((x) => x.id === place.area_id)) throw bad(`The area ${place.label} has since been removed.`, 409);
          const key = `${keyOf(at)}|${f.name.toLowerCase()}`;
          if (have.has(key)) continue;
          have.add(key);
          const row = await insertItem(b.id, at, f, user.id);
          n++;
          // The picture sent with it becomes the item's own copy, so clearing the Shelf later does not take it away.
          const doc = docId && await db.prepare('SELECT mime, path FROM documents WHERE id = ? AND user_id = ? AND path IS NOT NULL').get(docId, user.id);
          if (doc && PHOTO_TYPES[doc.mime]) {
            mkdirSync(DIR, { recursive: true });
            const path = `${DIR}/${row.id}-${Date.now()}.${PHOTO_TYPES[doc.mime]}`;
            if (await copyFile(doc.path, path).then(() => true, () => false)) {
              copied.push(path);
              await db.prepare('UPDATE inventory_items SET photo = ? WHERE id = ?').run(path, row.id);
            }
          }
        }
        await db.prepare('UPDATE inventory_proposals SET added = ? WHERE id = ?').run(n, p.id);
        return n;
      });
      p.added = added;
    } catch (e) {
      copied.forEach(dropPhoto);
      await db.prepare(`UPDATE inventory_proposals SET status = 'pending', decided_at = NULL WHERE id = ?`).run(p.id);
      throw e;
    }
  }
  return getProposal(user, id);
}

// ---------- Reem in chat ----------

const DEF = {
  name: 'inventory',
  description: 'The inventory of the buildings this user looks after: the things kept in each unit and area (AC, fridge, furniture, keys...), ' +
    'with how many, the condition (good, damaged or missing), notes, and who last changed it. ' +
    'Use for "what is in unit 204?", "which units have a damaged AC?", "what is missing at Park Place?", "how many fridges do we have?". ' +
    'Every filter is optional; leave them all empty for everything. ' +
    'View only. To add items use add_inventory; changing and removing is done on the Inventory page - say so if asked.',
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
const ADD = {
  name: 'add_inventory',
  description: 'Get new inventory items ready to add to a building this user looks after: things kept in a unit or an area. ' +
    'Use when the user says or types things like "add a fridge to Ayla unit 206", "unit 206 has a fridge, 2 ACs, a bed and a washing machine", ' +
    '"add a fridge and 2 ACs to units 201 to 210 in Ayla", "the lobby has 3 sofas". ' +
    'Every item goes to every place given, so one call covers many items and many units; make separate calls when different places get different things. ' +
    'For "units 201 to 210" use unit_range - it takes only the units that really exist. ' +
    'This only shows a card: nothing is added until the user taps Add on it, so never say it was added. ' +
    'Messages are often spoken, so fix obvious mishearings in item names (e.g. "fride" is a fridge) and use short, plain names in the singular ("Fridge", "Split AC"). ' +
    'When the message comes with a picture of ONE item ("this is the fridge in unit 206"), give that item the picture by its name in photo. ' +
    'When it is a picture of a whole room or several things ("this is unit 206"), look at it and list the fixtures, appliances and furniture you can clearly see, ' +
    'counting each kind; leave out anything you are unsure of, do not set photo, and tell the user the list came from the picture so they should check the card. ' +
    'It cannot change or remove what is already listed - that is done on the Inventory page.',
  input_schema: {
    type: 'object',
    properties: {
      building: { type: 'string', description: 'The building name, or part of it. May be left out when the user has only one building.' },
      places: { type: 'array', items: { type: 'string' }, description: 'Unit numbers ("206") and names of existing areas ("Lobby").' },
      unit_range: {
        type: 'object', description: 'Every existing unit numbered from..to, both included.',
        properties: { from: { type: 'integer' }, to: { type: 'integer' } }, required: ['from', 'to'],
      },
      new_areas: { type: 'array', items: { type: 'string' }, description: 'Areas to create, only when the user asked for a new area or agreed to one.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'number', description: 'How many in each place. 1 when not said.' },
            counted_in: { type: 'string', enum: COUNTED_IN.map((c) => c.value), description: 'Only when the user says a unit of count or measure. Leave out otherwise.' },
            condition: { type: 'string', enum: CONDITIONS, description: 'good unless the user says it is damaged or missing.' },
            notes: { type: 'string', description: 'Brand, serial number, or what is wrong with it, if said or clearly readable in the picture.' },
            photo: { type: 'string', description: 'The name of a picture attached to this message (from its <image name="…" /> tag) that shows this one item. Leave out otherwise.' },
          },
          required: ['name'],
        },
      },
    },
    required: ['items'],
  },
};
const MAX_CHAT_LINES = 300;

async function inventoryForChat(user, input) {
  const mine = (await keptBuildings(user)).filter((b) => !input.building || has(b.name, input.building));
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
  return lines.length > MAX_CHAT_LINES ? `${lines.slice(0, MAX_CHAT_LINES).join('\n')}\n(${total} items in all; ask for one building or place to see the rest.)` : lines.join('\n');
}

/**
 * The inventory tools, same shape as buildingKit(). Only for the master and administrators.
 * ctx: { conversationId, onCard } - onCard puts the Add/Cancel card in front of them.
 */
export async function inventoryKit(user, ctx = {}, ask = askSaifsys) {
  const keeps = (await keptBuildings(user)).length > 0;
  const handlers = keeps ? {
    inventory: (input) => inventoryForChat(user, input),
    add_inventory: async (input) => {
      const p = await propose(user, input, ctx, ask);
      ctx.onCard?.(p);
      const places = p.groups.flatMap((g) => g.places);
      return `Ready as card #${p.id}: ${p.total} ${p.total === 1 ? 'item' : 'items'} for ${p.building} (${places.length > 12 ? `${places.length} places` : places.join(', ')}).` +
        `${p.skipped ? ` ${p.skipped} already listed there and will be skipped.` : ''}` +
        ' NOT added yet - tell the user in one short line to check the card and tap Add. Never say it is added.';
    },
  } : {};
  return {
    definitions: keeps ? [DEF, ADD] : [],
    status: (name) => (name === ADD.name ? 'Getting the inventory items ready…' : 'Looking at the inventory…'),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
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
// Cards from chat. Before the '/:b' routes, so "proposals" is never read as a building.
inventoryRoutes.get('/proposals', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM inventory_proposals WHERE user_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(await Promise.all(rows.map((r) => getProposal(req.user, r.id))));
}));
// The picture on a card, before and after Add: only one that this person's card names.
inventoryRoutes.get('/proposals/:id/photo/:doc', wrap(async (req, res) => {
  const p = await proposalRow(req.user.id, req.params.id);
  const docId = Number(req.params.doc) || 0;
  const doc = p?.lines.some((l) => l.photo_doc === docId)
    && await db.prepare('SELECT mime, path FROM documents WHERE id = ? AND user_id = ? AND path IS NOT NULL').get(docId, req.user.id);
  if (!doc || !PHOTO_TYPES[doc.mime]) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(doc.mime).sendFile(doc.path);
}));
for (const [path, add] of [['add', true], ['cancel', false]]) {
  inventoryRoutes.post(`/proposals/:id/${path}`, wrap(async (req, res) => send(res, await decide(req.user, req.params.id, add))));
}
// Materials given to a saifsys job. Before the '/:b' routes, so "jobs" is never read as a building.
inventoryRoutes.get('/jobs/:job', wrap(async (req, res) => res.json(await takenForJob(req.user, req.params.job))));
inventoryRoutes.get('/:b', wrap(async (req, res) => send(res, await getInventory(req.user, req.params.b))));
inventoryRoutes.post('/:b/areas', wrap(async (req, res) => send(res, await addArea(req.user, req.params.b, req.body))));
inventoryRoutes.delete('/:b/areas/:area', wrap(async (req, res) => send(res, await deleteArea(req.user, req.params.b, req.params.area))));
inventoryRoutes.post('/:b/items', wrap(async (req, res) => send(res, await saveItem(req.user, req.params.b, null, req.body || {}))));
inventoryRoutes.put('/:b/items/:id', wrap(async (req, res) => send(res, await saveItem(req.user, req.params.b, req.params.id, req.body || {}))));
inventoryRoutes.delete('/:b/items/:id', wrap(async (req, res) => send(res, await deleteItem(req.user, req.params.b, req.params.id))));
inventoryRoutes.post('/:b/items/:id/take', wrap(async (req, res) => send(res, await takeItem(req.user, req.params.b, req.params.id, req.body || {}))));
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
