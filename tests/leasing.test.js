import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db } from './helpers/db.js';
import { create, update } from '../server/properties.js';
import { addTenant, removeTenant, listTenants, createBooking, updateBooking, confirmBooking, cancelBooking, removeBooking,
  listBookings, availability, suggestType, bookingStage, bookingDocs, addBookingDoc, removeBookingDoc } from '../server/leasing.js';

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
