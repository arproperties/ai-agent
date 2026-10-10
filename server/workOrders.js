import { db, tx } from './db.js';
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
