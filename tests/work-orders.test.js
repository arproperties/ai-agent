import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, remove } from '../server/properties.js';
import { createBooking } from '../server/leasing.js';
import { createWorkOrder, getWorkOrder, listWorkOrders } from '../server/workOrders.js';

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
