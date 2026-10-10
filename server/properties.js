import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { DATA_DIR } from './config.js';
import { todayHere } from './leasingRegion.js';
import { usPhone, usEin, einProblem, emailProblem, zipProblem } from './usFormat.js';
import { cleanDetails, readDocument } from './documentReader.js';

// Properties: the companies of the group, their buildings, and each building's units.
// Everyone signed in can read them; only the master adds, changes or removes. A company
// with buildings, or a building with units, cannot be removed: empty it first.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// The fields each one keeps, and what kind of value each is. Anything else sent is ignored.
const KINDS = {
  company: { table: 'prop_companies', parent: null, need: 'name',
    fields: { name: 'text', trade_license_no: 'text', trn: 'text', registration_date: 'date', phone: 'text', email: 'text', address: 'text', city: 'text', state: 'text', zip: 'text', notes: 'text' },
    // How a value is kept, and what is wrong with one (in words, or '' when nothing is).
    tidy: { trade_license_no: usEin, state: (v) => v.toUpperCase() },
    checks: { trade_license_no: einProblem, email: emailProblem, zip: zipProblem, state: (v) => (/^[A-Z]{2}$/.test(v) ? '' : 'State is two letters, like TX.') } },
  building: { table: 'prop_buildings', parent: 'company_id', need: 'name',
    fields: { name: 'text', emirate: 'text', city: 'text', zip: 'text', area: 'text', address: 'text', plot_no: 'text', makani_no: 'text', notes: 'text' } },
  unit: { table: 'prop_units', parent: 'building_id', need: 'unit_no',
    fields: { unit_no: 'text', floor: 'text', type: 'text', size_sqft: 'number', furnished: 'bool',
      dewa_no: 'text', blocked: 'bool', notes: 'text' } },
};

function clean(kind, body = {}) {
  const out = {};
  for (const [f, type] of Object.entries(KINDS[kind].fields)) {
    if (!(f in body)) continue;
    const v = body[f];
    if (type === 'bool') out[f] = !!v;
    else if (type === 'number') {
      if (v === '' || v == null) out[f] = null;
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) throw bad(`${f.replace(/_/g, ' ')} must be a number.`);
      else out[f] = Number(v);
    } else if (type === 'date') {
      const d = String(v ?? '').trim();
      if (d && !isDate(d)) throw bad(`${f.replace(/_/g, ' ')} is not a date.`);
      out[f] = d || null;
    } else {
      const s = String(v ?? '').trim().slice(0, 500);
      out[f] = (s && KINDS[kind].tidy?.[f] ? KINDS[kind].tidy[f](s) : s) || null;
    }
  }
  return out;
}

/**
 * Refuse a value that is not what its field holds (an EIN, an email, a ZIP code…). One that
 * is already kept (`was`) is not questioned, so an old row can still be edited around it.
 */
function check(kind, row, was = {}) {
  for (const [f, problem] of Object.entries(KINDS[kind].checks || {})) {
    if (row[f] && row[f] !== was[f] && problem(row[f])) throw bad(problem(row[f]));
  }
}

// Two companies may not share a name, whatever its capitals. `id` is the one being edited.
async function oneName(row, id = 0) {
  if (row.name && await db.prepare('SELECT 1 FROM prop_companies WHERE lower(name) = lower(?) AND id <> ?').get(row.name, Number(id))) {
    throw bad('A company with that name already exists.', 409);
  }
}

const dupe = (e, kind) => {
  if (e.code === '23505') throw bad(kind === 'unit' ? 'That unit number already exists in this building.' : `A ${kind} with that name already exists.`, 409);
  throw e;
};

