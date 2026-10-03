import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { chart, addAccount, changeAccount, deleteAccount, getSide, saveEntry, setStatus, deleteEntry } from '../server/recurring.js';

test.after(() => closeDb());

const pdf = (name = 'receipt.pdf') => ({ buffer: Buffer.from('%PDF-1.4 test'), mimetype: 'application/pdf', originalname: name });
const filesOf = async () => (await db.prepare('SELECT file FROM recurring_entries').all()).map((r) => r.file);

async function setup() {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const company = await addAccount(master, 'receivable', { name: ' Ain Al  Reem ' });
  const cash = await addAccount(master, 'receivable', { name: 'Cash to Mr Tauqeer', parent_id: company.id });
  return { master, company, cash };
}
const entry = (cash, more = {}) => ({ account_id: cash.id, amount: '1500.5', method: 'cash', due_date: '2099-01-31', ...more });

test('the chart is a parent with accounts under it, and each side has its own', async () => {
  const { master, company, cash } = await setup();
  assert.equal(company.name, 'Ain Al Reem');
  assert.deepEqual(await chart('receivable'), [{ id: company.id, name: 'Ain Al Reem', hidden: false, accounts: [{ id: cash.id, name: 'Cash to Mr Tauqeer', hidden: false, entries: 0 }] }]);
  assert.deepEqual(await chart('payable'), [], 'the payable chart knows nothing of the receivable one');

  await assert.rejects(addAccount(master, 'receivable', { name: 'ain al reem' }), /already a parent account/);
  await assert.rejects(addAccount(master, 'receivable', { name: 'cash to mr tauqeer', parent_id: company.id }), /already has an account/);
  await assert.rejects(addAccount(master, 'receivable', { name: ' ' }), /Give the parent account a name/);
  await assert.rejects(addAccount(master, 'receivable', { name: 'X', parent_id: cash.id }), /Pick the parent/, 'only two levels');
  await assert.rejects(addAccount(master, 'payable', { name: 'X', parent_id: company.id }), /Pick the parent/, 'a parent of the other side is not a parent here');
  await assert.rejects(addAccount(master, 'other', { name: 'X' }), { status: 404 });

  // The same names are free on the other side.
  const theirs = await addAccount(master, 'payable', { name: 'Ain Al Reem' });
  await addAccount(master, 'payable', { name: 'Cash to Mr Tauqeer', parent_id: theirs.id });
  assert.equal((await chart('payable'))[0].accounts.length, 1);
});

test('an entry needs an account of its own side, an amount, a payment, a due date and an attachment', async () => {
  const { master, company, cash } = await setup();
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash), null), /cannot be saved without one/);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash), { ...pdf(), mimetype: 'text/plain' }), /picture .* or a PDF/);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(company), pdf()), /Pick the account/, 'a parent is not an account');
  await assert.rejects(saveEntry(master, 'payable', null, entry(cash), pdf()), /Pick the account/, 'a receivable account is not a payable one');
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash, { amount: '0' }), pdf()), /above 0/);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash, { method: 'card' }), pdf()), /cash, bank transfer or cheque/);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash, { due_date: '' }), pdf()), /due date/);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash, { status: 'late' }), pdf()), /pending or paid/);
  assert.deepEqual(await filesOf(), [], 'nothing refused was kept');

  const e = await saveEntry(master, 'receivable', null, entry(cash, { note: ' March rent ' }), pdf());
  assert.deepEqual({ ...e, updated_at: 0 }, {
    id: e.id, account_id: cash.id, account: 'Cash to Mr Tauqeer', parent: 'Ain Al Reem', amount: 1500.5, method: 'cash', status: 'pending',
    due_date: '2099-01-31', note: 'March rent', file_name: 'receipt.pdf', file_mime: 'application/pdf', updated_at: 0, updated_by: 'Owner',
  });
  const [file] = await filesOf();
  assert.ok(existsSync(file));
  assert.deepEqual((await getSide('payable')).entries, []);
  await deleteEntry('receivable', e.id);
  assert.ok(!existsSync(file), 'the attachment goes with the entry');
});

