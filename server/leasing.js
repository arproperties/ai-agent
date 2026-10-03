import { Router } from 'express';
import { rmSync } from 'node:fs';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile, sendDoc, upload } from './properties.js';

// Leasing: tenants and their bookings of units (the properties are in properties.js).
// Anyone signed in can add tenants and make bookings; the price is set per booking.
//
// The one hard rule: a unit is never booked twice for the same day. Confirming checks
// the unit's other confirmed bookings while holding a lock on the unit's row, so two people
// confirming at the same moment cannot both win.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const todayUae = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

const PERIODS = new Set(['month', 'year']);
const FREQUENCIES = new Set(['monthly', 'quarterly', 'every_6_months', 'yearly', 'upfront']);
const TYPES = new Set(['short_term', 'lease']);

// ---------- tenants ----------

const TENANT_COLS = `id, kind, full_name, nationality, emirates_id_no, passport_no, phone, email, notes, created_at,
  to_char(emirates_id_expiry, 'YYYY-MM-DD') AS emirates_id_expiry`;

function tenantFields(body = {}, { partial = false } = {}) {
  const out = {};
  for (const f of ['full_name', 'nationality', 'emirates_id_no', 'passport_no', 'phone', 'email', 'notes']) if (f in body) out[f] = text(body[f]);
  if ('kind' in body) out.kind = body.kind === 'company' ? 'company' : 'person';
  if ('emirates_id_expiry' in body) {
    const v = String(body.emirates_id_expiry ?? '').trim();
    if (v && !isDate(v)) throw bad('Emirates ID expiry is not a date.');
    out.emirates_id_expiry = v || null;
  }
  if ((!partial || 'full_name' in out) && !out.full_name) throw bad("Give the tenant's name.");
  return out;
}

/** Tenants, newest first, with how many bookings each has; `q` matches name, phone, email, ID or passport. */
export function listTenants(q = '') {
  const like = `%${String(q).trim().toLowerCase()}%`;
  return db.prepare(`SELECT ${TENANT_COLS}, (SELECT count(*)::int FROM lease_bookings b WHERE b.tenant_id = t.id AND b.status <> 'cancelled') AS bookings
    FROM lease_tenants t
    WHERE lower(concat_ws(' ', full_name, phone, email, emirates_id_no, passport_no)) LIKE ?
    ORDER BY id DESC LIMIT 200`).all(like);
}

const getTenant = async (id) => {
  const t = await db.prepare(`SELECT ${TENANT_COLS} FROM lease_tenants WHERE id = ?`).get(Number(id));
  if (!t) throw bad('Tenant not found', 404);
  return t;
};

export async function addTenant(body, by) {
  const row = { ...tenantFields(body), created_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_tenants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  return getTenant(id);
}

export async function updateTenant(id, body) {
  const row = tenantFields(body, { partial: true });
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE lease_tenants SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), Number(id));
  return getTenant(id);
}

export async function removeTenant(id) {
  try {
    const r = await db.prepare('DELETE FROM lease_tenants WHERE id = ?').run(Number(id));
    if (!r.changes) throw bad('Tenant not found', 404);
  } catch (e) {
    if (e.code === '23503') throw bad('This tenant has bookings. Cancel or delete those first.', 409);
    throw e;
  }
  return { ok: true };
}

// ---------- bookings ----------

const BOOKING_SELECT = `SELECT b.id, b.unit_id, b.tenant_id, b.type, b.rent_amount, b.rent_period, b.payment_frequency,
    b.security_deposit, b.status, b.contract_no, b.cancel_reason, b.notes, b.created_at,
    (SELECT count(*)::int FROM lease_documents d WHERE d.booking_id = b.id) AS docs,
    to_char(b.start_date, 'YYYY-MM-DD') AS start_date, to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
    u.unit_no, u.floor, u.type AS unit_type, bl.id AS building_id, bl.name AS building, c.id AS company_id, c.name AS company,
    t.full_name AS tenant, t.phone AS tenant_phone, t.email AS tenant_email
  FROM lease_bookings b
  JOIN prop_units u ON u.id = b.unit_id
  JOIN prop_buildings bl ON bl.id = u.building_id
  JOIN prop_companies c ON c.id = bl.company_id
  JOIN lease_tenants t ON t.id = b.tenant_id`;