export async function create(kind, body, parentId, by) {
  const k = KINDS[kind];
  const row = clean(kind, body);
  if (!row[k.need]) throw bad(`${k.need === 'name' ? 'Name' : 'Unit number'} is required.`);
  check(kind, row);
  if (kind === 'company') await oneName(row);
  if (k.parent) {
    const ptable = kind === 'building' ? 'prop_companies' : 'prop_buildings';
    if (!(await db.prepare(`SELECT 1 FROM ${ptable} WHERE id = ?`).get(Number(parentId)))) throw bad('Not found', 404);
    row[k.parent] = Number(parentId);
  }
  if (kind === 'company') row.created_by = by ?? null;
  const cols = Object.keys(row);
  try {
    const { id } = await db.prepare(`INSERT INTO ${k.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
      .run(...cols.map((c) => row[c]));
    return db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(id);
  } catch (e) { return dupe(e, kind); }
}

export async function update(kind, id, body) {
  const k = KINDS[kind];
  const row = clean(kind, body);
  if (k.need in row && !row[k.need]) throw bad(`${k.need === 'name' ? 'Name' : 'Unit number'} is required.`);
  if (k.checks) check(kind, row, (await db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(Number(id))) || {});
  if (kind === 'company') await oneName(row, id);
  const cols = Object.keys(row);
  if (cols.length) {
    try {
      const r = await db.prepare(`UPDATE ${k.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => row[c]), Number(id));
      if (!r.changes) throw bad('Not found', 404);
    } catch (e) { if (e.status) throw e; dupe(e, kind); }
  }
  const out = await db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(Number(id));
  if (!out) throw bad('Not found', 404);
  return out;
}

export async function remove(kind, id) {
  // Its documents go with it: their rows cascade, their files are removed here. So do a
  // unit's photos, and those of its inspections.
  const files = (await db.prepare(`SELECT file_path FROM prop_documents WHERE ${OWNER[kind][0]} = ? AND file_path IS NOT NULL`).all(Number(id))).map((d) => d.file_path);
  if (kind === 'unit') {
    files.push(...(await db.prepare(`SELECT file_path FROM prop_unit_photos WHERE unit_id = ?
      UNION ALL SELECT p.file_path FROM prop_inspection_photos p JOIN prop_inspections i ON i.id = p.inspection_id WHERE i.unit_id = ?`).all(Number(id), Number(id))).map((p) => p.file_path));
  }
  try {
    const r = await db.prepare(`DELETE FROM ${KINDS[kind].table} WHERE id = ?`).run(Number(id));
    if (!r.changes) throw bad('Not found', 404);
  } catch (e) {
    if (e.code === '23503') throw bad({ company: 'Remove its buildings first.', building: 'Remove its units first.', unit: 'This unit has leases. Cancel or delete them first.' }[kind], 409);
    throw e;
  }
  for (const f of files) rmSync(f, { force: true });
  if (PHOTO_KINDS[kind]) await removePhoto(kind, id); // its picture goes with it
  return { ok: true };
}

/** Companies with how many buildings and units each has. */
export const listCompanies = () => db.prepare(`
  SELECT c.*, ${photoAt('company', 'c')}, (SELECT count(*)::int FROM prop_buildings b WHERE b.company_id = c.id) AS buildings,
    (SELECT count(*)::int FROM prop_units u JOIN prop_buildings b ON b.id = u.building_id WHERE b.company_id = c.id) AS units
  FROM prop_companies c ORDER BY c.name`).all();

export const listBuildings = (companyId) => db.prepare(`
  SELECT b.*, ${photoAt('building', 'b')}, (SELECT count(*)::int FROM prop_units u WHERE u.building_id = b.id) AS units
  FROM prop_buildings b WHERE b.company_id = ? ORDER BY b.name`).all(Number(companyId));

// Units in floor then number order, the way they read on a building's board (2, 10, 101…).
// A lease `b` whose tenant was inspected in (or stayed on by renewing) and has not been inspected
// out, nor renewed again: the unit is theirs until the move-out inspection, whatever the end date says.
export const HELD = `(b.renewed_from IS NOT NULL OR EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id AND i.kind = 'move_in' AND i.complete))
  AND NOT EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id AND i.kind = 'move_out' AND i.complete)
  AND NOT EXISTS (SELECT 1 FROM lease_bookings r WHERE r.renewed_from = b.id AND r.status <> 'cancelled')`;

