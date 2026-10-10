import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';
import { saveFile, sendDoc } from './properties.js';
import { bad, isDate, bookingRef, todayHere } from './leasing.js';

// Work orders: a repair to a unit, from the report to the fix. It belongs to the unit, and
// carries the lease and tenant the unit had on the day it was reported, which the server
// works out, so one is never tied to the wrong tenant; an empty unit's has neither.
//
// Only the office writes here: the technician or the AMC vendor is a name typed in. Nothing
// is charged and nothing is sent to the tenant. Every change is written to its history
// (lease_work_order_events), and a row of that history is never changed afterwards.

export const STATUS = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', done: 'Done', closed: 'Closed', cancelled: 'Cancelled' };
export const PRIORITIES = ['low', 'normal', 'urgent'];
export const LIVE = ['open', 'assigned', 'in_progress']; // not done yet
const STEPS = ['open', 'assigned', 'in_progress', 'done']; // forward only; closed and cancelled have rules of their own
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

/** WO-2026-0014. The number alone identifies it: the year is the year it was reported. */
export const workOrderRef = (w) => `WO-${w.reported_on.slice(0, 4)}-${String(w.id).padStart(4, '0')}`;

const SELECT = `SELECT w.id, w.unit_id, w.booking_id, w.tenant_id, w.tenant, w.category, w.priority, w.detail, w.reported_by, w.status, w.assigned_to,
    w.resolution, w.cancel_reason, w.created_by, w.created_at, ${day('w.reported_on')} AS reported_on, ${day('w.scheduled_on')} AS scheduled_on, ${day('w.done_on')} AS done_on,
    u.unit_no, bl.id AS building_id, bl.name AS building, r.name AS raised_by, ${day('b.start_date')} AS lease_start
  FROM lease_work_orders w
  JOIN prop_units u ON u.id = w.unit_id
  JOIN prop_buildings bl ON bl.id = u.building_id
  LEFT JOIN users r ON r.id = w.created_by
  LEFT JOIN lease_bookings b ON b.id = w.booking_id`;
const shape = ({ lease_start, ...w }, today) => ({ ...w, ref: workOrderRef(w), lease_ref: w.booking_id ? bookingRef({ id: w.booking_id, start_date: lease_start }) : null,
  overdue: LIVE.includes(w.status) && !!w.scheduled_on && w.scheduled_on < today });

const log = (id, kind, detail, by) => db.prepare('INSERT INTO lease_work_order_events (work_order_id, kind, detail, user_id) VALUES (?, ?, ?, ?)').run(id, kind, detail || null, by ?? null);

/** The confirmed lease a unit had on a day, with its tenant; null when it was empty. */
export async function leaseOn(unitId, on) {
  return (await db.prepare(`SELECT b.id AS booking_id, b.tenant_id, t.full_name AS tenant, ${day('b.start_date')} AS start_date
    FROM lease_bookings b JOIN lease_tenants t ON t.id = b.tenant_id
    WHERE b.unit_id = ? AND b.status = 'confirmed' AND ?::date BETWEEN b.start_date AND b.end_date
    ORDER BY b.start_date DESC LIMIT 1`).get(Number(unitId) || 0, on)) || null;
}
const linkOf = (lease) => ({ booking_id: lease?.booking_id ?? null, tenant_id: lease?.tenant_id ?? null, tenant: lease?.tenant ?? null });

export async function getWorkOrder(id, today = todayHere()) {
  const w = await db.prepare(`${SELECT} WHERE w.id = ?`).get(Number(id) || 0);
  if (!w) throw bad('That work order was not found.', 404);
  const files = await db.prepare('SELECT id, file_name, file_mime FROM lease_work_order_files WHERE work_order_id = ? ORDER BY id').all(w.id);
  const events = await db.prepare(`SELECT e.id, e.kind, e.detail, e.created_at, p.name AS who
    FROM lease_work_order_events e LEFT JOIN users p ON p.id = e.user_id WHERE e.work_order_id = ? ORDER BY e.id`).all(w.id);
  return { ...shape(w, today), files, events };
}

