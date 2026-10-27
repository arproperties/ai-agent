import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile, sendDoc, upload, HELD } from './properties.js';
import { requireMaster } from './auth.js';
import { todayHere, cash } from './leasingRegion.js';
import { usPhone } from './usFormat.js';
import { readSlip } from './slipReader.js';

export { todayHere };

// Leasing: tenants and their bookings of units (the properties are in properties.js).
// Anyone signed in can add tenants and make bookings; the price is set per booking.
//
// The one hard rule: a unit is never booked twice for the same day. Confirming checks
// the unit's other confirmed bookings while holding a lock on the unit's row, so two people
// confirming at the same moment cannot both win.

export const bad = (message, status = 400) => Object.assign(new Error(message), { status });
export const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const isTrue = (v) => v === true || v === 'true';

const PERIODS = new Set(['month', 'year']);
const FREQUENCIES = new Set(['monthly', 'quarterly', 'every_6_months', 'yearly', 'upfront']);
const TYPES = new Set(['short_term', 'lease']);
const DISCOUNTS = new Set(['percent', 'amount']);

// ---------- tenants ----------

const TENANT_COLS = `id, kind, full_name, nationality, ssn, housing, housing_authority, housing_detail, emirates_id_no, passport_no, phone, email, notes, old_account, created_at,
  to_char(emirates_id_expiry, 'YYYY-MM-DD') AS emirates_id_expiry`;
export const HOUSING_AUTHORITIES = ['Beaumont', 'Port Arthur', 'Orange', 'Legacy', 'Detcog', 'Louisiana'];

function tenantFields(body = {}, { partial = false } = {}) {
  const out = {};
  for (const f of ['full_name', 'nationality', 'ssn', 'housing_authority', 'housing_detail', 'emirates_id_no', 'passport_no', 'phone', 'email', 'notes']) if (f in body) out[f] = text(body[f]);
  if (out.phone) out.phone = usPhone(out.phone);
  if ('kind' in body) out.kind = body.kind === 'company' ? 'company' : 'person';
  // Not a housing tenant: no authority kept, so a tick taken off clears it too.
  if ('housing' in body) out.housing = isTrue(body.housing);
  if (out.housing === false) Object.assign(out, { housing_authority: null, housing_detail: null });
  if (out.housing_authority) {
    const known = HOUSING_AUTHORITIES.find((a) => a.toLowerCase() === out.housing_authority.toLowerCase());
    if (!known) throw bad(`The housing authority is one of ${HOUSING_AUTHORITIES.join(', ')}.`);
    out.housing_authority = known;
    // Only Louisiana has a line typed under it, and must.
    if (known !== 'Louisiana') out.housing_detail = null;
    else if (!out.housing_detail) throw bad('Say which Louisiana housing authority.');
  }
  if (out.housing && !out.housing_authority && (!partial || 'housing_authority' in body)) throw bad('Choose the housing authority.');
  if ('emirates_id_expiry' in body) {
    const v = String(body.emirates_id_expiry ?? '').trim();
    if (v && !isDate(v)) throw bad('ID expiry is not a date.');
    out.emirates_id_expiry = v || null;
  }
  if ((!partial || 'full_name' in out) && !out.full_name) throw bad("Give the tenant's name.");
  return out;
}

/** Tenants, newest first, with how many bookings each has; `q` matches name, phone, email, ID, passport, notes, or the Rent Manager account no. and name (so LEGACY or HUD finds those tenants). */
export function listTenants(q = '') {
  const like = `%${String(q).trim().toLowerCase()}%`;
  // A whole imported tenant list is a few hundred, so the cap sits well above that; the page shows them a page at a time.
  return db.prepare(`SELECT ${TENANT_COLS}, (SELECT count(*)::int FROM lease_bookings b WHERE b.tenant_id = t.id AND b.status <> 'cancelled') AS bookings
    FROM lease_tenants t
    WHERE lower(concat_ws(' ', full_name, phone, email, emirates_id_no, passport_no, ssn, housing_authority, housing_detail, notes, old_account, old_name)) LIKE ?
    ORDER BY id DESC LIMIT 5000`).all(like);
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
    if (e.code === '23503') throw bad('This tenant has leases. Cancel or delete those first.', 409);
    throw e;
  }
  return { ok: true };
}

// ---------- bookings ----------

const BOOKING_SELECT = `SELECT b.id, b.unit_id, b.tenant_id, b.type, b.rent_amount, b.rent_period, b.payment_frequency,
    b.security_deposit, b.status, b.contract_no, b.source, b.referred_by, rt.full_name AS referred_by_name, b.tenant_energy_account, b.cancel_reason, b.notes, b.created_at,
    b.fees, b.discounts, b.discount_type, b.discount_value, b.discount_note, b.tax_percent, b.renewed_from, b.deposit_refunded, b.deposit_note, to_char(b.deposit_settled_on, 'YYYY-MM-DD') AS deposit_settled_on,
    b.deposit_passed_to, to_char(b.deposit_passed_on, 'YYYY-MM-DD') AS deposit_passed_on,
    (SELECT count(*)::int FROM lease_documents d WHERE d.booking_id = b.id) AS docs,
    (b.import_batch IS NOT NULL OR EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id AND i.kind = 'move_in' AND i.complete)) AS moved_in,
    b.import_batch, to_char(b.billed_from, 'YYYY-MM-DD') AS billed_from, b.prorate, b.part_month_amount, b.leasing_agent,
    to_char(b.lease_sign_date, 'YYYY-MM-DD') AS lease_sign_date, to_char(b.move_in_date, 'YYYY-MM-DD') AS move_in_date,
    to_char(b.notice_date, 'YYYY-MM-DD') AS notice_date, to_char(b.expected_move_out, 'YYYY-MM-DD') AS expected_move_out,
    to_char(b.deposit_due, 'YYYY-MM-DD') AS deposit_due,
    b.no_late_fees, b.no_checks, b.no_partial_payments, b.no_payments, b.no_twa,
    EXISTS (SELECT 1 FROM prop_inspections i WHERE i.booking_id = b.id AND i.kind = 'move_out' AND i.complete) AS moved_out,
    to_char(b.start_date, 'YYYY-MM-DD') AS start_date, to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
    u.unit_no, u.floor, u.type AS unit_type, bl.id AS building_id, bl.name AS building, c.id AS company_id, c.name AS company,
    t.full_name AS tenant, t.phone AS tenant_phone, t.email AS tenant_email
  FROM lease_bookings b
  JOIN prop_units u ON u.id = b.unit_id
  JOIN prop_buildings bl ON bl.id = u.building_id
  JOIN prop_companies c ON c.id = bl.company_id
  JOIN lease_tenants t ON t.id = b.tenant_id
  LEFT JOIN lease_tenants rt ON rt.id = b.referred_by`;

export const bookingRef = (b) => `LS-${b.start_date.slice(0, 4)}-${String(b.id).padStart(4, '0')}`;

/** Where a booking stands today: draft, cancelled, upcoming, active or ended. */
export function bookingStage(b, today = todayHere()) {
  if (b.status !== 'confirmed') return b.status;
  return today < b.start_date ? 'upcoming' : today > b.end_date ? 'ended' : 'active';
}

const num = (v) => (v == null ? null : Number(v));
const shape = (b, today) => b && { ...b, fees: JSON.parse(b.fees || '[]'), discounts: JSON.parse(b.discounts || '[]'), discount_value: num(b.discount_value), tax_percent: num(b.tax_percent), part_month_amount: num(b.part_month_amount),
  ref: bookingRef(b), stage: bookingStage(b, today) };

/** A lease is a year or more (end on or after the day before the same date next year). */
export function suggestType(start, end) {
  const s = new Date(`${start}T00:00:00Z`);
  const yearOn = new Date(Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate() - 1)).toISOString().slice(0, 10);
  return end >= yearOn ? 'lease' : 'short_term';
}

export async function getBooking(id) {
  const b = await db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(Number(id));
  if (!b) throw bad('Lease not found', 404);
  return shape(b);
}

/** Bookings, newest start first. Filters: stage, company_id, building_id, unit_id, tenant_id, q. */
export async function listBookings({ stage, company_id, building_id, unit_id, tenant_id, q } = {}, today = todayHere()) {
  const where = [];
  const args = [];
  for (const [col, v] of [['c.id', company_id], ['bl.id', building_id], ['u.id', unit_id], ['t.id', tenant_id]]) {
    if (v) { where.push(`${col} = ?`); args.push(Number(v)); }
  }
  if (q && String(q).trim()) {
    where.push(`lower(concat_ws(' ', t.full_name, t.phone, t.email, u.unit_no, bl.name, c.name, b.contract_no, b.source, rt.full_name)) LIKE ?`);
    args.push(`%${String(q).trim().toLowerCase()}%`);
  }
  const rows = await db.prepare(`${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY b.start_date DESC, b.id DESC LIMIT 3000`).all(...args);
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
  if ('type' in body && body.type) { if (!TYPES.has(body.type)) throw bad('Unknown lease type.'); out.type = body.type; }
  for (const f of ['contract_no', 'notes']) if (f in body) out[f] = text(body[f], 2000);
  if ('source' in body) out.source = text(body.source, 60); // where the tenant came from: a name off the sources list
  if ('referred_by' in body) out.referred_by = Number(body.referred_by) || null; // the tenant who sent them, checked by mustRefer
  if ('tenant_energy_account' in body) out.tenant_energy_account = isTrue(body.tenant_energy_account); // the energy bill is in the tenant's own name
  // Other charges (pet fee, parking, commission, energy deposit…): each is due once, on the first day,
  // or, when it repeats, every month. A monthly one may start (`from`) and stop (`until`) on dates of
  // its own; with no `until` it runs to the end of the lease.
  if ('fees' in body) {
    const list = (Array.isArray(body.fees) ? body.fees : []).filter((f) => f && (f.label || f.amount));
    if (list.length > 10) throw bad('At most ten other charges.');
    const day = (s, name) => { if (!s) return null; if (!isDate(s)) throw bad(`${name} is not a date.`); return s; };
    const fees = list.map((f) => {
      if (!isTrue(f.repeats)) return { label: text(f.label, 60), amount: Number(f.amount) };
      const from = day(f.from, 'A monthly charge’s start'), until = day(f.until, 'A monthly charge’s end');
      if (from && until && until < from) throw bad(`${text(f.label, 60) || 'A monthly charge'} ends before it starts.`);
      return { label: text(f.label, 60), amount: Number(f.amount), repeats: true, ...(from ? { from } : {}), ...(until ? { until } : {}) };
    });
    if (fees.some((f) => !f.label || !(f.amount > 0))) throw bad('Each other charge needs a name and an amount.');
    if (new Set(fees.map((f) => f.label.toLowerCase())).size < fees.length) throw bad('Two other charges have the same name.');
    out.fees = JSON.stringify(fees);
  }
  // A discount off the rent: a percentage, or an amount off the rent as it was entered. Left empty, there is none.
  if ('discount_value' in body) {
    const v = body.discount_value;
    if (v === '' || v == null || Number(v) === 0) Object.assign(out, { discount_type: null, discount_value: null });
    else {
      if (!DISCOUNTS.has(body.discount_type)) throw bad('A discount is a percent or an amount.');
      if (!(Number(v) > 0)) throw bad('The discount must be a number above zero.');
      if (body.discount_type === 'percent' && Number(v) >= 100) throw bad('A discount in percent is below 100.');
      Object.assign(out, { discount_type: body.discount_type, discount_value: Number(v) });
    }
  }
  if ('discount_note' in body) out.discount_note = text(body.discount_note);
  // Discounts off the monthly rent, each between dates of its own: none is from the start, or to the end.
  if ('discounts' in body) {
    const list = (Array.isArray(body.discounts) ? body.discounts : []).filter((d) => d && (Number(d.amount) || d.from || d.until || d.note));
    if (list.length > 10) throw bad('At most ten discounts.');
    const day = (s, name) => { if (!s) return null; if (!isDate(s)) throw bad(`${name} is not a date.`); return s; };
    out.discounts = JSON.stringify(list.map((d) => {
      if (!(Number(d.amount) > 0)) throw bad('Each discount needs an amount above zero.');
      const from = day(d.from, 'A discount’s start'), until = day(d.until, 'A discount’s end');
      if (from && until && until < from) throw bad('A discount ends before it starts.');
      const note = text(d.note, 200);
      return { amount: money(Number(d.amount)), ...(from ? { from } : {}), ...(until ? { until } : {}), ...(note ? { note } : {}) };
    }));
  }
  // Tax on the rent and the other charges. Empty or zero is a booking with no tax.
  if ('tax_percent' in body) {
    const v = body.tax_percent;
    if (v !== '' && v != null && !(Number(v) >= 0 && Number(v) <= 100)) throw bad('The tax is a percentage from 0 to 100.');
    out.tax_percent = Number(v) > 0 ? Number(v) : null;
  }
  // How a part first month is charged (see proratedSchedule). Left empty, rent is due on the move-in day each month.
  if ('prorate' in body) {
    const v = body.prorate || null;
    if (v && !PRORATE.has(v)) throw bad('Unknown proration.');
    out.prorate = v;
  }
  // The part month's rent as Rent Manager charged it, in place of the one worked out by the day. Empty: worked out.
  if ('part_month_amount' in body) {
    const v = body.part_month_amount;
    if (v !== '' && v != null && !(Number(v) > 0)) throw bad('The prorated rent must be a number above zero.');
    out.part_month_amount = v === '' || v == null ? null : money(Number(v));
  }
  // What Rent Manager's General tab has besides: the day it was signed, the day the tenant moved in, a notice
  // given and the move-out expected from it, who let it, and its ticks.
  for (const [f, name] of DATES) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (v && !isDate(v)) throw bad(`${name} is not a date.`);
    out[f] = v || null;
  }
  if ('leasing_agent' in body) out.leasing_agent = text(body.leasing_agent, 80);
  for (const f of TICKS) if (f in body) out[f] = isTrue(body[f]);
  return out;
}