// Each with today's confirmed booking, if any (today where the business is), so the card can say who is in it;
// a lease that has ended still counts until its move-out inspection (move_out_due).
// energy_on_tenant: that tenant has an energy account of their own, so the unit's own number (dewa_no,
// the company's account) is not shown until the unit is vacant or on the company's account again.
// needs_make_ready: its last tenant has moved out, or a make-ready was begun, and nothing has come since (server/inspections.js).
// move_in_due: today's tenant has taken the unit (not by renewing) and their move-in inspection is not done.
export const listUnits = (buildingId, today = todayHere()) => db.prepare(`
  SELECT u.*, cur.tenant AS current_tenant, cur.end_date AS current_until, coalesce(cur.tenant_energy_account, false) AS energy_on_tenant, coalesce(cur.move_in_due, false) AS move_in_due, coalesce(cur.end_date < ?, false) AS move_out_due,
    (SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') FROM prop_unit_photos p WHERE p.unit_id = u.id) AS photos,
    coalesce((SELECT (i.kind = 'move_out' AND i.complete) OR (i.kind = 'make_ready' AND NOT i.complete) FROM prop_inspections i WHERE i.unit_id = u.id ORDER BY i.inspected_on DESC, i.id DESC LIMIT 1), false) AS needs_make_ready
  FROM prop_units u
  LEFT JOIN LATERAL (SELECT t.full_name AS tenant, to_char(b.end_date, 'YYYY-MM-DD') AS end_date, b.tenant_energy_account,
      b.renewed_from IS NULL AND NOT EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id AND i.kind IN ('move_in', 'move_out') AND i.complete) AS move_in_due FROM lease_bookings b
    JOIN lease_tenants t ON t.id = b.tenant_id
    WHERE b.unit_id = u.id AND b.status = 'confirmed' AND (?::date BETWEEN b.start_date AND b.end_date OR (b.end_date < ?::date AND ${HELD}))
    ORDER BY b.start_date DESC LIMIT 1) cur ON true
  WHERE building_id = ?
  ORDER BY NULLIF(regexp_replace(floor, '\\D', '', 'g'), '')::int NULLS FIRST, floor,
    NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(today, today, today, Number(buildingId));

// One company or building, with when its picture last changed (null when it has none).
/** The people who look after a building: its leasing alerts go to them. */
export const buildingStaff = (id) => db.prepare(`SELECT u.id, u.name FROM prop_building_staff s JOIN users u ON u.id = s.user_id
  WHERE s.building_id = ? AND NOT u.disabled ORDER BY u.name`).all(Number(id));

export async function setBuildingStaff(id, userIds) {
  const b = await one('prop_buildings', id);
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(Number.isInteger))];
  await db.prepare('DELETE FROM prop_building_staff WHERE building_id = ?').run(b.id);
  for (const u of ids) await db.prepare('INSERT INTO prop_building_staff (building_id, user_id) SELECT ?, id FROM users WHERE id = ? ON CONFLICT DO NOTHING').run(b.id, u);
  return buildingStaff(b.id);
}

const one = async (table, id) => {
  const kind = table === 'prop_companies' ? 'company' : 'building';
  const r = await db.prepare(`SELECT x.*, ${photoAt(kind, 'x')} FROM ${table} x WHERE x.id = ?`).get(Number(id));
  if (!r) throw bad('Not found', 404);
  return r;
};


// ---------- photos ----------
//
// One picture each: a company's logo, a building's photo. The row can be made without one.

const PHOTO_DIR = `${DATA_DIR}/properties/photos`;
const PHOTO_KINDS = { company: 'prop_companies', building: 'prop_buildings' };
const PICTURE = /^image\/(png|jpe?g|webp|gif)$/;
// When this one's picture last changed, for a query that lists companies (alias c) or buildings (alias b).
const photoAt = (kind, alias) => `(SELECT p.updated_at FROM prop_photos p WHERE p.kind = '${kind}' AND p.owner_id = ${alias}.id) AS photo_at`;

/** Fails unless `file` is a picture that can be shown, and not a huge one. */
function picture(file) {
  if (!file) throw bad('Choose a picture.');
  if (!PICTURE.test(file.mimetype || '')) throw bad('That is not a picture this can show. Use a JPG, PNG or WebP.');
  if (file.buffer.length > 8 * 1024 * 1024) throw bad('That picture is over 8 MB. Use a smaller one.');
}

export async function getPhoto(kind, id) {
  const p = await db.prepare('SELECT file_path, file_mime, updated_at FROM prop_photos WHERE kind = ? AND owner_id = ?').get(kind, Number(id) || 0);
  if (!p) throw bad('Not found', 404);
  return p;
}

/** Put up a company's logo or a building's photo, in place of any it had. */
export async function setPhoto(kind, id, file) {
  await one(PHOTO_KINDS[kind], id);
  picture(file);
  const old = await db.prepare('SELECT file_path FROM prop_photos WHERE kind = ? AND owner_id = ?').get(kind, Number(id));
  const f = saveFile(file, PHOTO_DIR);
  await db.prepare(`INSERT INTO prop_photos (kind, owner_id, file_path, file_mime) VALUES (?, ?, ?, ?)
    ON CONFLICT (kind, owner_id) DO UPDATE SET file_path = EXCLUDED.file_path, file_mime = EXCLUDED.file_mime, updated_at = extract(epoch from now())::bigint`)
    .run(kind, Number(id), f.file_path, f.file_mime);
  if (old) rmSync(old.file_path, { force: true });
  return { photo_at: (await getPhoto(kind, id)).updated_at };
}

/** Take the picture down. Not having one is fine: the end state is the same. */
export async function removePhoto(kind, id) {
  const old = await db.prepare('SELECT file_path FROM prop_photos WHERE kind = ? AND owner_id = ?').get(kind, Number(id) || 0);
  await db.prepare('DELETE FROM prop_photos WHERE kind = ? AND owner_id = ?').run(kind, Number(id) || 0);
  if (old) rmSync(old.file_path, { force: true });
  return { ok: true };
}


// A unit's photos: several, since the unit is what is shown to someone thinking of renting
// it. The first is the one on its card.

const UNIT_PHOTOS = 12;

/** Add one photo to a unit. */
export async function addUnitPhoto(unitId, file) {
  if (!(await db.prepare('SELECT 1 FROM prop_units WHERE id = ?').get(Number(unitId) || 0))) throw bad('Not found', 404);
  picture(file);
  const { n } = await db.prepare('SELECT count(*)::int AS n FROM prop_unit_photos WHERE unit_id = ?').get(Number(unitId));
  if (n >= UNIT_PHOTOS) throw bad(`A unit can have ${UNIT_PHOTOS} photos. Remove one first.`, 409);
  const f = saveFile(file, PHOTO_DIR);
  const { id } = await db.prepare('INSERT INTO prop_unit_photos (unit_id, file_path, file_mime) VALUES (?, ?, ?) RETURNING id').run(Number(unitId), f.file_path, f.file_mime);
  return { id };
}

export async function getUnitPhoto(id) {
  const p = await db.prepare('SELECT id, file_path, file_mime FROM prop_unit_photos WHERE id = ?').get(Number(id) || 0);
  if (!p) throw bad('Not found', 404);
  return p;
}

export async function removeUnitPhoto(id) {
  const p = await getUnitPhoto(id);
  await db.prepare('DELETE FROM prop_unit_photos WHERE id = ?').run(p.id);
  rmSync(p.file_path, { force: true });
  return { ok: true };
}

// ---------- documents ----------
//
// A document belongs to one company, one building or one unit: a licence, an insurance
// policy, a certificate. It is named freely, and the same name again under the same owner
// is its renewal. Each has a renewal window (renew_days before it expires) inside which
// it is due.

const DOC_DIR = `${DATA_DIR}/properties`;
const RENEW = 90; // days before expiry a document is due, unless it says otherwise
const RENEW_BY = ['remind', 'quotes']; // tracked until it is renewed, or shopped around for
const OWNER = { company: ['company_id', 'prop_companies'], building: ['building_id', 'prop_buildings'], unit: ['unit_id', 'prop_units'] };
const DOC_COLS = `id, company_id, building_id, unit_id, title, number, notes, file_name, file_mime, uploaded_by, created_at, renew_days, renew_by, details,
  (file_path IS NOT NULL) AS has_file,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date`;
// Newest first within a name: the one that expires last, then the one added last.
const NEWEST = 'expiry_date DESC NULLS LAST, id DESC';

const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;

/** valid | due (inside its renewal window) | expired | on_file (no expiry) for one document, as of `today` (YYYY-MM-DD). */
export function docStatus(doc, today) {
  if (!doc.expiry_date) return 'on_file';
  const left = day(doc.expiry_date) - day(today);
  return left < 0 ? 'expired' : left <= (doc.renew_days ?? RENEW) ? 'due' : 'valid';
}

const key = (title) => title.trim().toLowerCase();
/** A row as it is sent: without where its file is kept, its details read back from their JSON, and its status as of `today`. */
const view = ({ file_path, ...d }, today = todayHere()) => ({ ...d, details: JSON.parse(d.details || '{}'), status: docStatus(d, today) });

/**
 * Each company with its documents grouped by name ("Trade License" twice is one licence,
 * renewed): the newest of each name decides its status, and the card counts those.
 */
export async function docBoard(today = todayHere()) {
  const companies = await listCompanies();
  const docs = await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id IS NOT NULL ORDER BY lower(title), ${NEWEST}`).all();
  return companies.map((c) => {
    const groups = new Map();
    for (const d of docs) {
      if (d.company_id !== c.id) continue;
      const g = groups.get(key(d.title));
      if (g) g.count += 1;
      else groups.set(key(d.title), { title: d.title, count: 1, doc: view(d, today) });
    }
    const list = [...groups.values()].map((g) => ({ ...g, status: g.doc.status }));
    return { ...c, docs: list, expired: list.filter((g) => g.status === 'expired').length, due: list.filter((g) => g.status === 'due').length };
  });
}

