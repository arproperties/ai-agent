import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, remove } from '../server/properties.js';
import { createBooking } from '../server/leasing.js';
import { existsSync } from 'node:fs';
import { createWorkOrder, getWorkOrder, listWorkOrders, updateWorkOrder, addWorkOrderNote, removeWorkOrder,
  addWorkOrderFiles, getWorkOrderFile, removeWorkOrderFile, workOrderUnits, workOrderLink, moveMaintenanceNotes } from '../server/workOrders.js';
import { tenantHistory } from '../server/leasingHistory.js';

test.after(() => closeDb());

const AT = '2026-10-25';

// Sara has unit 101 from 15 September to 14 November. Unit 102 is empty.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const building = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, building.id);
  const u2 = await create('unit', { unit_no: '102' }, building.id);
  const bk = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  return { staff, building, u1, u2, bk, sara: bk.tenant_id };
}

test('a work order is raised on a unit and links itself to the lease and tenant of that day', async () => {
  const { staff, u1, u2, bk, sara } = await tower();
  await assert.rejects(createWorkOrder({ detail: 'x' }, staff, AT), /Choose the unit/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: ' ' }, staff, AT), /Say what is wrong/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', priority: 'asap' }, staff, AT), /low, normal or urgent/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', reported_on: '2026-13-40' }, staff, AT), /not a date/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', reported_on: '2026-10-26' }, staff, AT), /in the future/);

  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_by: 'Sara' }, staff, AT);
  assert.deepEqual([ac.ref, ac.status, ac.priority, ac.reported_on, ac.unit_no, ac.building, ac.tenant, ac.tenant_id, ac.booking_id, ac.lease_ref, ac.raised_by, ac.overdue],
    ['WO-2026-0001', 'open', 'normal', AT, '101', 'Tower', 'Sara', sara, bk.id, bk.ref, 'Staff', false]);
  assert.deepEqual(ac.events.map((e) => [e.kind, e.detail, e.who]), [['created', 'Raised for Sara', 'Staff']]);
  assert.deepEqual(ac.files, []);

  // An empty unit: the work order has no tenant.
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway' }, staff, AT);
  assert.deepEqual([paint.tenant, paint.tenant_id, paint.booking_id, paint.lease_ref], [null, null, null, null]);
  assert.deepEqual(paint.events.map((e) => e.detail), ['Raised for the vacant unit']);

  // Reported after the lease's last day: nobody's lease covers it, so it is the unit's alone.
  const late = await createWorkOrder({ unit_id: u1.id, detail: 'Door handle loose', reported_on: '2026-11-20' }, staff, '2026-11-25');
  assert.equal(late.tenant, null);

  // Given an assignee from the start, it starts as assigned.
  const leak = await createWorkOrder({ unit_id: u1.id, detail: 'Leak under the sink', assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-28', priority: 'urgent' }, staff, AT);
  assert.deepEqual([leak.status, leak.assigned_to, leak.scheduled_on], ['assigned', 'Cool Air LLC', '2026-10-28']);
  assert.deepEqual(leak.events.map((e) => [e.kind, e.detail]), [['created', 'Raised for Sara'], ['assigned', 'Assigned to Cool Air LLC']]);

  await assert.rejects(getWorkOrder(999), /not found/);
});

test('the list is filtered by status, place, tenant, priority, lateness and words', async () => {
  const { staff, building, u1, u2, bk, sara } = await tower();
  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_on: '2026-10-20' }, staff, AT);
  const leak = await createWorkOrder({ unit_id: u1.id, category: 'Plumbing', detail: 'Leak under the sink', priority: 'urgent', assigned_to: 'Pipes Co', scheduled_on: '2026-10-22' }, staff, AT);
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway', scheduled_on: '2026-10-30' }, staff, AT);
  await db.prepare("UPDATE lease_work_orders SET status = 'closed' WHERE id = ?").run(paint.id);
  const ids = async (q) => (await listWorkOrders(q, AT)).map((w) => w.id);

  assert.deepEqual(await ids({}), [paint.id, leak.id, ac.id], 'newest reported first, then newest made');
  assert.deepEqual(await ids({ status: 'active' }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ status: 'closed' }), [paint.id]);
  assert.deepEqual(await ids({ unit_id: u2.id }), [paint.id]);
  assert.deepEqual(await ids({ building_id: building.id }), [paint.id, leak.id, ac.id]);
  assert.deepEqual(await ids({ building_id: 999 }), []);
  assert.deepEqual(await ids({ tenant_id: sara }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ booking_id: bk.id }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ priority: 'urgent' }), [leak.id]);
  assert.deepEqual(await ids({ overdue: 'true' }), [leak.id], 'scheduled before today and not done');
  assert.deepEqual(await ids({ q: 'sink' }), [leak.id]);
  assert.deepEqual(await ids({ q: 'wo-2026-0001' }), [ac.id]);
  assert.deepEqual(await ids({ q: 'pipes' }), [leak.id]);
  assert.equal((await listWorkOrders({}, AT)).find((w) => w.id === leak.id).overdue, true);
  assert.equal((await listWorkOrders({}, AT)).find((w) => w.id === paint.id).overdue, false, 'a closed one is never overdue');
});

