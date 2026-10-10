import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  dueDate, createDuePayments, listEntries, listDues, saveEntry, setActive, deleteEntry, createNow, setPaid,
  listBuildings, saveBuilding, deleteBuilding,
  listAccounts, saveAccount, deleteAccount, getAccount, getDue, listTransfers, addTransfer, deleteTransfer, setAttachment, attachmentPath,
} from '../server/recurringPayments.js';

test.after(() => closeDb());

// The module's own buildings: Ayla Residence is 1, Gents Camp 2, Ladies Camp 3.
// And its own accounts: Cash to Mr Amran is 1, Cash to Mr Tauqeer 2.
async function setup() {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const jessa = { id: await makeUser('Jessa'), role: 'user' };
  const sabha = { id: await makeUser('Sabha'), role: 'user' };
  for (const name of ['Ayla Residence', 'Gents Camp', 'Ladies Camp']) await saveBuilding(master, null, { name });
  for (const name of ['Cash to Mr Amran', 'Cash to Mr Tauqeer']) await saveAccount(master, null, { name });
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

  // An invoice entered late keeps its own date, even one before the entry's start.
  const old = await createNow(jessa, byHand.id, '2026-12-20', '2026-09-28');
  assert.deepEqual([old.month, old.due_date], ['2026-09', '2026-09-28']);
  await assert.rejects(createNow(jessa, byHand.id, '2026-12-20', '2026-09-03'), /already has a payment for 2026-09/);
  await assert.rejects(createNow(jessa, byHand.id, '2026-12-20', '28/09/2026'), /date of the payment/);
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
    due_date: '2026-10-05', amount: 150, status: 'pending', paid_at: null, paid_on: null, paid_by: null, account: null, attachment: false,
  });
  await assert.rejects(setPaid(jessa, due.id, true), /Pick the account/);
  await assert.rejects(setPaid(jessa, due.id, true, { account_id: 99 }), /Pick the account/);
  const paid = await setPaid(jessa, due.id, true, { account_id: 2 }, '2026-10-07');
  assert.equal(paid.status, 'paid');
  assert.deepEqual(paid.account, { id: 2, name: 'Cash to Mr Tauqeer' });
  assert.equal(paid.paid_on, '2026-10-07', 'no date said = today');
  // The day it was received can be picked: the money came on the 3rd and is written down later.
  assert.equal((await setPaid(jessa, due.id, true, { account_id: 2, paid_on: '2026-10-03' }, '2026-10-07')).paid_on, '2026-10-03');
  await assert.rejects(setPaid(jessa, due.id, true, { account_id: 2, paid_on: '3/10/2026' }), /date the money was received/);
  assert.equal((await getAccount(jessa, 2)).movements[0].date, '2026-10-03');
  assert.equal(paid.paid_by, 'Jessa');
  assert.ok(paid.paid_at > 0);
  const back = await setPaid(jessa, due.id, false);
  assert.deepEqual([back.status, back.paid_at, back.paid_on, back.paid_by, back.account], ['pending', null, null, null, null]);
});

