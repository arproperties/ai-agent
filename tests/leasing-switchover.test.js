import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create, listUnits } from '../server/properties.js';
import { addTenant, createBooking, getBooking, updateBooking, bookingPayments, payBooking, addCharge, ledger, depositState, METHODS, NOT_RENT_MANAGER, overview } from '../server/leasing.js';
import { db } from './helpers/db.js';
import { receiptPdf } from '../server/leasingReceipt.js';
import { report as runReport } from '../server/leasingReports.js';

test.after(() => closeDb());

// A lease Rent Manager already billed up to a switch-over 1st: this app bills it from then on.
async function setup() {
  await reset();
  const staff = await makeUser('Diana');
  const c = await create('company', { name: 'J&R' });
  const bl = await create('building', { name: 'The Gates at Sour Lake' }, c.id);
  const u = await create('unit', { unit_no: 'GSL 101' }, bl.id);
  const t = await addTenant({ full_name: 'James Dickerson', phone: '(205) 913-7626' });
  const base = { unit_id: u.id, tenant_id: t.id, start_date: '2025-03-01', end_date: '2027-02-28', rent_amount: 1000, rent_period: 'month',
    payment_frequency: 'monthly', status: 'confirmed' };
  return { staff, bl, base };
}

test('a lease from Rent Manager bills only from the switch-over 1st', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  const rent = (await bookingPayments(bk.id, '2026-10-30')).filter((r) => r.kind === 'rent');
  assert.deepEqual(rent.map((r) => r.due_date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  const b = await getBooking(bk.id);
  assert.equal(b.import_batch, 'rent-manager-by-hand');
  assert.equal(b.moved_in, true);
});
test('billed_from must be a 1st inside the lease', async () => {
  const { staff, base } = await setup();
  await assert.rejects(createBooking({ ...base, billed_from: '2026-11-15' }, staff), /1st of a month/);
  await assert.rejects(createBooking({ ...base, billed_from: '2025-01-01' }, staff), /inside the lease/);
  await assert.rejects(createBooking({ ...base, billed_from: '2027-03-01' }, staff), /inside the lease/);
});
test('without billed_from a lease bills from its start as before', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking(base, staff);
  assert.equal((await bookingPayments(bk.id, '2026-10-30')).find((r) => r.kind === 'rent').due_date, '2025-03-01');
});
test('a Rent Manager lease is not move-in due on the unit list', async () => {
  const { staff, base, bl } = await setup();
  await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  assert.equal((await listUnits(bl.id, '2026-10-30'))[0].move_in_due, false);
});
test('the old deposit sits on its real date', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true, security_deposit: 500, deposit_due: '2023-04-01' }, staff);
  assert.equal((await bookingPayments(bk.id, '2026-10-30')).find((r) => r.kind === 'deposit').due_date, '2023-04-01');
});
test('billed_from cannot move once rent is paid', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  await payBooking(bk.id, { amount: 1000, method: 'cash', received_on: '2026-11-01' }, staff, '2026-11-02');
  await assert.rejects(updateBooking(bk.id, { billed_from: '2026-12-01' }, staff), /Payments are recorded/);
});

test('an opening credit and an old deposit are recorded as Paid in Rent Manager', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true, security_deposit: 500, deposit_due: '2023-04-01' }, staff);
  await payBooking(bk.id, { amount: 500, method: 'rent_manager', received_on: '2023-04-01' }, staff, '2026-10-30');
  assert.equal((await depositState(bk.id)).held, 500);
  await payBooking(bk.id, { amount: 200, method: 'rent_manager', received_on: '2026-10-31', keep_credit: true }, staff, '2026-10-31');
  assert.equal((await ledger(bk.id, '2026-10-31')).balance, -200);
});
test('an opening balance is one charge', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  await addCharge(bk.id, { label: 'Balance brought forward from Rent Manager', due_date: '2026-10-31', amount: 777.5 }, staff);
  assert.equal((await ledger(bk.id, '2026-10-31')).balance, 777.5);
});
test('Paid in Rent Manager is a method, with a SQL filter for the other modules', () => {
  assert.deepEqual(METHODS.find(([k]) => k === 'rent_manager'), ['rent_manager', 'Paid in Rent Manager']);
  assert.equal(NOT_RENT_MANAGER, "p.method <> 'rent_manager'");
});
test('a Rent Manager payment has no receipt', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true, security_deposit: 500, deposit_due: '2023-04-01' }, staff);
  await payBooking(bk.id, { amount: 500, method: 'rent_manager', received_on: '2023-04-01' }, staff, '2026-10-30');
  await payBooking(bk.id, { amount: 100, method: 'cash', received_on: '2026-10-30', keep_credit: true }, staff, '2026-10-30');
  const rm = await db.prepare("SELECT id FROM lease_payments WHERE method = 'rent_manager'").get();
  const cash = await db.prepare("SELECT id FROM lease_payments WHERE method = 'cash'").get();
  await assert.rejects(receiptPdf(rm.id), /no receipt/);
  assert.ok(await receiptPdf(cash.id));
});
test('reports leave Rent Manager money out of what was received', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  await payBooking(bk.id, { amount: 300, method: 'rent_manager', received_on: '2026-10-29', keep_credit: true }, staff, '2026-10-30');
  await payBooking(bk.id, { amount: 100, method: 'cash', received_on: '2026-10-29', keep_credit: true }, staff, '2026-10-30');
  const c = await runReport('collections', { from: '2026-10-01', to: '2026-10-30' }, '2026-10-30');
  assert.equal(c.rows.length, 1);
  assert.equal(c.total.amount, 100);
  const d = await runReport('daily', { day: '2026-10-29' }, '2026-10-30');
  assert.equal(d.rows.filter((r) => r.what === 'Payment received').length, 1);
});
test('the dashboard counts only money received here, not Rent Manager money', async () => {
  const { staff, base } = await setup();
  const bk = await createBooking({ ...base, start_date: '2026-10-01', end_date: '2027-09-30' }, staff);
  await payBooking(bk.id, { amount: 300, method: 'rent_manager', received_on: '2026-10-02' }, staff, '2026-10-30');
  await payBooking(bk.id, { amount: 400, method: 'cash', received_on: '2026-10-03', keep_credit: true }, staff, '2026-10-30');
  const o = await overview({}, '2026-10-30');
  assert.equal(o.methods.reduce((t, m) => t + m.amount, 0), 400);
  assert.equal(o.methods.some((m) => m.key === 'rent_manager'), false);
  assert.equal(o.collection.collected, 400);
});