/** Every document of one company, or only those under one name (its renewals). */
export async function companyDocs(companyId, title, today = todayHere()) {
  const rows = title
    ? await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? AND lower(title) = ? ORDER BY ${NEWEST}`).all(Number(companyId), key(title))
    : await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? ORDER BY lower(title), ${NEWEST}`).all(Number(companyId));
  return rows.map((d) => view(d, today));
}

/**
 * The register: every document of every company, building and unit, one row a name an owner
 * (its newest copy; `count` is how many copies that name has), the most pressing first. Each
 * says whose it is (`owner`, and `where` in words) and how long it has (`days_left`).
 * Narrowed to a building, a company's own documents are left out.
 */
export async function register({ company_id, building_id, status } = {}, today = todayHere()) {
  const rows = await db.prepare(`SELECT d.*, u.unit_no, bl.id AS in_building, bl.name AS building, c.id AS in_company, c.name AS company
    FROM (SELECT ${DOC_COLS} FROM prop_documents) d
    LEFT JOIN prop_units u ON u.id = d.unit_id
    LEFT JOIN prop_buildings bl ON bl.id = coalesce(d.building_id, u.building_id)
    JOIN prop_companies c ON c.id = coalesce(d.company_id, bl.company_id)
    ORDER BY lower(d.title), d.expiry_date DESC NULLS LAST, d.id DESC`).all();
  const groups = new Map(); // an owner and a name → its newest copy
  for (const d of rows) {
    const owner = d.unit_id ? 'unit' : d.building_id ? 'building' : 'company';
    const k = `${owner}:${d[OWNER[owner][0]]}:${key(d.title)}`;
    const g = groups.get(k);
    if (g) g.count += 1;
    else {
      groups.set(k, { ...view(d, today), owner, count: 1, days_left: d.expiry_date ? day(d.expiry_date) - day(today) : null,
        where: owner === 'unit' ? `Unit ${d.unit_no}, ${d.building}` : owner === 'building' ? d.building : d.company });
    }
  }
  const rank = { expired: 0, due: 1, valid: 2, on_file: 3 };
  return [...groups.values()]
    .filter((d) => (!Number(company_id) || d.in_company === Number(company_id)) && (!Number(building_id) || d.in_building === Number(building_id)) && (!status || d.status === status))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.days_left - b.days_left || a.title.localeCompare(b.title));
}

