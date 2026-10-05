import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { saveBuilding } from '../server/buildings.js';
import {
  dueDate, createDuePayments, listEntries, listDues, saveEntry, setActive, deleteEntry, createNow, setPaid,
} from '../server/recurringPayments.js';

test.after(() => closeDb());

// A stand-in for saifsys: only its building list is asked for, when an entry on the Buildings screen is saved.
const SITES = [{ id: 1, name: 'Ayla Residence' }, { id: 3, name: 'Gents Camp' }, { id: 4, name: 'Ladies Camp' }];
const ask = async (module, action) => {
  if (module === 'operations' && action === 'buildings') return { ok: true, buildings: SITES };
  throw new Error(`unexpected ${module}/${action}`);
};

async function setup() {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const jessa = { id: await makeUser('Jessa'), role: 'user' };
  const sabha = { id: await makeUser('Sabha'), role: 'user' };
  await saveBuilding(master, null, { name: 'Ayla', admin_id: jessa.id, sites: [1] }, ask);
  await saveBuilding(master, null, { name: 'Camps', admin_id: sabha.id, sites: [3, 4] }, ask);
  return { master, jessa, sabha };
}

const washer = { title: ' Washing  machine rent ', building_id: 1, unit: 'Laundry room', amount: '150', day: 5, first_month: '2026-10' };
const months = async (entryId) => (await db.prepare('SELECT month, due_date, amount, status FROM recurring_payment_dues WHERE payment_id = ? ORDER BY month').all(entryId));

test('the 31st is the last day of a shorter month', () => {
  assert.equal(dueDate('2026-10', 31), '2026-10-31');
  assert.equal(dueDate('2026-11', 31), '2026-11-30');
  assert.equal(dueDate('2026-02', 30), '2026-02-28');
  assert.equal(dueDate('2028-02', 30), '2028-02-29');
  assert.equal(dueDate('2026-10', 5), '2026-10-05');
});

test('an entry is checked, and comes back as it was kept', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-01');
  assert.deepEqual(e, {
    id: e.id, title: 'Washing machine rent', building: { id: 1, name: 'Ayla Residence' }, unit: 'Laundry room', amount: 150, day: 5,
    auto_create: true, first_month: '2026-10', active: true, notes: null, payments: 0, has_this_month: false,
  });
  const ok = { ...washer };
  await assert.rejects(saveEntry(jessa, null, { ...ok, title: ' ' }, '2026-10-01'), /Give the entry a title/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, building_id: 999 }, '2026-10-01'), /Pick the building/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, amount: 0 }, '2026-10-01'), /more than 0/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, amount: 'lots' }, '2026-10-01'), /more than 0/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, day: 32 }, '2026-10-01'), /1 to 31/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, day: 1.5 }, '2026-10-01'), /1 to 31/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, first_month: '2026-13' }, '2026-10-01'), /first month/);
  await assert.rejects(saveEntry(jessa, null, { ...ok, first_month: '2020-01' }, '2026-10-01'), /three years back/);
  assert.equal((await saveEntry(jessa, null, { ...ok, first_month: '' }, '2026-10-01')).first_month, '2026-10', 'no first month said = this month');
});

test('the line is created on its day, pending, and only once', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-01');
  assert.equal(await createDuePayments('2026-10-04'), 0, 'the 5th has not come');
  assert.deepEqual(await months(e.id), []);
  assert.equal(await createDuePayments('2026-10-05'), 1);
  assert.deepEqual(await months(e.id), [{ month: '2026-10', due_date: '2026-10-05', amount: 150, status: 'pending' }]);
  assert.equal(await createDuePayments('2026-10-05'), 0, 'running it again makes nothing new');
  assert.equal(await createDuePayments('2026-10-28'), 0);
  assert.equal(await createDuePayments('2026-11-05'), 1);
  assert.deepEqual((await months(e.id)).map((d) => d.month), ['2026-10', '2026-11']);
});