test('a month is listed with its totals, by building and by status', async () => {
  const { master } = await setup();
  await saveEntry(master, null, washer, '2026-10-05');
  await saveEntry(master, null, { title: 'Shop 3 rent', building_id: 2, unit: 'Shop 3', amount: 2500.5, day: 1, first_month: '2026-09' }, '2026-10-05');
  await saveEntry(master, null, { title: 'Shop 4 rent', building_id: 2, unit: 'Shop 4', amount: 1000, day: 2, first_month: '2026-10' }, '2026-10-05');

  const all = await listDues(master, {}, '2026-10-05');
  assert.equal(all.month, '2026-10');
  assert.deepEqual(all.buildings.map((b) => b.name), ['Ayla Residence', 'Gents Camp', 'Ladies Camp']);
  assert.deepEqual(all.dues.map((d) => d.title), ['Shop 3 rent', 'Shop 4 rent', 'Washing machine rent'], 'in the order they fall due');
  assert.deepEqual(all.totals, { pending: 3650.5, paid: 0, pending_count: 3, paid_count: 0 });

  await setPaid(master, all.dues[0].id, true, { account_id: 1 });
  const camp = await listDues(master, { building: '2', status: 'pending' }, '2026-10-05');
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

test('the buildings are the module\'s own: added, renamed, and deleted only when empty', async () => {
  const { master, jessa } = await setup();
  const shop = await saveBuilding(jessa, null, { name: '  Al  Noor shops ' });
  assert.deepEqual(shop, { id: 4, name: 'Al Noor shops', entries: 0 });
  await assert.rejects(saveBuilding(jessa, null, { name: ' ' }), /Give the building a name/);
  await assert.rejects(saveBuilding(jessa, null, { name: 'al noor SHOPS' }), /already in the list/);
  await assert.rejects(saveBuilding(jessa, 1, { name: 'Gents Camp' }), /already in the list/);
  assert.equal((await saveBuilding(jessa, shop.id, { name: 'al noor shops' })).name, 'al noor shops', 'its own name in other capitals is a rename');
  assert.equal(await saveBuilding(jessa, 999, { name: 'Nowhere' }), null);

  // A rename shows on the entries and on the lines already made.
  await saveEntry(jessa, null, washer, '2026-10-05');
  assert.equal((await saveBuilding(master, 1, { name: 'Ayla' })).entries, 1);
  assert.equal((await listEntries(jessa, '2026-10-05')).entries[0].building.name, 'Ayla');
  assert.equal((await listDues(jessa, {}, '2026-10-05')).dues[0].building.name, 'Ayla');
  assert.deepEqual((await listBuildings()).map((b) => b.name), ['al noor shops', 'Ayla', 'Gents Camp', 'Ladies Camp']);

  await assert.rejects(deleteBuilding(jessa, 1), /has 1 entry/);
  assert.deepEqual(await deleteBuilding(jessa, shop.id), { ok: true });
  assert.equal(await deleteBuilding(jessa, shop.id), null);
});

test('a building typed on the entry form is made there, or found if it is already in the list', async () => {
  const { jessa } = await setup();
  const fresh = await saveEntry(jessa, null, { ...washer, building_id: '', new_building: ' Corniche  Tower ' }, '2026-10-01');
  assert.deepEqual(fresh.building, { id: 4, name: 'Corniche Tower' });
  const found = await saveEntry(jessa, null, { ...washer, building_id: '', new_building: 'gents camp' }, '2026-10-01');
  assert.deepEqual(found.building, { id: 2, name: 'Gents Camp' });
  assert.equal((await listBuildings()).length, 4);
  await assert.rejects(saveEntry(jessa, null, { ...washer, building_id: '' }, '2026-10-01'), /Pick the building/);
});

test('everyone let in sees and changes all of it', async () => {
  const { master, jessa, sabha } = await setup();
  const ayla = await saveEntry(jessa, null, washer, '2026-10-05');
  const camp = await saveEntry(sabha, null, { ...washer, title: 'Shop 3 rent', building_id: 2 }, '2026-10-05');

  assert.deepEqual((await listEntries(jessa, '2026-10-05')).buildings.map((b) => b.name), ['Ayla Residence', 'Gents Camp', 'Ladies Camp']);
  assert.deepEqual((await listEntries(jessa, '2026-10-05')).entries.map((e) => e.id), [ayla.id, camp.id]);
  assert.equal((await listDues(sabha, {}, '2026-10-05')).dues.length, 2);
  assert.equal((await listDues(master, {}, '2026-10-05')).dues.length, 2);

  const [campDue] = (await listDues(sabha, { building: '2' }, '2026-10-05')).dues;
  assert.equal((await setPaid(jessa, campDue.id, true, { account_id: 1 })).paid_by, 'Jessa');
  assert.equal((await setActive(jessa, camp.id, false)).active, false);
  assert.equal(await setPaid(jessa, 999, true, { account_id: 1 }), null);
  assert.equal(await setActive(jessa, 999, false), null);
});

const balances = async () => Object.fromEntries((await listAccounts()).map((a) => [a.name, a.balance]));

test('the accounts are the module\'s own: added, renamed, and deleted only when nothing went through them', async () => {
  const { jessa } = await setup();
  assert.deepEqual(await saveAccount(jessa, null, { name: ' Bank ' }), { id: 3, name: 'Bank', balance: 0, used: false });
  await assert.rejects(saveAccount(jessa, null, { name: '' }), /Give the account a name/);
  await assert.rejects(saveAccount(jessa, null, { name: 'BANK' }), /already in the list/);
  assert.equal((await saveAccount(jessa, 3, { name: 'ADCB bank' })).name, 'ADCB bank');
  assert.equal(await saveAccount(jessa, 99, { name: 'Nowhere' }), null);

  await addTransfer(jessa, { from_id: 2, to_id: 1, amount: 10 }, '2026-10-06');
  await assert.rejects(deleteAccount(jessa, 1), /has payments or transfers/);
  assert.deepEqual(await deleteAccount(jessa, 3), { ok: true });
  assert.equal(await deleteAccount(jessa, 3), null);
});

test('money is where it was paid in, until it is transferred', async () => {
  const { jessa, sabha } = await setup();
  await saveEntry(jessa, null, washer, '2026-10-05');
  await saveEntry(jessa, null, { ...washer, title: 'Shop 3 rent', building_id: 2, unit: 'Shop 3', amount: 2500.5, day: 1 }, '2026-10-05');
  const [shop, wash] = (await listDues(jessa, {}, '2026-10-05')).dues;
  assert.deepEqual((await getDue(jessa, shop.id)).accounts, [{ id: 1, name: 'Cash to Mr Amran' }, { id: 2, name: 'Cash to Mr Tauqeer' }]);
  assert.equal(await getDue(jessa, 999), null);

  await setPaid(jessa, shop.id, true, { account_id: 2 });
  await setPaid(jessa, wash.id, true, { account_id: 2 });
  assert.deepEqual(await balances(), { 'Cash to Mr Amran': 0, 'Cash to Mr Tauqeer': 2650.5 });

  // Tauqeer hands 2,000 to Mr Amran.
  const t = await addTransfer(sabha, { from_id: 2, to_id: 1, amount: '2000', date: '2026-10-06', notes: ' Handed over at the office ' }, '2026-10-07');
  assert.deepEqual(t, {
    id: 1, from: { id: 2, name: 'Cash to Mr Tauqeer' }, to: { id: 1, name: 'Cash to Mr Amran' }, amount: 2000, date: '2026-10-06',
    notes: 'Handed over at the office', by: 'Sabha', attachment: false,
  });
  assert.deepEqual(await balances(), { 'Cash to Mr Amran': 2000, 'Cash to Mr Tauqeer': 650.5 });

  // A line put back to pending is no longer in its account.
  await setPaid(jessa, wash.id, false);
  assert.deepEqual(await balances(), { 'Cash to Mr Amran': 2000, 'Cash to Mr Tauqeer': 500.5 });

  const tauqeer = await getAccount(jessa, 2);
  assert.equal(tauqeer.account.balance, 500.5);
  assert.deepEqual(tauqeer.movements.map((m) => [m.kind, m.amount, m.text]).sort(), [
    ['payment', 2500.5, 'Shop 3 rent · Gents Camp · Shop 3 · 2026-10'],
    ['transfer', -2000, 'Transfer to Cash to Mr Amran · Handed over at the office'],
  ]);
  assert.deepEqual((await getAccount(jessa, 1)).movements.map((m) => [m.amount, m.text]), [[2000, 'Transfer from Cash to Mr Tauqeer · Handed over at the office']]);
  assert.equal(await getAccount(jessa, 99), null);

  // A transfer made by mistake is taken back.
  assert.deepEqual((await listTransfers()).transfers.map((x) => x.id), [1]);
  assert.deepEqual(await deleteTransfer(jessa, 1), { ok: true });
  assert.equal(await deleteTransfer(jessa, 1), null);
  assert.deepEqual(await balances(), { 'Cash to Mr Amran': 0, 'Cash to Mr Tauqeer': 2500.5 });
});

test('a transfer is checked', async () => {
  const { jessa } = await setup();
  const ok = { from_id: 2, to_id: 1, amount: 100 };
  await assert.rejects(addTransfer(jessa, { ...ok, from_id: 9 }), /comes from/);
  await assert.rejects(addTransfer(jessa, { ...ok, to_id: '' }), /goes to/);
  await assert.rejects(addTransfer(jessa, { ...ok, to_id: 2 }), /two different accounts/);
  await assert.rejects(addTransfer(jessa, { ...ok, amount: 0 }), /more than 0/);
  await assert.rejects(addTransfer(jessa, { ...ok, date: '06/10/2026' }), /date of the transfer/);
  assert.equal((await addTransfer(jessa, ok, '2026-10-06')).date, '2026-10-06', 'no date said = today');
  // The books are open: an account may go below zero.
  assert.deepEqual(await balances(), { 'Cash to Mr Amran': 100, 'Cash to Mr Tauqeer': -100 });
});

test('a paid line and a transfer can each keep a file, and a new one replaces it', async () => {
  const { jessa } = await setup();
  await saveEntry(jessa, null, washer, '2026-10-05');
  const [due] = (await listDues(jessa, {}, '2026-10-05')).dues;
  const t = await addTransfer(jessa, { from_id: 2, to_id: 1, amount: 100 }, '2026-10-06');
  const pdf = { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
  const jpg = { mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) };

  await assert.rejects(setAttachment(jessa, 'due', due.id, { mimetype: 'text/html', buffer: Buffer.from('<p>') }), /picture \(JPG, PNG\) or a PDF/);
  assert.equal(await setAttachment(jessa, 'due', 999, pdf), null);
  assert.deepEqual(await setAttachment(jessa, 'due', due.id, pdf), { ok: true });
  const first = await attachmentPath('due', due.id);
  assert.match(first, /due-1-\d+\.pdf$/);
  assert.equal((await getDue(jessa, due.id)).due.attachment, true);

  await setAttachment(jessa, 'due', due.id, jpg);
  assert.equal(existsSync(first), false, 'the old file is gone');
  assert.match(await attachmentPath('due', due.id), /\.jpg$/);

  await setAttachment(jessa, 'transfer', t.id, pdf);
  const kept = await attachmentPath('transfer', t.id);
  assert.equal((await listTransfers()).transfers[0].attachment, true);
  await deleteTransfer(jessa, t.id);
  assert.equal(existsSync(kept), false, 'a deleted transfer takes its file with it');
  (await import('node:fs')).rmSync(await attachmentPath('due', due.id), { force: true });
});
