import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile, sendDoc } from './properties.js';
import { bad, isDate, bookingRef, dayNo, money, todayHere, applyLateFees } from './leasing.js';
import { listWorkOrders, LIVE } from './workOrders.js';

// A tenant's history: what kind of tenant they have been. Three things in one list, newest
// first: rent that came in late, complaints made about them, and maintenance done for them.
//
// Late rent is never written down: it is worked out from the schedule and its payments each
// time, so it stays right when a payment is added, changed or deleted. A complaint is a plain
// record a person types in (lease_tenant_log), with any number of files (lease_tenant_log_files):
// it charges nothing and sends nothing. Maintenance is the tenant's work orders
// (server/workOrders.js), read here and changed there; a maintenance note older than work
// orders, with no lease to take a unit from, is still in the log and still shown.

const KINDS = new Set(['complaint']); // maintenance is a work order now
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;

const LOG_SELECT = `SELECT l.id, l.tenant_id, l.booking_id, l.kind AS type, l.category, l.detail, l.reported_by, l.resolution,
    to_char(l.happened_on, 'YYYY-MM-DD') AS date, to_char(l.resolved_on, 'YYYY-MM-DD') AS resolved_on, w.name AS logged_by,
    to_char(b.start_date, 'YYYY-MM-DD') AS start_date, u.unit_no, bl.name AS building
  FROM lease_tenant_log l
  LEFT JOIN users w ON w.id = l.created_by
  LEFT JOIN lease_bookings b ON b.id = l.booking_id
  LEFT JOIN prop_units u ON u.id = b.unit_id
  LEFT JOIN prop_buildings bl ON bl.id = u.building_id`;
const shape = ({ start_date, ...l }, files = []) => ({ ...l, ref: l.booking_id ? bookingRef({ id: l.booking_id, start_date }) : null,
  files: files.filter((f) => f.log_id === l.id).map(({ log_id, ...f }) => f) });
const FILE_DIR = `${DATA_DIR}/leasing`;
const FILE_COLS = 'f.id, f.log_id, f.file_name, f.file_mime';

const getLog = async (id) => {
  const l = await db.prepare(`${LOG_SELECT} WHERE l.id = ?`).get(Number(id));
  if (!l) throw bad('That entry was not found.', 404);
  return shape(l, await db.prepare(`SELECT ${FILE_COLS} FROM lease_tenant_log_files f WHERE f.log_id = ? ORDER BY f.id`).all(l.id));
};

const mustBeTenant = async (id) => {
  const t = await db.prepare('SELECT id, full_name, phone, email FROM lease_tenants WHERE id = ?').get(Number(id));
  if (!t) throw bad('Tenant not found', 404);
  return t;
};

/** The booking an entry belongs to: the one the tenant was in that day, else the last one begun before it. */
const bookingOn = async (tenantId, day) => (await db.prepare(`SELECT id FROM lease_bookings
  WHERE tenant_id = ? AND status <> 'draft' AND start_date <= ?::date
  ORDER BY (end_date >= ?::date) DESC, (status = 'confirmed') DESC, start_date DESC LIMIT 1`).get(tenantId, day, day))?.id ?? null;

function logFields(body = {}, today, { partial = false } = {}) {
  const out = {};
  if (!partial) {
    if (!KINDS.has(body.kind)) throw bad('An entry is a complaint. Maintenance is raised as a work order.');
    out.kind = body.kind;
  }
  if ('category' in body) out.category = text(body.category, 60);
  if ('reported_by' in body) out.reported_by = text(body.reported_by, 120);
  if ('resolution' in body) out.resolution = text(body.resolution, 500);
  if (!partial || 'detail' in body) {
    out.detail = text(body.detail, 2000);
    if (!out.detail) throw bad('Say what happened.');
  }
  if (!partial || 'happened_on' in body) {
    const v = String(body.happened_on ?? '').trim() || (partial ? '' : today);
    if (!isDate(v)) throw bad('The date is not a date.');
    if (v > today) throw bad('The date cannot be in the future.');
    out.happened_on = v;
  }
  if ('resolved' in body) out.resolved_on = body.resolved === true || body.resolved === 'true' ? today : null;
  return out;
}

