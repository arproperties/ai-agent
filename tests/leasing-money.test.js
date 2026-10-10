import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, setBuildingStaff, buildingStaff } from '../server/properties.js';
import { createBooking, bookingPayments, recordPayment, removePayment, payBooking, settleDeposit, depositState, bookingHistory, changeEnd, cancelBooking, getBooking } from '../server/leasing.js';
import { report } from '../server/leasingReports.js';
import { runAlerts, saveSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

const AT = '2026-10-10';

// Sara: two months in 101 from 15 September at 4,500 a month, with a 5,000 deposit. Nothing paid yet.
async function tower() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, security_deposit: 5000, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567', email: 'sara@example.com' } }, staff);
  return { master, staff, b, bk };
}

test('one payment can cover several months: it goes against what is owed, oldest first', async () => {
  const { staff, bk } = await tower();
  await assert.rejects(payBooking(bk.id, { amount: 20000, method: 'cash' }, staff, AT), /Only AED 14,000 is still owed on this lease/);
  await assert.rejects(payBooking(bk.id, { amount: 0, method: 'cash' }, staff, AT), /Enter the amount received/);

  const made = await payBooking(bk.id, { amount: 12000, method: 'transfer', received_on: '2026-10-08', reference: 'TT-7' }, staff, AT);
  assert.deepEqual(made.map((p) => p.amount), [5000, 4500, 2500]);
  assert.deepEqual((await bookingPayments(bk.id, AT)).map((r) => [r.name, r.due_date, r.paid, r.left, r.status]),
    [['Security deposit', '2026-09-15', 5000, 0, 'paid'], ['Rent', '2026-09-15', 4500, 0, 'paid'], ['Rent', '2026-10-15', 2500, 2000, 'partly_paid']]);
  await payBooking(bk.id, { amount: 2000, method: 'cash' }, staff, AT);
  await assert.rejects(payBooking(bk.id, { amount: 1, method: 'cash' }, staff, AT), /Nothing is owed on this lease/);
});

test('a late fee is added once the days of grace are over, and comes off if the money had come in time', async () => {
  const { staff, bk } = await tower();
  await assert.rejects(saveSettings({ latefee: { on: true } }), /an amount or a percent of the rent/);
  const cfg = await saveSettings({ latefee: { on: true, days: 5, amount: 100, percent: 2 } }, '2026-09-01');
  assert.deepEqual(cfg.latefee, { on: true, days: 5, amount: 100, percent: 2, since: '2026-09-01' });

  assert.equal((await bookingPayments(bk.id, '2026-09-20')).some((r) => r.kind === 'late'), false, 'the last day of grace: no fee yet');
  const rows = await bookingPayments(bk.id, AT);
  assert.deepEqual(rows.filter((r) => r.kind === 'late').map((r) => [r.name, r.due_date, r.amount, r.status]), [['Late fee (rent due 2026-09-15)', '2026-09-21', 190, 'overdue']]);
  assert.equal((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'late').length, 1, 'one fee for one late rent, however often it is looked at');
  assert.equal((await report('aging', {}, AT)).total.owed, 9690, 'it is owed like anything else: deposit, rent and the fee');

  // The rent turns out to have been transferred on the 18th: within the grace, so no fee.
  const sep = rows.find((r) => r.kind === 'rent');
  await recordPayment(sep.id, { amount: 4500, method: 'transfer', received_on: '2026-09-18' }, staff, AT);
  assert.equal((await bookingPayments(bk.id, AT)).some((r) => r.kind === 'late'), false);

  // October's rent is paid, but late: the fee stays owed.
  const LATER = '2026-10-25';
  const oct = (await bookingPayments(bk.id, LATER)).find((r) => r.kind === 'rent' && r.due_date === '2026-10-15');
  await recordPayment(oct.id, { amount: 4500, method: 'cash', received_on: '2026-10-24' }, staff, LATER);
  assert.deepEqual((await bookingPayments(bk.id, LATER)).filter((r) => r.kind === 'late').map((r) => [r.name, r.left]), [['Late fee (rent due 2026-10-15)', 190]]);

  // Switched off: nothing new is charged; what was charged stays.
  await saveSettings({ latefee: { on: false } });
  assert.equal((await bookingPayments(bk.id, '2026-12-30')).filter((r) => r.kind === 'late').length, 1);
});