test('a unit with work orders is not deleted, and the message says why', async () => {
  const { staff, u2 } = await tower();
  await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway' }, staff, AT);
  await assert.rejects(remove('unit', u2.id), /work orders/);
});

test('a work order moves forward step by step, and each step is written in its history', async () => {
  const { staff, u1 } = await tower();
  const boss = await makeUser('Boss');
  const w = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling' }, staff, AT);

  await assert.rejects(updateWorkOrder(w.id, { status: 'flying' }, staff, AT), /not a status/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'assigned' }, staff, AT), /who it is assigned to/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'closed' }, staff, AT), /Only a work order that is done/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'done' }, staff, AT), /Say what was done/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'cancelled' }, staff, AT), /Say why/);

  // Typing an assignee on an open one makes it assigned; a date is its schedule.
  let now = await updateWorkOrder(w.id, { assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-28' }, boss, AT);
  assert.deepEqual([now.status, now.assigned_to, now.scheduled_on], ['assigned', 'Cool Air LLC', '2026-10-28']);
  now = await updateWorkOrder(w.id, { status: 'in_progress' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { status: 'open' }, staff, AT), /already in progress/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'done', resolution: 'x', done_on: '2026-10-26' }, staff, AT), /in the future/);
  now = await updateWorkOrder(w.id, { status: 'done', resolution: 'Replaced the compressor' }, staff, AT);
  assert.deepEqual([now.status, now.resolution, now.done_on], ['done', 'Replaced the compressor', AT]);
  await assert.rejects(updateWorkOrder(w.id, { status: 'cancelled', cancel_reason: 'x' }, staff, AT), /cannot be cancelled/);
  now = await updateWorkOrder(w.id, { status: 'closed' }, boss, AT);
  assert.equal(now.status, 'closed');

  assert.deepEqual(now.events.map((e) => [e.kind, e.detail, e.who]), [
    ['created', 'Raised for Sara', 'Staff'],
    ['assigned', 'Assigned to Cool Air LLC', 'Boss'],
    ['scheduled', 'Scheduled for 2026-10-28', 'Boss'],
    ['status', 'Assigned → In progress', 'Staff'],
    ['status', 'In progress → Done: Replaced the compressor', 'Staff'],
    ['status', 'Done → Closed', 'Boss'],
  ]);
});

test('a step can be skipped, an assignee taken off, and the words changed', async () => {
  const { staff, u1, u2 } = await tower();
  // A five-minute fix: open straight to done.
  const bulb = await createWorkOrder({ unit_id: u1.id, detail: 'Bulb out' }, staff, AT);
  const done = await updateWorkOrder(bulb.id, { status: 'done', resolution: 'Changed the bulb', done_on: '2026-10-24' }, staff, AT);
  assert.deepEqual([done.status, done.done_on], ['done', '2026-10-24']);

  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', assigned_to: 'Pipes Co' }, staff, AT);
  let now = await updateWorkOrder(w.id, { assigned_to: '' }, staff, AT);
  assert.deepEqual([now.status, now.assigned_to], ['open', null], 'with nobody on it, it is open again');
  now = await updateWorkOrder(w.id, { detail: 'Leak under the kitchen sink', priority: 'urgent', category: 'Plumbing' }, staff, AT);
  assert.deepEqual([now.detail, now.priority, now.category], ['Leak under the kitchen sink', 'urgent', 'Plumbing']);
  assert.equal(now.events.at(-1).detail, 'Changed: type to Plumbing, priority to urgent, description');
  await assert.rejects(updateWorkOrder(w.id, { detail: ' ' }, staff, AT), /Say what is wrong/);

  // Nothing new: nothing is written.
  const before = now.events.length;
  now = await updateWorkOrder(w.id, { status: 'open', priority: 'urgent' }, staff, AT);
  assert.equal(now.events.length, before);

  // A reported day before the lease began: it is no longer the tenant's.
  now = await updateWorkOrder(w.id, { reported_on: '2026-09-01' }, staff, AT);
  assert.deepEqual([now.tenant, now.booking_id], [null, null]);
  now = await updateWorkOrder(w.id, { reported_on: '2026-10-01' }, staff, AT);
  assert.equal(now.tenant, 'Sara');

  // Cancelled with its reason.
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint' }, staff, AT);
  const off = await updateWorkOrder(paint.id, { status: 'cancelled', cancel_reason: 'Owner will repaint next year' }, staff, AT);
  assert.deepEqual([off.status, off.cancel_reason, off.events.at(-1).detail], ['cancelled', 'Owner will repaint next year', 'Open → Cancelled: Owner will repaint next year']);
});