/** Every company, building and unit by name: what a document can be filed under. */
export const places = async () => ({
  companies: await db.prepare('SELECT id, name FROM prop_companies ORDER BY name').all(),
  buildings: await db.prepare('SELECT id, name, company_id FROM prop_buildings ORDER BY name').all(),
  units: await db.prepare(`SELECT id, unit_no, building_id FROM prop_units
    ORDER BY NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(),
});

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(day(v));
function docFields(body = {}) {
  const out = {};
  for (const f of ['title', 'number', 'notes']) if (f in body) out[f] = String(body[f] ?? '').trim().slice(0, 300) || null;
  for (const f of ['issue_date', 'expiry_date']) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (v && !isDate(v)) throw bad(`${f === 'issue_date' ? 'Issue' : 'Expiry'} date is not a date.`);
    out[f] = v || null;
  }
  if ('title' in out && !out.title) throw bad('Give the document a name.');
  // A form sends an emptied box as empty text: that is the window left as it was, not no window.
  if ('renew_days' in body && String(body.renew_days ?? '').trim() !== '') {
    const n = Number(body.renew_days);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw bad('The renewal window is a whole number of days from 0 to 365.');
    out.renew_days = n;
  }
  if ('renew_by' in body) {
    if (!RENEW_BY.includes(body.renew_by)) throw bad('A document is renewed by a reminder or by quotes.');
    out.renew_by = body.renew_by;
  }
  if ('details' in body) out.details = JSON.stringify(cleanDetails(body.details));
  return out;
}

/** The one thing a document is filed under, from company_id, building_id or unit_id: exactly one of them. */
async function ownerOf(body = {}) {
  const given = Object.values(OWNER).filter(([col]) => Number(body[col]) > 0);
  if (given.length !== 1) throw bad('A document belongs to one company, one building or one unit.');
  const [[col, table]] = given;
  if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(body[col])))) throw bad('Not found', 404);
  return { [col]: Number(body[col]) };
}

const getDoc = async (id) => {
  const d = await db.prepare(`SELECT ${DOC_COLS}, file_path FROM prop_documents WHERE id = ?`).get(Number(id));
  if (!d) throw bad('Not found', 404);
  return d;
};

/** Every copy under one document's name and owner (the current one and its renewals), newest first. */
export async function docHistory(id, today = todayHere()) {
  const d = await getDoc(id);
  const [col] = Object.values(OWNER).find(([c]) => d[c] != null);
  return (await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE ${col} = ? AND lower(title) = ? ORDER BY ${NEWEST}`).all(d[col], key(d.title))).map((r) => view(r, today));
}