test('a deposit given back is in the collections, the daily report and the tenant statement', async () => {
  const { staff, bk } = await tower();
  const [deposit] = await bookingPayments(bk.id, AT);
  const paid = await recordPayment(deposit.id, { amount: 5000, method: 'cash', received_on: '2026-09-15' }, staff, AT);
  await settleDeposit(bk.id, { refunded: 4000, note: 'Repainting' }, staff, AT);
  // The payment that brought the deposit in cannot be deleted from under what was given back.
  await assert.rejects(removePayment(paid.id, staff), /AED 4,000 of this deposit has already been given back/);
  assert.equal((await depositState(bk.id)).held, 5000);

  const got = await report('collections', { from: '2026-09-01', to: AT }, AT);
  assert.deepEqual(got.rows.map((r) => [r.received_on, r.what, r.amount]), [['2026-09-15', 'Security deposit', 5000], [AT, 'Deposit returned', -4000]]);
  assert.deepEqual(got.summary.slice(0, 4).map((f) => [f.label, f.value]), [['Collected', 5000], ['Payments', 1], ['Deposits returned', 4000], ['Net', 1000]]);
  assert.equal(got.total.amount, 1000);

  const day = await report('daily', {}, AT);
  assert.deepEqual(day.rows.filter((r) => r.what === 'Deposit returned').map((r) => [r.tenant, r.detail, r.amount]), [['Sara', 'Repainting', -4000]]);
  const st = await report('statement', { tenant_id: bk.tenant_id }, AT);
  assert.ok(st.rows.some((r) => r.description === 'Security deposit returned · AED 4,000 · Repainting · Unit 101, Tower' && r.balance === 4500), 'a line of its own that changes no balance');
});

test('the people who look after a building get its alerts, and the tenant can be emailed automatically', async () => {
  const { master, staff, b, bk } = await tower();
  const keeper = await makeUser('Keeper');
  assert.deepEqual((await setBuildingStaff(b.id, [keeper, keeper, 9999])).map((u) => u.name), ['Keeper']);
  assert.equal((await buildingStaff(b.id)).length, 1);

  // The day after the rent was due: staff who made the booking, the building's keeper and the master all hear of it.
  await saveSettings({ quiet: { from: 0, to: 0 } });
  const sent = await runAlerts('2026-09-16', 9);
  assert.deepEqual(sent.map((n) => n.user_id).sort(), [master, staff, keeper].sort());

  // The tenant is emailed only once the master switches that on, and once a day at most.
  const mails = [];
  const mail = async (to, subject, text) => { mails.push([to, subject, text]); };
  await runAlerts('2026-09-17', 9, { mail });
  assert.equal(mails.length, 0, 'off until the master says');
  await saveSettings({ tenant: { on: true } });
  await runAlerts('2026-09-18', 9, { mail });
  await runAlerts('2026-09-18', 10, { mail });
  assert.equal(mails.length, 1, 'three days late is a day to chase, and it goes once');
  assert.equal(mails[0][0], 'sara@example.com');
  assert.match(mails[0][1], /^Overdue: rent for unit 101, Tower/);
  assert.match(mails[0][2], /^Dear Sara, rent of AED 4,500 .* is now 3 days late/);
  await runAlerts('2026-09-19', 9, { mail });
  assert.equal(mails.length, 1, 'four days late is not one of the days');
  assert.equal((await bookingHistory(bk.id))[0].detail, 'Emailed to the tenant automatically');

  // An email that fails is tried again on the next round.
  let tries = 0;
  await runAlerts('2026-09-22', 9, { mail: async () => { tries++; throw new Error('smtp down'); } });
  await runAlerts('2026-09-22', 10, { mail });
  assert.deepEqual([tries, mails.length], [1, 2]);

  // October's rent, due on the 15th: the tenant hears three days before, unless the master says not before.
  await runAlerts('2026-10-11', 9, { mail });
  assert.equal(mails.length, 2, 'four days before is not the day');
  assert.deepEqual((await saveSettings({ tenant: { before: 0 } })).tenant, { on: true, before: 0 });
  await runAlerts('2026-10-12', 9, { mail });
  assert.equal(mails.length, 2, 'not before, the master said');
  await saveSettings({ tenant: { before: 3 } });
  await runAlerts('2026-10-12', 10, { mail });
  assert.equal(mails.length, 3);
  assert.match(mails[2][1], /^Reminder: rent for unit 101, Tower/);
  assert.match(mails[2][2], /^Dear Sara, a kind reminder that rent of AED 4,500 .* is due on /);

  // Two bookings of one tenant are one tenant behind.
  const u2 = await create('unit', { unit_no: '102' }, b.id);
  await createBooking({ unit_id: u2.id, tenant_id: bk.tenant_id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 3000, status: 'confirmed' }, staff);
  const aging = await report('aging', {}, AT);
  assert.deepEqual([aging.rows.length, aging.summary[1].label, aging.summary[1].value], [2, 'Tenants behind', 1]);
});