export async function addLog(tenantId, body, by, today = todayHere()) {
  const t = await mustBeTenant(tenantId);
  const f = logFields(body, today);
  const row = { ...f, tenant_id: t.id, booking_id: await bookingOn(t.id, f.happened_on), created_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_tenant_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
  return getLog(id);
}

/** Change an entry's words or date, or mark it resolved (`resolved: true`, today) or open again. */
export async function updateLog(id, body, today = todayHere()) {
  const now = await getLog(id);
  const row = logFields(body, today, { partial: true });
  if (row.resolved_on && now.resolved_on) delete row.resolved_on; // already resolved: its day stays
  if (row.happened_on) row.booking_id = await bookingOn(now.tenant_id, row.happened_on);
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE lease_tenant_log SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), now.id);
  return getLog(id);
}

export async function removeLog(id) {
  const files = await db.prepare('SELECT file_path FROM lease_tenant_log_files WHERE log_id = ?').all(Number(id));
  const r = await db.prepare('DELETE FROM lease_tenant_log WHERE id = ?').run(Number(id));
  if (!r.changes) throw bad('That entry was not found.', 404);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

/** Attach files to an entry: as many as are sent, added to the ones it has. */
export async function addLogFiles(id, files, by) {
  const l = await getLog(id);
  if (!files?.length) throw bad('Choose a file to attach.');
  for (const file of files) {
    const f = saveFile(file, FILE_DIR);
    await db.prepare('INSERT INTO lease_tenant_log_files (log_id, file_path, file_name, file_mime, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(l.id, f.file_path, f.file_name, f.file_mime, by ?? null);
  }
  return getLog(id);
}

export const getLogFile = async (id) => {
  const f = await db.prepare('SELECT id, file_path, file_name, file_mime FROM lease_tenant_log_files WHERE id = ?').get(Number(id));
  if (!f) throw bad('Not found', 404);
  return f;
};

export async function removeLogFile(id) {
  const f = await getLogFile(id);
  await db.prepare('DELETE FROM lease_tenant_log_files WHERE id = ?').run(f.id);
  rmSync(f.file_path, { force: true });
  return { ok: true };
}

/**
 * Rent of this tenant's that was not all in by its due date: paid late (and on which day it
 * was all in), or still owed. A late fee charged for it comes with it.
 */
async function lateRent(tenantId, today) {
  await applyLateFees(today);
  const rents = await db.prepare(`SELECT i.id, i.booking_id, i.amount, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
      u.unit_no, bl.name AS building,
      (SELECT f.amount FROM lease_installments f WHERE f.booking_id = i.booking_id AND f.kind = 'late' AND f.label = to_char(i.due_date, 'YYYY-MM-DD') LIMIT 1) AS fee
    FROM lease_installments i
    JOIN lease_bookings b ON b.id = i.booking_id
    JOIN prop_units u ON u.id = b.unit_id
    JOIN prop_buildings bl ON bl.id = u.building_id
    WHERE b.tenant_id = ? AND b.status <> 'draft' AND i.kind = 'rent' AND i.amount > 0 AND i.due_date < ?::date`).all(tenantId, today);
  const pays = await db.prepare(`SELECT p.installment_id, p.amount, to_char(p.received_on, 'YYYY-MM-DD') AS received_on
    FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id JOIN lease_bookings b ON b.id = i.booking_id
    WHERE b.tenant_id = ? AND i.kind = 'rent' ORDER BY p.received_on, p.id`).all(tenantId);
  return rents.flatMap((r) => {
    const amount = Number(r.amount);
    let paid = 0;
    let paidOn = null;
    for (const p of pays.filter((x) => x.installment_id === r.id)) {
      paid = money(paid + Number(p.amount));
      if (!paidOn && paid >= amount) paidOn = p.received_on;
    }
    if (paidOn && paidOn <= r.due_date) return [];
    return [{ type: 'late', date: r.due_date, booking_id: r.booking_id, ref: bookingRef({ id: r.booking_id, start_date: r.start_date }), unit_no: r.unit_no, building: r.building,
      amount, paid_on: paidOn, days_late: dayNo(paidOn || today) - dayNo(r.due_date), left: money(Math.max(0, amount - paid)), fee: r.fee == null ? null : Number(r.fee) }];
  });
}

/** A work order as a line of the history. Once done, the day it was done is the day it was resolved. */
const asMaintenance = (w) => ({ type: 'maintenance', id: w.id, wo: w.ref, status: w.status, priority: w.priority, overdue: w.overdue, tenant_id: w.tenant_id, booking_id: w.booking_id,
  ref: w.lease_ref, unit_no: w.unit_no, building: w.building, date: w.reported_on, category: w.category, detail: w.detail, reported_by: w.reported_by, assigned_to: w.assigned_to,
  resolved_on: LIVE.includes(w.status) ? null : w.done_on, resolution: w.resolution, logged_by: w.raised_by, files: [] });

/** The unit a tenant has today, where a new work order of theirs would go. */
const unitToday = async (tenantId, today) => (await db.prepare(`SELECT b.unit_id, u.unit_no, bl.name AS building
  FROM lease_bookings b JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id
  WHERE b.tenant_id = ? AND b.status = 'confirmed' AND ?::date BETWEEN b.start_date AND b.end_date
  ORDER BY b.start_date DESC LIMIT 1`).get(tenantId, today)) || null;

/** One tenant's history: the figures at the top, then everything in one list, newest first. */
export async function tenantHistory(tenantId, today = todayHere()) {
  const tenant = await mustBeTenant(tenantId);
  const late = await lateRent(tenant.id, today);
  const files = await db.prepare(`SELECT ${FILE_COLS} FROM lease_tenant_log_files f JOIN lease_tenant_log l ON l.id = f.log_id WHERE l.tenant_id = ? ORDER BY f.id`).all(tenant.id);
  const log = (await db.prepare(`${LOG_SELECT} WHERE l.tenant_id = ?`).all(tenant.id)).map((l) => shape(l, files));
  // A cancelled work order was never maintenance done for them, so it is left out.
  const orders = (await listWorkOrders({ tenant_id: tenant.id }, today)).filter((w) => w.status !== 'cancelled').map(asMaintenance);
  const all = [...log, ...orders];
  const of = (type) => all.filter((l) => l.type === type);
  const open = (list) => list.filter((l) => !l.resolved_on && (!l.wo || LIVE.includes(l.status))).length;
  const ORDER = { maintenance: 0, complaint: 1, late: 2 };
  return {
    tenant,
    current: await unitToday(tenant.id, today),
    summary: {
      late: late.length, late_unpaid: late.filter((l) => !l.paid_on).length,
      late_days: late.length ? Math.round(late.reduce((t, l) => t + l.days_late, 0) / late.length) : 0, // on average
      late_fees: money(late.reduce((t, l) => t + (l.fee || 0), 0)),
      complaints: of('complaint').length, complaints_open: open(of('complaint')),
      maintenance: of('maintenance').length, maintenance_open: open(of('maintenance')),
    },
    items: [...late, ...all].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : ORDER[a.type] - ORDER[b.type] || (b.id || 0) - (a.id || 0))),
  };
}

export const historyRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_FILES = 10; // in one go; more can be added after
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES } });

historyRoutes.get('/tenants/:id/history', wrap(async (req, res) => res.json(await tenantHistory(req.params.id))));
historyRoutes.post('/tenants/:id/log', wrap(async (req, res) => res.json(await addLog(req.params.id, req.body, req.user.id))));
historyRoutes.put('/log/:id', wrap(async (req, res) => res.json(await updateLog(req.params.id, req.body))));
historyRoutes.delete('/log/:id', wrap(async (req, res) => res.json(await removeLog(req.params.id))));
historyRoutes.post('/log/:id/files', upload.array('files', MAX_FILES), wrap(async (req, res) => res.json(await addLogFiles(req.params.id, req.files, req.user.id))));
historyRoutes.get('/log/files/:id/file', wrap(async (req, res) => sendDoc(req, res, await getLogFile(req.params.id))));
historyRoutes.delete('/log/files/:id', wrap(async (req, res) => res.json(await removeLogFile(req.params.id))));