/** What a person types on a work order, checked. `partial`: only what was sent. */
function fields(body = {}, today, { partial = false } = {}) {
  const out = {};
  if ('category' in body) out.category = text(body.category, 60);
  if ('reported_by' in body) out.reported_by = text(body.reported_by, 120);
  if ('assigned_to' in body) out.assigned_to = text(body.assigned_to, 120);
  if (!partial || 'priority' in body) {
    out.priority = body.priority == null || body.priority === '' ? 'normal' : body.priority;
    if (!PRIORITIES.includes(out.priority)) throw bad('The priority is low, normal or urgent.');
  }
  if (!partial || 'detail' in body) {
    out.detail = text(body.detail, 2000);
    if (!out.detail) throw bad('Say what is wrong.');
  }
  if (!partial || 'reported_on' in body) {
    const v = String(body.reported_on ?? '').trim() || (partial ? '' : today);
    if (!isDate(v)) throw bad('The date is not a date.');
    if (v > today) throw bad('The reported date cannot be in the future.');
    out.reported_on = v;
  }
  if ('scheduled_on' in body) {
    const v = String(body.scheduled_on ?? '').trim();
    if (v && !isDate(v)) throw bad('The scheduled date is not a date.');
    out.scheduled_on = v || null;
  }
  return out;
}

