import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { create, update } from '../server/properties.js';
import { report } from '../server/leasingReports.js';
import { listAlerts } from '../server/leasingAlerts.js';
import { addTenant, removeTenant, listTenants, createBooking, createBookingWithDocs, updateBooking, confirmBooking, cancelBooking, removeBooking,
  listBookings, availability, suggestType, bookingStage, bookingDocs, addBookingDoc, removeBookingDoc, overview, schedule, bookingPayments, recordPayment, removePayment } from '../server/leasing.js';

test.after(() => closeDb());

async function units() {
  await reset();
  const c = await create('company', { name: 'A' });
  const b = await create('building', { name: 'Tower' }, c.id);
  return { b, u1: await create('unit', { unit_no: '101' }, b.id), u2: await create('unit', { unit_no: '102' }, b.id) };
}
const stay = (unit_id, start_date, end_date, extra = {}) => ({ unit_id, start_date, end_date, rent_amount: 4500, tenant: { full_name: 'Sara' }, ...extra });

test('a lease is a year or more; the stage comes from the dates', () => {
  assert.equal(suggestType('2026-11-01', '2027-10-31'), 'lease');
  assert.equal(suggestType('2026-11-01', '2027-10-30'), 'short_term');
  assert.equal(suggestType('2026-11-01', '2026-12-31'), 'short_term');
  const b = { status: 'confirmed', start_date: '2026-11-01', end_date: '2026-11-30' };
  assert.equal(bookingStage(b, '2026-10-31'), 'upcoming');
  assert.equal(bookingStage(b, '2026-11-30'), 'active');
  assert.equal(bookingStage(b, '2026-12-01'), 'ended');
  assert.equal(bookingStage({ ...b, status: 'draft' }, '2026-11-05'), 'draft');
});