test('a finished work order is reopened before it is changed, and notes can always be added', async () => {
  const { staff, u1 } = await tower();
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'AC not cooling', assigned_to: 'Cool Air LLC' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { reopen: true }, staff, AT), /not finished/);
  await updateWorkOrder(w.id, { status: 'done', resolution: 'Regassed' }, staff, AT);
  await updateWorkOrder(w.id, { status: 'closed' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { detail: 'Something else' }, staff, AT), /Reopen it to change it/);

  await assert.rejects(addWorkOrderNote(w.id, '  ', staff, AT), /Write the note/);
  let now = await addWorkOrderNote(w.id, 'Tenant says it is warm again', staff, AT);
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['note', 'Tenant says it is warm again']);

  now = await updateWorkOrder(w.id, { reopen: true, note: 'Not cooling again' }, staff, AT);
  assert.deepEqual([now.status, now.resolution, now.done_on], ['in_progress', null, null], 'it has an assignee, so work carries on');
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['reopened', 'Closed → In progress: Not cooling again']);

  // One with nobody on it goes back to open.
  const bulb = await createWorkOrder({ unit_id: u1.id, detail: 'Bulb out' }, staff, AT);
  await updateWorkOrder(bulb.id, { status: 'cancelled', cancel_reason: 'Duplicate' }, staff, AT);
  now = await updateWorkOrder(bulb.id, { reopen: true }, staff, AT);
  assert.deepEqual([now.status, now.cancel_reason], ['open', null]);
});

test('only a work order nobody has started is deleted; after that it is cancelled, so its history is kept', async () => {
  const { staff, u1 } = await tower();
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Typed twice by mistake' }, staff, AT);
  const started = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', assigned_to: 'Pipes Co' }, staff, AT);
  await assert.rejects(removeWorkOrder(started.id), /Cancel it instead/);
  assert.deepEqual(await removeWorkOrder(w.id), { ok: true });
  await assert.rejects(getWorkOrder(w.id), /not found/);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_work_order_events WHERE work_order_id = ?').get(w.id)).n, 0);
  await assert.rejects(removeWorkOrder(999), /not found/);
});

test('a work order takes several files, each removed by itself, and all go when it is deleted', async () => {
  const { staff, u1 } = await tower();
  const file = (name, mime = 'image/jpeg') => ({ buffer: Buffer.from(name), originalname: name, mimetype: mime });
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Leak under the sink' }, staff, AT);
  await assert.rejects(addWorkOrderFiles(w.id, [], staff, AT), /Choose a file/);
  await assert.rejects(addWorkOrderFiles(999, [file('a.jpg')], staff, AT), /not found/);

  const two = await addWorkOrderFiles(w.id, [file('before.jpg'), file('report.pdf', 'application/pdf')], staff, AT);
  assert.deepEqual(two.files.map((f) => [f.file_name, f.file_mime]), [['before.jpg', 'image/jpeg'], ['report.pdf', 'application/pdf']]);
  assert.deepEqual([two.events.at(-1).kind, two.events.at(-1).detail], ['file_added', 'Added before.jpg, report.pdf']);
  const paths = (await db.prepare('SELECT file_path FROM lease_work_order_files ORDER BY id').all()).map((r) => r.file_path);
  assert.ok(paths.every((p) => existsSync(p)));
  assert.equal((await getWorkOrderFile(two.files[0].id)).file_name, 'before.jpg');

  await removeWorkOrderFile(two.files[0].id, staff);
  assert.equal(existsSync(paths[0]), false);
  await assert.rejects(removeWorkOrderFile(two.files[0].id, staff), /Not found/);
  const now = await getWorkOrder(w.id, AT);
  assert.deepEqual(now.files.map((f) => f.file_name), ['report.pdf']);
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['file_removed', 'Removed before.jpg']);

  await removeWorkOrder(w.id);
  assert.ok(paths.every((p) => !existsSync(p)), 'deleting the work order deletes its files');
});

test('the form is told the units there are, and whose a unit is on a day', async () => {
  const { u1, u2, bk } = await tower();
  assert.deepEqual((await workOrderUnits()).map((u) => [u.unit_no, u.building]), [['101', 'Tower'], ['102', 'Tower']]);
  assert.deepEqual(await workOrderLink(u1.id, '2026-10-01', AT), { tenant: 'Sara', ref: bk.ref });
  assert.deepEqual(await workOrderLink(u1.id, '', AT), { tenant: 'Sara', ref: bk.ref }, 'no day given is today');
  assert.deepEqual(await workOrderLink(u2.id, '2026-10-01', AT), { tenant: null, ref: null });
  assert.deepEqual(await workOrderLink(u1.id, 'yesterday', AT), { tenant: null, ref: null }, 'a day that is not a date links to nobody');
});

