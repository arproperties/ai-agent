import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create, listUnits } from '../server/properties.js';
import { addTenant, createBooking, getBooking, updateBooking, bookingPayments, payBooking } from '../server/leasing.js';

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