test('a pending entry past its due date is overdue, and the totals follow', async () => {
  const { master, cash } = await setup();
  const late = await saveEntry(master, 'receivable', null, entry(cash, { amount: 100, due_date: '2020-01-01' }), pdf());
  const soon = await saveEntry(master, 'receivable', null, entry(cash, { amount: 200 }), pdf());
  const done = await saveEntry(master, 'receivable', null, entry(cash, { amount: 50, due_date: '2020-01-01', status: 'paid', method: 'cheque' }), pdf());
  assert.equal(late.status, 'overdue');
  assert.equal(done.status, 'paid', 'paid is never overdue');
  let side = await getSide('receivable');
  assert.deepEqual(side.totals, { pending: 200, overdue: 100, paid: 50 });
  assert.deepEqual(side.entries.map((e) => e.id), [late.id, soon.id, done.id], 'soonest due first, paid last');

  assert.equal((await setStatus(master, 'receivable', late.id, 'paid')).status, 'paid');
  assert.equal(await setStatus(master, 'payable', soon.id, 'paid'), null, 'not from the other side');
  await assert.rejects(setStatus(master, 'receivable', soon.id, 'overdue'), /pending or paid/);
  side = await getSide('receivable');
  assert.deepEqual(side.totals, { pending: 200, overdue: 0, paid: 150 });
  for (const f of await filesOf()) await deleteEntry('receivable', (await db.prepare('SELECT id FROM recurring_entries WHERE file = ?').get(f)).id);
});

test('changing an entry keeps its attachment unless a new one comes', async () => {
  const { master, company, cash } = await setup();
  const bank = await addAccount(master, 'receivable', { name: 'Bank', parent_id: company.id });
  const e = await saveEntry(master, 'receivable', null, entry(cash), pdf());
  const [first] = await filesOf();

  const moved = await saveEntry(master, 'receivable', e.id, entry(bank, { amount: 99, method: 'bank', status: 'paid' }), null);
  assert.deepEqual([moved.account, moved.amount, moved.method, moved.status, moved.file_name], ['Bank', 99, 'bank', 'paid', 'receipt.pdf']);
  assert.deepEqual(await filesOf(), [first]);

  const swapped = await saveEntry(master, 'receivable', e.id, entry(bank), pdf('new.pdf'));
  assert.equal(swapped.file_name, 'new.pdf');
  assert.ok(!existsSync(first), 'the old attachment is not left behind');
  assert.equal(await saveEntry(master, 'payable', e.id, entry(bank), null), null);
  await deleteEntry('receivable', e.id);
});

test('an account with entries is hidden, not removed', async () => {
  const { master, company, cash } = await setup();
  const e = await saveEntry(master, 'receivable', null, entry(cash), pdf());
  await assert.rejects(deleteAccount('receivable', cash.id), /Hide it instead/);
  await assert.rejects(deleteAccount('receivable', company.id), /still has accounts/);
  assert.equal(await deleteAccount('payable', cash.id), null);

  assert.equal((await changeAccount('receivable', cash.id, { hidden: true })).hidden, true);
  await assert.rejects(saveEntry(master, 'receivable', null, entry(cash), pdf()), /is hidden/);
  assert.equal((await saveEntry(master, 'receivable', e.id, entry(cash, { amount: 5 }), null)).amount, 5, 'an entry already on it can still be changed');
  assert.equal((await changeAccount('receivable', cash.id, { name: 'Cash to Mr T', hidden: false })).name, 'Cash to Mr T');
  assert.equal((await getSide('receivable')).entries[0].account, 'Cash to Mr T');
  await assert.rejects(changeAccount('receivable', cash.id, { name: '' }), /cannot be empty/);

  await deleteEntry('receivable', e.id);
  assert.deepEqual(await deleteAccount('receivable', cash.id), { ok: true });
  assert.deepEqual(await deleteAccount('receivable', company.id), { ok: true });
  assert.deepEqual(await chart('receivable'), []);
});
