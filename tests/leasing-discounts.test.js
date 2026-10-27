import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { addTenant, createBooking, getBooking, updateBooking, takePayment, schedule } from '../server/leasing.js';
import { create } from '../server/properties.js';

test.after(() => closeDb());

const B = { rent_amount: 1100, rent_period: 'month', payment_frequency: 'monthly', prorate: 'first', tax_percent: null, start_date: '2026-08-17', end_date: '2027-01-31' };
const rows = (s) => s.map((r) => [r.due, r.amount]);

test('a discount with no dates comes off every month, the prorated one by its days', () => {
  const s = schedule({ ...B, discounts: [{ amount: 100 }] });
  assert.deepEqual(rows(s).slice(0, 3), [['2026-08-17', 483.87], ['2026-09-01', 1000], ['2026-10-01', 1000]]); // 15 of 31 days of 1000
  assert.equal(s.length, 6);
});

test('a discount from a date leaves the months before it as they were', () => {
  const s = schedule({ ...B, discounts: [{ amount: 100, from: '2026-11-01' }] });
  assert.deepEqual(rows(s), [['2026-08-17', 532.26], ['2026-09-01', 1100], ['2026-10-01', 1100], ['2026-11-01', 1000], ['2026-12-01', 1000], ['2027-01-01', 1000]]);
  const some = schedule({ ...B, discounts: [{ amount: 100, from: '2026-11-01', until: '2026-12-31' }, { amount: 50, from: '2026-12-01' }] });
  assert.deepEqual(some.slice(3).map((r) => r.amount), [1000, 950, 1050]);
});

test('tax is on the rent after the discount; a quarter counts its months', () => {
  assert.equal(schedule({ ...B, tax_percent: 10, discounts: [{ amount: 100, from: '2026-09-01' }] })[1].amount, 1100); // 1000 + 100 tax
  const q = schedule({ ...B, prorate: null, payment_frequency: 'quarterly', start_date: '2026-09-01', end_date: '2027-08-31', discounts: [{ amount: 100, from: '2026-11-01' }] });
  assert.deepEqual(q.map((r) => r.amount), [3200, 3000, 3000, 3000]); // Sep, Oct full; Nov on 100 off
});

test('a discount on a lease with payments: only rent not yet paid changes', async () => {
  await reset();
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'Gates' }, c.id);
  const u = await create('unit', { unit_no: '101' }, bl.id);
  const t = await addTenant({ full_name: 'James Dickerson' });
  const lease = await createBooking({ unit_id: u.id, tenant_id: t.id, ...B, status: 'confirmed' });
  const rent = async () => (await db.prepare("SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due, amount FROM lease_installments WHERE booking_id = ? AND kind = 'rent' ORDER BY due_date").all(lease.id))
    .map((r) => ({ ...r, amount: Number(r.amount) }));
  for (const r of (await rent()).slice(0, 3)) await takePayment(r.id, { amount: r.amount, method: 'cash', received_on: r.due }, null, r.due);

  await assert.rejects(updateBooking(lease.id, { discounts: [{ amount: 100, from: '2026-10-01' }] }), /10\/01\/2026 is already paid/);
  await assert.rejects(updateBooking(lease.id, { discounts: [{ amount: 100 }] }), (e) => e.status === 409);
  await assert.rejects(updateBooking(lease.id, { discounts: [{ amount: 1100, from: '2026-11-01' }] }), /less than the rent/);
  await assert.rejects(updateBooking(lease.id, { discounts: [{ amount: 100, from: '2026-12-01', until: '2026-11-01' }] }), /ends before it starts/);

  const now = await updateBooking(lease.id, { discounts: [{ amount: 100, from: '2026-11-01', note: 'tenant asked' }] });
  assert.deepEqual(now.discounts, [{ amount: 100, from: '2026-11-01', note: 'tenant asked' }]);
  assert.deepEqual((await rent()).map((r) => r.amount), [532.26, 1100, 1100, 1000, 1000, 1000]);
  assert.deepEqual((await getBooking(lease.id)).discounts.length, 1);
  // Taking it off again puts the rent back, still leaving the paid months alone.
  await updateBooking(lease.id, { discounts: [] });
  assert.deepEqual((await rent()).map((r) => r.amount), [532.26, 1100, 1100, 1100, 1100, 1100]);
});