const DATES = [['lease_sign_date', 'Lease sign date'], ['move_in_date', 'Move-in date'], ['notice_date', 'Notice date'], ['expected_move_out', 'Expected move-out'], ['deposit_due', 'Deposit date']];
export const TICKS = ['no_late_fees', 'no_checks', 'no_partial_payments', 'no_payments', 'no_twa'];

/** The tenant named as having sent this one must be on the list, and not the lease's own tenant. */
async function mustRefer(referredBy, tenantId) {
  if (!referredBy) return;
  if (Number(referredBy) === Number(tenantId)) throw bad('A tenant cannot be referred by themselves.');
  await getTenant(referredBy);
}

const PRORATE = new Set(['first', 'second']);
/** A part month is worked out in days of a month, so only a lease paid month by month can have one. */
const mustProrateMonthly = (b) => { if (b.prorate && b.payment_frequency !== 'monthly') throw bad('Proration needs monthly payments.'); };

/** An amount taken off the rent has to leave some rent. */
const mustLeaveRent = (b) => {
  if (b.discount_type === 'amount' && Number(b.discount_value) >= Number(b.rent_amount)) throw bad('The discount must be less than the rent.');
  if (discountsOf(b).some((d) => d.amount >= monthlyRent(b))) throw bad('A discount must be less than the rent for a month.');
};

/**
 * The confirmed booking of this unit that shares a day with these dates, if any; or one that
 * ended before them whose tenant has not been inspected out (the unit is not vacant until then).
 */
const clash = (unitId, start, end, exceptId = 0, followsId = 0) => db.prepare(`${BOOKING_SELECT}
  WHERE b.unit_id = ? AND b.status = 'confirmed' AND b.id <> ? AND ((b.start_date <= ? AND b.end_date >= ?) OR (b.end_date < ? AND b.id <> ? AND ${HELD}))
  ORDER BY b.start_date LIMIT 1`).get(Number(unitId), Number(exceptId), end, start, start, Number(followsId) || 0);

/**
 * The tenant's own confirmed booking of this unit that ends the day before `start`, if it has no
 * renewal yet. A lease made straight after it (say an Airbnb stay that turns into a lease) is the
 * same tenant staying on, so it follows on from it as a renewal does: no move-out, no move-in.
 */
const followsOn = async (unitId, tenantId, start, exceptId = 0) => (await db.prepare(`SELECT b.id FROM lease_bookings b
  WHERE b.unit_id = ? AND b.tenant_id = ? AND b.status = 'confirmed' AND b.end_date = ? AND b.id <> ?
    AND NOT EXISTS (SELECT 1 FROM lease_bookings r WHERE r.renewed_from = b.id AND r.status <> 'cancelled' AND r.id <> ?)
  ORDER BY b.id DESC LIMIT 1`).get(Number(unitId), Number(tenantId), iso(dayNo(start) - 1), Number(exceptId), Number(exceptId)))?.id ?? null;

/**
 * Both bookings say in their history why neither has the inspection a change of tenant would
 * need, so it can be answered months later. Gives back what the new one's own entry says.
 */
async function logFollowOn(priorId, next, by) {
  const prior = await getBooking(priorId);
  await logEvent(prior.id, 'renewed', `${prior.tenant} stays on as ${next.ref} from ${next.start_date}: no move-out inspection, the tenant did not leave`, by);
  return `Follows on from ${prior.ref}, ${prior.tenant}'s stay in this unit that ended ${prior.end_date}: no move-in inspection, the tenant was already in`;
}

/** Fails unless the unit can be confirmed for these dates. Call inside tx(): it locks the unit. `followsId`: the booking it follows on from, which does not hold the unit against it. */
async function mustBeFree(unitId, start, end, exceptId, followsId) {
  const unit = await db.prepare('SELECT id, blocked FROM prop_units WHERE id = ? FOR UPDATE').get(Number(unitId));
  if (!unit) throw bad('Unit not found', 404);
  if (unit.blocked) throw bad('This unit is blocked (not for rent). Unblock it on the building page first.', 409);
  const other = await clash(unitId, start, end, exceptId, followsId);
  if (other && other.end_date < start) throw bad(`Unit ${other.unit_no} is not vacant: ${other.tenant}'s move-out inspection is not done (${bookingRef(other)}). Do it first.`, 409);
  if (other) throw bad(`Unit ${other.unit_no} is already leased by ${other.tenant} from ${other.start_date} to ${other.end_date} (${bookingRef(other)}).`, 409);
}

/** A new booking, as a draft or straight to confirmed. A new tenant can come with it. */
export const createBooking = (body = {}, by) => tx(() => makeBooking(body, by));

/** What a booking made on the booking form must come with, each as a file: [the upload's field, the document's name]. */
export const REQUIRED_DOCS = [['driver_license', 'Driver License'], ['proof_of_employment', 'Proof of Employment']];

/** A booking made on the booking form: it is not saved without each of REQUIRED_DOCS, which are kept with it. */
export async function createBookingWithDocs(body = {}, files = {}, by) {
  const missing = REQUIRED_DOCS.filter(([f]) => !files?.[f]?.[0]).map(([, name]) => name);
  if (missing.length) throw bad(`Attach the tenant's ${missing.join(' and ')}.`);
  return tx(async () => {
    const made = await makeBooking(body, by);
    for (const [f, title] of REQUIRED_DOCS) await addBookingDoc(made.id, { title }, files[f][0], by);
    return getBooking(made.id);
  });
}

/**
 * A lease from Rent Manager's Rent Roll (server/leaseImport.js), confirmed: the tenant is already
 * living there, so there is no move-in inspection and no documents are asked for. Rent falling due
 * before `billedFrom` was billed in Rent Manager and is left off the schedule.
 */
export const importBooking = (body, by, { batch, billedFrom }) => tx(() => makeBooking({ ...body, status: 'confirmed' }, by,
  { import_batch: batch, billed_from: billedFrom }, 'Imported from Rent Manager'));

/** createBooking without its own transaction, for a caller that is already in one. */
async function makeBooking(body = {}, by, extra = {}, made_as = null) {
  const row = bookingFields(body);
  mustLeaveRent(row);
  mustProrateMonthly(row);
  if (!body.unit_id) throw bad('Choose a unit.');
  const confirm = body.status === 'confirmed';
  const tenantId = body.tenant_id ? (await getTenant(body.tenant_id)).id : (await addTenant(body.tenant || {}, by)).id;
  await mustRefer(row.referred_by, tenantId);
  const follows = extra.import_batch ? null : await followsOn(body.unit_id, tenantId, row.start_date);
  if (confirm) await mustBeFree(body.unit_id, row.start_date, row.end_date, 0, follows);
  else if (!(await db.prepare('SELECT 1 FROM prop_units WHERE id = ?').get(Number(body.unit_id)))) throw bad('Unit not found', 404);
  const full = { type: suggestType(row.start_date, row.end_date), ...row, unit_id: Number(body.unit_id), tenant_id: tenantId,
    status: confirm ? 'confirmed' : 'draft', created_by: by ?? null, ...(follows ? { renewed_from: follows } : {}), ...extra };
  const cols = Object.keys(full);
  const { id } = await db.prepare(`INSERT INTO lease_bookings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => full[c]));
  const made = await getBooking(id);
  if (confirm) await writeSchedule(made);
  await learnPrices(made.fees, made.building_id);
  const how = made_as || (confirm ? 'Confirmed straight away' : 'Saved as a draft');
  await logEvent(id, 'created', follows ? `${how} · ${await logFollowOn(follows, made, by)}` : how, by);
  return made;
}

/** Change a booking's details. A confirmed one is re-checked against the unit's other bookings. */
export async function updateBooking(id, body = {}, by) {
  return tx(async () => {
    const old = await getBooking(id);
    if (old.status === 'cancelled') throw bad('A cancelled lease cannot be changed.', 409);
    const row = bookingFields(body, { partial: true });
    if (body.unit_id) row.unit_id = Number(body.unit_id);
    if (body.tenant_id) row.tenant_id = (await getTenant(body.tenant_id)).id;
    if ('referred_by' in row || row.tenant_id) await mustRefer('referred_by' in row ? row.referred_by : old.referred_by, row.tenant_id || old.tenant_id);
    const start = row.start_date || old.start_date;
    const end = row.end_date || old.end_date;
    if (end < start) throw bad('The end date is before the start date.');
    mustLeaveRent({ ...old, ...row });
    mustProrateMonthly({ ...old, ...row });
    // Moved to the day after the same tenant's stay in the unit ends: it follows on from that stay now. A link it has is kept.
    if (!old.renewed_from && !old.import_batch) {
      const follows = await followsOn(row.unit_id || old.unit_id, row.tenant_id || old.tenant_id, start, old.id);
      if (follows) row.renewed_from = follows;
    }
    if (old.status === 'confirmed') await mustBeFree(row.unit_id || old.unit_id, start, end, old.id, row.renewed_from);
    // The schedule is rebuilt around the rows already paid, which only holds if they still fit it.
    const fixed = ['start_date', 'rent_period', 'payment_frequency', 'discount_type', 'prorate'].some((f) => f in row && row[f] !== old[f])
      || ['rent_amount', 'discount_value', 'tax_percent', 'part_month_amount'].some((f) => f in row && row[f] !== num(old[f]));
    if (fixed && await db.prepare('SELECT 1 FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id WHERE i.booking_id = ? LIMIT 1').get(old.id)) {
      throw bad('Payments are recorded on this lease, so its start date, rent, discount, tax and payment frequency cannot change (nor how its first month is charged). Cancel it and make a new lease instead.', 409);
    }
    // A discount agreed later may change rent still to be paid, never rent that has money against it.
    if ('discounts' in row && row.discounts !== JSON.stringify(old.discounts)) {
      const paid = await db.prepare(`SELECT DISTINCT to_char(i.due_date, 'YYYY-MM-DD') AS due FROM lease_installments i JOIN lease_payments p ON p.installment_id = i.id
        WHERE i.booking_id = ? AND i.kind = 'rent' ORDER BY 1`).all(old.id);
      const was = new Map(schedule(old).map((r) => [r.due, r.amount]));
      const hit = schedule({ ...old, ...row, start_date: start, end_date: end }).find((r) => paid.some((p) => p.due === r.due) && r.amount !== was.get(r.due));
      const usDate = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
      if (hit) throw bad(`The rent due ${usDate(hit.due)} is already paid, so a discount cannot change it. Start the discount after it.`, 409);
    }
    const cols = Object.keys(row);
    if (cols.length) await db.prepare(`UPDATE lease_bookings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), old.id);
    const now = await getBooking(id);
    if (now.status === 'confirmed') await writeSchedule(now);
    // Late fees switched off on this lease: those not paid come off (a paid one stays, as money was taken for it).
    // Switched back on, applyLateFees() works them out again the next time the schedule is looked at.
    if (now.no_late_fees && !old.no_late_fees) {
      await db.prepare("DELETE FROM lease_installments i WHERE i.booking_id = ? AND i.kind = 'late' AND NOT EXISTS (SELECT 1 FROM lease_payments p WHERE p.installment_id = i.id)").run(old.id);
    }
    if ('fees' in row) await learnPrices(now.fees, now.building_id);
    const same = (c) => (c === 'fees' || c === 'discounts' ? row[c] === JSON.stringify(old[c]) : String(row[c] ?? '') === String(old[c] ?? '') || (row[c] != null && Number(row[c]) === Number(old[c])));
    const changed = cols.filter((c) => c !== 'renewed_from' && !same(c)).map((c) => c.replace(/_id$/, '').replace(/_/g, ' '));
    if (changed.length) await logEvent(old.id, 'changed', changed.join(', '), by);
    if (row.renewed_from) await logEvent(old.id, 'changed', await logFollowOn(row.renewed_from, now, by), by);
    return now;
  });
}

