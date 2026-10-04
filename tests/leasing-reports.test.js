import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { addTenant, createBooking, confirmBooking, renewBooking, bookingPayments, recordPayment, schedule, total, overview } from '../server/leasing.js';
import { report } from '../server/leasingReports.js';
import { listAlerts, runAlerts, saveSettings, getSettings, isQuiet } from '../server/leasingAlerts.js';

test.after(() => closeDb());

const AT = '2026-10-10';

// Sara: a two-month stay in 101, September part paid. Omar: a year's lease of 102 starting
// today, paid quarterly, Emirates ID expiring in 26 days. 103 has never been let.
async function books() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const [u1, u2] = [await create('unit', { unit_no: '101', type: '1BR' }, b.id), await create('unit', { unit_no: '102' }, b.id)];
  await create('unit', { unit_no: '103' }, b.id);
  const sara = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed', tenant: { full_name: 'Sara', phone: '050' } }, staff);
  const omar = await addTenant({ full_name: 'Omar', emirates_id_expiry: '2026-11-05' });
  const lease = await createBooking({ unit_id: u2.id, tenant_id: omar.id, start_date: AT, end_date: '2027-10-09', rent_amount: 60000, rent_period: 'year',
    payment_frequency: 'quarterly', contract_no: 'EJ-1', status: 'confirmed' }, staff);
  // Sara's booking was confirmed three days ago (UAE), with no contract since.
  await db.prepare('UPDATE lease_bookings SET created_at = ? WHERE id = ?').run(Date.UTC(2026, 9, 7, 6) / 1000, sara.id);
  const [sep] = await bookingPayments(sara.id, AT);
  await recordPayment(sep.id, { amount: 2000, method: 'transfer', received_on: '2026-10-05', reference: 'TT-1' }, staff, AT);
  return { master, staff, c, b, sara, omar, lease };
}

test('reports: rent roll, aging, collections, expiring, vacancy and a tenant statement', async () => {
  const { b, sara, omar } = await books();

  const day = await report('daily', {}, AT);
  assert.deepEqual(day.rows.map((r) => [r.what, r.tenant, r.unit_no, r.amount]), [['Due, not paid', 'Omar', '102', 15000], ['Move-in', 'Omar', '102', undefined]]);
  assert.deepEqual(day.summary.slice(0, 5).map((x) => x.value), [0, 0, 15000, 15000, 1]);
  const fifth = await report('daily', { day: '2026-10-05' }, AT);
  assert.deepEqual(fifth.rows.map((r) => [r.what, r.tenant, r.detail, r.amount, r.by]), [['Payment received', 'Sara', 'Rent · Bank transfer · TT-1', 2000, 'Staff']]);
  assert.equal(fifth.subtitle, 'All companies · 2026-10-05');
  await assert.rejects(report('daily', { day: '2026-10-11' }, AT), /has not happened yet/);

  const roll = await report('rent-roll', {}, AT);
  assert.deepEqual(roll.rows.map((r) => [r.unit_no, r.status, r.tenant, r.rent, r.owed]),
    [['101', 'Overdue', 'Sara', 4500, 2500], ['102', 'Occupied', 'Omar', 5000, null], ['103', 'Vacant', undefined, null, null]]);
  assert.deepEqual(roll.total, { rent: 9500, owed: 2500 });
  assert.equal(roll.subtitle, 'All companies');
  assert.equal((await report('rent-roll', { building_id: b.id }, AT)).subtitle, 'Tower, ACE');
  assert.equal((await report('rent-roll', { building_id: b.id + 1 }, AT)).rows.length, 0);

  const aging = await report('aging', {}, AT);
  assert.deepEqual(aging.rows.map((r) => [r.tenant, r.b0, r.b1, r.owed, r.days]), [['Sara', 2500, 0, 2500, 25]]);
  assert.equal(aging.total.owed, 2500);

  const got = await report('collections', {}, AT);
  assert.deepEqual(got.rows.map((r) => [r.received_on, r.tenant, r.method, r.reference, r.amount, r.recorded_by]), [['2026-10-05', 'Sara', 'Bank transfer', 'TT-1', 2000, 'Staff']]);
  assert.deepEqual([got.from, got.to, got.total.amount], ['2026-10-01', AT, 2000]);
  assert.equal((await report('collections', { from: '2026-09-01', to: '2026-09-30' }, AT)).rows.length, 0);
  await assert.rejects(report('collections', { from: '2026-10-02', to: '2026-10-01' }, AT), /before the start/);

  assert.deepEqual((await report('expiring', { days: 60 }, AT)).rows.map((r) => [r.tenant, r.days_left, r.renewal, r.kind]), [['Sara', 35, 'Not renewed', 'Short stay']]);
  assert.equal((await report('expiring', { days: 30 }, AT)).rows.length, 0);

  const empty = await report('vacancy', {}, AT);
  assert.deepEqual(empty.rows.map((r) => [r.unit_no, r.days_vacant]), [['103', null]]);

  const st = await report('statement', { tenant_id: sara.tenant_id }, AT);
  assert.deepEqual(st.rows.map((r) => [r.date, r.charge, r.payment, r.balance]), [['2026-09-15', 4500, null, 4500], ['2026-10-05', null, 2000, 2500]]);
  assert.equal(st.summary.at(-1).label, 'Next due 2026-10-15');
  assert.deepEqual((await report('statement', { tenant_id: omar.id }, AT)).rows.map((r) => [r.date, r.charge, r.balance]), [[AT, 15000, 15000]]);
  await assert.rejects(report('statement', {}, AT), /Choose a tenant/);
  await assert.rejects(report('nope', {}, AT), /No such report/);
});