test('a stay is extended, or cut short when it was booked for too long, with payments already recorded', async () => {
  const { staff, b, bk } = await tower();
  // Booked for six months by mistake: make it so, and take the deposit and two months of rent.
  const six = await changeEnd(bk.id, '2027-03-14', staff);
  assert.deepEqual([six.end_date, six.overpaid], ['2027-03-14', 0]);
  assert.equal((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'rent').length, 6);
  await payBooking(bk.id, { amount: 14000, method: 'transfer', received_on: '2026-10-01' }, staff, AT);

  // It was really three months: the unpaid months after that go, the paid ones stay as they are.
  const three = await changeEnd(bk.id, '2026-12-14', staff);
  assert.deepEqual([three.end_date, three.overpaid], ['2026-12-14', 0]);
  assert.deepEqual((await bookingPayments(bk.id, AT)).map((r) => [r.name, r.due_date, r.amount, r.paid, r.status]),
    [['Security deposit', '2026-09-15', 5000, 5000, 'paid'], ['Rent', '2026-09-15', 4500, 4500, 'paid'], ['Rent', '2026-10-15', 4500, 4500, 'paid'], ['Rent', '2026-11-15', 4500, 0, 'upcoming']]);

  // Shorter than what has been paid for: the month paid beyond the new end is said, and stays on the books as received.
  const one = await changeEnd(bk.id, '2026-10-14', staff);
  assert.equal(one.overpaid, 4500);
  assert.deepEqual((await bookingPayments(bk.id, AT)).filter((r) => r.kind === 'rent').map((r) => [r.due_date, r.amount, r.left]), [['2026-09-15', 4500, 0], ['2026-10-15', 4500, 0]]);
  assert.match((await bookingHistory(bk.id))[0].detail, /^Stay ended early: end date 2026-12-14 to 2026-10-14 · AED 4,500 of rent was paid for time taken off$/);

  // Longer again needs the unit free for the extra days.
  const u1 = (await getBooking(bk.id)).unit_id;
  await createBooking({ unit_id: u1, start_date: '2026-12-01', end_date: '2026-12-31', rent_amount: 4000, status: 'confirmed', tenant: { full_name: 'Omar' } }, staff);
  await assert.rejects(changeEnd(bk.id, '2026-12-14', staff), /already leased by Omar/);
  assert.equal((await changeEnd(bk.id, '2026-11-14', staff)).end_date, '2026-11-14');

  await assert.rejects(changeEnd(bk.id, '2026-11-14', staff), /already has/);
  await assert.rejects(changeEnd(bk.id, '2026-09-01', staff), /before the start date/);
  await assert.rejects(changeEnd(bk.id, 'soon', staff), /Choose the new end date/);
  const up = await createBooking({ unit_id: (await create('unit', { unit_no: '102' }, b.id)).id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, payment_frequency: 'upfront', status: 'confirmed', tenant: { full_name: 'Lina' } }, staff);
  await payBooking(up.id, { amount: 9000, method: 'cash' }, staff, AT);
  await assert.rejects(changeEnd(up.id, '2026-12-14', staff), /paid upfront\. Use Renew/);
  await cancelBooking(bk.id, 'Left', staff, AT);
  await assert.rejects(changeEnd(bk.id, '2026-12-01', staff), /Only a confirmed lease/);
});
