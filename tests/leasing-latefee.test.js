import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, updateBooking, bookingPayments, recordPayment, bookingHistory, addWeekdays, iso, dayNo } from '../server/leasing.js';
import { runAlerts, saveSettings, getSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

// Sara: from Tue 15 September 2026 at 4,500 a month, rent due on the 15th. Nothing paid yet.
async function sara(extra = {}) {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567', email: 'sara@example.com' }, ...extra }, staff);
  return { staff, bk };
}
const fees = async (id, day) => (await bookingPayments(id, day)).filter((r) => r.kind === 'late').map((r) => [r.label, r.due_date, r.amount]);

test('weekdays only: Saturday and Sunday are skipped', () => {
  assert.equal(iso(addWeekdays(dayNo('2026-09-15'), 4)), '2026-09-21'); // Tue + 4 weekdays: Wed, Thu, Fri, Mon
  assert.equal(iso(addWeekdays(dayNo('2026-09-18'), 1)), '2026-09-21'); // Fri → Mon
});

test('the defaults: 3 weekdays of grace, 50 the day after, then 5 every day to the month end, at most 100', async () => {
  const { bk } = await sara();
  const cfg = await saveSettings({ latefee: { on: true } }, '2026-09-01');
  assert.deepEqual(cfg.latefee, { on: true, days: 3, amount: 50, percent: 0, daily: 5, cap: 100, email: 5, since: '2026-09-01' });

  // Due Tue 15th: the grace is Wed, Thu, Fri; the 50 goes on Sat 19th.
  assert.deepEqual(await fees(bk.id, '2026-09-18'), [], 'Fri 18th is the 3rd weekday of grace');
  assert.deepEqual(await fees(bk.id, '2026-09-19'), [['2026-09-15', '2026-09-19', 50]]);
  assert.deepEqual(await fees(bk.id, '2026-09-20'), [['2026-09-15', '2026-09-19', 55]], 'after the grace, a Sunday counts');
  assert.deepEqual(await fees(bk.id, '2026-09-25'), [['2026-09-15', '2026-09-19', 80]]);
  assert.deepEqual(await fees(bk.id, '2026-09-30'), [['2026-09-15', '2026-09-19', 105]], 'eleven days of 5');
  assert.deepEqual(await fees(bk.id, '2026-10-09'), [['2026-09-15', '2026-09-19', 105]], 'it stops at the end of the month');
  // October's rent starts its own: due Thu 15th, grace Fri, Mon, Tue (the weekend skipped), 50 on Wed 21st.
  assert.deepEqual((await fees(bk.id, '2026-10-23'))[1], ['2026-10-15', '2026-10-21', 60]);
});

test('the daily part stops once the rent is paid, never goes past the cap, and none at all if paid in the grace', async () => {
  const { staff, bk } = await sara();
  await saveSettings({ latefee: { on: true } }, '2026-09-01');
  const sep = (await bookingPayments(bk.id, '2026-09-21')).find((r) => r.kind === 'rent');
  await recordPayment(sep.id, { amount: 4500, method: 'cash', received_on: '2026-09-24' }, staff, '2026-09-24');
  assert.deepEqual(await fees(bk.id, '2026-09-30'), [['2026-09-15', '2026-09-19', 70]], 'Sun to Wed: paid on Thu');

  const { staff: s2, bk: b2 } = await sara();
  await saveSettings({ latefee: { on: true, days: 0, amount: 50, daily: 10, cap: 100 } }, '2026-09-01');
  assert.deepEqual(await fees(b2.id, '2026-09-30'), [['2026-09-15', '2026-09-16', 150]], 'fourteen days of 10 (17th to 30th), held to 100');
  const r = (await bookingPayments(b2.id, '2026-09-30')).find((x) => x.kind === 'rent');
  await saveSettings({ latefee: { on: true, days: 3 } }, '2026-09-01');
  await recordPayment(r.id, { amount: 4500, method: 'cash', received_on: '2026-09-18' }, s2, '2026-09-30');
  assert.deepEqual(await fees(b2.id, '2026-09-30'), [], 'paid on the last weekday of grace: no fee');
});

test('a lease marked no late fees is never charged', async () => {
  const { bk } = await sara({ no_late_fees: true });
  await saveSettings({ latefee: { on: true } }, '2026-09-01');
  assert.deepEqual(await fees(bk.id, '2026-09-30'), []);
});

test('the switch on a lease: off takes its unpaid late fees off, on works them out again', async () => {
  const { staff, bk } = await sara();
  await saveSettings({ latefee: { on: true } }, '2026-09-01');
  assert.equal((await fees(bk.id, '2026-10-23')).length, 2);
  await updateBooking(bk.id, { no_late_fees: true }, staff);
  assert.deepEqual(await fees(bk.id, '2026-10-23'), []);
  await updateBooking(bk.id, { no_late_fees: false }, staff);
  assert.deepEqual(await fees(bk.id, '2026-10-23'), [['2026-09-15', '2026-09-19', 105], ['2026-10-15', '2026-10-21', 60]]);

  // A late fee with money against it stays when switched off, and grows no more.
  const fee = (await bookingPayments(bk.id, '2026-10-23')).find((r) => r.kind === 'late');
  await recordPayment(fee.id, { amount: 20, method: 'cash', received_on: '2026-10-23' }, staff, '2026-10-23');
  await updateBooking(bk.id, { no_late_fees: true }, staff);
  assert.deepEqual(await fees(bk.id, '2026-10-30'), [['2026-09-15', '2026-09-19', 105]]);
});

test('the tenant is emailed when the fee goes on, then every 5th day while it is owed', async () => {
  const { staff, bk } = await sara();
  await saveSettings({ latefee: { on: true }, quiet: { from: 0, to: 0 } }, '2026-09-01');
  assert.equal((await getSettings()).tenant.on, false, 'the dues email is off: this one goes anyway');
  const mails = [];
  const mail = async (to, subject, text) => { mails.push([to, subject, text]); };
  for (const day of ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-23', '2026-09-24', '2026-09-25']) await runAlerts(day, 9, { mail });
  assert.deepEqual(mails.map((m) => m[0]), ['sara@example.com', 'sara@example.com'], 'Sat 19th, then Thu 24th');
  assert.match(mails[0][1], /^Late fee: unit 101, Tower/);
  assert.match(mails[0][2], /Late fee \(rent due 2026-09-15\) · due 09\/19\/2026 · USD 50/);
  assert.match(mails[1][2], /USD 75/, 'the fee as it stands on the day: 50 and five days of 5');
  assert.equal((await bookingHistory(bk.id))[0].detail, 'Late fee emailed to the tenant automatically');

  // Paid: no more emails about it.
  for (const r of (await bookingPayments(bk.id, '2026-09-29')).filter((x) => x.left > 0 && x.due_date <= '2026-09-29')) {
    await recordPayment(r.id, { amount: r.left, method: 'cash', received_on: '2026-09-29' }, staff, '2026-09-29');
  }
  await runAlerts('2026-10-04', 9, { mail }); // 15 days on: a day to email, but nothing is owed
  assert.equal(mails.length, 2);

  // Emails switched off on the lease: neither the late fee email nor the reminder goes.
  const { bk: quiet } = await sara({ no_emails: true });
  await saveSettings({ latefee: { on: true }, tenant: { on: true }, quiet: { from: 0, to: 0 } }, '2026-09-01');
  const none = [];
  for (const day of ['2026-09-16', '2026-09-18', '2026-09-19', '2026-09-24']) await runAlerts(day, 9, { mail: async (...m) => { none.push(m); } });
  assert.deepEqual([none.length, (await fees(quiet.id, '2026-09-24')).length], [0, 1], 'the fee is still charged; only the email is off');

  // 0: never emailed.
  await saveSettings({ latefee: { email: 0 } }, '2026-09-01');
  assert.equal((await getSettings()).latefee.email, 0);
});