/**
 * Move a confirmed booking's end date: the tenant stays longer, or the stay turns out
 * shorter than was booked (they leave early, or it was booked for too long by mistake).
 * It works with payments already recorded, which a full edit of the terms does not.
 *   Longer: the unit must be free for the extra days; the extra rent is added to the schedule.
 *   Shorter: payments not yet made for the time taken off are removed; what was due for the
 *   time actually stayed is still owed. Rent already paid for time taken off stays on the
 *   books as received, and is reported back as `overpaid`, to give back or carry over.
 */
export async function changeEnd(id, endDate, by) {
  const end = String(endDate ?? '').trim();
  if (!isDate(end)) throw bad('Choose the new end date.');
  return tx(async () => {
    const old = await getBooking(id);
    if (old.status !== 'confirmed') throw bad('Only a confirmed lease can be extended or ended early.', 409);
    if (end === old.end_date) throw bad('That is the end date it already has.');
    if (end < old.start_date) throw bad('The end date is before the start date.');
    const paidRent = Number((await db.prepare(`SELECT coalesce(sum(p.amount), 0) AS n FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id
      WHERE i.booking_id = ? AND i.kind = 'rent'`).get(old.id)).n);
    if (end > old.end_date) {
      // Paid upfront, the one payment is dated the first day: more rent on it would be overdue from then.
      if (old.payment_frequency === 'upfront' && paidRent > 0) throw bad('This stay was paid upfront. Use Renew to add the extra time as a new lease.', 409);
      await mustBeFree(old.unit_id, old.start_date, end, old.id);
    }
    await db.prepare('UPDATE lease_bookings SET end_date = ? WHERE id = ?').run(end, old.id);
    // The tenant's own next lease of the unit, made before this stay was ended, starts the day after now: it follows on from it.
    let follower = null;
    if (!(await db.prepare("SELECT 1 FROM lease_bookings WHERE renewed_from = ? AND status <> 'cancelled'").get(old.id))) {
      follower = (await db.prepare(`UPDATE lease_bookings SET renewed_from = ? WHERE id = (SELECT id FROM lease_bookings WHERE unit_id = ? AND tenant_id = ? AND start_date = ?
        AND status <> 'cancelled' AND renewed_from IS NULL AND import_batch IS NULL ORDER BY id DESC LIMIT 1) RETURNING id`).run(old.id, old.unit_id, old.tenant_id, iso(dayNo(end) + 1))).id;
    }
    const now = await getBooking(id);
    await writeSchedule(now);
    const overpaid = money(Math.max(0, paidRent - total(schedule(now))));
    await logEvent(old.id, 'changed', `${end > old.end_date ? 'Stay extended' : 'Stay ended early'}: end date ${old.end_date} to ${end}${overpaid > 0 ? ` · ${cash(overpaid)} of rent was paid for time taken off` : ''}`, by);
    if (follower) await logEvent(follower, 'changed', await logFollowOn(old.id, await getBooking(follower), by), by);
    return { ...now, overpaid };
  });
}

export async function confirmBooking(id, by) {
  return tx(async () => {
    const b = await getBooking(id);
    if (b.status !== 'draft') throw bad(`Only a draft can be confirmed (this one is ${b.status}).`, 409);
    await mustBeFree(b.unit_id, b.start_date, b.end_date, b.id);
    await db.prepare("UPDATE lease_bookings SET status = 'confirmed' WHERE id = ?").run(b.id);
    await writeSchedule(b);
    await logEvent(b.id, 'confirmed', null, by);
    return getBooking(id);
  });
}

/**
 * Cancelling stops what has not fallen due yet, and nothing else: rent, deposit or charges
 * due on or before the day it is cancelled are still owed, and stay in the alerts and the
 * reports until they are paid. Payments not yet due are taken off the schedule (one already
 * part paid owes no more than it was paid).
 */