/** Keep an uploaded file on disk; gives the columns to store for it (nothing when no file came). */
export function saveFile(file, dir = DOC_DIR) {
  if (!file) return {};
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${Date.now()}-${randomBytes(6).toString('hex')}`;
  writeFileSync(path, file.buffer);
  return { file_path: path, file_name: file.originalname.slice(0, 200), file_mime: file.mimetype };
}

/** File a document under the company, building or unit named in `body`. */
export async function addDocument(body = {}, file, by) {
  const fields = docFields({ title: '', ...body });
  const row = { ...fields, ...(await ownerOf(body)), ...saveFile(file), uploaded_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO prop_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  return view(await getDoc(id));
}

/** File a document under a company. */
export const addDoc = (companyId, body, file, by) => addDocument({ ...body, company_id: companyId, building_id: null, unit_id: null }, file, by);

/** Change a document's details, and replace its file when a new one is sent. Whose it is stays. */
export async function updateDoc(id, body, file) {
  const old = await getDoc(id);
  const row = { ...docFields(body), ...saveFile(file) };
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE prop_documents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), old.id);
  if (file && old.file_path) rmSync(old.file_path, { force: true });
  return view(await getDoc(id));
}

export async function removeDoc(id) {
  const d = await getDoc(id);
  await db.prepare('DELETE FROM prop_documents WHERE id = ?').run(d.id);
  if (d.file_path) rmSync(d.file_path, { force: true });
  return { ok: true };
}

// ---------- routes ----------

export const propertyRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const INLINE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/; // opened in the browser; anything else downloads

/** Send a stored document's file: shown in the browser when it can be, downloaded otherwise. */
export function sendDoc(req, res, d) {
  if (!d.file_path) throw bad('Not found', 404);
  const inline = INLINE.test(d.file_mime || '') && !req.query.download;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.file_name || 'document')}`);
  res.type(inline ? d.file_mime : 'application/octet-stream').sendFile(d.file_path);
}