test('months missed while the server was down are made on the next run', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, { ...washer, day: 31, first_month: '2026-11' }, '2026-10-01');
  assert.equal(await createDuePayments('2027-03-10'), 4);
  assert.deepEqual((await months(e.id)).map((d) => d.due_date), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
});

test('an entry added after its day shows this month straight away', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, { ...washer, day: 1 }, '2026-10-05');
  assert.equal(e.payments, 1);
  assert.equal(e.has_this_month, true);
});

test('a paused entry and one that does not create its own are left alone', async () => {
  const { jessa } = await setup();
  const paused = await saveEntry(jessa, null, washer, '2026-10-01');
  const byHand = await saveEntry(jessa, null, { ...washer, title: 'Parking', auto_create: false }, '2026-10-01');
  assert.equal((await setActive(jessa, paused.id, false, '2026-10-01')).active, false);
  assert.equal(await createDuePayments('2026-12-20'), 0);

  // Resumed, it catches up at once.
  assert.equal((await setActive(jessa, paused.id, true, '2026-12-20')).payments, 3);

  // By hand: this month's, once, and not while paused.
  const due = await createNow(jessa, byHand.id, '2026-12-20');
  assert.deepEqual([due.month, due.due_date, due.status, due.title], ['2026-12', '2026-12-05', 'pending', 'Parking']);
  await assert.rejects(createNow(jessa, byHand.id, '2026-12-20'), /already there/);
  await setActive(jessa, byHand.id, false, '2026-12-20');
  await assert.rejects(createNow(jessa, byHand.id, '2027-01-02'), /is paused/);
});

test('changing an entry is for the months to come', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-05');
  const changed = await saveEntry(jessa, e.id, { ...washer, amount: 200, day: 10 }, '2026-10-20');
  assert.equal(changed.amount, 200);
  await createDuePayments('2026-11-10');
  assert.deepEqual(await months(e.id), [
    { month: '2026-10', due_date: '2026-10-05', amount: 150, status: 'pending' },
    { month: '2026-11', due_date: '2026-11-10', amount: 200, status: 'pending' },
  ]);
});

test('a line is marked paid with who and when, and can go back to pending', async () => {
  const { jessa } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-05');
  const [due] = (await listDues(jessa, {}, '2026-10-05')).dues;
  assert.deepEqual({ ...due }, {
    id: due.id, entry_id: e.id, month: '2026-10', title: 'Washing machine rent', building: { id: 1, name: 'Ayla Residence' }, unit: 'Laundry room',
    due_date: '2026-10-05', amount: 150, status: 'pending', paid_at: null, paid_by: null,
  });
  const paid = await setPaid(jessa, due.id, true);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_by, 'Jessa');
  assert.ok(paid.paid_at > 0);
  const back = await setPaid(jessa, due.id, false);
  assert.deepEqual([back.status, back.paid_at, back.paid_by], ['pending', null, null]);
});

