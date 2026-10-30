import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile, sendDoc } from './properties.js';
import { bad, isDate, METHODS } from './leasing.js';

// The Rent Manager archive: old leases kept as history, typed in by staff. An archived lease,
// its payments and its work orders are records only. They live in tables of their own that no
// live query reads, so they are never an installment, a payment on a ledger, a work order on
// the board, or a reason a unit looks taken: nothing here can change a balance, a schedule,
// an alert, a report or what is sent to QuickBooks, Zego or a tenant.
//
// A tenant is picked, or a past tenant who is not in the app is just a typed name (no tenant
// record is made). The name is copied at save, so the archive still names them if their record
// is later removed. "Unpaid at end" is a figure to read; it collects nothing.

export const ENDED = [['renewed', 'Renewed'], ['moved_out', 'Moved out'], ['evicted', 'Evicted'], ['transferred', 'Transferred to another unit']];
/** Live methods, less Zego and "Paid in Rent Manager" (which are for live money), plus Check, which Rent Manager had. */
export const ARCHIVE_METHODS = [...METHODS.filter(([k]) => k !== 'zego' && k !== 'rent_manager'), ['check', 'Check']];
const ARCHIVE_DIR = `${DATA_DIR}/lease-archive`;

const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const blank = (v) => v == null || String(v).trim() === '';