propertyRoutes.get('/docs', wrap(async (req, res) => res.json(await docBoard())));
propertyRoutes.get('/companies/:id/docs', wrap(async (req, res) => res.json(await companyDocs(req.params.id, req.query.title))));
propertyRoutes.post('/companies/:id/docs', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await addDoc(req.params.id, req.body, req.file, req.user.id))));
propertyRoutes.put('/docs/:id', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await updateDoc(req.params.id, req.body, req.file))));
propertyRoutes.delete('/docs/:id', requireMaster, wrap(async (req, res) => res.json(await removeDoc(req.params.id))));
propertyRoutes.get('/docs/:id/file', wrap(async (req, res) => sendDoc(req, res, await getDoc(req.params.id))));
// The register: every document, whoever it belongs to. Reading a file only suggests; nothing is kept by it.
propertyRoutes.get('/documents', wrap(async (req, res) => res.json({ documents: await register(req.query), master: req.user.role === 'master' })));
propertyRoutes.get('/documents/:id/history', wrap(async (req, res) => res.json(await docHistory(req.params.id))));
propertyRoutes.post('/documents', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await addDocument(req.body, req.file, req.user.id))));
propertyRoutes.post('/documents/read', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await readDocument(req.file))));
propertyRoutes.get('/places', wrap(async (req, res) => res.json(await places())));

propertyRoutes.get('/companies', wrap(async (req, res) => res.json(await listCompanies())));
propertyRoutes.get('/companies/:id', wrap(async (req, res) => res.json({ ...(await one('prop_companies', req.params.id)), list: await listBuildings(req.params.id) })));
propertyRoutes.get('/buildings/:id', wrap(async (req, res) => {
  const b = await one('prop_buildings', req.params.id);
  res.json({ ...b, company: await one('prop_companies', b.company_id), list: await listUnits(b.id), staff: await buildingStaff(b.id) });
}));
propertyRoutes.put('/buildings/:id/staff', requireMaster, wrap(async (req, res) => res.json(await setBuildingStaff(req.params.id, req.body?.user_ids))));

for (const [kind, path] of [['company', 'companies'], ['building', 'buildings']]) {
  propertyRoutes.get(`/${path}/:id/photo`, wrap(async (req, res) => {
    const p = await getPhoto(kind, req.params.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // the address changes when the picture does
    res.type(p.file_mime).sendFile(p.file_path);
  }));
  propertyRoutes.post(`/${path}/:id/photo`, requireMaster, upload.single('photo'), wrap(async (req, res) => res.json(await setPhoto(kind, req.params.id, req.file))));
  propertyRoutes.delete(`/${path}/:id/photo`, requireMaster, wrap(async (req, res) => res.json(await removePhoto(kind, req.params.id))));
}

propertyRoutes.post('/units/:id/photos', requireMaster, upload.single('photo'), wrap(async (req, res) => res.json(await addUnitPhoto(req.params.id, req.file))));
propertyRoutes.delete('/unit-photos/:id', requireMaster, wrap(async (req, res) => res.json(await removeUnitPhoto(req.params.id))));
propertyRoutes.get('/unit-photos/:id', wrap(async (req, res) => {
  const p = await getUnitPhoto(req.params.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // a photo never changes; a new one has a new address
  res.type(p.file_mime).sendFile(p.file_path);
}));

propertyRoutes.post('/companies', requireMaster, wrap(async (req, res) => res.json(await create('company', req.body, null, req.user.id))));
propertyRoutes.post('/companies/:id/buildings', requireMaster, wrap(async (req, res) => res.json(await create('building', req.body, req.params.id))));
propertyRoutes.post('/buildings/:id/units', requireMaster, wrap(async (req, res) => res.json(await create('unit', req.body, req.params.id))));

for (const [kind, path] of [['company', 'companies'], ['building', 'buildings'], ['unit', 'units']]) {
  propertyRoutes.put(`/${path}/:id`, requireMaster, wrap(async (req, res) => res.json(await update(kind, req.params.id, req.body))));
  propertyRoutes.delete(`/${path}/:id`, requireMaster, wrap(async (req, res) => res.json(await remove(kind, req.params.id))));
}