test('a month is listed with its totals, by building and by status', async () => {
  const { master } = await setup();
  await saveEntry(master, null, washer, '2026-10-05');
  await saveEntry(master, null, { title: 'Shop 3 rent', building_id: 3, unit: 'Shop 3', amount: 2500.5, day: 1, first_month: '2026-09' }, '2026-10-05');
  await saveEntry(master, null, { title: 'Shop 4 rent', building_id: 3, unit: 'Shop 4', amount: 1000, day: 2, first_month: '2026-10' }, '2026-10-05');

  const all = await listDues(master, {}, '2026-10-05');
  assert.equal(all.month, '2026-10');
  assert.deepEqual(all.buildings.map((b) => b.name), ['Ayla Residence', 'Gents Camp', 'Ladies Camp']);
  assert.deepEqual(all.dues.map((d) => d.title), ['Shop 3 rent', 'Shop 4 rent', 'Washing machine rent'], 'in the order they fall due');
  assert.deepEqual(all.totals, { pending: 3650.5, paid: 0, pending_count: 3, paid_count: 0 });

  await setPaid(master, all.dues[0].id, true);
  const camp = await listDues(master, { building: '3', status: 'pending' }, '2026-10-05');
  assert.deepEqual(camp.dues.map((d) => d.title), ['Shop 4 rent']);
  assert.deepEqual(camp.totals, { pending: 1000, paid: 2500.5, pending_count: 1, paid_count: 1 }, 'the totals are the building\'s, whatever status is looked at');
  assert.deepEqual((await listDues(master, { month: '2026-09' }, '2026-10-05')).dues.map((d) => d.title), ['Shop 3 rent']);

  // By shop or unit: the ones typed on the entries, narrowed to the building picked.
  assert.deepEqual(all.units, ['Laundry room', 'Shop 3', 'Shop 4']);
  assert.deepEqual(camp.units, ['Shop 3', 'Shop 4']);
  const shop3 = await listDues(master, { unit: ' shop 3 ' }, '2026-10-05');
  assert.deepEqual(shop3.dues.map((d) => d.title), ['Shop 3 rent']);
  assert.deepEqual(shop3.totals, { pending: 0, paid: 2500.5, pending_count: 0, paid_count: 1 });
  assert.deepEqual((await listDues(master, { unit: 'Shop 9' }, '2026-10-05')).dues, []);
  assert.equal((await listDues(master, { month: 'nonsense' }, '2026-10-05')).month, '2026-10');
});

test('an entry with payments is paused, not deleted', async () => {
  const { jessa } = await setup();
  const withLines = await saveEntry(jessa, null, washer, '2026-10-05');
  const fresh = await saveEntry(jessa, null, { ...washer, title: 'Parking', day: 25 }, '2026-10-05');
  await assert.rejects(deleteEntry(jessa, withLines.id), /already has payments/);
  assert.deepEqual(await deleteEntry(jessa, fresh.id), { ok: true });
  assert.deepEqual((await listEntries(jessa, '2026-10-05')).entries.map((e) => e.title), ['Washing machine rent']);
});

test('each person has only their own buildings', async () => {
  const { master, jessa, sabha } = await setup();
  const ayla = await saveEntry(jessa, null, washer, '2026-10-05');
  const camp = await saveEntry(sabha, null, { ...washer, title: 'Shop 3 rent', building_id: 3 }, '2026-10-05');
  const stranger = { id: await makeUser('Stranger'), role: 'user' };

  assert.deepEqual((await listEntries(jessa, '2026-10-05')).buildings, [{ id: 1, name: 'Ayla Residence' }]);
  assert.deepEqual((await listEntries(jessa, '2026-10-05')).entries.map((e) => e.id), [ayla.id]);
  assert.deepEqual((await listDues(sabha, {}, '2026-10-05')).dues.map((d) => d.title), ['Shop 3 rent']);
  assert.equal((await listDues(master, {}, '2026-10-05')).dues.length, 2);
  assert.deepEqual(await listDues(stranger, {}, '2026-10-05'), { month: '2026-10', buildings: [], units: [], dues: [], totals: { pending: 0, paid: 0, pending_count: 0, paid_count: 0 } });

  // Somebody else's entry and line are simply not there.
  const [campDue] = (await listDues(sabha, {}, '2026-10-05')).dues;
  await assert.rejects(saveEntry(jessa, null, { ...washer, building_id: 3 }, '2026-10-05'), /Pick the building/);
  assert.equal(await saveEntry(jessa, camp.id, washer, '2026-10-05'), null);
  assert.equal(await setActive(jessa, camp.id, false), null);
  assert.equal(await deleteEntry(jessa, camp.id), null);
  assert.equal(await createNow(jessa, camp.id), null);
  assert.equal(await setPaid(jessa, campDue.id, true), null);
  assert.equal((await setPaid(master, campDue.id, true)).status, 'paid');
});