/** A date that must be there. */
function needDate(v, label) {
  const s = String(v ?? '').trim();
  if (!isDate(s)) throw bad(`${label} is not a date.`);
  return s;
}
/** A date that may be empty. */
function maybeDate(v, label) {
  if (blank(v)) return null;
  return needDate(v, label);
}
/** Money that is 0 or more, or empty. */
function maybeMoney(v, label) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be 0 or more.`);
  return Math.round(n * 100) / 100;
}

// ---------- archived leases ----------

const SELECT = `SELECT a.id, a.unit_id, a.tenant_id, a.tenant_name AS tenant, ${day('a.start_date')} AS start_date, ${day('a.end_date')} AS end_date,
    a.rent_amount, a.security_deposit, a.ended_how, a.unpaid_at_end, a.notes, a.created_by, a.created_at,
    u.unit_no, bl.id AS building_id, bl.name AS building
  FROM lease_archive a JOIN prop_units u ON u.id = a.unit_id JOIN prop_buildings bl ON bl.id = u.building_id`;

/** The list, oldest first, with how many payments, work orders and files each has. Every filter is optional. */
export async function listArchive({ unit_id, tenant_id, building_id, q } = {}) {
  const where = [];
  const args = [];
  const add = (sql, ...v) => { where.push(sql); args.push(...v); };
  if (Number(unit_id)) add('a.unit_id = ?', Number(unit_id));
  if (Number(tenant_id)) add('a.tenant_id = ?', Number(tenant_id));
  if (Number(building_id)) add('bl.id = ?', Number(building_id));
  const words = String(q ?? '').trim();
  if (words) {
    const like = `%${words.replace(/[\\%_]/g, '\\$&')}%`;
    if (/^\d{4}$/.test(words)) add('(a.tenant_name ILIKE ? OR u.unit_no ILIKE ? OR extract(year FROM a.start_date) = ? OR extract(year FROM a.end_date) = ?)', like, like, Number(words), Number(words));
    else add('(a.tenant_name ILIKE ? OR u.unit_no ILIKE ?)', like, like);
  }
  const rows = await db.prepare(`SELECT x.*,
      (SELECT count(*)::int FROM lease_archive_payments p WHERE p.archive_id = x.id) AS payments,
      (SELECT count(*)::int FROM lease_archive_work_orders w WHERE w.archive_id = x.id) AS work_orders,
      (SELECT count(*)::int FROM lease_archive_files f WHERE f.archive_id = x.id) AS files
    FROM (${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}) x ORDER BY x.start_date, x.id`).all(...args);
  return rows.map(({ notes, created_by, created_at, ...r }) => r);
}

const PAY_COLS = `p.id, p.archive_id, ${day('p.received_on')} AS received_on, p.amount, p.method, p.reference, p.notes, p.file_name, p.file_mime, p.created_by`;
const WO_COLS = `w.id, w.archive_id, ${day('w.reported_on')} AS reported_on, w.detail, w.resolution, ${day('w.done_on')} AS done_on, w.cost, w.created_by`;
const FILE_COLS = 'f.id, f.archive_id, f.work_order_id, f.title, f.category, f.file_name, f.file_mime';

/** One archived lease with its payments (oldest first), work orders (each with its files) and its own files. */
export async function getArchive(id) {
  const a = await db.prepare(`${SELECT} WHERE a.id = ?`).get(Number(id) || 0);
  if (!a) throw bad('That archived lease was not found.', 404);
  const payments = await db.prepare(`SELECT ${PAY_COLS} FROM lease_archive_payments p WHERE p.archive_id = ? ORDER BY p.received_on, p.id`).all(a.id);
  const orders = await db.prepare(`SELECT ${WO_COLS} FROM lease_archive_work_orders w WHERE w.archive_id = ? ORDER BY w.reported_on, w.id`).all(a.id);
  const files = await db.prepare(`SELECT ${FILE_COLS} FROM lease_archive_files f WHERE f.archive_id = ? ORDER BY f.id`).all(a.id);
  return { ...a, payments, work_orders: orders.map((w) => ({ ...w, files: files.filter((f) => f.work_order_id === w.id) })), files: files.filter((f) => !f.work_order_id) };
}

/** The lease a person typed, checked: `now` is the saved row when editing. */
async function leaseFields(body, now) {
  const m = { ...(now ? { unit_id: now.unit_id, tenant_id: now.tenant_id, tenant_name: now.tenant, start_date: now.start_date, end_date: now.end_date,
    rent_amount: now.rent_amount, security_deposit: now.security_deposit, ended_how: now.ended_how, unpaid_at_end: now.unpaid_at_end, notes: now.notes } : {}), ...body };
  const unit = await db.prepare('SELECT id FROM prop_units WHERE id = ?').get(Number(m.unit_id) || 0);
  if (!unit) throw bad('Choose a unit.');
  let tenantId = null;
  let name = text(m.tenant_name, 200);
  if (!blank(m.tenant_id)) {
    const t = await db.prepare('SELECT id, full_name FROM lease_tenants WHERE id = ?').get(Number(m.tenant_id) || 0);
    if (!t) throw bad('That tenant was not found.', 404);
    tenantId = t.id;
    name = t.full_name;
  }
  if (!name) throw bad('Choose the tenant or type their name.');
  const start = needDate(m.start_date, 'The start date');
  const end = needDate(m.end_date, 'The end date');
  if (end < start) throw bad('The end date cannot be before the start date.');
  if (!ENDED.some(([k]) => k === m.ended_how)) throw bad('Say how the lease ended.');
  return { unit_id: unit.id, tenant_id: tenantId, tenant_name: name, start_date: start, end_date: end,
    rent_amount: maybeMoney(m.rent_amount, 'The rent'), security_deposit: maybeMoney(m.security_deposit, 'The deposit'),
    ended_how: m.ended_how, unpaid_at_end: maybeMoney(m.unpaid_at_end, 'The unpaid amount'), notes: text(m.notes, 4000) };
}

/** Archive an old lease. */
export async function addArchive(body = {}, by) {
  const row = { ...(await leaseFields(body)), created_by: by ?? null };
  const cols = Object.keys(row);
  const made = await db.prepare(`INSERT INTO lease_archive (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
  return getArchive(made.id);
}