export const bookingRef = (b) => `BK-${b.start_date.slice(0, 4)}-${String(b.id).padStart(4, '0')}`;

/** Where a booking stands today: draft, cancelled, upcoming, active or ended. */
export function bookingStage(b, today = todayUae()) {
  if (b.status !== 'confirmed') return b.status;
  return today < b.start_date ? 'upcoming' : today > b.end_date ? 'ended' : 'active';
}

const shape = (b, today) => b && { ...b, ref: bookingRef(b), stage: bookingStage(b, today) };

/** A lease is a year or more (end on or after the day before the same date next year). */
export function suggestType(start, end) {
  const s = new Date(`${start}T00:00:00Z`);
  const yearOn = new Date(Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate() - 1)).toISOString().slice(0, 10);
  return end >= yearOn ? 'lease' : 'short_term';
}

export async function getBooking(id) {
  const b = await db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(Number(id));
  if (!b) throw bad('Booking not found', 404);
  return shape(b);
}

/** Bookings, newest start first. Filters: stage, company_id, building_id, unit_id, tenant_id, q. */
export async function listBookings({ stage, company_id, building_id, unit_id, tenant_id, q } = {}, today = todayUae()) {
  const where = [];
  const args = [];
  for (const [col, v] of [['c.id', company_id], ['bl.id', building_id], ['u.id', unit_id], ['t.id', tenant_id]]) {
    if (v) { where.push(`${col} = ?`); args.push(Number(v)); }
  }
  if (q && String(q).trim()) {
    where.push(`lower(concat_ws(' ', t.full_name, t.phone, t.email, u.unit_no, bl.name, c.name, b.contract_no)) LIKE ?`);
    args.push(`%${String(q).trim().toLowerCase()}%`);
  }
  const rows = await db.prepare(`${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY b.start_date DESC, b.id DESC LIMIT 500`).all(...args);
  const out = rows.map((b) => shape(b, today));
  return stage ? out.filter((b) => b.stage === stage) : out;
}

function bookingFields(body = {}, { partial = false } = {}) {
  const out = {};
  for (const f of ['start_date', 'end_date']) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (!isDate(v)) throw bad(`${f === 'start_date' ? 'Start' : 'End'} date is missing or not a date.`);
    out[f] = v;
  }
  if (!partial && (!out.start_date || !out.end_date)) throw bad('Choose the start and end dates.');
  if (out.start_date && out.end_date && out.end_date < out.start_date) throw bad('The end date is before the start date.');
  for (const f of ['rent_amount', 'security_deposit']) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === '' || v == null) { out[f] = null; continue; }
    if (!Number.isFinite(Number(v)) || Number(v) < 0) throw bad(`${f === 'rent_amount' ? 'Rent' : 'Deposit'} must be a number.`);
    out[f] = Number(v);
  }
  if ((!partial || 'rent_amount' in out) && !(out.rent_amount > 0)) throw bad('Enter the rent.');
  if ('rent_period' in body) { if (!PERIODS.has(body.rent_period)) throw bad('Rent is per month or per year.'); out.rent_period = body.rent_period; }
  if ('payment_frequency' in body) { if (!FREQUENCIES.has(body.payment_frequency)) throw bad('Unknown payment frequency.'); out.payment_frequency = body.payment_frequency; }
  if ('type' in body && body.type) { if (!TYPES.has(body.type)) throw bad('Unknown booking type.'); out.type = body.type; }
  for (const f of ['contract_no', 'notes']) if (f in body) out[f] = text(body[f], 2000);
  return out;
}

/** The confirmed booking of this unit that shares a day with these dates, if any. */
const clash = (unitId, start, end, exceptId = 0) => db.prepare(`${BOOKING_SELECT}
  WHERE b.unit_id = ? AND b.status = 'confirmed' AND b.id <> ? AND b.start_date <= ? AND b.end_date >= ?
  ORDER BY b.start_date LIMIT 1`).get(Number(unitId), Number(exceptId), end, start);

