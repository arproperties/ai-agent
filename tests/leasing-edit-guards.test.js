import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser, giveActions } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingPayments, recordPayment } from '../server/leasing.js';

test.after(() => closeDb());

// A confirmed lease: rent 900 from 1 October, water 40 a month, a 150 deposit. Diana may add and edit, not delete.
async function lease() {
  await reset();
  const diana = await makeUser('Diana');
  await giveActions(diana, 'add', 'edit');
  const boss = await makeUser('Boss');
  await giveActions(boss, 'add', 'edit', 'delete');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-10-01', end_date: '2027-01-31', rent_amount: 900, security_deposit: 150, status: 'confirmed',
    fees: [{ label: 'Water', amount: 40, repeats: true }, { label: 'Pet fee', amount: 200 }], tenant: { full_name: 'Sara', phone: '050 123 4567' } }, boss);
  return { diana, boss, bk };
}
const WATER = { label: 'Water', amount: 40, repeats: true };
const PET = { label: 'Pet fee', amount: 200 };

test('taking a charge, a rent line or the deposit off needs Delete', async () => {
  const { diana, boss, bk } = await lease();
  await assert.rejects(updateBooking(bk.id, { fees: [PET] }, diana), (e) => e.status === 403 && /Water/.test(e.message));
  await assert.rejects(updateBooking(bk.id, { security_deposit: '' }, diana), /security deposit.*Delete/);
  const two = [{ label: 'Rent', amount: 900, until: '2026-12-31' }, { label: 'Rent', amount: 950, from: '2027-01-01' }];
  await updateBooking(bk.id, { rent_amount: 900, rent_lines: two }, diana); // a rent line added: an edit
  await assert.rejects(updateBooking(bk.id, { rent_amount: 900, rent_lines: [two[0]] }, diana), (e) => e.status === 403 && /rent line/.test(e.message));
  // Changing an amount, a date or adding a line is an edit.
  await updateBooking(bk.id, { fees: [{ ...WATER, amount: 45 }, PET, { label: 'Parking', amount: 30, repeats: true }] }, diana);
  // The boss may take it off.
  const now = await updateBooking(bk.id, { fees: [PET] }, boss);
  assert.deepEqual(now.fees.map((f) => f.label), ['Pet fee']);
});

test('a paid line cannot be lowered below what was paid, nor taken off; raising it is fine', async () => {
  const { boss, bk } = await lease();
  const pet = (await bookingPayments(bk.id, '2026-10-01')).find((r) => r.name === 'Pet fee');
  await recordPayment(pet.id, { amount: 200, method: 'cash', received_on: '2026-10-01' }, boss, '2026-10-01');
  await assert.rejects(updateBooking(bk.id, { fees: [WATER, { ...PET, amount: 150 }] }, boss), (e) => e.status === 409 && /Pet fee due 10\/01\/2026 has .*200.* paid/.test(e.message));
  await assert.rejects(updateBooking(bk.id, { fees: [WATER] }, boss), /Pet fee .* paid/);
  await updateBooking(bk.id, { fees: [WATER, { ...PET, amount: 250 }] }, boss);
  const after = (await bookingPayments(bk.id, '2026-10-01')).find((r) => r.name === 'Pet fee');
  assert.equal(after.amount, 250);
  // Nothing was changed by the refused edits: the lease still has both charges.
  assert.equal((await bookingPayments(bk.id, '2026-10-01')).filter((r) => r.name === 'Water').length, 4);
});
