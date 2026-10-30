import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingPayments, recordPayment } from '../server/leasing.js';
import { saveSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

// Rent typed in two parts: Tenant 500 + HUD/Agency 272, so the lease's rent is 772. From Tue 15 September 2026, due the 15th.
async function split(extra = {}) {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 772, rent_amount_2: 272, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' }, ...extra }, staff);
  return { staff, bk };
}
const rents = async (id, day = '2026-09-15') => (await bookingPayments(id, day)).filter((r) => r.kind === 'rent').map((r) => [r.due_date, r.name, r.amount]);

test('each month bills two rent lines, one per part, that add up to the rent', async () => {
  const { bk } = await split();
  assert.equal(bk.rent_amount_2, 272);
  assert.deepEqual(await rents(bk.id), [
    ['2026-09-15', 'Rent', 500], ['2026-09-15', 'Rent · HUD/Agency', 272],
    ['2026-10-15', 'Rent', 500], ['2026-10-15', 'Rent · HUD/Agency', 272],
  ]);
});

test('a taxed lease splits the tax with the rent, and the two lines still add up exactly', async () => {
  const { bk } = await split({ rent_amount: 1000, rent_amount_2: 333, tax_percent: 8.25 });
  const sep = (await bookingPayments(bk.id, '2026-09-15')).filter((r) => r.kind === 'rent' && r.due_date === '2026-09-15');
  assert.equal(sep.reduce((t, r) => t + r.amount, 0).toFixed(2), '1082.50');
  assert.equal(sep.reduce((t, r) => t + r.tax, 0).toFixed(2), '82.50');
});

test('with no HUD/Agency part (empty or 0) the rent stays one line; taking it off an unpaid lease makes it one again', async () => {
  const { staff, bk } = await split();
  await updateBooking(bk.id, { rent_amount: 772, rent_amount_2: '' }, staff);
  assert.deepEqual(await rents(bk.id), [['2026-09-15', 'Rent', 772], ['2026-10-15', 'Rent', 772]]);
});

test('once paid, the split cannot change', async () => {
  const { staff, bk } = await split();
  const [one] = await bookingPayments(bk.id, '2026-09-15');
  await recordPayment(one.id, { amount: 500, method: 'cash', received_on: '2026-09-15' }, staff, '2026-09-15');
  await assert.rejects(updateBooking(bk.id, { rent_amount: 772, rent_amount_2: 300 }, staff), /Tenant \/ HUD split/);
});

test('late fees: one fee a month, on both parts together; none once both are paid in the grace', async () => {
  const { staff, bk } = await split();
  await saveSettings({ latefee: { on: true } }, '2026-09-01');
  const fees = async (day) => (await bookingPayments(bk.id, day)).filter((r) => r.kind === 'late').map((r) => [r.label, r.amount]);
  const [one, two] = (await bookingPayments(bk.id, '2026-09-15')).filter((r) => r.kind === 'rent');
  await recordPayment(one.id, { amount: 500, method: 'cash', received_on: '2026-09-16' }, staff, '2026-09-16');
  assert.deepEqual(await fees('2026-09-19'), [['2026-09-15', 50]], 'HUD/Agency still owed: the month is late');
  await recordPayment(two.id, { amount: 272, method: 'cash', received_on: '2026-09-17' }, staff, '2026-09-19');
  assert.deepEqual(await fees('2026-09-19'), [], 'both paid within the grace: no fee');
});
