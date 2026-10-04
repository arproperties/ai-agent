import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { existsSync } from 'node:fs';
import { createBooking, updateBooking, bookingPayments, recordPayment, removePayment, attachPaymentFile, overview, depositState, settleDeposit, renewBooking, bookingHistory, listBookings, listServices, addService, updateService, removeService } from '../server/leasing.js';
import { receiptRow, renderReceipt, inWords } from '../server/leasingReceipt.js';
import { tenantReminder, noteReminder, saveWording, whatsappNumber } from '../server/leasingAlerts.js';
import { importBookings } from '../server/leasingImport.js';
import { leasingKit } from '../server/leasingKit.js';
import { saveRegion, region, todayHere, hourHere, cash } from '../server/leasingRegion.js';

test.after(() => closeDb());

const AT = '2026-10-10';

async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE', trn: '100200300' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, b.id);
  return { staff, c, b, u1 };
}
const sara = (unit_id, extra = {}) => ({ unit_id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
  tenant: { full_name: 'Sara', phone: '050 123 4567', email: 'sara@example.com' }, ...extra });

test('deposit and other charges are on the schedule; the deposit is settled at check-out', async () => {
  const { staff, u1 } = await tower();
  await assert.rejects(createBooking(sara(u1.id, { fees: [{ label: '', amount: 500 }] })), /needs a name and an amount/);
  const bk = await createBooking(sara(u1.id, { security_deposit: 5000, fees: [{ label: 'Admin fee', amount: 500 }] }), staff);
  assert.deepEqual(bk.fees, [{ label: 'Admin fee', amount: 500 }]);

  const rows = await bookingPayments(bk.id, AT);
  assert.deepEqual(rows.map((r) => [r.name, r.due_date, r.amount, r.status]),
    [['Security deposit', '2026-09-15', 5000, 'overdue'], ['Admin fee', '2026-09-15', 500, 'overdue'], ['Rent', '2026-09-15', 4500, 'overdue'], ['Rent', '2026-10-15', 4500, 'upcoming']]);
  const o = await overview({ months: 3 }, AT);
  assert.deepEqual([o.collection.due, o.overdue.total], [9000, 10000], 'the rent chart counts rent only; what is owed counts everything');

  assert.equal((await depositState(bk.id)).status, 'unpaid');
  await assert.rejects(settleDeposit(bk.id, { refunded: 0, note: 'x' }, staff, AT), /No deposit has been received/);
  await recordPayment(rows[0].id, { amount: 5000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  assert.deepEqual(await depositState(bk.id), { amount: 5000, held: 5000, refunded: null, note: null, settled_on: null, status: 'held' });
  await assert.rejects(settleDeposit(bk.id, { refunded: 4000 }, staff, AT), /Say what was deducted/);
  await assert.rejects(settleDeposit(bk.id, { refunded: 6000, note: 'x' }, staff, AT), /between 0 and AED 5,000/);
  const d = await settleDeposit(bk.id, { refunded: 4000, note: 'Repainting' }, staff, AT);
  assert.deepEqual([d.status, d.refunded, d.note, d.settled_on], ['partly_refunded', 4000, 'Repainting', AT]);

  // A changed deposit rebuilds the unpaid rows only: the paid deposit row stays as it was.
  await updateBooking(bk.id, { fees: [] }, staff);
  assert.deepEqual((await bookingPayments(bk.id, AT)).map((r) => r.name), ['Security deposit', 'Rent', 'Rent']);
});

test('a deposit or charge changed after part of it is paid owes what the booking now says', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id, { security_deposit: 5000, fees: [{ label: 'Admin fee', amount: 500 }] }), staff);
  const [deposit, fee] = await bookingPayments(bk.id, AT);
  await recordPayment(deposit.id, { amount: 2000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  await recordPayment(fee.id, { amount: 200, method: 'cash', received_on: '2026-09-15' }, staff, AT);

  await updateBooking(bk.id, { security_deposit: 4000, fees: [] }, staff);
  assert.deepEqual((await bookingPayments(bk.id, AT)).slice(0, 2).map((r) => [r.name, r.amount, r.paid, r.left, r.status]),
    [['Security deposit', 4000, 2000, 2000, 'overdue'], ['Admin fee', 200, 200, 0, 'paid']], 'the charge taken off owes no more than was paid');
  await updateBooking(bk.id, { security_deposit: 1000 }, staff);
  assert.deepEqual((await bookingPayments(bk.id, AT)).slice(0, 1).map((r) => [r.amount, r.left, r.status]), [[2000, 0, 'paid']], 'never less than has come in');
});

test('extra services: a saved list, charged once or with every rent payment', async () => {
  const { staff, u1 } = await tower();
  await assert.rejects(addService({ name: ' ' }, staff), /Give the service a name/);
  await assert.rejects(addService({ name: 'Parking', amount: -5 }, staff), /above zero/);
  const parking = await addService({ name: 'Parking', amount: 300, repeats: true }, staff);
  const pet = await addService({ name: 'Pet fee' }, staff); // made from the booking form: no price yet
  await assert.rejects(addService({ name: 'pet FEE' }, staff), /already has a service with that name/);
  assert.deepEqual((await listServices()).map((s) => [s.name, s.amount, s.repeats]), [['Parking', 300, true], ['Pet fee', null, false]]);

  const bk = await createBooking(sara(u1.id, { fees: [{ label: 'Parking', amount: 250, repeats: true }, { label: 'Pet fee', amount: 800 }] }), staff);
  assert.deepEqual(bk.fees, [{ label: 'Parking', amount: 250, repeats: true }, { label: 'Pet fee', amount: 800 }]);
  assert.deepEqual((await bookingPayments(bk.id, AT)).map((r) => [r.name, r.due_date, r.amount]),
    [['Parking', '2026-09-15', 250], ['Pet fee', '2026-09-15', 800], ['Rent', '2026-09-15', 4500], ['Parking', '2026-10-15', 250], ['Rent', '2026-10-15', 4500]]);
  assert.deepEqual((await listServices()).map((s) => [s.name, s.amount]), [['Parking', 300], ['Pet fee', 800]], 'the first price charged becomes the usual one; a set price stays');

  const next = await renewBooking(bk.id, staff);
  assert.deepEqual(next.fees, [{ label: 'Parking', amount: 250, repeats: true }], 'only a charge that repeats carries on into the renewal');

  assert.equal((await updateService(pet.id, { name: 'Pets', amount: '' })).amount, null);
  await assert.rejects(updateService(pet.id, { name: 'parking' }), /already has a service with that name/);
  await removeService(parking.id);
  await assert.rejects(removeService(parking.id), /Service not found/);
  assert.deepEqual((await bookingPayments(bk.id, AT)).map((r) => r.name), ['Parking', 'Pet fee', 'Rent', 'Parking', 'Rent'], 'a booking keeps its charges when the list changes');
});

test('each building has its own services and prices; a booking learns the price in its own building', async () => {
  const { staff, c, b, u1 } = await tower();
  const marina = await create('building', { name: 'Marina' }, c.id);
  const here = await addService({ name: 'Parking', amount: 300, repeats: true, building_id: b.id }, staff);
  const there = await addService({ name: 'Parking', amount: 500, repeats: true, building_id: marina.id }, staff);
  await addService({ name: 'Pet fee', building_id: marina.id }, staff);
  const pet = await addService({ name: 'Pet fee', building_id: b.id }, staff);
  await assert.rejects(addService({ name: 'parking', building_id: b.id }, staff), /already has a service with that name/);
  await assert.rejects(addService({ name: 'Gym', building_id: 9999 }, staff), /Building not found/);

  assert.deepEqual((await listServices(b.id)).map((s) => [s.name, s.amount, s.building_id]), [['Parking', 300, b.id], ['Pet fee', null, b.id]]);
  assert.deepEqual((await listServices(marina.id)).map((s) => [s.name, s.amount]), [['Parking', 500], ['Pet fee', null]]);
  assert.equal((await listServices()).length, 4);

  // A booking in Tower charges a pet fee: Tower's list learns the price, Marina's does not.
  await createBooking(sara(u1.id, { fees: [{ label: 'Pet fee', amount: 800 }] }), staff);
  assert.deepEqual([(await listServices(b.id)).find((s) => s.id === pet.id).amount, (await listServices(marina.id)).find((s) => s.name === 'Pet fee').amount], [800, null]);
  assert.deepEqual([here.building_id, there.building_id], [b.id, marina.id]);
});

test('renewal, history, the receipt and the reminder to the tenant', async () => {
  const { staff, u1 } = await tower();
  const bk = await createBooking(sara(u1.id), staff);
  const [sep] = await bookingPayments(bk.id, AT);

  const r = await tenantReminder(sep.id, AT);
  assert.match(r.message, /^Dear Sara, rent of AED 4,500 for unit 101, Tower was due on 15 September 2026 and is now 25 days late\./);
  assert.ok(r.whatsapp.startsWith('https://wa.me/971501234567?text=Dear%20Sara'));
  assert.ok(r.mailto.startsWith('mailto:sara@example.com?subject=Overdue'));
  await saveWording({ overdue: 'Hello {tenant}, {amount} is late for {unit}. {nonsense}' });
  assert.equal((await tenantReminder(sep.id, AT)).message, 'Hello Sara, AED 4,500 is late for 101. {nonsense}');
  await assert.rejects(saveWording({ due: 'short' }), /between 20 and 1,000/);
  assert.deepEqual([whatsappNumber('+971 50 123 4567'), whatsappNumber('00971501234567'), whatsappNumber('501234567'), whatsappNumber('12')],
    ['971501234567', '971501234567', '971501234567', null]);
  await noteReminder(sep.id, 'whatsapp', staff);

  const pay = await recordPayment(sep.id, { amount: 4000.5, method: 'transfer', received_on: '2026-10-05', reference: 'TT-9' }, staff, AT);
  const slip = await receiptRow(pay.id);
  assert.deepEqual([slip.tenant, slip.company, slip.trn, slip.unit_no, Number(slip.amount), Number(slip.due_amount), Number(slip.paid_so_far), slip.kind, slip.recorded_by],
    ['Sara', 'ACE', '100200300', '101', 4000.5, 4500, 4000.5, 'rent', 'Staff']);
  assert.equal((await bookingPayments(bk.id, AT))[0].payments[0].receipt_no, 'RC-2026-00001');
  await assert.rejects(receiptRow(999), /Not found/);
  // The page itself needs the PDF library, which a machine without it skips.
  if (await import('pdf-lib').catch(() => null)) {
    const pdf = await renderReceipt({ ...slip, tenant: 'سارة Ali' });
    assert.equal(pdf.name, 'RC-2026-00001.pdf');
    assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-', 'a name the PDF font cannot write does not stop the receipt');
  }
  assert.deepEqual([inWords(4000.5), inWords(15000), inWords(1234567), inWords(0)],
    ['Four Thousand Dirhams and 50 Fils Only', 'Fifteen Thousand Dirhams Only', 'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Dirhams Only', 'Zero Dirhams Only']);

  // The slip: attached when the payment is recorded or afterwards, replaced, and gone with the payment.
  const slip1 = { buffer: Buffer.from('one'), originalname: 'transfer.pdf', mimetype: 'application/pdf' };
  const [, oct] = await bookingPayments(bk.id, AT);
  const withSlip = await recordPayment(oct.id, { amount: '100', method: 'cash' }, staff, AT, slip1);
  const seen = async () => (await bookingPayments(bk.id, AT))[1].payments[0];
  assert.deepEqual([(await seen()).has_file, (await seen()).file_name, pay.id !== withSlip.id], [true, 'transfer.pdf', true]);
  assert.equal((await bookingPayments(bk.id, AT))[0].payments[0].has_file, false);
  const path = async () => (await db.prepare('SELECT file_path FROM lease_payments WHERE id = ?').get(withSlip.id)).file_path;
  const first = await path();
  await attachPaymentFile(withSlip.id, { buffer: Buffer.from('two'), originalname: 'photo.jpg', mimetype: 'image/jpeg' }, staff);
  assert.deepEqual([(await seen()).file_name, existsSync(first), existsSync(await path())], ['photo.jpg', false, true]);
  await assert.rejects(attachPaymentFile(withSlip.id, null, staff), /Choose a file/);
  const second = await path();
  await removePayment(withSlip.id, staff);
  assert.equal(existsSync(second), false);

  const next = await renewBooking(bk.id, staff);
  assert.deepEqual([next.status, next.start_date, next.end_date, next.renewed_from, Number(next.rent_amount), next.unit_id], ['draft', '2026-11-15', '2027-01-14', bk.id, 4500, u1.id]);
  await assert.rejects(renewBooking(bk.id, staff), /already has a renewal/);
  await assert.rejects(renewBooking(next.id, staff), /Only a confirmed booking/);

  await updateBooking(bk.id, { notes: 'Called twice' }, staff);
  assert.deepEqual((await bookingHistory(bk.id)).map((e) => [e.kind, e.by]),
    [['changed', 'Staff'], ['renewed', 'Staff'], ['payment_deleted', 'Staff'], ['document', 'Staff'], ['payment', 'Staff'], ['payment', 'Staff'], ['reminder', 'Staff'], ['created', 'Staff']]);
  assert.equal((await bookingHistory(bk.id))[0].detail, 'notes');
});

test('import: checked first, all or nothing, with what is missing created', async () => {
  const { staff, c } = await tower();
  const row = (extra) => ({ company: 'ace', building: 'Marina', unit_no: '201', tenant_name: 'Omar', phone: '0501112222', start_date: '01/09/2026', end_date: '2027-08-31',
    rent_amount: '4,500', payment_frequency: 'Monthly', rent_paid_so_far: '6000', ...extra });
  const count = async () => (await db.prepare('SELECT count(*)::int AS n FROM lease_bookings').get()).n;

  const check = await importBookings([row()], { by: staff, today: AT });
  assert.deepEqual([check.imported, check.failed, check.results[0].ok, await count()], [false, 0, true, 0], 'a check keeps nothing');

  const bad = await importBookings([row(), row({ unit_no: '202', start_date: 'soon' }), row({ tenant_name: 'Lina' })], { commit: true, by: staff, today: AT });
  assert.deepEqual([bad.imported, bad.failed, await count()], [false, 2, 0], 'one bad row and nothing is kept');
  assert.match(bad.results[1].error, /Start date is missing or not a date/);
  assert.match(bad.results[2].error, /already booked by Omar/);

  const done = await importBookings([row(), row({ unit_no: '202', tenant_name: 'Omar', rent_paid_so_far: '' })], { commit: true, by: staff, today: AT });
  assert.deepEqual([done.imported, done.failed, await count()], [true, 0, 2]);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM prop_companies').get()).n, 1, 'ACE was found, whatever its capitals');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_tenants').get()).n, 1, 'the same name and phone is one tenant');
  const [first] = (await listBookings({ company_id: c.id })).filter((b) => b.unit_no === '201');
  assert.deepEqual((await bookingPayments(first.id, AT)).slice(0, 3).map((i) => [i.due_date, i.paid, i.status]),
    [['2026-09-01', 4500, 'paid'], ['2026-10-01', 1500, 'overdue'], ['2026-11-01', 0, 'upcoming']]);
  await assert.rejects(importBookings([], { by: staff }), /no rows/);
});