test('a booking made on the form is not saved without the driver license and the proof of employment', async () => {
  const { u1 } = await units();
  const scan = (name) => [{ buffer: Buffer.from(name), originalname: `${name}.pdf`, mimetype: 'application/pdf' }];
  const body = stay(u1.id, '2026-11-01', '2026-11-30', { status: 'confirmed' });
  await assert.rejects(createBookingWithDocs(body, {}), /Attach the tenant's Driver License and Proof of Employment/);
  await assert.rejects(createBookingWithDocs(body, { driver_license: scan('dl') }), /Attach the tenant's Proof of Employment\./);
  assert.equal((await listBookings()).length, 0, 'nothing is saved by a refusal');

  const bk = await createBookingWithDocs(body, { driver_license: scan('dl'), proof_of_employment: scan('job') });
  assert.equal(bk.status, 'confirmed');
  assert.deepEqual((await bookingDocs(bk.id)).map((d) => [d.title, d.file_name, d.has_file]),
    [['Driver License', 'dl.pdf', true], ['Proof of Employment', 'job.pdf', true]]);
});

test('a unit is never confirmed twice for the same day', async () => {
  const { b, u1, u2 } = await units();
  const first = await createBooking(stay(u1.id, '2026-11-01', '2026-11-30', { status: 'confirmed' }));
  assert.equal(first.status, 'confirmed');
  assert.equal(first.type, 'short_term');
  assert.match(first.ref, /^BK-2026-\d{4}$/);

  await assert.rejects(createBooking(stay(u1.id, '2026-11-30', '2026-12-31', { status: 'confirmed' })), /already booked by Sara/);
  const next = await createBooking(stay(u1.id, '2026-12-01', '2026-12-31', { status: 'confirmed' }));
  assert.equal(next.status, 'confirmed', 'the day after the last night is free');

  // A draft holds nothing, and fails only when it is confirmed.
  const draft = await createBooking(stay(u1.id, '2026-11-15', '2026-11-20'));
  assert.equal(draft.status, 'draft');
  await assert.rejects(confirmBooking(draft.id), /already booked/);
  await assert.rejects(updateBooking(next.id, { start_date: '2026-11-25' }), /already booked/, 'moving a confirmed one is checked too');

  const free = await availability(b.id, '2026-11-10', '2026-11-12');
  assert.equal(free.find((x) => x.id === u1.id).free, false);
  assert.equal(free.find((x) => x.id === u1.id).taken_by.tenant, 'Sara');
  assert.equal(free.find((x) => x.id === u2.id).free, true);

  await cancelBooking(first.id, 'Tenant changed plans');
  await confirmBooking(draft.id);
  assert.equal((await listBookings({ stage: 'cancelled' })).length, 1);
  await assert.rejects(cancelBooking(first.id, 'again'), /Already cancelled/);
  await assert.rejects(cancelBooking(draft.id, ' '), /Say why/);
});

test('blocked units, checks on input, tenants with bookings stay', async () => {
  const { u1, u2 } = await units();
  await update('unit', u2.id, { blocked: true });
  await assert.rejects(createBooking(stay(u2.id, '2026-11-01', '2026-11-30', { status: 'confirmed' })), /blocked/);
  await assert.rejects(createBooking(stay(u1.id, '2026-11-30', '2026-11-01')), /end date is before/);
  await assert.rejects(createBooking(stay(u1.id, '2026-11-01', '2026-11-30', { rent_amount: 0 })), /Enter the rent/);
  await assert.rejects(createBooking(stay(u1.id, '2026-11-01', '2026-11-30', { tenant: {} })), /tenant's name/);

  const t = await addTenant({ full_name: 'Omar Ali', phone: '+971 50 111 2222' });
  const bk = await createBooking({ ...stay(u1.id, '2026-11-01', '2027-10-31'), tenant_id: t.id, tenant: undefined });
  assert.equal(bk.type, 'lease');
  assert.equal((await listTenants('omar'))[0].bookings, 1);
  await assert.rejects(removeTenant(t.id), /has bookings/);
  await removeBooking(bk.id);
  await removeTenant(t.id);
});

test('booking documents: named freely, counted on the booking, gone with a deleted draft', async () => {
  const { u1 } = await units();
  const bk = await createBooking(stay(u1.id, '2026-11-01', '2026-11-30'));
  assert.equal(bk.docs, 0);

  const contract = await addBookingDoc(bk.id, { title: ' Signed contract ', notes: 'Original in the office' });
  assert.equal(contract.title, 'Signed contract');
  assert.equal(contract.has_file, false);
  assert.equal('file_path' in contract, false, 'where the file is kept is never sent out');
  await addBookingDoc(bk.id, { title: 'Emirates ID' });
  await assert.rejects(addBookingDoc(bk.id, {}), /Give the document a name/);
  await assert.rejects(addBookingDoc(999, { title: 'X' }), /Booking not found/);

  assert.deepEqual((await bookingDocs(bk.id)).map((d) => d.title), ['Signed contract', 'Emirates ID']);
  assert.equal((await listBookings())[0].docs, 2);

  await removeBookingDoc(contract.id);
  await assert.rejects(removeBookingDoc(contract.id), /Not found/);
  assert.equal((await bookingDocs(bk.id)).length, 1);

  await removeBooking(bk.id); // its documents go with it
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_documents').get()).n, 0);
});

test('the payment schedule follows the frequency', () => {
  const lease = { start_date: '2026-11-01', end_date: '2027-10-31', rent_amount: '60000', rent_period: 'year' };
  assert.deepEqual(schedule({ ...lease, payment_frequency: 'quarterly' }),
    ['2026-11-01', '2027-02-01', '2027-05-01', '2027-08-01'].map((due) => ({ due, amount: 15000 })));
  assert.deepEqual(schedule({ ...lease, payment_frequency: 'upfront' }), [{ due: '2026-11-01', amount: 60000 }]);
  assert.deepEqual(schedule({ start_date: '2027-01-31', end_date: '2027-03-10', rent_amount: 3000, rent_period: 'month', payment_frequency: 'monthly' }).map((p) => p.due),
    ['2027-01-31', '2027-02-28'], 'a month with no 31st is due on its last day');
});

test('overview: occupancy, rent due and collected, overdue and leases ending come from the bookings', async () => {
  const { b, u1 } = await units();
  await create('unit', { unit_no: '103', blocked: true }, b.id);
  const bk = await createBooking(stay(u1.id, '2026-09-15', '2026-11-14', { status: 'confirmed' }));
  await createBooking(stay(u1.id, '2026-12-01', '2026-12-31')); // a draft counts for nothing
  const at = '2026-10-10';

  let o = await overview({}, at);
  assert.deepEqual(o.units, { total: 3, let: 1, occupied: 0, ending: 0, overdue: 1, vacant: 1, blocked: 1 });
  assert.equal(o.occupancy, 0.5, 'the blocked unit is left out');
  assert.deepEqual(o.monthly.slice(9).map((m) => [m.month, m.due, m.collected, m.inPeriod]),
    [['2026-08', 0, 0, false], ['2026-09', 4500, 0, false], ['2026-10', 4500, 0, true]]);
  assert.deepEqual(o.collection, { due: 4500, collected: 0 });
  assert.deepEqual(o.overdue.rows.map((r) => [r.tenant, r.unit_no, r.owed, r.days_overdue]), [['Sara', '101', 4500, 25]]);
  assert.deepEqual(o.overdue.aging.map((x) => x.amount), [4500, 0, 0, 0]);
  assert.deepEqual(o.dueSoon.map((p) => [p.tenant, p.unit_no, p.rent, p.due_in]), [['Sara', '101', 4500, 5]]);
  assert.deepEqual(o.ending.map((u) => [u.unit_no, u.days_left, u.renewal]), [['101', 35, 'Not renewed']]);
  assert.deepEqual(o.trends.occupancy.slice(9), [0, 0.5, 0.5]);
  assert.deepEqual(o.trends.vacant.slice(9), [2, 1, 1]);
  assert.deepEqual(o.trends.overdue.slice(9), [0, 4500, 4500]);
  assert.deepEqual(o.buildings.map((x) => [x.name, x.total, x.vacant, x.occupancy, x.floors[0].length]), [['Tower', 3, 1, 0.5, 3]]);
  assert.deepEqual(o.activity.map((x) => x.kind).sort(), ['confirmed', 'draft']);
  assert.deepEqual(o.filters, { companies: [{ id: b.company_id, name: 'A' }], buildings: [{ id: b.id, name: 'Tower', company_id: b.company_id }] });

  // Part of September comes in, then the rest.
  const [sep, oct] = await bookingPayments(bk.id, at);
  assert.deepEqual([sep.due_date, sep.status, oct.due_date, oct.status], ['2026-09-15', 'overdue', '2026-10-15', 'upcoming']);
  await recordPayment(sep.id, { amount: 2000, method: 'transfer', received_on: '2026-10-05', reference: 'TT-1' }, null, at);
  await assert.rejects(recordPayment(sep.id, { amount: 2600, method: 'cash' }, null, at), /Only AED 2,500 is still owed/);
  await assert.rejects(recordPayment(sep.id, { amount: 100, method: 'cheque' }, null, at), /bank transfer, cash or card/);
  await assert.rejects(recordPayment(sep.id, { amount: 100, method: 'cash', received_on: '2026-10-11' }, null, at), /in the future/);
  o = await overview({ months: 3 }, at);
  assert.deepEqual(o.collection, { due: 9000, collected: 2000 });
  assert.equal(o.overdue.total, 2500);
  assert.deepEqual(o.methods.map((m) => [m.key, m.amount]), [['transfer', 2000], ['cash', 0], ['card', 0]]);
  assert.deepEqual(o.trends.overdue.slice(10), [4500, 2500], 'what was owed at the end of September is not changed by a payment in October');
  assert.ok(o.activity.some((x) => x.kind === 'payment' && x.amount === 2000));

  const cash = await recordPayment(sep.id, { amount: 2500, method: 'cash' }, null, at);
  await assert.rejects(recordPayment(sep.id, { amount: 1, method: 'cash' }, null, at), /already paid in full/);
  o = await overview({}, at);
  assert.equal(o.overdue.rows.length, 0);
  assert.deepEqual([o.units.ending, o.units.overdue], [1, 0]);
  assert.deepEqual((await bookingPayments(bk.id, at)).map((r) => [r.status, r.paid, r.left, r.payments.length]), [['paid', 4500, 0, 2], ['upcoming', 0, 4500, 0]]);

  // With money recorded the terms are fixed; the end date can still move, and paid rows stay.
  await assert.rejects(updateBooking(bk.id, { rent_amount: 5000 }), /Payments are recorded/);
  await updateBooking(bk.id, { end_date: '2026-12-14', rent_amount: 4500 });
  assert.deepEqual((await bookingPayments(bk.id, at)).map((r) => [r.due_date, r.paid]), [['2026-09-15', 4500], ['2026-10-15', 0], ['2026-11-15', 0]]);
  await removePayment(cash.id);
  assert.equal((await overview({}, at)).overdue.total, 2500);

  // Cancelled: what had fallen due is still owed (the rest of September); October and November are taken off.
  await cancelBooking(bk.id, 'Left early', null, at);
  o = await overview({ months: 3 }, at);
  assert.deepEqual([o.overdue.total, o.collection.due, o.collection.collected, o.units.vacant], [2500, 4500, 2000, 2]);
  assert.deepEqual((await bookingPayments(bk.id, at)).map((r) => [r.due_date, r.amount, r.left, r.status]), [['2026-09-15', 4500, 2500, 'overdue']]);
  assert.deepEqual((await listAlerts({}, at)).filter((a) => a.rule === 'overdue').map((a) => [a.tenant, a.amount]), [['Sara', 2500]], 'and it is still chased');
  assert.equal((await report('rent-roll', {}, at)).summary.at(-1).value, 2500, 'the rent roll says what a tenant who left still owes');

  assert.equal(o.missingContracts, 0);
  const again = await createBooking(stay(u1.id, '2026-10-01', '2026-10-31', { status: 'confirmed' }));
  assert.equal((await overview({}, at)).missingContracts, 1);
  await addBookingDoc(again.id, { title: 'Signed contract' });
  assert.equal((await overview({}, at)).missingContracts, 0);
  assert.equal((await overview({ building_id: b.id + 1 }, at)).units.total, 0);
});
