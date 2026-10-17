import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { addTenant, createBooking, getBooking, updateBooking, takePayment, schedule } from '../server/leasing.js';
import { create } from '../server/properties.js';

test.after(() => closeDb());

const B = { rent_amount: 1100, rent_period: 'month', payment_frequency: 'monthly', prorate: null, tax_percent: null };

test('prorated at move-in: the part month on the move-in day, then the 1st', () => {
  const s = schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' });
  assert.deepEqual([s[0].due, s[0].amount], ['2026-10-17', 532.26]);
  assert.deepEqual([s[1].due, s[1].amount], ['2026-11-01', 1100]);
  assert.deepEqual([s.at(-1).due, s.at(-1).amount, s.length], ['2027-10-01', 1100, 13]);
});

test('prorated from the 2nd month: a full month at move-in, the part month on the next 1st', () => {
  const s = schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'second' });
  assert.deepEqual(s.slice(0, 3).map((r) => [r.due, r.amount]), [['2026-10-17', 1100], ['2026-11-01', 532.26], ['2026-12-01', 1100]]);
  assert.deepEqual([s.at(-1).due, s.length, Math.round(s.reduce((t, r) => t + r.amount, 0) * 100) / 100], ['2027-10-01', 13, 13732.26]);
});

test('the edges of a month', () => {
  assert.equal(schedule({ ...B, start_date: '2026-10-31', end_date: '2027-10-31', prorate: 'first' })[0].amount, 35.48); // 1 day of 31
  assert.equal(schedule({ ...B, start_date: '2027-02-15', end_date: '2028-01-31', prorate: 'first' })[0].amount, 550); // 14 of 28 days
  assert.equal(schedule({ ...B, start_date: '2028-02-15', end_date: '2029-01-31', prorate: 'first' })[0].amount, 568.97); // 15 of 29 days
  const short = schedule({ ...B, start_date: '2026-10-17', end_date: '2026-10-31', prorate: 'second' });
  assert.deepEqual(short.map((r) => [r.due, r.amount]), [['2026-10-17', 532.26]]); // no next 1st: billed at move-in
  const mid = schedule({ ...B, start_date: '2026-11-01', end_date: '2027-04-15', prorate: 'first' });
  assert.deepEqual([mid[0].amount, mid.at(-1).due, mid.at(-1).amount], [1100, '2027-04-01', 550]); // 15 of 30
});

test('yearly rent, tax, and no proration', () => {
  assert.equal(schedule({ ...B, rent_amount: 13200, rent_period: 'year', start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' })[0].amount, 532.26);
  assert.equal(schedule({ ...B, tax_percent: 8.25, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' })[0].amount, 576.17); // 532.26 + 43.91
  assert.equal(schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-16', prorate: null })[1].due, '2026-11-17'); // as today
  assert.equal(schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-16', prorate: 'first', payment_frequency: 'quarterly' })[1].due, '2027-01-17');
});

test('a prorated lease in the database: its charges, its checks, and its deposit', async () => {
  await reset();
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'Gates' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, bl.id);
  const u2 = await create('unit', { unit_no: '102' }, bl.id);
  const t = await addTenant({ full_name: 'Sara Lee' });
  const lease = (unit, extra) => createBooking({ unit_id: unit.id, tenant_id: t.id, start_date: '2026-10-17', end_date: '2027-10-31', rent_amount: 1100,
    payment_frequency: 'monthly', security_deposit: 500, fees: [{ label: 'Pet', amount: 50, repeats: true }], status: 'confirmed', ...extra });
  const rows = async (id, kind) => (await db.prepare("SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due, amount FROM lease_installments WHERE booking_id = ? AND kind = ? ORDER BY due_date").all(id, kind))
    .map((r) => ({ ...r, amount: Number(r.amount) }));

  const first = await lease(u1, { prorate: 'first' });
  assert.equal((await getBooking(first.id)).prorate, 'first');
  const fee = (await rows(first.id, 'fee'))[0];
  // A repeating charge is its whole price on the part month too, as Rent Manager bills it.
  assert.deepEqual([fee.due, fee.amount], ['2026-10-17', 50]);
  assert.equal((await rows(first.id, 'rent'))[0].amount, 532.26);
  assert.equal((await rows(first.id, 'deposit'))[0].due, '2026-10-17');

  const second = await lease(u2, { prorate: 'second' });
  const fees = await rows(second.id, 'fee');
  assert.deepEqual(fees.slice(0, 2).map((f) => [f.due, f.amount]), [['2026-10-17', 50], ['2026-11-01', 50]]);
  assert.equal((await rows(second.id, 'deposit'))[0].due, '2026-10-17');

  await assert.rejects(lease(u1, { prorate: 'first', payment_frequency: 'quarterly', status: 'draft' }), /Proration needs monthly payments/);
  await assert.rejects(lease(u1, { prorate: 'weekly', status: 'draft' }), /Unknown proration/);
  await assert.rejects(updateBooking(first.id, { payment_frequency: 'quarterly' }), /Proration needs monthly payments/);

  const rent = (await rows(first.id, 'rent'))[0];
  await takePayment(rent.id, { amount: rent.amount, method: 'cash', received_on: '2026-10-17' }, null, '2026-10-17');
  await assert.rejects(updateBooking(first.id, { prorate: 'second' }), (e) => e.status === 409);
});

test('a lease that does not prorate is billed exactly as before', async () => {
  await reset();
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'Gates' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, bl.id);
  const u2 = await create('unit', { unit_no: '102' }, bl.id);
  const t = await addTenant({ full_name: 'Sara Lee' });
  const fees = async (id) => (await db.prepare("SELECT to_char(due_date, 'YYYY-MM-DD') AS due, amount FROM lease_installments WHERE booking_id = ? AND kind = 'fee' ORDER BY due_date").all(id))
    .map((r) => [r.due, Number(r.amount)]);
  // A repeating charge stays its own amount with each payment, however many months the payment covers.
  const q = await createBooking({ unit_id: u1.id, tenant_id: t.id, start_date: '2026-10-17', end_date: '2027-10-16', rent_amount: 1100,
    payment_frequency: 'quarterly', fees: [{ label: 'Pet', amount: 50, repeats: true }], status: 'confirmed' });
  assert.deepEqual(await fees(q.id), [['2026-10-17', 50], ['2027-01-17', 50], ['2027-04-17', 50], ['2027-07-17', 50]]);
  const m = await createBooking({ unit_id: u2.id, tenant_id: t.id, start_date: '2026-10-17', end_date: '2027-10-16', rent_amount: 1100,
    payment_frequency: 'monthly', fees: [{ label: 'Pet', amount: 50, repeats: true }], status: 'confirmed' });
  assert.equal((await getBooking(m.id)).prorate, null);
  const rent = await db.prepare("SELECT to_char(due_date, 'YYYY-MM-DD') AS due, amount FROM lease_installments WHERE booking_id = ? AND kind = 'rent' ORDER BY due_date").all(m.id);
  assert.deepEqual([rent.length, rent[0].due, Number(rent[0].amount), rent[1].due], [12, '2026-10-17', 1100, '2026-11-17']);
  assert.ok((await fees(m.id)).every(([, a]) => a === 50));
  // An imported lease keeps its own schedule even if prorate were set on it.
  assert.equal(schedule({ ...B, start_date: '2026-08-17', end_date: '2027-01-31', billed_from: '2026-11-01', prorate: 'first' })[0].due, '2026-11-01');
});
