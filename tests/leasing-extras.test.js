import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { existsSync } from 'node:fs';
import { addTenant, changeEnd, createBooking, updateBooking, bookingPayments, recordPayment, removePayment, attachPaymentFile, overview, depositState, settleDeposit, passDeposit, takeBackDeposit, removeBooking, renewBooking, bookingHistory, listBookings, listServices, addService, updateService, removeService, listSources, addSource, renameSource, removeSource } from '../server/leasing.js';
import { receiptRow, renderReceipt, inWords } from '../server/leasingReceipt.js';
import { tenantReminder, noteReminder, saveWording, whatsappNumber } from '../server/leasingAlerts.js';
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

test('at a renewal the deposit is passed on to the new booking, which gives it back; the first booking keeps the trail', async () => {
  const { staff, u1 } = await tower();
  const a = await createBooking(sara(u1.id, { security_deposit: 5000 }), staff);
  const [dep] = await bookingPayments(a.id, AT);
  await assert.rejects(passDeposit(a.id, staff, AT), /No deposit has been received/);
  const paid = await recordPayment(dep.id, { amount: 5000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  await assert.rejects(passDeposit(a.id, staff, AT), /no renewal to pass the deposit on to/);

  const b = await renewBooking(a.id, staff);
  assert.deepEqual((await depositState(a.id)).can_pass, { id: b.id, ref: b.ref });
  assert.deepEqual((await depositState(b.id)), { amount: 0, held: 0, refunded: null, note: null, settled_on: null, status: 'none', waiting: { id: a.id, ref: a.ref, amount: 5000 } });

  const was = await passDeposit(a.id, staff, AT);
  assert.deepEqual([was.status, was.held, was.passed_to], ['passed_on', 5000, { id: b.id, ref: b.ref, on: AT }]);
  const now = await depositState(b.id);
  assert.deepEqual([now.status, now.held, now.from, now.waiting], ['held', 5000, [{ id: a.id, ref: a.ref, on: AT, amount: 5000 }], undefined]);
  assert.equal((await bookingHistory(a.id))[0].detail, `AED 5,000 passed on to ${b.ref}`);
  assert.equal((await bookingHistory(b.id))[0].detail, `AED 5,000 carried over from ${a.ref}`);
  assert.deepEqual((await bookingPayments(a.id, AT)).map((r) => [r.name, r.paid, r.status]).slice(0, 1), [['Security deposit', 5000, 'paid']], 'no money moved: the payment stays where it was received');
  await assert.rejects(passDeposit(a.id, staff, AT), /already passed on/);
  await assert.rejects(settleDeposit(a.id, { refunded: 5000 }, staff, AT), new RegExp(`passed on to ${b.ref}. Give it back from that lease`));

  // Undone, and done again; then given back from the renewal, after which neither can be undone.
  assert.equal((await takeBackDeposit(a.id, staff)).status, 'held');
  assert.equal((await depositState(b.id)).status, 'none');
  await passDeposit(a.id, staff, AT);
  const end = await settleDeposit(b.id, { refunded: 4000, note: 'Repainting' }, staff, AT);
  assert.deepEqual([end.status, end.held, end.refunded], ['partly_refunded', 5000, 4000]);
  await assert.rejects(takeBackDeposit(a.id, staff), new RegExp(`already been given back from ${b.ref}`));
  await assert.rejects(removePayment(paid.id, staff), /AED 4,000 of this deposit has already been given back/);
  assert.equal((await depositState(a.id)).status, 'passed_on', 'the first booking still says where its deposit went');
});

test('a renewal that is deleted gives the deposit passed on to it back to the booking it came from', async () => {
  const { staff, u1 } = await tower();
  const a = await createBooking(sara(u1.id, { security_deposit: 5000 }), staff);
  const [dep] = await bookingPayments(a.id, AT);
  await recordPayment(dep.id, { amount: 5000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  const b = await renewBooking(a.id, staff);
  await passDeposit(a.id, staff, AT);
  await removeBooking(b.id);
  const d = await depositState(a.id);
  assert.deepEqual([d.status, d.held, d.passed_to], ['held', 5000, undefined]);
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

  // Taken off the booking altogether, what came in is still the tenant's: held, and given back.
  await updateBooking(bk.id, { security_deposit: null }, staff);
  assert.deepEqual([(await depositState(bk.id)).held, (await depositState(bk.id)).status], [2000, 'held']);
  assert.equal((await settleDeposit(bk.id, { refunded: 2000 }, staff, AT)).status, 'refunded');
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

test('sources: one list for the whole app, and a booking says where its tenant came from', async () => {
  const { staff, u1 } = await tower();
  await assert.rejects(addSource({ name: ' ' }, staff), /Give the source a name/);
  const airbnb = await addSource({ name: 'Airbnb' }, staff);
  const walk = await addSource({ name: 'Walk-in' }, staff);
  await assert.rejects(addSource({ name: 'AIRBNB' }, staff), /already a source with that name/);
  assert.deepEqual((await listSources()).map((x) => x.name), ['Airbnb', 'Walk-in']);

  const bk = await createBooking(sara(u1.id, { source: 'Airbnb' }), staff);
  assert.equal(bk.source, 'Airbnb');
  assert.deepEqual((await listBookings({ q: 'airbnb' })).map((b) => b.id), [bk.id], 'a booking is found by its source');
  assert.equal((await renewBooking(bk.id, staff)).source, 'Airbnb', 'a renewal is the same tenant, so the same source');

  await assert.rejects(renameSource(walk.id, { name: 'airbnb' }), /already a source with that name/);
  await renameSource(airbnb.id, { name: 'Airbnb app' });
  assert.equal((await listBookings({ unit_id: u1.id })).find((b) => b.id === bk.id).source, 'Airbnb app', 'renaming a source renames it on its bookings');
  await removeSource(airbnb.id);
  await assert.rejects(removeSource(airbnb.id), /Source not found/);
  assert.equal((await listBookings({ unit_id: u1.id })).find((b) => b.id === bk.id).source, 'Airbnb app', 'a booking keeps its source when the list changes');
  assert.equal((await updateBooking(bk.id, { source: '' }, staff)).source, null);
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
  assert.match(r.message, /^Dear Sara, rent of AED 4,500 for unit 101, Tower was due on 09\/15\/2026 and is now 25 days late\./);
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
  await assert.rejects(renewBooking(next.id, staff), /Only a confirmed lease/);

  await updateBooking(bk.id, { notes: 'Called twice' }, staff);
  assert.deepEqual((await bookingHistory(bk.id)).map((e) => [e.kind, e.by]),
    [['changed', 'Staff'], ['renewed', 'Staff'], ['payment_deleted', 'Staff'], ['document', 'Staff'], ['payment', 'Staff'], ['payment', 'Staff'], ['reminder', 'Staff'], ['created', 'Staff']]);
  assert.equal((await bookingHistory(bk.id))[0].detail, 'notes');
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
  assert.deepEqual(kit.definitions.slice(0, 3).map((d) => d.name), ['leasing_report', 'leasing_tenant_statement', 'leasing_free_units']);
});

test('Riley sets a tenancy up from the chat: company, building, units, service, tenant and booking', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const staffId = await makeUser('Staff');
  let changed = 0;
  const kit = leasingKit({ id: boss, role: 'master' }, { onChanged: () => changed++ });
  const ask = (name, input) => kit.run({ id: 't', name, input });
  const says = async (name, input) => { const r = await ask(name, input); assert.ok(!r.is_error, r.content); return r.content; };

  assert.equal(await says('leasing_list', { what: 'companies' }), 'No companies yet.');
  assert.equal(changed, 0, 'looking changes nothing');
  assert.equal(await says('leasing_add_company', { name: 'ACE Properties', trn: '100200300' }), 'Company added: ACE Properties.');
  assert.match(await says('leasing_add_building', { company: 'ace', name: 'Marina Tower', area: 'Marina' }), /^Building added: Marina Tower, under ACE Properties/);
  assert.match(await says('leasing_add_units', { building: 'marina', units: [{ unit_no: '101', type: '1BR' }, { unit_no: '102' }, { unit_no: '101' }] }),
    /^2 units added to Marina Tower: 101, 102\.\nNot added: 101: That unit number already exists/);
  assert.match(await says('leasing_add_service', { building: 'Marina Tower', name: 'Parking', amount: 300, repeats: true }), /Parking, AED 300, charged with every rent payment/);
  assert.equal(await says('leasing_add_tenant', { full_name: 'Sara Khan', phone: '0501234567' }), 'Tenant added: Sara Khan · 050-123-4567.');
  const twice = await ask('leasing_add_tenant', { full_name: 'sara khan' });
  assert.deepEqual([twice.is_error, /already a tenant named Sara Khan \(050-123-4567\)/.test(twice.content)], [true, true]);

  // Always a draft, as on the form; a charge the building does not list yet is added to its list on the way.
  const booking = { building: 'Marina', unit_no: '101', tenant: 'Sara', start_date: '2026-11-01', end_date: '2027-10-31', rent_amount: 60000, rent_period: 'year',
    security_deposit: 5000, tax_percent: 0, charges: [{ name: 'Parking', amount: 300, repeats: true }, { name: 'Pet fee', amount: 800 }] };
  const draft = await says('leasing_add_booking', booking);
  assert.match(draft, /^Lease LS-2026-0001 saved as a DRAFT .*Sara Khan, unit 101, Marina Tower, 2026-11-01 to 2027-10-31, AED 60,000 per year, paid monthly, no VAT\.\nAdded to Marina Tower's services: Pet fee\.\nStill to do: the move-in inspection, after which the lease is confirmed; and, on the screens, attach the tenant's Driver License and Proof of Employment .*$/);
  assert.match(await says('leasing_list', { what: 'services', building: 'Marina' }), /- Parking: AED 300, with every rent payment\n- Pet fee: AED 800, once/);
  // Asked for again, the same stay is not made twice: the draft is changed, and keeps the charges it had.
  const again = await ask('leasing_add_booking', { ...booking, charges: [{ name: 'Laundry', amount: 20, repeats: true }] });
  assert.deepEqual([again.is_error, /already a draft for this tenant and unit: LS-2026-0001 .*leasing_change_booking/.test(again.content)], [true, true]);
  assert.match(await says('leasing_change_booking', { booking: 'LS-2026-0001', set_charges: [{ name: 'Laundry', amount: 20, repeats: true }] }),
    /^Lease changed, still a DRAFT .*charges: Parking AED 300 with every rent payment, Pet fee AED 800 once, Laundry AED 20 with every rent payment\.\nAdded to Marina Tower's services: Laundry\.$/);
  assert.match(await says('leasing_change_booking', { booking: 'LS-2026-0001', remove_charges: ['laundry'] }), /charges: Parking AED 300 with every rent payment, Pet fee AED 800 once\.$/);
  assert.match(await says('leasing_list', { what: 'bookings', search: 'sara' }), /^- LS-2026-0001 \(draft, move-in inspection not done\): Sara Khan, unit 101, Marina Tower/);
  // As on the screens, it is not confirmed before the tenant is inspected in: she writes that down as she is told it.
  const tooSoon = await ask('leasing_confirm_booking', { booking: 'LS-2026-0001' });
  assert.deepEqual([tooSoon.is_error, /^Do the move-in inspection first, then confirm the lease\. Ask the user how they found the unit and write it down with leasing_record_inspection/.test(tooSoon.content)], [true, true]);
  assert.match(await says('leasing_record_inspection', { building: 'Marina', unit_no: '101', kind: 'move_in', everything_else: 'good' }), /^Move-in inspection of unit 101, Marina Tower for LS-2026-0001 \(Sara Khan\), dated .*: finished\./);
  assert.match(await says('leasing_list', { what: 'bookings', search: 'sara' }), /^- LS-2026-0001 \(draft, move-in inspection done\)/);
  assert.match(await says('leasing_confirm_booking', { booking: 'LS-2026-0001' }), /is confirmed: Sara Khan, unit 101.*\nPayment schedule: 26 payments, AED 69,400 in all; AED 11,100 is due on the first day\./s);
  assert.match((await ask('leasing_add_booking', { ...booking, unit_no: '999' })).content, /has no unit "999"/);
  assert.equal(changed, 10, 'each thing added is told to the screen behind; what failed is not');

  // Like the form, a new booking starts with the region's usual tax; where the tenant came from is kept, and a new source joins the list.
  const { tax_percent, ...untaxed } = booking;
  assert.match(await says('leasing_add_booking', { ...untaxed, unit_no: '102', charges: [], source: 'Airbnb' }), /paid monthly, VAT 5%, source Airbnb\.\nAdded to the sources list: Airbnb\.\nStill to do: the move-in inspection/);
  assert.equal(await says('leasing_list', { what: 'sources' }), 'Sources:\n- Airbnb');
  assert.match(await says('leasing_change_booking', { booking: 'LS-2026-0002', source: 'airbnb', notes: 'Called' }), /VAT 5%; source: Airbnb\.$/, 'a source is taken as the list has it, and not added twice');
  assert.match(await says('leasing_change_booking', { booking: 'LS-2026-0002', source: '' }), /VAT 5%\.$/);

  // Somebody who is not the master can book and add a tenant, not add property.
  const staff = leasingKit({ id: staffId, role: 'user' });
  const no = await staff.run({ id: 't', name: 'leasing_add_company', input: { name: 'Other' } });
  assert.deepEqual([no.is_error, no.content], [true, 'Only the master can add a company. Tell the user to ask them.']);
  const bare = await staff.run({ id: 't', name: 'leasing_add_tenant', input: { full_name: 'Omar' } });
  assert.deepEqual([bare.is_error, bare.content], [true, 'A tenant needs a contact number. Ask the user for it.']);
  assert.ok(!(await staff.run({ id: 't', name: 'leasing_add_tenant', input: { full_name: 'Omar', phone: '0507654321' } })).is_error);
});

test('Riley follows a unit round its inspections: what is next, who still has it, and when it can be leased', async () => {
  const { staff, u1 } = await tower();
  const plus = (days) => new Date(Date.parse(`${todayHere()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  await addTenant({ full_name: 'Sara', phone: '0501234567' }, staff);
  const kit = leasingKit({ id: staff, role: 'user' });
  const ask = (name, input) => kit.run({ id: 't', name, input });
  const says = async (name, input) => { const r = await ask(name, input); assert.ok(!r.is_error, r.content); return r.content; };
  const unit = () => says('leasing_unit_inspections', { building: 'Tower', unit_no: '101' });
  const units = () => says('leasing_list', { what: 'units', building: 'Tower' });

  assert.match(await units(), /^Tower has 1 unit \(today is .*\):\n- 101: empty$/);
  assert.match(await unit(), /No lease now or to come\.\nNext: the make-ready: the work on the empty unit before it is let\.\nNo inspection or make-ready has been written down yet\.$/);

  // Asked to confirm it in one go, she still makes a draft: the tenant is not inspected in yet.
  const made = await says('leasing_add_booking', { building: 'Tower', unit_no: '101', tenant: 'Sara', start_date: plus(-30), end_date: plus(300), rent_amount: 4500, confirm: true });
  assert.match(made, /^Lease LS-\d+-0001 saved as a DRAFT/);
  const ref = made.match(/LS-\d+-\d+/)[0];
  assert.match(await unit(), new RegExp(`Its lease: ${ref} \\(draft, move-in inspection not done\\): Sara.*\\nNext: the move-in inspection of ${ref} \\(Sara\\), which is late: the lease has started\\. The lease is confirmed after it\\.`));
  assert.equal((await ask('leasing_confirm_booking', { booking: ref })).is_error, true);
  // The move-in is told to her in two goes: the kitchen first, which does not finish it, then the rest. Only what is said is rated.
  const record = (input) => says('leasing_record_inspection', { building: 'Tower', unit_no: '101', ...input });
  const begun = await record({ kind: 'move_in', notes: 'Keys: 2', areas: [{ area: 'kitchen', condition: 'good', note: 'New hob' }, { area: 'Balcony', condition: 'fair' }] });
  assert.match(begun, new RegExp(`^Move-in inspection of unit 101, Tower for ${ref} \\(Sara\\), dated ${todayHere()}: NOT finished\\. Still to look at: Entrance & doors, Living room, Bedrooms, .*Keys & remotes\\.\\nIt says: Kitchen: good \\(New hob\\); Balcony: fair\\.\\nNext: the move-in inspection of`));
  assert.equal((await ask('leasing_confirm_booking', { booking: ref })).is_error, true, 'begun is not done');
  const wrong = await ask('leasing_record_inspection', { building: 'Tower', unit_no: '101', kind: 'move_in', everything_else: 'done' });
  assert.deepEqual([wrong.is_error, wrong.content], [true, 'A move-in inspection is rated good or fair or damaged, not "done".']);
  assert.match(await record({ kind: 'move_in', everything_else: 'good' }), new RegExp(`: finished\\.\\nIt says: Entrance & doors: good; Living room: good; Kitchen: good \\(New hob\\); .*Balcony: fair\\.\\nNext: confirming ${ref} \\(Sara\\): the move-in inspection is done\\. Confirm it only when the user says to\\.`));
  assert.match(await unit(), new RegExp(`Next: confirming ${ref} \\(Sara\\): the move-in inspection is done\\.\\nInspections, newest first:\\n- .* Move-in inspection, Sara \\[${ref}\\], finished, by Staff: .*Kitchen: good \\(New hob\\); .*Balcony: fair\\. Notes: Keys: 2$`));
  assert.match(await says('leasing_confirm_booking', { booking: ref }), /is confirmed: Sara, unit 101/);
  assert.match(await units(), new RegExp(`- 101: leased to Sara until ${plus(300)}$`));

  // She leaves early. Until she is inspected out the unit is hers: not free, and not to be leased, whatever the dates say.
  await changeEnd(1, plus(-1), staff);
  assert.match(await units(), new RegExp(`- 101: lease ended ${plus(-1)}, not vacant until Sara's move-out inspection is done$`));
  assert.match(await says('leasing_free_units', { building: 'Tower', start_date: plus(1), end_date: plus(30) }),
    new RegExp(`0 of 1 units free\\.\\n- Unit 101: not vacant: Sara's lease ended ${plus(-1)} and the move-out inspection is not done \\(${ref}\\)$`));
  const held = new RegExp(`\\nListed as vacant, but not to be leased yet \\(the move-out inspection is not done\\):\\n- Unit 101, Tower: Sara, lease ended ${plus(-1)}$`);
  assert.match(await says('leasing_report', { report: 'vacant_units' }), held);
  assert.match(await unit(), /Next: the move-out inspection of LS-\d+-0001 \(Sara\), which is late/);

  // Her move-out looks at what her move-in looked at (the balcony too), and frees the unit; then the make-ready, job by job.
  assert.match(await record({ kind: 'move_out', areas: [{ area: 'Kitchen', condition: 'damaged', note: 'Worktop burnt' }], everything_else: 'good' }), /: finished\.\nIt says: .*Kitchen: damaged \(Worktop burnt\); .*Balcony: good\.\nNext: the make-ready/);
  assert.match(await unit(), /Next: the make-ready.*\n- .* Move-out inspection, Sara \[LS-\d+-0001\], finished, by Staff: .*Kitchen: damaged \(Worktop burnt\).*\n- .* Move-in inspection, Sara/s);
  assert.match(await units(), /- 101: empty, to be made ready$/);
  assert.match(await record({ kind: 'make_ready', areas: [{ area: 'Cleaning', condition: 'done' }] }), /^Make-ready of unit 101, Tower, dated .*: NOT finished\. Still to do: Painting, Repairs, AC service, Pest control, Locks & keys\./);
  assert.match(await record({ kind: 'make_ready', everything_else: 'done' }), /: finished\.\n.*\nNext: nothing: it is made ready, and waits for a lease\./);
  assert.match(await units(), /- 101: empty$/);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM prop_inspections').get()).n, 3, 'each was carried on, not written twice');
  assert.doesNotMatch(await says('leasing_report', { report: 'vacant_units' }), /not to be leased yet/);
  assert.match(await says('leasing_free_units', { building: 'Tower', start_date: plus(1), end_date: plus(30) }), /1 of 1 units free/);
});

test('currency, time zone and phone code follow the region the master sets', async () => {
  const { staff, u1 } = await tower();
  const noon = new Date('2026-10-10T01:30:00Z'); // 05:30 on the 10th in Dubai, 21:30 on the 9th in New York
  assert.deepEqual([region().currency, todayHere(noon), hourHere(noon), cash(4500), whatsappNumber('050 123 4567')], ['AED', '2026-10-10', 5, 'AED 4,500', '971501234567']);
  try {
    await assert.rejects(saveRegion({ timezone: 'Mars/Olympus' }), /time zone is not known/);
    await assert.rejects(saveRegion({ currency: 'dollars' }), /three-letter code/);
    assert.deepEqual(await saveRegion({ currency: 'usd', timezone: 'America/New_York', phone_code: '+1' }), { currency: 'USD', timezone: 'America/New_York', phone_code: '1', tax_percent: 5, tax_name: 'VAT' });
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