test('alerts: what is open, who is buzzed, and never twice', async () => {
  const { master, staff } = await books();

  const open = await listAlerts({}, AT);
  assert.deepEqual(open.map((a) => [a.rule, a.tenant, a.level, a.fires]),
    [['overdue', 'Sara', 'bad', false], ['due', 'Omar', 'warn', true], ['contract', 'Sara', 'warn', true], ['eid', 'Omar', 'warn', false]]);
  assert.equal(open[0].title, 'Sara owes AED 2,500');
  assert.equal(open[1].title, 'Omar: AED 15,000 is due today');

  assert.deepEqual(await runAlerts(AT, 23), [], 'nothing goes out in the quiet hours');
  const sent = await runAlerts(AT, 9);
  // Sara is 25 days late, which is not one of the rule's days, but nobody has been told yet: it goes.
  assert.deepEqual(sent.find((n) => n.user_id === staff), { user_id: staff, title: 'Sara owes AED 2,500', body: 'Unit 101, Tower · 25 days late — and 2 more' });
  assert.deepEqual(sent.find((n) => n.user_id === master), { user_id: master, title: 'Leasing today', body: 'Today: 1 due (AED 15,000), 1 overdue (AED 2,500)' });
  assert.deepEqual(await runAlerts(AT, 10), [], 'the same day again sends nothing');

  // The master changes the rules: day 25 is now a day to chase, and due-today is off.
  const cfg = await saveSettings({ overdue: { days: '25, 1' }, due: { on: false }, quiet: { from: 0, to: 0 } });
  assert.deepEqual([cfg.overdue.days, cfg.due.on, cfg.upcoming.days], [[1, 25], false, 3]);
  assert.deepEqual(await getSettings(), cfg);
  assert.deepEqual((await listAlerts({}, AT)).map((a) => [a.rule, a.fires]), [['overdue', true], ['contract', true], ['eid', false]]);
  // The next day Omar is a day late, which is a day to chase. Sara, already told, waits for her next day.
  const next = await runAlerts('2026-10-11', 23);
  assert.deepEqual(next.find((n) => n.user_id === staff), { user_id: staff, title: 'Omar owes AED 15,000', body: 'Unit 102, Tower · 1 day late' });
  assert.deepEqual(next.find((n) => n.user_id === master), { user_id: master, title: 'Leasing today', body: 'Today: 0 due (AED 0), 2 overdue (AED 17,500)' });
  // The day after, nothing new is late: staff hear only that Sara's October rent is three days off, the master gets the morning total.
  assert.deepEqual((await runAlerts('2026-10-12', 23)).map((n) => [n.user_id, n.title]).sort(), [[master, 'Leasing today'], [staff, 'Sara: AED 4,500 is due in 3 days']]);
  await assert.rejects(saveSettings({ upcoming: { days: 99 } }), /whole number from 0 to 60/);
  await assert.rejects(saveSettings({ ending: { lease: '' } }), /between one and eight/);

  assert.deepEqual([isQuiet({ from: 22, to: 8 }, 23), isQuiet({ from: 22, to: 8 }, 7), isQuiet({ from: 22, to: 8 }, 8), isQuiet({ from: 1, to: 5 }, 3), isQuiet({ from: 0, to: 0 }, 3)],
    [true, true, false, true, false]);
});

test('rent that goes unpaid stays in sight across a renewal and after the tenant has left', async () => {
  const { staff, sara } = await books();

  // A year written 16 March to 16 March is twelve payments, and they add up to the rent to the fil.
  const year = schedule({ start_date: '2026-03-16', end_date: '2027-03-16', rent_amount: 62000, rent_period: 'year', payment_frequency: 'monthly' });
  assert.deepEqual([year.length, year.at(-1).due, total(year)], [12, '2027-02-16', 62000]);

  // Sara renews still owing 2,500 of September and all of October, and pays the first month of the renewal.
  const again = await renewBooking(sara.id, staff);
  await confirmBooking(again.id, staff);
  const [nov] = await bookingPayments(again.id, '2026-11-20');
  await recordPayment(nov.id, { amount: 4500, method: 'cash', received_on: '2026-11-15' }, staff, '2026-11-20');
  const roll = await report('rent-roll', {}, '2026-11-20');
  assert.deepEqual(roll.rows.filter((r) => r.unit_no === '101').map((r) => [r.tenant, r.status, r.owed]), [['Sara', 'Overdue', 7000]], 'the old booking is still owed on her unit');
  assert.equal(roll.summary.some((f) => f.label === 'Owed by tenants who left'), false);

  // By February she has gone, owing December as well. The unit is empty; the debt is not forgotten.
  const feb = await report('rent-roll', {}, '2027-02-01');
  assert.deepEqual(feb.rows.filter((r) => r.unit_no === '101').map((r) => [r.status, r.owed]), [['Vacant', null]]);
  assert.deepEqual(feb.summary.at(-1), { label: 'Owed by tenants who left', value: 11500, kind: 'money' });
  assert.deepEqual((await report('aging', {}, '2027-02-01')).rows.filter((r) => r.tenant === 'Sara').map((r) => r.owed), [7000, 4500], 'a line for each of her bookings');
  assert.ok((await listAlerts({}, '2027-02-01')).some((a) => a.rule === 'overdue' && a.tenant === 'Sara' && a.amount === 7000));

  // The overview's bands and the report's bands are the same figures.
  const o = await overview({}, '2027-02-01');
  const bands = (await report('aging', {}, '2027-02-01')).total;
  assert.deepEqual(o.overdue.aging.map((x) => x.amount), [bands.b0, bands.b1, bands.b2, bands.b3]);
  assert.equal(o.overdue.total, bands.owed);
});