test('the maintenance notes of a tenant’s history become work orders, once, with their files', async () => {
  const { staff, u1, bk, sara } = await tower();
  const note = (detail, on, resolved, resolution, booking = bk.id) => db.prepare(`INSERT INTO lease_tenant_log (tenant_id, booking_id, kind, category, detail, reported_by, happened_on, resolved_on, resolution, created_by, created_at)
    VALUES (?, ?, 'maintenance', 'AC', ?, 'Sara', ?, ?, ?, ?, 1760000000) RETURNING id`).run(sara, booking, detail, on, resolved, resolution, staff);
  const open = await note('AC not cooling', '2026-10-01', null, null);
  const fixed = await note('Filter blocked', '2026-09-20', '2026-09-22', 'Cleaned the filter');
  const loose = await note('Before any lease', '2026-01-05', null, null, null);
  await db.prepare("INSERT INTO lease_tenant_log (tenant_id, booking_id, kind, detail, happened_on) VALUES (?, ?, 'complaint', 'Loud music', '2026-10-02')").run(sara, bk.id);
  await db.prepare("INSERT INTO lease_tenant_log_files (log_id, file_path, file_name, file_mime, uploaded_by) VALUES (?, '/tmp/wo-before.jpg', 'before.jpg', 'image/jpeg', ?)").run(open.id, staff);

  assert.equal(await moveMaintenanceNotes(), 2);
  const [a, b] = await listWorkOrders({ tenant_id: sara }, AT);
  assert.deepEqual([a.detail, a.status, a.reported_on, a.unit_id, a.booking_id, a.tenant, a.category, a.reported_by, a.raised_by, a.done_on],
    ['AC not cooling', 'open', '2026-10-01', u1.id, bk.id, 'Sara', 'AC', 'Sara', 'Staff', null]);
  assert.deepEqual([b.detail, b.status, b.reported_on, b.done_on, b.resolution], ['Filter blocked', 'closed', '2026-09-20', '2026-09-22', 'Cleaned the filter']);
  const full = await getWorkOrder(a.id, AT);
  assert.deepEqual(full.files.map((f) => f.file_name), ['before.jpg']);
  assert.deepEqual(full.events.map((e) => [e.kind, e.detail, String(e.created_at)]), [['created', 'Moved from the tenant’s history', '1760000000']]);
  assert.equal((await getWorkOrder(b.id, AT)).events[0].detail, 'Moved from the tenant’s history, resolved 2026-09-22');

  // What is left behind: the complaint, and the note with no lease to take its unit from.
  assert.deepEqual((await db.prepare('SELECT id, kind FROM lease_tenant_log ORDER BY id').all()).map((r) => r.kind), ['maintenance', 'complaint']);
  assert.equal((await db.prepare('SELECT id FROM lease_tenant_log WHERE kind = ?').get('maintenance')).id, loose.id);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_tenant_log_files').get()).n, 0);

  assert.equal(await moveMaintenanceNotes(), 0, 'a second run finds nothing to move');
  assert.equal((await listWorkOrders({}, AT)).length, 2);
});

test('a tenant’s history shows their work orders as maintenance, and counts the ones not done', async () => {
  const { staff, u1, u2, bk, sara } = await tower();
  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_on: '2026-10-20' }, staff, AT);
  const leak = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', reported_on: '2026-10-21' }, staff, AT);
  const off = await createWorkOrder({ unit_id: u1.id, detail: 'Typed twice', reported_on: '2026-10-22' }, staff, AT);
  await createWorkOrder({ unit_id: u2.id, detail: 'Somebody else’s unit' }, staff, AT);
  await updateWorkOrder(leak.id, { status: 'done', resolution: 'Tightened the trap' }, staff, AT);
  await updateWorkOrder(off.id, { status: 'cancelled', cancel_reason: 'Duplicate' }, staff, AT);

  const h = await tenantHistory(sara, AT);
  const mine = h.items.filter((i) => i.type === 'maintenance');
  assert.deepEqual(mine.map((i) => [i.wo, i.date, i.status, i.resolved_on, i.resolution, i.ref, i.unit_no]), [
    [leak.ref, '2026-10-21', 'done', AT, 'Tightened the trap', bk.ref, '101'],
    [ac.ref, '2026-10-20', 'open', null, null, bk.ref, '101'],
  ]);
  assert.deepEqual([h.summary.maintenance, h.summary.maintenance_open], [2, 1], 'a cancelled one is not counted');
  assert.deepEqual(h.current, { unit_id: u1.id, unit_no: '101', building: 'Tower' });
  assert.equal((await tenantHistory(sara, '2026-12-01')).current, null, 'after the lease, they have no unit');
});