/** Raise a work order on a unit. Its lease and tenant are whoever had the unit on the reported day. */
export async function createWorkOrder(body = {}, by, today = todayHere()) {
  const unit = await db.prepare('SELECT id FROM prop_units WHERE id = ?').get(Number(body.unit_id) || 0);
  if (!unit) throw bad('Choose the unit.');
  const f = fields(body, today);
  const lease = await leaseOn(unit.id, f.reported_on);
  const row = { ...f, ...linkOf(lease), unit_id: unit.id, status: f.assigned_to ? 'assigned' : 'open', created_by: by ?? null };
  const id = await tx(async () => {
    const cols = Object.keys(row);
    const made = await db.prepare(`INSERT INTO lease_work_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
    await log(made.id, 'created', lease ? `Raised for ${lease.tenant}` : 'Raised for the vacant unit', by);
    if (row.assigned_to) await log(made.id, 'assigned', `Assigned to ${row.assigned_to}`, by);
    return made.id;
  });
  return getWorkOrder(id, today);
}

/** The list, newest first. `status: 'active'` is everything not closed or cancelled. */
export async function listWorkOrders({ status, building_id, unit_id, booking_id, tenant_id, priority, overdue, q } = {}, today = todayHere()) {
  const where = [];
  const args = [];
  const add = (sql, ...v) => { where.push(sql); args.push(...v); };
  if (status === 'active') add("w.status NOT IN ('closed', 'cancelled')");
  else if (STATUS[status]) add('w.status = ?', status);
  if (Number(building_id)) add('bl.id = ?', Number(building_id));
  if (Number(unit_id)) add('w.unit_id = ?', Number(unit_id));
  if (Number(booking_id)) add('w.booking_id = ?', Number(booking_id));
  if (Number(tenant_id)) add('w.tenant_id = ?', Number(tenant_id));
  if (PRIORITIES.includes(priority)) add('w.priority = ?', priority);
  if (overdue === true || overdue === 'true' || overdue === '1') add("w.status IN ('open', 'assigned', 'in_progress') AND w.scheduled_on < ?::date", today);
  const words = String(q ?? '').trim().toLowerCase();
  if (words) {
    add(`lower(concat_ws(' ', 'WO-' || to_char(w.reported_on, 'YYYY') || '-' || lpad(w.id::text, 4, '0'), u.unit_no, bl.name, w.tenant, w.category, w.detail, w.assigned_to)) LIKE ?`, `%${words}%`);
  }
  const rows = await db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY w.reported_on DESC, w.id DESC`).all(...args);
  return rows.map((w) => shape(w, today));
}

/** A finished one goes back to work: in progress when somebody is on it, open when nobody is. */
async function reopen(now, note, by, today) {
  if (LIVE.includes(now.status)) throw bad(`${now.ref} is not finished.`, 409);
  const status = now.assigned_to ? 'in_progress' : 'open';
  const why = text(note, 500);
  await tx(async () => {
    await db.prepare('UPDATE lease_work_orders SET status = ?, resolution = NULL, done_on = NULL, cancel_reason = NULL WHERE id = ?').run(status, now.id);
    await log(now.id, 'reopened', `${STATUS[now.status]} → ${STATUS[status]}${why ? `: ${why}` : ''}`, by);
  });
  return getWorkOrder(now.id, today);
}

/**
 * Change a work order: its words, who is on it, when they come, or its status. Each kind of
 * change is one line of its history. `reopen: true` takes a finished one back to work.
 */
export async function updateWorkOrder(id, body = {}, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  if (body.reopen) return reopen(now, body.note, by, today);
  if (['closed', 'cancelled'].includes(now.status)) throw bad(`${now.ref} is ${STATUS[now.status].toLowerCase()}. Reopen it to change it.`, 409);
  const f = fields(body, today, { partial: true });
  const changed = (k) => k in f && f[k] !== now[k];
  const set = {};
  const events = [];

  const words = [['category', 'type'], ['priority', 'priority'], ['detail', 'description'], ['reported_by', 'reported by'], ['reported_on', 'reported date']].filter(([k]) => changed(k));
  for (const [k] of words) set[k] = f[k];
  if (words.length) events.push(['edited', `Changed: ${words.map(([k, name]) => (k === 'detail' ? name : `${name} to ${f[k] ?? 'none'}`)).join(', ')}`]);
  // Reported on another day: the lease and tenant are those of that day.
  if (changed('reported_on')) Object.assign(set, linkOf(await leaseOn(now.unit_id, f.reported_on)));

  let status = now.status;
  if (changed('assigned_to')) {
    set.assigned_to = f.assigned_to;
    events.push(['assigned', f.assigned_to ? `Assigned to ${f.assigned_to}` : 'Assignee removed']);
    if (f.assigned_to && status === 'open') status = 'assigned';
    if (!f.assigned_to && status === 'assigned') status = 'open';
  }
  if (changed('scheduled_on')) {
    set.scheduled_on = f.scheduled_on;
    events.push(['scheduled', f.scheduled_on ? `Scheduled for ${f.scheduled_on}` : 'Schedule cleared']);
  }

  const to = body.status;
  if (to != null && to !== status) {
    if (!STATUS[to]) throw bad('That is not a status.');
    const from = status;
    let note = '';
    if (to === 'cancelled') {
      if (!LIVE.includes(from)) throw bad('A work order that is done cannot be cancelled.', 409);
      set.cancel_reason = text(body.cancel_reason, 500);
      if (!set.cancel_reason) throw bad('Say why it is cancelled.');
      note = set.cancel_reason;
    } else if (to === 'closed') {
      if (from !== 'done') throw bad('Only a work order that is done can be closed.', 409);
    } else {
      if (STEPS.indexOf(to) < STEPS.indexOf(from)) throw bad(`${now.ref} is already ${STATUS[from].toLowerCase()}.`, 409);
      if (to === 'assigned' && !('assigned_to' in set ? set.assigned_to : now.assigned_to)) throw bad('Say who it is assigned to.');
      if (to === 'done') {
        set.resolution = text(body.resolution, 2000);
        if (!set.resolution) throw bad('Say what was done.');
        const on = String(body.done_on ?? '').trim() || today;
        if (!isDate(on)) throw bad('The date is not a date.');
        if (on > today) throw bad('The finished date cannot be in the future.');
        set.done_on = on;
        note = set.resolution;
      }
    }
    events.push(['status', `${STATUS[from]} → ${STATUS[to]}${note ? `: ${note}` : ''}`]);
    status = to;
  }
  if (status !== now.status) set.status = status;

  const cols = Object.keys(set);
  if (!cols.length) return now;
  await tx(async () => {
    await db.prepare(`UPDATE lease_work_orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), now.id);
    for (const [kind, detail] of events) await log(now.id, kind, detail, by);
  });
  return getWorkOrder(now.id, today);
}

/** A line somebody adds to the history: "tenant not home, coming back Thursday". Allowed whatever its status. */
export async function addWorkOrderNote(id, note, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  const words = text(note, 1000);
  if (!words) throw bad('Write the note.');
  await log(now.id, 'note', words, by);
  return getWorkOrder(now.id, today);
}

/** Delete one raised by mistake. Once somebody is on it, it is cancelled instead, so what happened is kept. */
export async function removeWorkOrder(id) {
  const now = await getWorkOrder(id);
  if (now.status !== 'open' || now.assigned_to) throw bad(`${now.ref} has been started. Cancel it instead, so its history is kept.`, 409);
  const files = await db.prepare('SELECT file_path FROM lease_work_order_files WHERE work_order_id = ?').all(now.id);
  await db.prepare('DELETE FROM lease_work_orders WHERE id = ?').run(now.id);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

// ---------- files ----------

const FILE_DIR = `${DATA_DIR}/leasing`;

/** Attach files: as many as are sent, added to the ones it has. */
export async function addWorkOrderFiles(id, files, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  if (!files?.length) throw bad('Choose a file to attach.');
  const names = [];
  for (const file of files) {
    const f = saveFile(file, FILE_DIR);
    await db.prepare('INSERT INTO lease_work_order_files (work_order_id, file_path, file_name, file_mime, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(now.id, f.file_path, f.file_name, f.file_mime, by ?? null);
    names.push(f.file_name);
  }
  await log(now.id, 'file_added', `Added ${names.join(', ')}`, by);
  return getWorkOrder(now.id, today);
}

export const getWorkOrderFile = async (id) => {
  const f = await db.prepare('SELECT id, work_order_id, file_path, file_name, file_mime FROM lease_work_order_files WHERE id = ?').get(Number(id) || 0);
  if (!f) throw bad('Not found', 404);
  return f;
};

export async function removeWorkOrderFile(id, by) {
  const f = await getWorkOrderFile(id);
  await db.prepare('DELETE FROM lease_work_order_files WHERE id = ?').run(f.id);
  rmSync(f.file_path, { force: true });
  await log(f.work_order_id, 'file_removed', `Removed ${f.file_name}`, by);
  return { ok: true };
}

// ---------- what the form asks ----------

/** Every unit, for the form's picker. */
export const workOrderUnits = () => db.prepare(`SELECT u.id, u.unit_no, bl.id AS building_id, bl.name AS building
  FROM prop_units u JOIN prop_buildings bl ON bl.id = u.building_id ORDER BY lower(bl.name), u.unit_no`).all();

/** Whose a unit is on a day (today when none is given), so the form can say who the work order will be for. */
export async function workOrderLink(unitId, on, today = todayHere()) {
  const d = String(on ?? '').trim() || today;
  const lease = isDate(d) ? await leaseOn(unitId, d) : null;
  return { tenant: lease?.tenant ?? null, ref: lease ? bookingRef({ id: lease.booking_id, start_date: lease.start_date }) : null };
}

// ---------- the notes that came before ----------

/**
 * Maintenance used to be a line in a tenant's history (lease_tenant_log). Each of those
 * becomes a work order on the unit of its lease: open if it was open, closed if it was
 * resolved, with its files. Run at every start; once a note is moved it is gone from the
 * old table, so a second run finds nothing. A note with no lease has no unit, and stays.
 */
export async function moveMaintenanceNotes() {
  const notes = await db.prepare(`SELECT l.id, l.tenant_id, l.booking_id, l.category, l.detail, l.reported_by, l.resolution, l.created_by, l.created_at,
      ${day('l.happened_on')} AS happened_on, ${day('l.resolved_on')} AS resolved_on, b.unit_id, t.full_name AS tenant
    FROM lease_tenant_log l JOIN lease_bookings b ON b.id = l.booking_id JOIN lease_tenants t ON t.id = l.tenant_id
    WHERE l.kind = 'maintenance' ORDER BY l.id`).all();
  for (const n of notes) {
    await tx(async () => {
      const { id } = await db.prepare(`INSERT INTO lease_work_orders (unit_id, booking_id, tenant_id, tenant, category, detail, reported_by, reported_on, status, resolution, done_on, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(n.unit_id, n.booking_id, n.tenant_id, n.tenant, n.category, n.detail, n.reported_by, n.happened_on,
        n.resolved_on ? 'closed' : 'open', n.resolved_on ? n.resolution : null, n.resolved_on, n.created_by, n.created_at);
      await db.prepare('INSERT INTO lease_work_order_events (work_order_id, kind, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'created', `Moved from the tenant’s history${n.resolved_on ? `, resolved ${n.resolved_on}` : ''}`, n.created_by, n.created_at);
      // The files stay where they are on disk; only the rows that point at them move.
      await db.prepare(`INSERT INTO lease_work_order_files (work_order_id, file_path, file_name, file_mime, uploaded_by, created_at)
        SELECT ?::int, file_path, file_name, file_mime, uploaded_by, created_at FROM lease_tenant_log_files WHERE log_id = ? ORDER BY id`).run(id, n.id);
      await db.prepare('DELETE FROM lease_tenant_log WHERE id = ?').run(n.id);
    });
  }
  return notes.length;
}

// ---------- routes ----------

export const workOrderRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_FILES = 10; // in one go; more can be added after
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES } });
const isMaster = (req) => req.user.role === 'master';

workOrderRoutes.get('/work-orders', wrap(async (req, res) => res.json({ work_orders: await listWorkOrders(req.query), master: isMaster(req) })));
workOrderRoutes.get('/work-orders/units', wrap(async (req, res) => res.json(await workOrderUnits())));
workOrderRoutes.get('/work-orders/link', wrap(async (req, res) => res.json(await workOrderLink(req.query.unit_id, req.query.on))));
workOrderRoutes.get('/work-orders/files/:id/file', wrap(async (req, res) => sendDoc(req, res, await getWorkOrderFile(req.params.id))));
workOrderRoutes.delete('/work-orders/files/:id', wrap(async (req, res) => res.json(await removeWorkOrderFile(req.params.id, req.user.id))));
workOrderRoutes.post('/work-orders', wrap(async (req, res) => res.json(await createWorkOrder(req.body, req.user.id))));
workOrderRoutes.get('/work-orders/:id', wrap(async (req, res) => res.json({ ...(await getWorkOrder(req.params.id)), master: isMaster(req) })));
workOrderRoutes.put('/work-orders/:id', wrap(async (req, res) => res.json(await updateWorkOrder(req.params.id, req.body, req.user.id))));
workOrderRoutes.delete('/work-orders/:id', requireMaster, wrap(async (req, res) => res.json(await removeWorkOrder(req.params.id))));
workOrderRoutes.post('/work-orders/:id/notes', wrap(async (req, res) => res.json(await addWorkOrderNote(req.params.id, req.body?.note, req.user.id))));
workOrderRoutes.post('/work-orders/:id/files', upload.array('files', MAX_FILES), wrap(async (req, res) => res.json(await addWorkOrderFiles(req.params.id, req.files, req.user.id))));