/** Change an archived lease: what is sent replaces what was there. */
export async function updateArchive(id, body = {}, by) {
  const now = await getArchive(id);
  const row = await leaseFields(body, now);
  const cols = Object.keys(row);
  await db.prepare(`UPDATE lease_archive SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), now.id);
  return getArchive(now.id);
}

/** Delete an archived lease with its payments, work orders and files, on disk too. */
export async function removeArchive(id) {
  const a = await getArchive(id);
  const paths = [
    ...(await db.prepare('SELECT file_path FROM lease_archive_payments WHERE archive_id = ?').all(a.id)),
    ...(await db.prepare('SELECT file_path FROM lease_archive_files WHERE archive_id = ?').all(a.id)),
  ].map((r) => r.file_path).filter(Boolean);
  await db.prepare('DELETE FROM lease_archive WHERE id = ?').run(a.id);
  for (const p of paths) rmSync(p, { force: true });
  return { ok: true };
}

/** The archived leases of this lease's tenant in this unit, oldest first. */
export async function previousLeases(bookingId) {
  const b = await db.prepare('SELECT unit_id, tenant_id FROM lease_bookings WHERE id = ?').get(Number(bookingId) || 0);
  if (!b) throw bad('Lease not found', 404);
  return listArchive({ unit_id: b.unit_id, tenant_id: b.tenant_id });
}

// ---------- old payments ----------

function paymentFields(body, now) {
  const m = { ...(now || {}), ...body };
  const amount = Number(m.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw bad('The amount must be more than 0.');
  if (!ARCHIVE_METHODS.some(([k]) => k === m.method)) throw bad('Choose a payment method from the list.');
  return { received_on: needDate(m.received_on, 'The date'), amount: Math.round(amount * 100) / 100, method: m.method, reference: text(m.reference, 200), notes: text(m.notes, 1000) };
}
const getPayment = async (id) => {
  const p = await db.prepare(`SELECT ${PAY_COLS}, p.file_path FROM lease_archive_payments p WHERE p.id = ?`).get(Number(id) || 0);
  if (!p) throw bad('That payment was not found.', 404);
  return p;
};

/** A payment line on an archived lease, with an optional receipt or check image. */
export async function addArchivePayment(archiveId, body = {}, file, by) {
  const a = await getArchive(archiveId);
  const row = { ...paymentFields(body), ...saveFile(file, ARCHIVE_DIR) };
  const cols = ['archive_id', ...Object.keys(row), 'created_by'];
  const made = await db.prepare(`INSERT INTO lease_archive_payments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(a.id, ...Object.values(row), by ?? null);
  const { file_path, ...p } = await getPayment(made.id);
  return p;
}

export async function updateArchivePayment(id, body = {}) {
  const now = await getPayment(id);
  const row = paymentFields(body, now);
  const cols = Object.keys(row);
  await db.prepare(`UPDATE lease_archive_payments SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), now.id);
  const { file_path, ...p } = await getPayment(now.id);
  return p;
}

export async function removeArchivePayment(id) {
  const p = await getPayment(id);
  await db.prepare('DELETE FROM lease_archive_payments WHERE id = ?').run(p.id);
  if (p.file_path) rmSync(p.file_path, { force: true });
  return { ok: true };
}

/** The receipt on a payment, as a file to send. */
export const getArchivePaymentFile = async (id) => {
  const p = await getPayment(id);
  if (!p.file_path) throw bad('Not found', 404);
  return p;
};

// ---------- old work orders ----------

function workOrderFields(body, now) {
  const m = { ...(now || {}), ...body };
  const detail = text(m.detail, 2000);
  if (!detail) throw bad('Say what was wrong.');
  return { reported_on: needDate(m.reported_on, 'The reported date'), detail, resolution: text(m.resolution, 2000),
    done_on: maybeDate(m.done_on, 'The done date'), cost: maybeMoney(m.cost, 'The cost') };
}
const getWorkOrder = async (id) => {
  const w = await db.prepare(`SELECT ${WO_COLS} FROM lease_archive_work_orders w WHERE w.id = ?`).get(Number(id) || 0);
  if (!w) throw bad('That work order was not found.', 404);
  return w;
};

/** A work order line on an archived lease. It is a record: it never appears on the Work Orders board. */
export async function addArchiveWorkOrder(archiveId, body = {}, by) {
  const a = await getArchive(archiveId);
  const row = workOrderFields(body);
  const cols = ['archive_id', ...Object.keys(row), 'created_by'];
  const made = await db.prepare(`INSERT INTO lease_archive_work_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(a.id, ...Object.values(row), by ?? null);
  return getWorkOrder(made.id);
}

export async function updateArchiveWorkOrder(id, body = {}) {
  const now = await getWorkOrder(id);
  const row = workOrderFields(body, now);
  const cols = Object.keys(row);
  await db.prepare(`UPDATE lease_archive_work_orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), now.id);
  return getWorkOrder(now.id);
}

export async function removeArchiveWorkOrder(id) {
  const w = await getWorkOrder(id);
  const files = await db.prepare('SELECT file_path FROM lease_archive_files WHERE work_order_id = ?').all(w.id);
  await db.prepare('DELETE FROM lease_archive_work_orders WHERE id = ?').run(w.id);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

// ---------- files ----------

/** Attach files to an archived lease, or to one of its work orders (`work_order_id`). */
export async function addArchiveFiles(archiveId, files, { title, category, work_order_id } = {}, by) {
  const a = await getArchive(archiveId);
  if (!files?.length) throw bad('Choose a file to attach.');
  let woId = null;
  if (!blank(work_order_id)) {
    const w = await getWorkOrder(work_order_id);
    if (w.archive_id !== a.id) throw bad('That work order is not on this archived lease.');
    woId = w.id;
  }
  for (const file of files) {
    const f = saveFile(file, ARCHIVE_DIR);
    await db.prepare('INSERT INTO lease_archive_files (archive_id, work_order_id, title, category, file_path, file_name, file_mime, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, woId, text(title, 200), text(category, 60), f.file_path, f.file_name, f.file_mime, by ?? null);
  }
  return getArchive(a.id);
}

export const getArchiveFile = async (id) => {
  const f = await db.prepare('SELECT id, archive_id, work_order_id, title, category, file_path, file_name, file_mime FROM lease_archive_files WHERE id = ?').get(Number(id) || 0);
  if (!f) throw bad('Not found', 404);
  return f;
};

export async function removeArchiveFile(id) {
  const f = await getArchiveFile(id);
  await db.prepare('DELETE FROM lease_archive_files WHERE id = ?').run(f.id);
  rmSync(f.file_path, { force: true });
  return { ok: true };
}

// ---------- routes ----------

export const archiveRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_FILES = 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES } });

// The fixed paths come before /archive/:id so that they are not taken for an id.
archiveRoutes.get('/archive', wrap(async (req, res) => res.json(await listArchive(req.query))));
archiveRoutes.get('/archive/meta', wrap(async (req, res) => res.json({ ended: ENDED, methods: ARCHIVE_METHODS })));
archiveRoutes.get('/archive/files/:id/file', wrap(async (req, res) => sendDoc(req, res, await getArchiveFile(req.params.id))));
archiveRoutes.delete('/archive/files/:id', wrap(async (req, res) => res.json(await removeArchiveFile(req.params.id))));
archiveRoutes.get('/archive/payments/:id/file', wrap(async (req, res) => sendDoc(req, res, await getArchivePaymentFile(req.params.id))));
archiveRoutes.put('/archive/payments/:id', wrap(async (req, res) => res.json(await updateArchivePayment(req.params.id, req.body))));
archiveRoutes.delete('/archive/payments/:id', wrap(async (req, res) => res.json(await removeArchivePayment(req.params.id))));
archiveRoutes.put('/archive/work-orders/:id', wrap(async (req, res) => res.json(await updateArchiveWorkOrder(req.params.id, req.body))));
archiveRoutes.delete('/archive/work-orders/:id', wrap(async (req, res) => res.json(await removeArchiveWorkOrder(req.params.id))));
archiveRoutes.get('/archive/:id', wrap(async (req, res) => res.json(await getArchive(req.params.id))));
archiveRoutes.post('/archive', wrap(async (req, res) => res.json(await addArchive(req.body, req.user.id))));
archiveRoutes.put('/archive/:id', wrap(async (req, res) => res.json(await updateArchive(req.params.id, req.body, req.user.id))));
archiveRoutes.delete('/archive/:id', wrap(async (req, res) => res.json(await removeArchive(req.params.id))));
archiveRoutes.post('/archive/:id/payments', upload.single('file'), wrap(async (req, res) => res.json(await addArchivePayment(req.params.id, req.body, req.file, req.user.id))));
archiveRoutes.post('/archive/:id/work-orders', wrap(async (req, res) => res.json(await addArchiveWorkOrder(req.params.id, req.body, req.user.id))));
archiveRoutes.post('/archive/:id/files', upload.array('files', MAX_FILES), wrap(async (req, res) => res.json(await addArchiveFiles(req.params.id, req.files, req.body, req.user.id))));
archiveRoutes.get('/bookings/:id/previous', wrap(async (req, res) => res.json(await previousLeases(req.params.id))));