export async function cancelBooking(id, reason, by, today = todayHere()) {
  return tx(async () => {
    const b = await getBooking(id);
    if (b.status === 'cancelled') throw bad('Already cancelled.', 409);
    const why = text(reason, 500);
    if (!why) throw bad('Say why it is cancelled.');
    await db.prepare("UPDATE lease_bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(why, b.id);
    await db.prepare('DELETE FROM lease_installments i WHERE i.booking_id = ? AND i.due_date > ? AND NOT EXISTS (SELECT 1 FROM lease_payments p WHERE p.installment_id = i.id)').run(b.id, today);
    await db.prepare(`UPDATE lease_installments SET amount = (SELECT coalesce(sum(p.amount), 0) FROM lease_payments p WHERE p.installment_id = lease_installments.id), tax = ${TAX_OF_PAID}
      WHERE booking_id = ? AND due_date > ?`).run(b.id, today);
    await logEvent(b.id, 'cancelled', why, by);
    return getBooking(id);
  });
}

/** A draft can be deleted outright; anything confirmed is cancelled instead, so its history stays. */
export async function removeBooking(id) {
  const b = await getBooking(id);
  if (b.status !== 'draft') throw bad('Only a draft can be deleted. Cancel a confirmed lease instead.', 409);
  // Its documents go with it; their rows cascade, their files are removed here.
  const files = await db.prepare('SELECT file_path FROM lease_documents WHERE booking_id = ? AND file_path IS NOT NULL').all(b.id);
  await db.prepare('DELETE FROM lease_bookings WHERE id = ?').run(b.id);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

// ---------- booking documents ----------

const DOC_DIR = `${DATA_DIR}/leasing`;
const DOC_COLS = `id, booking_id, title, category, notes, file_name, file_mime, uploaded_by, created_at, generated, (file_path IS NOT NULL) AS has_file`;
// How Rent Manager files a lease's notes and files (its History / Notes tab). Left empty: no category.
export const DOC_CATEGORIES = [['lease', 'Lease'], ['application', 'Application'], ['notice', 'Notice'], ['move_in', 'Move-in form'], ['other', 'Other']];

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
  const category = text(body.category, 20);
  if (category && !DOC_CATEGORIES.some(([k]) => k === category)) throw bad('Unknown category.');
  const b = await getBooking(bookingId);
  const row = { title, category, notes: text(body.notes, 2000), ...saveFile(file, DOC_DIR), booking_id: b.id, uploaded_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  await logEvent(b.id, 'document', title, by);
  const { file_path, ...doc } = await getDoc(id);
  return doc;
}

export async function removeBookingDoc(id, by) {
  const d = await getDoc(id);
  await db.prepare('DELETE FROM lease_documents WHERE id = ?').run(d.id);
  await logEvent(d.booking_id, 'document_removed', d.title, by);
  if (d.file_path) rmSync(d.file_path, { force: true });
  return { ok: true };
}

/** The units of a building and whether each is free for these dates (and if not, who has it). */
export async function availability(buildingId, start, end) {
  if (!isDate(start) || !isDate(end) || end < start) throw bad('Choose valid start and end dates.');
  const units = await db.prepare(`SELECT id, unit_no, floor, type, size_sqft, furnished, blocked FROM prop_units WHERE building_id = ?
    ORDER BY NULLIF(regexp_replace(floor, '\\D', '', 'g'), '')::int NULLS FIRST, floor,
      NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(Number(buildingId));
  const taken = await db.prepare(`${BOOKING_SELECT} WHERE bl.id = ? AND b.status = 'confirmed' AND ((b.start_date <= ? AND b.end_date >= ?) OR (b.end_date < ? AND ${HELD}))`)
    .all(Number(buildingId), end, start, start); // a tenant not inspected out still has the unit
  return units.map((u) => {
    const t = taken.find((b) => b.unit_id === u.id);
    return { ...u, free: !u.blocked && !t, taken_by: t ? { tenant: t.tenant, start_date: t.start_date, end_date: t.end_date, ref: bookingRef(t) } : null };
  });
}

// ---------- history ----------

/** Write down what happened to a booking, and who did it. */
export const logEvent = (bookingId, kind, detail, by) =>
  db.prepare('INSERT INTO lease_events (booking_id, kind, detail, user_id) VALUES (?, ?, ?, ?)').run(Number(bookingId), kind, detail || null, by ?? null);

/** A booking's history, newest first: created, confirmed, changed, payments, documents, reminders… */
export async function bookingHistory(bookingId) {
  const b = await getBooking(bookingId);
  return db.prepare(`SELECT e.id, e.kind, e.detail, e.created_at, w.name AS by FROM lease_events e LEFT JOIN users w ON w.id = e.user_id
    WHERE e.booking_id = ? ORDER BY e.id DESC LIMIT 200`).all(b.id);
}

// ---------- payment schedule and payments ----------

const STEP = { monthly: 1, quarterly: 3, every_6_months: 6, yearly: 12 };
export const METHODS = [['transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['money_order', 'Money order'], ['online', 'Online card']];
export const AGING = [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['90+ days', 91, Infinity]];
const ENDING = 60; // days before its end a lease counts as ending soon
export const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
export const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const money = (n) => Math.round(n * 100) / 100;
export const total = (list, f = (x) => x.amount) => money(list.reduce((t, x) => t + f(x), 0));
/** The same day `n` months on, or the month's last day when it has no such day (31 Jan → 28 Feb). */
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
/** The rent as it is charged: what was entered, less the booking's discount. */
export const netRent = (b) => {
  const rent = Number(b.rent_amount);
  const off = Number(b.discount_value) || 0;
  return b.discount_type === 'percent' ? rent - (rent * off) / 100 : b.discount_type === 'amount' ? rent - off : rent;
};
export const monthlyRent = (b) => netRent(b) / (b.rent_period === 'year' ? 12 : 1);
/** A booking's dated discounts, whether still the JSON it is kept as or already read. */
export const discountsOf = (b) => (typeof b.discounts === 'string' ? JSON.parse(b.discounts) : b.discounts || []);
/** What the dated discounts take off the rent of the month billed on `due`. */
const offOn = (b, due) => discountsOf(b).reduce((t, d) => t + ((!d.from || due >= d.from) && (!d.until || due <= d.until) ? Number(d.amount) : 0), 0);
/** The tax on an amount, at the booking's rate; nothing when it has none. */
export const taxOn = (b, amount) => money((amount * (Number(b.tax_percent) || 0)) / 100);
/** How many months a stay covers; a part month counts as a month. An end date written as the
    same day of the month as the start (16 March to 16 March) is the whole months and no more:
    that is how a year is often written, not a thirteenth month of rent. */
function monthsOf(b) {
  let months = 1;
  while (addMonths(b.start_date, months) < b.end_date) months++;
  return months;
}
/** What a row of the schedule is for, in words: Rent, Security deposit, or the charge's own name. */
export const dueName = (i) => (i.kind === 'deposit' ? 'Security deposit' : i.kind === 'fee' || i.kind === 'charge' ? i.label : i.kind === 'late' ? `Late fee (rent due ${i.label})`
  : i.kind === 'credit' ? 'Credit (paid ahead)' : 'Rent');
/** The rows writeSchedule() leaves alone: late fees, charges added by hand, and money kept as a credit. */
const KEPT = "('late', 'charge', 'credit')";

/** When a booking's rent falls due and how much: one row per payment, from its frequency.
    A part month counts as a month; "upfront" is the whole stay on the first day. The amount
    is the rent after its discount, with the tax on it (`tax`, on a booking that is taxed). */
export function schedule(b) {
  if (b.billed_from) return importedSchedule(b);
  if (prorates(b)) return proratedSchedule(b);
  const months = monthsOf(b);
  const step = STEP[b.payment_frequency] || months;
  const out = [];
  // Each payment is the rent up to its end less the rent up to its start, so a yearly rent that
  // does not divide by twelve still adds up to exactly itself.
  const upTo = (n) => money(monthlyRent(b) * n);
  for (let k = 0; k < months; k += step) {
    // Less the dated discounts of each month the payment covers.
    let off = 0;
    for (let j = k; j < Math.min(k + step, months); j++) off += offOn(b, addMonths(b.start_date, j));
    const rent = money(Math.max(0, upTo(Math.min(k + step, months)) - upTo(k) - off));
    const tax = taxOn(b, rent);
    out.push({ due: addMonths(b.start_date, k), amount: money(rent + tax), ...(tax ? { tax } : {}), share: Math.min(step, months - k) });
  }
  return out;
}

/** Whether a lease's rent follows proratedSchedule(): an imported lease never does. */
const prorates = (b) => !b.billed_from && b.prorate && b.payment_frequency === 'monthly';
/** How many days the month of `s` has. */
const daysIn = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate();
/** The last day of the month of `s`. */
const lastOfMonth = (s) => `${s.slice(0, 8)}${String(daysIn(s)).padStart(2, '0')}`;

/**
 * A lease that prorates its first month, as Rent Manager bills: the days lived in the move-in month
 * are charged at the month's rent divided by that month's days, then full rent is due on each 1st.
 * The last month is cut the same way when the lease ends before it does. With 'first' the part month
 * is due on the move-in day. With 'second' a full month's rent (the one after the part month) is taken
 * on the move-in day, and the part month is due on the next 1st instead; when the lease has no next 1st,
 * the part month is due on the move-in day. Each row's `share` is how many months it bills,
 * so a charge that repeats is cut the same way.
 */
function proratedSchedule(b) {
  const part = (from, to) => (dayNo(to) - dayNo(from) + 1) / daysIn(from);
  const firstOfNext = (s) => iso(dayNo(lastOfMonth(s)) + 1);
  const rows = [];
  const head = b.start_date.endsWith('-01') ? null : { due: b.start_date, share: part(b.start_date, b.end_date < lastOfMonth(b.start_date) ? b.end_date : lastOfMonth(b.start_date)) };
  for (let d = head ? firstOfNext(b.start_date) : b.start_date; d <= b.end_date; d = firstOfNext(d)) {
    rows.push({ due: d, share: b.end_date < lastOfMonth(d) ? part(d, b.end_date) : 1 });
  }
  if (head && b.prorate === 'second' && rows.length) rows.splice(0, 1, { due: b.start_date, share: rows[0].share }, { due: rows[0].due, share: head.share, part: true });
  else if (head) rows.unshift({ ...head, part: true });
  return rows.map(({ due, share, part }) => {
    // The part month at the amount typed for it, when one was (Rent Manager's own figure).
    // A dated discount comes off a part month by its days, as the rent does.
    const off = offOn(b, due) * share;
    const rent = money(Math.max(0, part && Number(b.part_month_amount) > 0 ? Number(b.part_month_amount) - off : (monthlyRent(b) - offOn(b, due)) * share));
    const tax = taxOn(b, rent);
    return { due, amount: money(rent + tax), ...(tax ? { tax } : {}), share };
  });
}

/**
 * A lease imported from Rent Manager: rent in full on the 1st of each month, as Rent Manager
 * bills it, from `billed_from` (a 1st) to the lease's end. What fell due before was billed there.
 */
function importedSchedule(b) {
  const firsts = [];
  for (let d = b.billed_from; d <= b.end_date; d = addMonths(d, 1)) firsts.push(d);
  const step = STEP[b.payment_frequency] || firsts.length;
  const out = [];
  for (let k = 0; k < firsts.length; k += step) {
    const off = firsts.slice(k, k + step).reduce((t, d) => t + offOn(b, d), 0);
    const rent = money(Math.max(0, monthlyRent(b) * Math.min(step, firsts.length - k) - off));
    const tax = taxOn(b, rent);
    out.push({ due: firsts[k], amount: money(rent + tax), ...(tax ? { tax } : {}), share: Math.min(step, firsts.length - k) });
  }
  return out;
}

// A row cut down to what was paid on it keeps the same share of tax in what is left.
const TAX_OF_PAID = 'CASE WHEN amount > 0 THEN round(tax * (SELECT coalesce(sum(p.amount), 0) FROM lease_payments p WHERE p.installment_id = lease_installments.id) / amount, 2) ELSE 0 END';

/**
 * Write a confirmed booking's schedule: the rent, then the security deposit and any other
 * charges. Those are due on the first day, except a charge that repeats, which is due every
 * month between its own dates. A taxed booking's rent and charges carry their tax; the deposit never does. Rows with no payment against them are rebuilt. A row with money against
 * it is kept, and owes what the terms now say (never less than it has been paid); one the
 * terms no longer ask for at all (a charge taken off, a stay cut short) owes nothing more.
 */
async function writeSchedule(b) {
  // Late fees and charges added by hand are not part of the terms: applyLateFees() and addCharge() add them, and they stay as they are.
  await db.prepare(`DELETE FROM lease_installments i WHERE i.booking_id = ? AND i.kind NOT IN ${KEPT} AND NOT EXISTS (SELECT 1 FROM lease_payments p WHERE p.installment_id = i.id)`).run(b.id);
  const fees = typeof b.fees === 'string' ? JSON.parse(b.fees) : b.fees || [];
  const rent = schedule(b);
  // A monthly charge is due each month whatever the rent's own frequency, on the days monthly rent would be,
  // from its own start (if any) up to its own end (if any): one ended on 15 March is billed on 1 March, not 1 April.
  const months = b.payment_frequency === 'monthly' ? rent : schedule({ ...b, payment_frequency: 'monthly' });
  const monthlyDues = (f) => months.map((p) => p.due).filter((d) => (!f.from || d >= f.from) && (!f.until || d <= f.until));
  // Due once, on the first day; or, on a lease imported from Rent Manager, the first day billed here.
  const first = b.billed_from > b.start_date ? b.billed_from : b.start_date;
  // The deposit on its own date when it was charged before the start, as Rent Manager has it (GSL 102: three weeks before).
  const depositDue = b.deposit_due || first;
  // There is only ever one deposit row: a new date moves it, payment and all, rather than owing a second one.
  await db.prepare("UPDATE lease_installments SET due_date = ? WHERE booking_id = ? AND kind = 'deposit' AND due_date <> ?::date").run(depositDue, b.id, depositDue);
  const rows = [
    ...rent.map((p) => ({ kind: 'rent', label: '', ...p })),
    ...(Number(b.security_deposit) > 0 ? [{ kind: 'deposit', label: '', due: depositDue, amount: Number(b.security_deposit) }] : []),
    // A monthly charge is due in full each month, a part month too: Rent Manager bills
    // water/trash at its whole price on the prorated month (Francis, 2026-10-17).
    ...fees.flatMap((f) => (f.repeats ? monthlyDues(f).map((d) => [d, f.amount]) : [[first, f.amount]])
      .map(([due, amount]) => ({ kind: 'fee', label: f.label, due, amount: money(amount + taxOn(b, amount)), tax: taxOn(b, amount) }))),
  ];
  const paid = '(SELECT coalesce(sum(p.amount), 0) FROM lease_payments p WHERE p.installment_id = lease_installments.id)';
  for (const r of rows) {
    await db.prepare(`INSERT INTO lease_installments (booking_id, kind, label, due_date, amount, tax) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (booking_id, kind, label, due_date) DO UPDATE SET amount = GREATEST(EXCLUDED.amount, ${paid}), tax = EXCLUDED.tax`).run(b.id, r.kind, r.label, r.due, r.amount, r.tax || 0);
  }
  const asked = new Set(rows.map((r) => `${r.kind}|${r.label}|${r.due}`));
  const have = await db.prepare(`SELECT id, kind, label, to_char(due_date, 'YYYY-MM-DD') AS due FROM lease_installments WHERE booking_id = ? AND kind NOT IN ${KEPT}`).all(b.id);
  for (const h of have) {
    if (!asked.has(`${h.kind}|${h.label}|${h.due}`)) await db.prepare(`UPDATE lease_installments SET amount = ${paid}, tax = ${TAX_OF_PAID} WHERE id = ?`).run(h.id);
  }
}

/** Bookings confirmed before schedules (or deposits on them) were kept get theirs the first time anyone looks. */
async function backfillSchedules() {
  const rows = await db.prepare(`${BOOKING_SELECT} WHERE b.status = 'confirmed' AND (NOT EXISTS (SELECT 1 FROM lease_installments i WHERE i.booking_id = b.id)
    OR (b.security_deposit > 0 AND NOT EXISTS (SELECT 1 FROM lease_installments i WHERE i.booking_id = b.id AND i.kind = 'deposit')))`).all();
  for (const b of rows) await writeSchedule(b);
}

/** Whether day number `n` is a Saturday or a Sunday (day 0, 1 January 1970, was a Thursday). */
export const isWeekend = (n) => [0, 6].includes((((n + 4) % 7) + 7) % 7);
/** The day number `k` weekdays after day `n`: Saturdays and Sundays are not counted. */
export function addWeekdays(n, k) {
  let d = n;
  for (let left = k; left > 0;) { d++; if (!isWeekend(d)) left--; }
  return d;
}

/**
 * The late fee, when the master has set one (Alert rules). The days of grace are weekdays (a
 * Saturday or Sunday inside them does not count); rent not received in full within them gets a fee
 * the day after the last: a fixed amount or a share of that rent. Each day after it, weekends too,
 * to the end of the month the rent fell due in, `daily` more is added while the rent is still not
 * paid in full, at most `cap` a month for that part. Each month's rent has its own. The fee is one row on the schedule,
 * due the day it went on, whose amount grows. Only rent falling due since the rule was switched on
 * is charged, so old arrears are not all fined at once. A fee put on because a payment was written
 * down late, when the money had come in time, comes off again.
 */
export async function applyLateFees(today) {
  const row = await db.prepare("SELECT value FROM lease_settings WHERE key = 'alerts'").get();
  const rule = row && JSON.parse(row.value).latefee;
  if (!rule?.on || !(rule.amount > 0 || rule.percent > 0)) return;
  const grace = Number(rule.days) || 0;
  const daily = Number(rule.daily) || 0;
  const cap = Number(rule.cap) > 0 ? Number(rule.cap) : Infinity;
  const T = dayNo(today);
  const rents = await db.prepare(`SELECT r.id, r.booking_id, to_char(r.due_date, 'YYYY-MM-DD') AS due, r.amount FROM lease_installments r JOIN lease_bookings b ON b.id = r.booking_id
    WHERE r.kind = 'rent' AND b.status = 'confirmed' AND NOT b.no_late_fees AND r.due_date >= ?::date AND r.due_date < ?::date`).all(rule.since || today, today);
  if (!rents.length) return;
  const pays = await db.prepare(`SELECT installment_id, to_char(received_on, 'YYYY-MM-DD') AS on_day, amount FROM lease_payments
    WHERE installment_id IN (${rents.map(() => '?').join(', ')}) ORDER BY received_on, id`).all(...rents.map((r) => r.id));
  const paid = '(SELECT coalesce(sum(p.amount), 0) FROM lease_payments p WHERE p.installment_id = lease_installments.id)';
  for (const r of rents) {
    // The day the rent was paid in full, if it has been.
    let sum = 0, full = null;
    for (const p of pays) if (p.installment_id === r.id && full == null && (sum += Number(p.amount)) >= Number(r.amount) - 0.004) full = dayNo(p.on_day);
    const feeDay = addWeekdays(dayNo(r.due), grace) + 1;
    const fee = await db.prepare("SELECT id FROM lease_installments WHERE booking_id = ? AND kind = 'late' AND label = ?").get(r.booking_id, r.due);
    if (full != null && full < feeDay) {
      // In time after all: the fee comes off, unless money was already taken against it.
      if (fee) await db.prepare('DELETE FROM lease_installments i WHERE i.id = ? AND NOT EXISTS (SELECT 1 FROM lease_payments p WHERE p.installment_id = i.id)').run(fee.id);
      continue;
    }
    if (T < feeDay) continue;
    // Each day after the fee went on, weekends too, to the month's end, while the rent was still owed.
    const monthEnd = dayNo(lastOfMonth(r.due));
    const upTo = Math.min(T, monthEnd, full != null ? full - 1 : Infinity);
    const extra = Math.min(cap, daily * Math.max(0, upTo - feeDay));
    const amount = money(Number(rule.amount || 0) + (Number(r.amount) * Number(rule.percent || 0)) / 100 + extra);
    if (!(amount > 0)) continue;
    if (fee) await db.prepare(`UPDATE lease_installments SET amount = GREATEST(?, ${paid}), due_date = ? WHERE id = ?`).run(amount, iso(feeDay), fee.id);
    else await db.prepare("INSERT INTO lease_installments (booking_id, kind, label, due_date, amount) VALUES (?, 'late', ?, ?, ?) ON CONFLICT DO NOTHING").run(r.booking_id, r.due, iso(feeDay), amount);
  }
}

/** A booking's schedule: each payment due, what has come in against it, and where it stands. */
export async function bookingPayments(bookingId, today = todayHere()) {
  await backfillSchedules();
  await applyLateFees(today);
  const b = await getBooking(bookingId);
  const rows = await db.prepare(`SELECT id, kind, label, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount, tax, held FROM lease_installments WHERE booking_id = ?
    ORDER BY due_date, (kind = 'rent'), kind, label`).all(b.id);
  const pays = await db.prepare(`SELECT p.id, p.installment_id, p.amount, p.method, p.reference, p.notes, p.batch, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, w.name AS recorded_by,
      (p.file_path IS NOT NULL) AS has_file, p.file_name
    FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id LEFT JOIN users w ON w.id = p.recorded_by
    WHERE i.booking_id = ? ORDER BY p.received_on, p.id`).all(b.id);
  return rows.map((i) => {
    const payments = pays.filter((p) => p.installment_id === i.id).map((p) => ({ ...p, amount: Number(p.amount), receipt_no: receiptNo(p) }));
    const amount = Number(i.amount);
    const paid = total(payments);
    const status = paid >= amount ? 'paid' : i.due_date < today ? 'overdue' : paid > 0 ? 'partly_paid' : i.due_date === today ? 'due' : 'upcoming';
    return { ...i, name: dueName(i), amount, tax: Number(i.tax), paid, left: money(Math.max(0, amount - paid)), status, payments };
  });
}

export const receiptNo = (p) => `RC-${p.received_on.slice(0, 4)}-${String(p.id).padStart(5, '0')}`;

/** Money received against one payment due, inside the caller's transaction. `file` is its proof (the slip), if there is one. */
export async function takePayment(installmentId, body = {}, by, today = todayHere(), file = null, { batch = null, whole = false } = {}) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw bad('Enter the amount received.');
  if (!METHODS.some(([k]) => k === body.method)) throw bad('Choose how it was paid: bank transfer, cash, card, money order or online card.');
  const received_on = String(body.received_on ?? '').trim() || today;
  if (!isDate(received_on)) throw bad('The date received is not a date.');
  if (received_on > today) throw bad('The date received cannot be in the future.');
  const i = await db.prepare('SELECT id, booking_id, kind, label, amount FROM lease_installments WHERE id = ? FOR UPDATE').get(Number(installmentId));
  if (!i) throw bad('Not found', 404);
  const ticks = await db.prepare('SELECT no_payments, no_partial_payments FROM lease_bookings WHERE id = ?').get(i.booking_id);
  if (ticks.no_payments) throw bad(NO_PAYMENTS, 409);
  const { paid } = await db.prepare('SELECT coalesce(sum(amount), 0) AS paid FROM lease_payments WHERE installment_id = ?').get(i.id);
  const left = money(Number(i.amount) - Number(paid));
  // A credit row owes nothing: it holds money paid beyond what the lease charges.
  if (i.kind !== 'credit' && amount > left) throw bad(left > 0 ? `Only ${cash(left)} is still owed on this one.` : 'This one is already paid in full.', 409);
  // Paid against this one row only (not spread by payBooking, which checks the whole for itself).
  if (whole && ticks.no_partial_payments && money(amount) < left) throw bad(`This lease takes payments in full only: ${cash(left)} is owed on this one.`, 409);
  const row = { installment_id: i.id, amount: money(amount), method: body.method, received_on, reference: text(body.reference), notes: text(body.notes, 2000), recorded_by: by ?? null, batch, ...saveFile(file, DOC_DIR) };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_payments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
  await logEvent(i.booking_id, 'payment', `${cash(amount)} · ${dueName(i)} · ${METHODS.find(([k]) => k === body.method)[1]}`, by);
  return { id, installment_id: i.id, amount: money(amount), method: body.method, received_on };
}

/** The slip's amount, as read off it, is the most that can be recorded with it. A slip that cannot be read limits nothing.
    Read before the transaction opens, so a slow reading holds no lock. */
async function withinSlip(amount, file) {
  if (!file) return;
  const { amount: most } = await readSlip(file);
  if (most && money(Number(amount)) > most) throw bad(`The slip shows ${cash(most)}. A payment recorded with it cannot be more than that.`, 409);
}

/** Money received against one payment due. It can be part of it, never more than is still owed, nor than its slip shows. */
export const recordPayment = async (installmentId, body, by, today, file) => {
  await withinSlip(body?.amount, file);
  return tx(() => takePayment(installmentId, body, by, today, file, { whole: true }));
};

const NO_PAYMENTS = 'This lease is marked not to take payments (Don\'t accept payments). Untick it on the lease first.';

/**
 * Where money for the booking as a whole goes, in order: of what has fallen due by the day it came in,
 * the extra charges (deposit, fees, water…) oldest first, then the rent oldest first; after that what
 * is not due yet, by date, a day's charges before its rent. Each row with the `part` it takes and what
 * is left on it `after`; `extra` is what is more than the lease owes.
 */
export async function paymentPlan(bookingId, body = {}, today = todayHere()) {
  const b = await getBooking(bookingId);
  const on = String(body.received_on ?? '').trim() || today;
  const rent = (r) => (r.kind === 'rent' ? 1 : 0);
  const step = (r) => (r.due_date <= on ? rent(r) : 2);
  const open = (await bookingPayments(b.id, today)).filter((r) => r.left > 0)
    .sort((x, y) => step(x) - step(y) || x.due_date.localeCompare(y.due_date) || rent(x) - rent(y));
  let left = money(Number(body.amount) || 0);
  const rows = [];
  for (const r of open) {
    if (left <= 0) break;
    const part = Math.min(left, r.left);
    rows.push({ id: r.id, kind: r.kind, name: r.name, due_date: r.due_date, status: r.status, part, after: money(r.left - part) });
    left = money(left - part);
  }
  return { on, rows, owed: total(open, (r) => r.left), extra: Math.max(0, left), open };
}

/**
 * Money received for the booking as a whole (two months paid together, say): it goes as paymentPlan
 * lays out, over as many rows as it covers, each with its own receipt.
 * Never more than the booking still owes. The slip, if there is one, goes with the first.
 * The rows it was spread over share a `batch`, so the transactions list shows it as the one payment it was.
 * A lease ticked "Don't accept partial payments" takes nothing less than what is due by the day it was received.
 * With `keep_credit`, what is more than the lease owes is kept on it as a credit (a minus balance), as
 * Rent Manager carries money paid ahead on the account; otherwise more than is owed is refused.
 */
export const payBooking = async (bookingId, body = {}, by, today = todayHere(), file = null) => {
  await withinSlip(body.amount, file);
  return spreadPayment(bookingId, body, by, today, file);
};

const spreadPayment = (bookingId, body, by, today, file) => tx(async () => {
  const b = await getBooking(bookingId);
  if (b.no_payments) throw bad(NO_PAYMENTS, 409);
  const amount = money(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw bad('Enter the amount received.');
  const { on, rows, owed, extra: left, open } = await paymentPlan(b.id, body, today);
  const keep = isTrue(body.keep_credit);
  if (amount > owed && !keep) throw bad(owed > 0 ? `Only ${cash(owed)} is still owed on this lease.` : 'Nothing is owed on this lease.', 409);
  if (b.no_partial_payments) {
    const due = total(open.filter((r) => r.due_date <= on), (r) => r.left);
    if (amount < due) throw bad(`This lease takes payments in full only: ${cash(due)} is due by ${on}.`, 409);
  }
  const batch = randomUUID();
  const made = [];
  for (const r of rows) made.push(await takePayment(r.id, { ...body, amount: r.part }, by, today, made.length ? null : file, { batch }));
  if (left > 0) {
    const c = (await db.prepare("SELECT id FROM lease_installments WHERE booking_id = ? AND kind = 'credit' AND due_date = ?").get(b.id, on))
      ?? (await db.prepare("INSERT INTO lease_installments (booking_id, kind, label, due_date, amount) VALUES (?, 'credit', 'Credit', ?, 0) RETURNING id").get(b.id, on));
    made.push(await takePayment(c.id, { ...body, amount: left }, by, today, made.length ? null : file, { batch }));
  }
  return made;
});

// ---------- charges added by hand, and the transactions list ----------

/**
 * A charge on a date of its own, added to a confirmed lease at any time: a mailbox key deposit,
 * a court cost, a late charge from before the lease was entered here. Owed like the rent, and
 * left alone when the schedule is rebuilt. No tax: it is charged as typed.
 */
export const addCharge = (bookingId, body = {}, by) => tx(async () => {
  const b = await getBooking(bookingId);
  if (b.status !== 'confirmed') throw bad('Charges are added to a confirmed lease.', 409);
  const label = text(body.label, 60);
  if (!label) throw bad('Give the charge a name.');
  const due = String(body.due_date ?? '').trim();
  if (!isDate(due)) throw bad('Choose the date of the charge.');
  const amount = Number(body.amount);
  if (!(amount > 0)) throw bad('The charge needs an amount above zero.');
  // Held with the deposit: counted in what is held, as Rent Manager counts a deposit-type charge (GSL 103's pet fee).
  const held = isTrue(body.held);
  const made = await db.prepare(`INSERT INTO lease_installments (booking_id, kind, label, due_date, amount, held) VALUES (?, 'charge', ?, ?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING id`).get(b.id, label, due, money(amount), held);
  if (!made) throw bad(`This lease already has a ${label} on ${due}.`, 409);
  await logEvent(b.id, 'charge', `${label} · ${cash(amount)} on ${due}${held ? ' · held with the deposit' : ''}`, by);
  return { id: made.id, label, due_date: due, amount: money(amount), held };
});

/** Take off a charge added by hand, while nothing has been paid against it. */
export const removeCharge = (installmentId, by) => tx(async () => {
  const i = await db.prepare("SELECT id, booking_id, kind, label, amount, to_char(due_date, 'YYYY-MM-DD') AS due FROM lease_installments WHERE id = ? FOR UPDATE").get(Number(installmentId) || 0);
  if (!i) throw bad('Not found', 404);
  if (i.kind !== 'charge') throw bad('Only a charge added by hand can be taken off.', 409);
  if (await db.prepare('SELECT 1 FROM lease_payments WHERE installment_id = ? LIMIT 1').get(i.id)) throw bad('A payment is recorded against this charge. Delete the payment first.', 409);
  await db.prepare('DELETE FROM lease_installments WHERE id = ?').run(i.id);
  await logEvent(i.booking_id, 'charge_removed', `${i.label} · ${cash(Number(i.amount))} on ${i.due}`, by);
  return { ok: true };
});

/**
 * The lease's transactions, as Rent Manager's Transactions tab lists them: each charge on the day
 * it falls due (up to `today`), each payment on the day it was received, with the balance after
 * each line. An amount spread over several charges is one line. `balance` is what is owed today.
 */
export async function ledger(bookingId, today = todayHere()) {
  const rows = await bookingPayments(bookingId, today);
  const charges = rows.map((r, n) => ({ date: r.due_date, kind: 'charge', description: r.name, amount: r.amount, order: n }))
    .filter((r) => r.date <= today && r.amount > 0);
  const paid = new Map();
  for (const p of rows.flatMap((r) => r.payments)) {
    const key = p.batch || `p${p.id}`;
    const at = paid.get(key);
    if (at) at.amount = money(at.amount + p.amount);
    else paid.set(key, { date: p.received_on, kind: 'payment', amount: p.amount, method: p.method, reference: p.reference, order: p.id });
  }
  const payments = [...paid.values()].map((p) => ({
    date: p.date, kind: 'payment', order: p.order, method: p.method, reference: p.reference, amount: -p.amount,
    description: ['Payment', METHODS.find(([k]) => k === p.method)?.[1], p.reference].filter(Boolean).join(' · '),
  }));
  // Charges first on a day, then payments; each in the order it was made.
  const all = [...charges, ...payments].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.order - b.order : a.kind === 'charge' ? -1 : 1));
  let balance = 0;
  const out = all.map(({ order, ...r }) => { balance = money(balance + r.amount); return { ...r, balance }; });
  return { rows: out, balance };
}

const getPayment = async (id) => {
  const p = await db.prepare(`SELECT p.id, p.amount, p.batch, p.file_path, p.file_name, p.file_mime, i.booking_id, i.kind FROM lease_payments p
    JOIN lease_installments i ON i.id = p.installment_id WHERE p.id = ?`).get(Number(id) || 0);
  if (!p) throw bad('Not found', 404);
  return p;
};

/** Attach the proof of a payment (the slip), or replace the one it has. */
export async function attachPaymentFile(id, file, by) {
  if (!file) throw bad('Choose a file to attach.');
  const p = await getPayment(id);
  // Money spread over several rows was one payment: the slip covers all of it.
  const { paid } = p.batch ? await db.prepare('SELECT sum(amount) AS paid FROM lease_payments WHERE batch = ?').get(p.batch) : { paid: p.amount };
  await withinSlip(paid, file);
  const f = saveFile(file, DOC_DIR);
  await db.prepare('UPDATE lease_payments SET file_path = ?, file_name = ?, file_mime = ? WHERE id = ?').run(f.file_path, f.file_name, f.file_mime, p.id);
  if (p.file_path) rmSync(p.file_path, { force: true });
  await logEvent(p.booking_id, 'document', `Payment slip · ${f.file_name}`, by);
  return { id: p.id, has_file: true, file_name: f.file_name };
}

export async function removePayment(id, by) {
  const p = await getPayment(id);
  // A deposit given back has to have come in: without the payment the books would show money returned that was never received.
  if (p.kind === 'deposit') {
    // Passed on at a renewal, it is given back from the booking that holds it now.
    let holder = await getBooking(p.booking_id);
    while (holder.deposit_passed_to) holder = await getBooking(holder.deposit_passed_to);
    const d = await depositState(holder.id);
    if (d.refunded != null && money(d.held - Number(p.amount)) < d.refunded) throw bad(`${cash(d.refunded)} of this deposit has already been given back. Change what was given back first.`, 409);
  }
  await db.prepare('DELETE FROM lease_payments WHERE id = ?').run(p.id);
  if (p.file_path) rmSync(p.file_path, { force: true });
  await logEvent(p.booking_id, 'payment_deleted', cash(p.amount), by);
  return { ok: true };
}

// ---------- security deposit ----------

/** What has been received as deposit on this booking itself, with what was paid on charges held with it. */
const depositPaid = async (id) => Number((await db.prepare(`SELECT coalesce(sum(p.amount), 0) AS n FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id
  WHERE i.booking_id = ? AND (i.kind = 'deposit' OR i.held)`).get(id)).n);
/** The charges held with the deposit, in full. */
const heldCharges = async (id) => Number((await db.prepare('SELECT coalesce(sum(amount), 0) AS n FROM lease_installments WHERE booking_id = ? AND held').get(id)).n);
/** The earlier bookings whose deposit was passed on to this one, each with what it brought: its own, and any passed on to it in turn. */
async function carriedTo(id) {
  const out = [];
  for (const f of await db.prepare(`${BOOKING_SELECT} WHERE b.deposit_passed_to = ? ORDER BY b.id`).all(id)) {
    out.push({ id: f.id, ref: bookingRef(f), on: f.deposit_passed_on, amount: money(await depositPaid(f.id) + total(await carriedTo(f.id))) });
  }
  return out;
}

/**
 * Where a booking's deposit stands: unpaid, held, passed on, or settled (refunded, partly
 * refunded or kept). At a renewal the deposit can be passed on to the new booking, which then
 * holds it and gives it back: `from` is what was carried over to this booking and from where,
 * `passed_to` the booking this one's went to. `can_pass` is the renewal it could go to, and
 * `waiting` the deposit still held on the booking this one renews.
 */
export async function depositState(bookingId) {
  const b = await getBooking(bookingId);
  const amount = money((Number(b.security_deposit) || 0) + await heldCharges(b.id));
  const from = await carriedTo(b.id);
  const held = money(await depositPaid(b.id) + total(from));
  const refunded = b.deposit_refunded == null ? null : Number(b.deposit_refunded);
  const to = b.deposit_passed_to ? await getBooking(b.deposit_passed_to) : null;
  // A deposit taken off the booking after it was received is still held, and still to give back.
  const status = to ? 'passed_on' : !amount && !held ? 'none' : refunded == null ? (held > 0 ? 'held' : 'unpaid') : refunded >= held ? 'refunded' : refunded > 0 ? 'partly_refunded' : 'kept';
  const out = { amount, held, refunded, note: b.deposit_note, settled_on: b.deposit_settled_on, status };
  if (from.length) out.from = from;
  if (to) out.passed_to = { id: to.id, ref: to.ref, on: b.deposit_passed_on };
  else if (held > 0 && refunded == null) {
    const next = await db.prepare(`${BOOKING_SELECT} WHERE b.renewed_from = ? AND b.status <> 'cancelled' AND b.deposit_refunded IS NULL ORDER BY b.id DESC LIMIT 1`).get(b.id);
    if (next) out.can_pass = { id: next.id, ref: bookingRef(next) };
  }
  if (b.renewed_from && b.deposit_refunded == null && !from.some((f) => f.id === b.renewed_from)) {
    const prior = await db.prepare(`${BOOKING_SELECT} WHERE b.id = ? AND b.deposit_refunded IS NULL AND b.deposit_passed_to IS NULL`).get(b.renewed_from);
    const theirs = prior ? money(await depositPaid(prior.id) + total(await carriedTo(prior.id))) : 0;
    if (theirs > 0) out.waiting = { id: prior.id, ref: bookingRef(prior), amount: theirs };
  }
  return out;
}

/** At a renewal: the deposit held on this booking goes to the booking that renews it, which gives it back at its own check-out. No money moves. */
export const passDeposit = (bookingId, by, today = todayHere()) => tx(async () => {
  const d = await depositState(bookingId);
  if (d.passed_to) throw bad(`This deposit was already passed on to ${d.passed_to.ref}.`, 409);
  if (!d.held) throw bad('No deposit has been received on this lease.', 409);
  if (d.refunded != null) throw bad('This deposit has already been given back.', 409);
  if (!d.can_pass) throw bad('This lease has no renewal to pass the deposit on to. Renew it first.', 409);
  const b = await getBooking(bookingId);
  await db.prepare('UPDATE lease_bookings SET deposit_passed_to = ?, deposit_passed_on = ? WHERE id = ?').run(d.can_pass.id, today, b.id);
  await logEvent(b.id, 'deposit_passed', `${cash(d.held)} passed on to ${d.can_pass.ref}`, by);
  await logEvent(d.can_pass.id, 'deposit_carried', `${cash(d.held)} carried over from ${b.ref}`, by);
  return depositState(b.id);
});

/** Undo passing it on, as long as the booking it went to has not given it back or passed it on again. */
export const takeBackDeposit = (bookingId, by) => tx(async () => {
  const b = await getBooking(bookingId);
  if (!b.deposit_passed_to) throw bad('This deposit was not passed on.', 409);
  const next = await getBooking(b.deposit_passed_to);
  if (next.deposit_refunded != null) throw bad(`This deposit has already been given back from ${next.ref}.`, 409);
  if (next.deposit_passed_to) throw bad(`${next.ref} has passed it on again. Undo that first.`, 409);
  await db.prepare('UPDATE lease_bookings SET deposit_passed_to = NULL, deposit_passed_on = NULL WHERE id = ?').run(b.id);
  await logEvent(b.id, 'deposit_back', `Passing on to ${next.ref} undone`, by);
  await logEvent(next.id, 'deposit_back', `Deposit returned to ${b.ref}: passing on undone`, by);
  return depositState(b.id);
});

/** At check-out: how much of the deposit went back, and why the rest was kept. */
export async function settleDeposit(bookingId, body = {}, by, today = todayHere()) {
  const d = await depositState(bookingId);
  if (d.passed_to) throw bad(`This deposit was passed on to ${d.passed_to.ref}. Give it back from that lease.`, 409);
  if (!d.held) throw bad('No deposit has been received on this lease.', 409);
  const refunded = Number(body.refunded);
  if (!Number.isFinite(refunded) || refunded < 0 || refunded > d.held) throw bad(`The refund is between 0 and ${cash(d.held)}.`);
  const note = text(body.note, 1000);
  if (refunded < d.held && !note) throw bad('Say what was deducted, and why.');
  await db.prepare('UPDATE lease_bookings SET deposit_refunded = ?, deposit_note = ?, deposit_settled_on = ? WHERE id = ?').run(money(refunded), note, today, Number(bookingId));
  await logEvent(bookingId, 'deposit', `${cash(refunded)} refunded of ${cash(d.held)}${note ? ` · ${note}` : ''}`, by);
  return depositState(bookingId);
}

// ---------- extra services ----------
//
// The list a booking's other charges are picked from: pet fee, parking, cleaning, anything.
// Each building has its own list, with its own prices. A booking keeps its own copy of the name and the price, so changing or removing a service
// here never touches a booking.

function serviceFields(body = {}, { partial = false } = {}) {
  const out = {};
  if ('name' in body) out.name = text(body.name, 60);
  if ((!partial || 'name' in out) && !out.name) throw bad('Give the service a name.');
  if ('amount' in body) {
    const v = body.amount;
    if (v !== '' && v != null && !(Number(v) > 0)) throw bad('The price must be a number above zero.');
    out.amount = v === '' || v == null ? null : money(Number(v));
  }
  if ('repeats' in body) out.repeats = isTrue(body.repeats);
  if ('building_id' in body) out.building_id = Number(body.building_id) || null;
  return out;
}

const serviceRow = (s) => ({ ...s, amount: s.amount == null ? null : Number(s.amount) });
const taken = (e) => (e.code === '23505' ? bad('This building already has a service with that name.', 409) : e.code === '23503' ? bad('Building not found', 404) : e);

/** The saved services, by name. `amount` is the usual price (null: none yet); one that `repeats` is charged every month. */
export const listServices = async (buildingId) => (await db.prepare('SELECT id, name, amount, repeats, building_id FROM lease_services ORDER BY lower(name)').all())
  .filter((s) => !buildingId || s.building_id == null || s.building_id === Number(buildingId)).map(serviceRow);

const getService = async (id) => {
  const s = await db.prepare('SELECT id, name, amount, repeats, building_id FROM lease_services WHERE id = ?').get(Number(id) || 0);
  if (!s) throw bad('Service not found', 404);
  return serviceRow(s);
};

export async function addService(body, by) {
  const row = { ...serviceFields(body), created_by: by ?? null };
  const cols = Object.keys(row);
  try {
    const { id } = await db.prepare(`INSERT INTO lease_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
    return getService(id);
  } catch (e) { throw taken(e); }
}

export async function updateService(id, body) {
  const row = serviceFields(body, { partial: true });
  const cols = Object.keys(row);
  try {
    if (cols.length) await db.prepare(`UPDATE lease_services SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), Number(id) || 0);
  } catch (e) { throw taken(e); }
  return getService(id);
}

export async function removeService(id) {
  const r = await db.prepare('DELETE FROM lease_services WHERE id = ?').run(Number(id) || 0);
  if (!r.changes) throw bad('Service not found', 404);
  return { ok: true };
}

/** A service added while making a booking has no usual price yet: the first booking to charge it sets one. */
async function learnPrices(fees, buildingId) {
  for (const f of fees) {
    await db.prepare('UPDATE lease_services SET amount = ?, repeats = ? WHERE lower(name) = lower(?) AND amount IS NULL AND (building_id = ? OR building_id IS NULL)').run(f.amount, !!f.repeats, f.label, buildingId);
  }
}

// ---------- sources ----------
//
// Where tenants come from: a walk-in, a referral, a listing site. One list for the whole app,
// picked from on the booking form and kept on its own page. A booking keeps the name itself,
// so removing a source here never touches a booking; renaming one renames it on the bookings
// that have it.

const sourceName = (body = {}) => {
  const name = text(body.name, 60);
  if (!name) throw bad('Give the source a name.');
  return name;
};
const sourceTaken = (e) => (e.code === '23505' ? bad('There is already a source with that name.', 409) : e);

export const listSources = () => db.prepare('SELECT id, name FROM lease_sources ORDER BY lower(name)').all();

export async function addSource(body, by) {
  try {
    return await db.prepare('INSERT INTO lease_sources (name, created_by) VALUES (?, ?) RETURNING id, name').get(sourceName(body), by ?? null);
  } catch (e) { throw sourceTaken(e); }
}

export async function renameSource(id, body) {
  const name = sourceName(body);
  return tx(async () => {
    const old = await db.prepare('SELECT id, name FROM lease_sources WHERE id = ?').get(Number(id) || 0);
    if (!old) throw bad('Source not found', 404);
    try { await db.prepare('UPDATE lease_sources SET name = ? WHERE id = ?').run(name, old.id); } catch (e) { throw sourceTaken(e); }
    await db.prepare('UPDATE lease_bookings SET source = ? WHERE lower(source) = lower(?)').run(name, old.name);
    return { id: old.id, name };
  });
}

export async function removeSource(id) {
  const r = await db.prepare('DELETE FROM lease_sources WHERE id = ?').run(Number(id) || 0);
  if (!r.changes) throw bad('Source not found', 404);
  return { ok: true };
}

// ---------- renewal ----------

/**
 * Renew a confirmed booking: a draft of the same unit, tenant and rent, starting the day
 * after this one ends and running as long. It is a draft so the new rent and dates can be
 * agreed first; the deposit is already held, so it is not asked for again, and of the other
 * charges only those that repeat (a pet fee, parking) carry on. The tax carries on, and so
 * does where the tenant came from; a discount does not, being something agreed for one stay.
 */
export async function renewBooking(id, by) {
  const b = await getBooking(id);
  if (b.status !== 'confirmed') throw bad('Only a confirmed lease can be renewed.', 409);
  const again = await db.prepare("SELECT id FROM lease_bookings WHERE renewed_from = ? AND status <> 'cancelled'").get(b.id);
  if (again) throw bad(`This lease already has a renewal (${bookingRef(await getBooking(again.id))}).`, 409);
  const start = iso(dayNo(b.end_date) + 1);
  const end = iso(dayNo(addMonths(start, monthsOf(b))) - 1);
  const { id: nextId } = await db.prepare(`INSERT INTO lease_bookings (unit_id, tenant_id, type, start_date, end_date, rent_amount, rent_period, payment_frequency, prorate, fees, tax_percent, source, referred_by, status, renewed_from, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`).run(b.unit_id, b.tenant_id, b.type, start, end, b.rent_amount, b.rent_period, b.payment_frequency, b.prorate,
    // A monthly charge that has already stopped stays behind; one still running carries on from the new start.
    JSON.stringify(b.fees.filter((f) => f.repeats && !(f.until && f.until < start)).map(({ from, ...f }) => f)), b.tax_percent, b.source, b.referred_by, b.id, by ?? null);
  const next = await getBooking(nextId);
  await logEvent(b.id, 'renewed', `Renewal ${next.ref} drafted for ${start} to ${end}`, by);
  await logEvent(next.id, 'created', `Renewal of ${b.ref}, saved as a draft`, by);
  return next;
}

// ---------- the books: what the overview, the reports and the alerts all read ----------

/**
 * Everything about one company, one building, or all of them, as it stands on `today`:
 * each unit and who is in it, every payment due with what has come in against it, and who
 * is behind. Nothing here is stored; it is worked out from the bookings and the payments.
 */
export async function snapshot({ company_id, building_id } = {}, today = todayHere()) {
  await backfillSchedules();
  await applyLateFees(today);
  const every = await db.prepare(`SELECT bl.id, bl.name, bl.area, bl.city, bl.emirate, c.id AS company_id, c.name AS company
    FROM prop_buildings bl JOIN prop_companies c ON c.id = bl.company_id ORDER BY c.name, bl.name`).all();
  const list = every.filter((b) => (!company_id || b.company_id === Number(company_id)) && (!building_id || b.id === Number(building_id)));
  const buildingOf = new Map(list.map((b) => [b.id, b]));
  const units = (await db.prepare(`SELECT id, building_id, unit_no, floor, type, blocked FROM prop_units
    ORDER BY NULLIF(regexp_replace(floor, '\\D', '', 'g'), '')::int NULLS FIRST, floor,
      NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all()).filter((u) => buildingOf.has(u.building_id));
  const unitOf = new Map(units.map((u) => [u.id, u]));
  const bookings = (await db.prepare(`SELECT b.id, b.unit_id, b.tenant_id, b.status, b.type, b.rent_amount, b.rent_period, b.payment_frequency, b.contract_no, b.discount_type, b.discount_value,
      b.created_at, b.created_by, to_char(b.start_date, 'YYYY-MM-DD') AS start_date, to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
      b.deposit_refunded, b.deposit_note, to_char(b.deposit_settled_on, 'YYYY-MM-DD') AS deposit_settled_on,
      t.full_name AS tenant, t.email AS tenant_email, t.phone AS tenant_phone, w.name AS added_by,
      (b.contract_no IS NOT NULL OR EXISTS (SELECT 1 FROM lease_documents d WHERE d.booking_id = b.id AND d.title ILIKE '%contract%' AND NOT d.generated)) AS has_contract
    FROM lease_bookings b JOIN lease_tenants t ON t.id = b.tenant_id LEFT JOIN users w ON w.id = b.created_by
    ORDER BY b.start_date, b.id`).all()).filter((b) => unitOf.has(b.unit_id));
  const bookingOf = new Map(bookings.map((b) => [b.id, b]));
  const confirmed = bookings.filter((b) => b.status === 'confirmed');
  const place = (u) => { const bl = buildingOf.get(u.building_id); return { unit_no: u.unit_no, building: bl.name, building_id: bl.id, company: bl.company }; };
  const where = (b) => ({ booking_id: b.id, tenant: b.tenant, ...place(unitOf.get(b.unit_id)) });
  const letOn = (u, d) => confirmed.find((b) => b.unit_id === u.id && b.start_date <= d && b.end_date >= d);
  const T = dayNo(today);

  // Every payment due, with what has come in against it. A cancelled booking still owes what
  // had fallen due by the day it was cancelled; cancelBooking took the rest off its schedule.
  const pays = (await db.prepare(`SELECT p.id, p.installment_id, i.booking_id, i.kind, i.label, i.amount AS due_amount, i.tax AS due_tax, p.amount, p.method, p.reference, p.created_at, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, w.name AS added_by
    FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id LEFT JOIN users w ON w.id = p.recorded_by
    ORDER BY p.received_on, p.id`).all())
    // `tax`: the part of each payment that is tax, the same share of it as of the row it pays.
    .filter((p) => bookingOf.has(p.booking_id)).map(({ due_amount, due_tax, ...p }) => ({ ...p, amount: Number(p.amount), tax: Number(due_tax) > 0 ? money((Number(p.amount) * Number(due_tax)) / Number(due_amount)) : 0 }));
  const paysOf = new Map();
  for (const p of pays) paysOf.set(p.installment_id, [...(paysOf.get(p.installment_id) || []), p]);
  const dues = (await db.prepare("SELECT id, booking_id, kind, label, to_char(due_date, 'YYYY-MM-DD') AS due, amount FROM lease_installments ORDER BY due_date, id").all())
    .filter((i) => bookingOf.has(i.booking_id)).map((i) => {
      const b = bookingOf.get(i.booking_id);
      const payments = paysOf.get(i.id) || [];
      const paid = total(payments);
      const amount = Number(i.amount);
      return { ...where(b), id: i.id, kind: i.kind, name: dueName(i), due: i.due, amount, paid, left: money(Math.max(0, amount - paid)), payments };
    });

  // Who is behind: what each booking owes on payments whose day has passed, and since when.
  const late = new Map();
  for (const p of dues) {
    if (p.due >= today || !p.left) continue;
    const { id, kind, name, due, amount, paid, left, payments, ...who } = p;
    const o = late.get(p.booking_id) || late.set(p.booking_id, { ...who, owed: 0, days_overdue: 0 }).get(p.booking_id);
    o.owed = money(o.owed + left);
    o.days_overdue = Math.max(o.days_overdue, T - dayNo(due));
  }
  const overdue = [...late.values()].sort((a, b) => b.days_overdue - a.days_overdue);

  // Each unit as it stands today. Overdue wins over ending soon for its colour; both are let.
  const rows = units.map((u) => {
    const row = { unit_id: u.id, floor: u.floor, type: u.type, ...place(u) };
    const cur = letOn(u, today);
    if (u.blocked) return { ...row, status: 'blocked' };
    if (!cur) {
      const last = confirmed.filter((b) => b.unit_id === u.id && b.end_date < today).map((b) => b.end_date).sort().pop();
      return { ...row, status: 'vacant', days_vacant: last ? T - dayNo(last) : null, vacant_since: last ? iso(dayNo(last) + 1) : null };
    }
    const days_left = dayNo(cur.end_date) - T;
    const next = confirmed.find((b) => b.unit_id === u.id && b.start_date > cur.end_date);
    // What the tenant owes on this unit: this booking, and any earlier one of theirs here
    // (the one this was renewed from), so a renewal never turns an unpaid unit green.
    const debts = confirmed.filter((b) => b.unit_id === u.id && b.tenant_id === cur.tenant_id && late.has(b.id)).map((b) => late.get(b.id));
    const owes = debts.length ? { owed: total(debts, (d) => d.owed), days_overdue: Math.max(...debts.map((d) => d.days_overdue)) } : null;
    return { ...row, booking_id: cur.id, tenant: cur.tenant, rent: monthlyRent(cur), days_left,
      renewal: !next ? 'Not renewed' : next.tenant_id === cur.tenant_id ? 'Renewed' : 'Let again',
      ...(owes ? { status: 'overdue', owed: owes.owed, days_overdue: owes.days_overdue } : { status: days_left <= ENDING ? 'ending' : 'occupied' }) };
  });

  // Deposits given back: money that went out, which the reports show beside what came in.
  const refunds = bookings.filter((b) => Number(b.deposit_refunded) > 0 && b.deposit_settled_on)
    .map((b) => ({ ...where(b), on: b.deposit_settled_on, amount: Number(b.deposit_refunded), note: b.deposit_note }));
  // Who looks after each building, for the alerts.
  const staffOf = new Map();
  for (const r of await db.prepare('SELECT building_id, user_id FROM prop_building_staff').all()) staffOf.set(r.building_id, [...(staffOf.get(r.building_id) || []), r.user_id]);

  return { today, T, every, list, units, rows, bookings, bookingOf, confirmed, pays, dues, overdue, refunds, staffOf, where, letOn };
}

// ---------- overview ----------

/**
 * The Leasing home screen for one company, one building, or everything: occupancy, rent
 * due against collected over the last twelve months, who is overdue, what is due this week
 * and which leases end soon.
 */
export async function overview({ company_id, building_id, months } = {}, today = todayHere()) {
  const span = [1, 3, 12].includes(Number(months)) ? Number(months) : 1;
  const { T, every, list, units, rows, bookings, bookingOf, confirmed, pays, dues, overdue, where, letOn } = await snapshot({ company_id, building_id }, today);
  const count = (s) => rows.filter((u) => u.status === s).length;
  const lettable = units.filter((u) => !u.blocked);
  const letCount = rows.filter((u) => u.tenant).length;

  // Twelve months ending this month: the rent falling due in each and how much of it has come in,
  // then how full the buildings were, and what was owed, at each month's end.
  const first = `${today.slice(0, 7)}-01`;
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(first, i - 11).slice(0, 7);
    const mine = dues.filter((p) => p.kind === 'rent' && p.due.startsWith(month));
    return { month, due: total(mine), collected: total(mine, (p) => p.paid), inPeriod: i >= 12 - span };
  });
  const period = new Set(monthly.filter((m) => m.inPeriod).map((m) => m.month));
  const received = dues.filter((p) => p.kind === 'rent' && period.has(p.due.slice(0, 7))).flatMap((p) => p.payments);
  const ends = Array.from({ length: 12 }, (_, i) => (i === 11 ? today : iso(dayNo(addMonths(first, i - 10)) - 1)));
  const letAt = ends.map((d) => lettable.filter((u) => letOn(u, d)).length);
  const owedAt = (d) => total(dues.filter((p) => p.due < d), (p) => Math.max(0, p.amount - total(p.payments.filter((x) => x.received_on <= d))));

  return {
    filters: {
      companies: [...new Map(every.map((b) => [b.company_id, b.company]))].map(([id, name]) => ({ id, name })),
      buildings: every.map((b) => ({ id: b.id, name: b.name, company_id: b.company_id })),
    },
    units: { total: units.length, let: letCount, occupied: count('occupied'), ending: count('ending'), overdue: count('overdue'), vacant: count('vacant'), blocked: count('blocked') },
    occupancy: lettable.length ? letCount / lettable.length : 0,
    collection: { due: total(monthly.filter((m) => m.inPeriod), (m) => m.due), collected: total(monthly.filter((m) => m.inPeriod), (m) => m.collected) },
    monthly,
    overdue: {
      total: total(overdue, (o) => o.owed), rows: overdue,
      // Each unpaid amount by its own age, as the "Overdue by age" report has it.
      aging: AGING.map(([label, from, to]) => {
        const band = dues.filter((p) => p.left && p.due < today && T - dayNo(p.due) >= from && T - dayNo(p.due) <= to);
        return { label, amount: total(band, (p) => p.left), count: new Set(band.map((p) => p.booking_id)).size };
      }),
    },
    methods: METHODS.map(([key, label]) => ({ key, label, amount: total(received.filter((p) => p.method === key)) })),
    dueSoon: dues.filter((p) => p.left > 0).map(({ payments, ...p }) => ({ ...p, rent: p.left, date: p.due, due_in: dayNo(p.due) - T }))
      .filter((p) => p.due_in >= 0 && p.due_in <= 6).sort((a, b) => a.due_in - b.due_in),
    ending: rows.filter((u) => u.days_left <= ENDING).sort((a, b) => a.days_left - b.days_left),
    missingContracts: confirmed.filter((b) => b.end_date >= today && !b.has_contract).length,
    buildings: list.map((b) => {
      const mine = rows.filter((u) => u.building_id === b.id);
      const open = mine.filter((u) => u.status !== 'blocked').length;
      const floors = [...new Set(mine.map((u) => u.floor))].reverse(); // top floor first
      return { id: b.id, name: b.name, area: [b.area, b.city, b.emirate].filter(Boolean).join(', '), company: b.company, total: mine.length,
        vacant: mine.filter((u) => u.status === 'vacant').length,
        occupancy: open ? mine.filter((u) => u.tenant).length / open : 0,
        floors: floors.map((f) => mine.filter((u) => u.floor === f)) };
    }),
    trends: { occupancy: letAt.map((n) => (lettable.length ? n / lettable.length : 0)), vacant: letAt.map((n) => lettable.length - n), overdue: ends.map(owedAt) },
    activity: [
      ...bookings.map((b) => ({ ...where(b), kind: b.status, by: b.added_by, at: Number(b.created_at) })),
      ...pays.map((p) => ({ ...where(bookingOf.get(p.booking_id)), kind: 'payment', amount: p.amount, by: p.added_by, at: Number(p.created_at) })),
    ].sort((a, b) => b.at - a.at).slice(0, 8),
  };
}

// ---------- routes (any signed-in user) ----------

export const leasingRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// A new booking comes as a form: its details as JSON in `booking`, beside the files it must have.
const bookingFiles = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: REQUIRED_DOCS.length } })
  .fields(REQUIRED_DOCS.map(([name]) => ({ name, maxCount: 1 })));