/** Fails unless the unit can be confirmed for these dates. Call inside tx(): it locks the unit. */
async function mustBeFree(unitId, start, end, exceptId) {
  const unit = await db.prepare('SELECT id, blocked FROM prop_units WHERE id = ? FOR UPDATE').get(Number(unitId));
  if (!unit) throw bad('Unit not found', 404);
  if (unit.blocked) throw bad('This unit is blocked (not for rent). Unblock it on the building page first.', 409);
  const other = await clash(unitId, start, end, exceptId);
  if (other) throw bad(`Unit ${other.unit_no} is already booked by ${other.tenant} from ${other.start_date} to ${other.end_date} (${bookingRef(other)}).`, 409);
}

/** A new booking, as a draft or straight to confirmed. A new tenant can come with it. */
export async function createBooking(body = {}, by) {
  const row = bookingFields(body);
  if (!body.unit_id) throw bad('Choose a unit.');
  const confirm = body.status === 'confirmed';
  return tx(async () => {
    const tenantId = body.tenant_id ? (await getTenant(body.tenant_id)).id : (await addTenant(body.tenant || {}, by)).id;
    if (confirm) await mustBeFree(body.unit_id, row.start_date, row.end_date, 0);
    else if (!(await db.prepare('SELECT 1 FROM prop_units WHERE id = ?').get(Number(body.unit_id)))) throw bad('Unit not found', 404);
    const full = { type: suggestType(row.start_date, row.end_date), ...row, unit_id: Number(body.unit_id), tenant_id: tenantId,
      status: confirm ? 'confirmed' : 'draft', created_by: by ?? null };
    const cols = Object.keys(full);
    const { id } = await db.prepare(`INSERT INTO lease_bookings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
      .run(...cols.map((c) => full[c]));
    return getBooking(id);
  });
}

/** Change a booking's details. A confirmed one is re-checked against the unit's other bookings. */
export async function updateBooking(id, body = {}) {
  return tx(async () => {
    const old = await getBooking(id);
    if (old.status === 'cancelled') throw bad('A cancelled booking cannot be changed.', 409);
    const row = bookingFields(body, { partial: true });
    if (body.unit_id) row.unit_id = Number(body.unit_id);
    if (body.tenant_id) row.tenant_id = (await getTenant(body.tenant_id)).id;
    const start = row.start_date || old.start_date;
    const end = row.end_date || old.end_date;
    if (end < start) throw bad('The end date is before the start date.');
    if (old.status === 'confirmed') await mustBeFree(row.unit_id || old.unit_id, start, end, old.id);
    const cols = Object.keys(row);
    if (cols.length) await db.prepare(`UPDATE lease_bookings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), old.id);
    return getBooking(id);
  });
}

export async function confirmBooking(id) {
  return tx(async () => {
    const b = await getBooking(id);
    if (b.status !== 'draft') throw bad(`Only a draft can be confirmed (this one is ${b.status}).`, 409);
    await mustBeFree(b.unit_id, b.start_date, b.end_date, b.id);
    await db.prepare("UPDATE lease_bookings SET status = 'confirmed' WHERE id = ?").run(b.id);
    return getBooking(id);
  });
}