test('Riley reads the leasing records, and only reads', async () => {
  const { staff, u1 } = await tower();
  await createBooking(sara(u1.id), staff);
  const kit = leasingKit();
  const ask = (name, input) => kit.run({ id: 't', name, input });

  const late = await ask('leasing_report', { report: 'overdue', building: 'tow' });
  assert.match(late.content, /^Overdue by age \(Tower, ACE/);
  assert.match(late.content, /Tenant: Sara/);
  const none = await ask('leasing_report', { report: 'rent_roll', building: 'Palm' });
  assert.equal(none.is_error, true);
  assert.match(none.content, /No building matches "Palm"\. There are: Tower/);
  assert.match((await ask('leasing_tenant_statement', { tenant: 'sara' })).content, /^Statement · Sara/);
  assert.match((await ask('leasing_free_units', { building: 'Tower', start_date: '2026-10-01', end_date: '2026-10-31' })).content, /0 of 1 units free\.\n- Unit 101: taken by Sara/);
  assert.deepEqual(kit.definitions.map((d) => d.name), ['leasing_report', 'leasing_tenant_statement', 'leasing_free_units']);
});

test('currency, time zone and phone code follow the region the master sets', async () => {
  const { staff, u1 } = await tower();
  const noon = new Date('2026-10-10T01:30:00Z'); // 05:30 on the 10th in Dubai, 21:30 on the 9th in New York
  assert.deepEqual([region().currency, todayHere(noon), hourHere(noon), cash(4500), whatsappNumber('050 123 4567')], ['AED', '2026-10-10', 5, 'AED 4,500', '971501234567']);
  try {
    await assert.rejects(saveRegion({ timezone: 'Mars/Olympus' }), /time zone is not known/);
    await assert.rejects(saveRegion({ currency: 'dollars' }), /three-letter code/);
    assert.deepEqual(await saveRegion({ currency: 'usd', timezone: 'America/New_York', phone_code: '+1' }), { currency: 'USD', timezone: 'America/New_York', phone_code: '1' });
    assert.deepEqual([todayHere(noon), hourHere(noon), cash(4500.5), cash(4500, { exact: true })], ['2026-10-09', 21, 'USD 4,500.50', 'USD 4,500.00']);
    assert.deepEqual([whatsappNumber('(415) 555-1234'), whatsappNumber('+971 50 123 4567'), inWords(4000.5)], ['14155551234', '971501234567', 'Four Thousand Dollars and 50 Cents Only']);

    const bk = await createBooking(sara(u1.id), staff);
    const [sep] = await bookingPayments(bk.id, AT);
    assert.match((await tenantReminder(sep.id, AT)).message, /rent of USD 4,500 for unit 101/);
    await assert.rejects(recordPayment(sep.id, { amount: 5000, method: 'cash' }, staff, AT), /Only USD 4,500 is still owed/);
    const kit = await leasingKit().run({ id: 't', name: 'leasing_report', input: { report: 'rent_roll' } });
    assert.match(kit.content, /amounts in USD\)/);
  } finally {
    await saveRegion({ currency: 'AED', timezone: 'Asia/Dubai', phone_code: '971' }); // the setting is kept in memory: put it back for the tests that follow
  }
});