const sentBooking = (req) => {
  if (!req.is('multipart/form-data')) return req.body;
  try { return JSON.parse(req.body.booking); } catch { throw bad('The lease details did not arrive.'); }
};

// The form makes a draft: a lease is confirmed after its move-in inspection (server/inspections.js).
const asDraft = (b) => {
  if (b?.status === 'confirmed') throw bad('Save the lease as a draft, do the move-in inspection, then confirm it.', 409);
  return b;
};

leasingRoutes.get('/tenants', wrap(async (req, res) => res.json(await listTenants(req.query.q))));
leasingRoutes.post('/tenants', wrap(async (req, res) => res.json(await addTenant(req.body, req.user.id))));
leasingRoutes.put('/tenants/:id', wrap(async (req, res) => res.json(await updateTenant(req.params.id, req.body))));
leasingRoutes.delete('/tenants/:id', wrap(async (req, res) => res.json(await removeTenant(req.params.id))));

leasingRoutes.get('/services', wrap(async (req, res) => res.json(await listServices(req.query.building_id))));
leasingRoutes.post('/services', wrap(async (req, res) => res.json(await addService(req.body, req.user.id))));
leasingRoutes.put('/services/:id', wrap(async (req, res) => res.json(await updateService(req.params.id, req.body))));
leasingRoutes.delete('/services/:id', wrap(async (req, res) => res.json(await removeService(req.params.id))));