export async function cancelBooking(id, reason) {
  const b = await getBooking(id);
  if (b.status === 'cancelled') throw bad('Already cancelled.', 409);
  const why = text(reason, 500);
  if (!why) throw bad('Say why it is cancelled.');
  await db.prepare("UPDATE lease_bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(why, b.id);
  return getBooking(id);
}

/** A draft can be deleted outright; anything confirmed is cancelled instead, so its history stays. */
export async function removeBooking(id) {
  const b = await getBooking(id);
  if (b.status !== 'draft') throw bad('Only a draft can be deleted. Cancel a confirmed booking instead.', 409);
  // Its documents go with it; their rows cascade, their files are removed here.
  const files = await db.prepare('SELECT file_path FROM lease_documents WHERE booking_id = ? AND file_path IS NOT NULL').all(b.id);
  await db.prepare('DELETE FROM lease_bookings WHERE id = ?').run(b.id);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

// ---------- booking documents ----------

const DOC_DIR = `${DATA_DIR}/leasing`;
const DOC_COLS = `id, booking_id, title, notes, file_name, file_mime, uploaded_by, created_at, (file_path IS NOT NULL) AS has_file`;

const getDoc = async (id) => {
  const d = await db.prepare(`SELECT ${DOC_COLS}, file_path FROM lease_documents WHERE id = ?`).get(Number(id));
  if (!d) throw bad('Not found', 404);
  return d;
};

/** What is kept with a booking (contract, ID, payment slips…), in the order it was added. */
export async function bookingDocs(bookingId) {
  const b = await getBooking(bookingId);
  return db.prepare(`SELECT ${DOC_COLS} FROM lease_documents WHERE booking_id = ? ORDER BY id`).all(b.id);
}

/** A cancelled booking can still take documents (the cancellation letter, the refund slip). */
export async function addBookingDoc(bookingId, body = {}, file, by) {
  const title = text(body.title);
  if (!title) throw bad('Give the document a name.');
  const b = await getBooking(bookingId);
  const row = { title, notes: text(body.notes, 2000), ...saveFile(file, DOC_DIR), booking_id: b.id, uploaded_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  const { file_path, ...doc } = await getDoc(id);
  return doc;
}

export async function removeBookingDoc(id) {
  const d = await getDoc(id);
  await db.prepare('DELETE FROM lease_documents WHERE id = ?').run(d.id);
  if (d.file_path) rmSync(d.file_path, { force: true });
  return { ok: true };
}

/** The units of a building and whether each is free for these dates (and if not, who has it). */
export async function availability(buildingId, start, end) {
  if (!isDate(start) || !isDate(end) || end < start) throw bad('Choose valid start and end dates.');
  const units = await db.prepare(`SELECT id, unit_no, floor, type, size_sqft, furnished, blocked FROM prop_units WHERE building_id = ?
    ORDER BY NULLIF(regexp_replace(floor, '\\D', '', 'g'), '')::int NULLS FIRST, floor,
      NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(Number(buildingId));
  const taken = await db.prepare(`${BOOKING_SELECT} WHERE bl.id = ? AND b.status = 'confirmed' AND b.start_date <= ? AND b.end_date >= ?`)
    .all(Number(buildingId), end, start);
  return units.map((u) => {
    const t = taken.find((b) => b.unit_id === u.id);
    return { ...u, free: !u.blocked && !t, taken_by: t ? { tenant: t.tenant, start_date: t.start_date, end_date: t.end_date, ref: bookingRef(t) } : null };
  });
}

// ---------- routes (any signed-in user) ----------

export const leasingRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

leasingRoutes.get('/tenants', wrap(async (req, res) => res.json(await listTenants(req.query.q))));
leasingRoutes.post('/tenants', wrap(async (req, res) => res.json(await addTenant(req.body, req.user.id))));
leasingRoutes.put('/tenants/:id', wrap(async (req, res) => res.json(await updateTenant(req.params.id, req.body))));
leasingRoutes.delete('/tenants/:id', wrap(async (req, res) => res.json(await removeTenant(req.params.id))));

leasingRoutes.get('/available', wrap(async (req, res) => res.json(await availability(req.query.building_id, req.query.start, req.query.end))));
leasingRoutes.get('/bookings', wrap(async (req, res) => res.json(await listBookings(req.query))));
leasingRoutes.get('/bookings/:id', wrap(async (req, res) => res.json(await getBooking(req.params.id))));
leasingRoutes.post('/bookings', wrap(async (req, res) => res.json(await createBooking(req.body, req.user.id))));
leasingRoutes.put('/bookings/:id', wrap(async (req, res) => res.json(await updateBooking(req.params.id, req.body))));
leasingRoutes.post('/bookings/:id/confirm', wrap(async (req, res) => res.json(await confirmBooking(req.params.id))));
leasingRoutes.post('/bookings/:id/cancel', wrap(async (req, res) => res.json(await cancelBooking(req.params.id, req.body?.reason))));
leasingRoutes.delete('/bookings/:id', wrap(async (req, res) => res.json(await removeBooking(req.params.id))));

leasingRoutes.get('/bookings/:id/docs', wrap(async (req, res) => res.json(await bookingDocs(req.params.id))));
leasingRoutes.post('/bookings/:id/docs', upload.single('file'), wrap(async (req, res) => res.json(await addBookingDoc(req.params.id, req.body, req.file, req.user.id))));
leasingRoutes.delete('/docs/:id', wrap(async (req, res) => res.json(await removeBookingDoc(req.params.id))));
leasingRoutes.get('/docs/:id/file', wrap(async (req, res) => sendDoc(req, res, await getDoc(req.params.id))));
