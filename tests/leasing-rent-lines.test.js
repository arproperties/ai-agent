import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingPayments, recordPayment } from '../server/leasing.js';

test.after(() => closeDb());

// Rent as dated lines: Tenant 3 and HUD 828 to 15 November, then Tenant 50 and HUD 781. 15 September to 14 January, due the 15th.
const LINES = [
  { label: 'Rent – Tenant', amount: 3, until: '2026-11-14', hud: false },
  { label: 'Rent – HUD/Agency', amount: 828, until: '2026-11-14', hud: true },
  { label: 'Rent – Tenant', amount: 50, from: '2026-11-15', hud: false },
  { label: 'Rent – HUD/Agency', amount: 781, from: '2026-11-15', hud: true },
];
async function lease(lines = LINES) {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2027-01-14', rent_amount: 831, rent_amount_2: 828, rent_lines: lines, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  return { staff, bk };
}
const rents = async (id) => (await bookingPayments(id, '2026-09-15')).filter((r) => r.kind === 'rent').map((r) => [r.due_date, r.name, r.amount]);

test('each month bills the rent lines it falls in, Tenant and HUD/Agency apart', async () => {
  const { bk } = await lease();
  assert.equal(bk.rent_lines.length, 4);
  assert.deepEqual(await rents(bk.id), [
    ['2026-09-15', 'Rent · Tenant', 3], ['2026-09-15', 'Rent · HUD/Agency', 828],
    ['2026-10-15', 'Rent · Tenant', 3], ['2026-10-15', 'Rent · HUD/Agency', 828],
    ['2026-11-15', 'Rent · Tenant', 50], ['2026-11-15', 'Rent · HUD/Agency', 781],
    ['2026-12-15', 'Rent · Tenant', 50], ['2026-12-15', 'Rent · HUD/Agency', 781],
  ]);
});

test('a month only HUD pays is their line alone; a month no line covers bills no rent', async () => {
  const { bk } = await lease([
    { label: 'Rent – HUD/Agency', amount: 828, until: '2026-10-14', hud: true },
    { label: 'Rent', amount: 900, from: '2026-11-15' },
  ]);
  assert.deepEqual(await rents(bk.id), [
    ['2026-09-15', 'Rent · HUD/Agency', 828],
    ['2026-11-15', 'Rent · Tenant', 900], ['2026-12-15', 'Rent · Tenant', 900],
  ]);
});

test('HUD changing after a paid month is fine; changing a paid month is refused', async () => {
  const { staff, bk } = await lease();
  const [one] = await bookingPayments(bk.id, '2026-09-15');
  await recordPayment(one.id, { amount: 3, method: 'cash', received_on: '2026-09-15' }, staff, '2026-09-15');
  const later = LINES.map((l) => (l.until ? { ...l, until: '2026-12-14' } : { ...l, from: '2026-12-15' }));
  await updateBooking(bk.id, { rent_amount: 831, rent_amount_2: 828, rent_lines: later }, staff);
  assert.deepEqual((await rents(bk.id)).filter(([d]) => d === '2026-11-15').map((r) => r[2]), [3, 828]);
  const sooner = [{ ...LINES[0], amount: 10 }, ...LINES.slice(1)];
  await assert.rejects(updateBooking(bk.id, { rent_amount: 838, rent_amount_2: 828, rent_lines: sooner }, staff), /already paid|cannot change/);
});

test('a rent typed as one amount (no rent lines) clears the lines and bills as before', async () => {
  const { staff, bk } = await lease();
  const now = await updateBooking(bk.id, { rent_amount: 900, rent_amount_2: '' }, staff);
  assert.equal(now.rent_lines, null);
  assert.deepEqual((await rents(bk.id)).map((r) => r[2]), [900, 900, 900, 900]);
});