leasingRoutes.get('/sources', wrap(async (req, res) => res.json(await listSources())));
leasingRoutes.post('/sources', wrap(async (req, res) => res.json(await addSource(req.body, req.user.id))));
leasingRoutes.put('/sources/:id', wrap(async (req, res) => res.json(await renameSource(req.params.id, req.body))));
leasingRoutes.delete('/sources/:id', wrap(async (req, res) => res.json(await removeSource(req.params.id))));

leasingRoutes.get('/overview', wrap(async (req, res) => res.json(await overview(req.query))));
leasingRoutes.get('/available',wrap(async (req, res) => res.json(await availability(req.query.building_id, req.query.start, req.query.end))));
leasingRoutes.get('/bookings', wrap(async (req, res) => res.json(await listBookings(req.query))));
leasingRoutes.get('/bookings/:id', wrap(async (req, res) => res.json(await getBooking(req.params.id))));
// A new lease gets its contract (server/leaseContract.js) once it is saved; a change makes the one it has again.
const contract = (id, by, opts) => import('./leaseContract.js').then((m) => m.keepContract(id, by, opts));
const withContract = async (made, by) => { await contract(made.id, by); return getBooking(made.id); };
const keepsContract = async (now, by) => { await contract(now.id, by, { onlyIfKept: true }); return now; };

leasingRoutes.post('/bookings', bookingFiles, wrap(async (req, res) => res.json(await withContract(await createBookingWithDocs(asDraft(sentBooking(req)), req.files, req.user.id), req.user.id))));
leasingRoutes.put('/bookings/:id', wrap(async (req, res) => res.json(await keepsContract(await updateBooking(req.params.id, req.body, req.user.id), req.user.id))));
leasingRoutes.post('/bookings/:id/contract', wrap(async (req, res) => {
  const { fileContract } = await import('./leaseContract.js');
  await fileContract(req.params.id, req.user.id);
  res.json(await bookingDocs(req.params.id));
}));
leasingRoutes.post('/bookings/:id/confirm', wrap(async (req, res) => res.json(await confirmBooking(req.params.id, req.user.id))));
leasingRoutes.post('/bookings/:id/end', wrap(async (req, res) => res.json(await keepsContract(await changeEnd(req.params.id, req.body?.end_date, req.user.id), req.user.id))));
leasingRoutes.post('/bookings/:id/cancel', wrap(async (req, res) => res.json(await cancelBooking(req.params.id, req.body?.reason, req.user.id))));
leasingRoutes.delete('/bookings/:id', wrap(async (req, res) => res.json(await removeBooking(req.params.id))));

leasingRoutes.get('/bookings/:id/docs', wrap(async (req, res) => res.json(await bookingDocs(req.params.id))));
leasingRoutes.post('/bookings/:id/docs', upload.single('file'), wrap(async (req, res) => res.json(await addBookingDoc(req.params.id, req.body, req.file, req.user.id))));
leasingRoutes.post('/bookings/:id/renew', wrap(async (req, res) => res.json(await withContract(await renewBooking(req.params.id, req.user.id), req.user.id))));
leasingRoutes.get('/bookings/:id/history', wrap(async (req, res) => res.json(await bookingHistory(req.params.id))));
leasingRoutes.get('/bookings/:id/deposit', wrap(async (req, res) => res.json(await depositState(req.params.id))));
leasingRoutes.post('/bookings/:id/deposit', wrap(async (req, res) => res.json(await settleDeposit(req.params.id, req.body, req.user.id))));
leasingRoutes.post('/bookings/:id/deposit/pass', wrap(async (req, res) => res.json(await passDeposit(req.params.id, req.user.id))));
leasingRoutes.delete('/bookings/:id/deposit/pass', wrap(async (req, res) => res.json(await takeBackDeposit(req.params.id, req.user.id))));
leasingRoutes.get('/bookings/:id/payments', wrap(async (req, res) => res.json(await bookingPayments(req.params.id))));
leasingRoutes.get('/bookings/:id/payments/plan', wrap(async (req, res) => { const { open, ...plan } = await paymentPlan(req.params.id, req.query); res.json(plan); }));
leasingRoutes.post('/bookings/:id/payments', upload.single('file'), wrap(async (req, res) => res.json(await payBooking(req.params.id, req.body, req.user.id, undefined, req.file))));
leasingRoutes.get('/bookings/:id/ledger', wrap(async (req, res) => res.json(await ledger(req.params.id))));
leasingRoutes.post('/bookings/:id/charges', wrap(async (req, res) => res.json(await addCharge(req.params.id, req.body, req.user.id))));
leasingRoutes.delete('/charges/:id', wrap(async (req, res) => res.json(await removeCharge(req.params.id, req.user.id))));
leasingRoutes.post('/slips/read', upload.single('file'), wrap(async (req, res) => res.json(await readSlip(req.file))));
leasingRoutes.post('/installments/:id/payments', upload.single('file'), wrap(async (req, res) => res.json(await recordPayment(req.params.id, req.body, req.user.id, undefined, req.file))));
leasingRoutes.post('/payments/:id/file', upload.single('file'), wrap(async (req, res) => res.json(await attachPaymentFile(req.params.id, req.file, req.user.id))));
leasingRoutes.get('/payments/:id/file', wrap(async (req, res) => sendDoc(req, res, await getPayment(req.params.id))));
leasingRoutes.delete('/payments/:id', requireMaster, wrap(async (req, res) => res.json(await removePayment(req.params.id, req.user.id))));
leasingRoutes.delete('/docs/:id', wrap(async (req, res) => res.json(await removeBookingDoc(req.params.id, req.user.id))));
leasingRoutes.get('/docs/:id/file', wrap(async (req, res) => sendDoc(req, res, await getDoc(req.params.id))));
