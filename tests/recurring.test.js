import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  companies, addCompany, renameCompany, deleteCompany, chart, addAccount, changeAccount, deleteAccount, getSide, saveEntry, setStatus, deleteEntry,
} from '../server/recurring.js';

test.after(() => closeDb());

const R = 'receivable';
const pdf = (name = 'receipt.pdf') => ({ buffer: Buffer.from('%PDF-1.4 test'), mimetype: 'application/pdf', originalname: name });
const filesOf = async () => (await db.prepare('SELECT file FROM recurring_entries ORDER BY id').all()).map((r) => r.file);
const clear = async (companyId, side = R) => { for (const e of (await getSide(companyId, side)).entries) await deleteEntry(companyId, side, e.id); };

async function setup() {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const co = await addCompany(master, { name: ' Ain Al  Reem ' });
  const cash = await addAccount(master, co.id, R, { name: 'Cash' });
  const tauqeer = await addAccount(master, co.id, R, { name: 'Cash to Mr Tauqeer', parent_id: cash.id, account_no: ' 1310 ' });
  return { master, co, cash, tauqeer };
}
const entry = (account, more = {}) => ({ account_id: account.id, amount: '1500.5', method: 'cash', due_date: '2099-01-31', ...more });

test('a company is typed freely, once', async () => {
  const { master, co } = await setup();
  assert.equal(co.name, 'Ain Al Reem');
  await assert.rejects(addCompany(master, { name: 'ain al reem' }), /already a company/);
  await assert.rejects(addCompany(master, { name: ' ' }), /Give the company a name/);
  const other = await addCompany(master, { name: 'Saif Holding' });
  await assert.rejects(renameCompany(other.id, { name: 'Ain Al Reem' }), /already a company/);
  assert.equal((await renameCompany(other.id, { name: 'Saif Holding Group' })).name, 'Saif Holding Group');
  assert.equal(await renameCompany(999, { name: 'X' }), null);
  assert.deepEqual((await companies()).map((c) => c.name), ['Ain Al Reem', 'Saif Holding Group']);
});

test('the chart is open: any name, any depth, an optional number, and each company and side has its own', async () => {
  const { master, co, cash, tauqeer } = await setup();
  assert.equal(tauqeer.account_no, '1310');
  const deep = await addAccount(master, co.id, R, { name: 'March', parent_id: tauqeer.id });
  assert.deepEqual((await chart(co.id, R)).map((a) => [a.depth, a.account_no, a.name, a.under]), [
    [0, null, 'Cash', ''], [1, '1310', 'Cash to Mr Tauqeer', 'Cash'], [2, null, 'March', 'Cash › Cash to Mr Tauqeer'],
  ]);
  assert.deepEqual(await chart(co.id, 'payable'), [], 'the payable chart knows nothing of the receivable one');

  await assert.rejects(addAccount(master, co.id, R, { name: 'cash' }), /already an account called cash/);
  await assert.rejects(addAccount(master, co.id, R, { name: ' ' }), /Give the account a name/);
  await assert.rejects(addAccount(master, co.id, 'payable', { name: 'X', parent_id: cash.id }), /goes under/, 'not under an account of the other side');
  await assert.rejects(addAccount(master, co.id, 'other', { name: 'X' }), { status: 404 });
  assert.equal(await addAccount(master, 999, R, { name: 'X' }), null);
  // The same name is free one level down, on the other side, and in another company.
  await addAccount(master, co.id, R, { name: 'Cash', parent_id: deep.id });
  await addAccount(master, co.id, 'payable', { name: 'Cash' });
  const other = await addCompany(master, { name: 'Saif Holding' });
  await addAccount(master, other.id, R, { name: 'Cash' });
  await assert.rejects(addAccount(master, other.id, R, { name: 'X', parent_id: cash.id }), /goes under/, 'not under another company\'s account');
  assert.equal((await chart(other.id, R)).length, 1);
});

test('an entry needs an account of its own company and side, an amount, a payment, a due date and an attachment', async () => {
  const { master, co, cash, tauqeer } = await setup();
  const other = await addCompany(master, { name: 'Saif Holding' });
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer), null), /cannot be saved without one/);
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer), { ...pdf(), mimetype: 'text/plain' }), /picture .* or a PDF/);
  await assert.rejects(saveEntry(master, co.id, 'payable', null, entry(tauqeer), pdf()), /Pick the account/, 'a receivable account is not a payable one');
  await assert.rejects(saveEntry(master, other.id, R, null, entry(tauqeer), pdf()), /Pick the account/, 'nor another company\'s');
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer, { amount: '0' }), pdf()), /above 0/);
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer, { method: 'card' }), pdf()), /cash, bank transfer or cheque/);
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer, { due_date: '' }), pdf()), /due date/);
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer, { status: 'late' }), pdf()), /pending or paid/);
  assert.equal(await saveEntry(master, 999, R, null, entry(tauqeer), pdf()), null);
  assert.deepEqual(await filesOf(), [], 'nothing refused was kept');

  const e = await saveEntry(master, co.id, R, null, entry(tauqeer, { note: ' March rent ' }), pdf());
  assert.deepEqual({ ...e, updated_at: 0 }, {
    id: e.id, account_id: tauqeer.id, account_no: '1310', account: 'Cash to Mr Tauqeer', under: 'Cash', amount: 1500.5, method: 'cash', status: 'pending',
    due_date: '2099-01-31', note: 'March rent', file_name: 'receipt.pdf', file_mime: 'application/pdf', updated_at: 0, updated_by: 'Owner',
  });
  const onParent = await saveEntry(master, co.id, R, null, entry(cash), pdf());
  assert.equal(onParent.account, 'Cash', 'an account with others under it still takes entries');
  const [file] = await filesOf();
  assert.ok(existsSync(file));
  assert.deepEqual((await getSide(co.id, 'payable')).entries, []);
  assert.deepEqual((await getSide(other.id, R)).entries, []);
  assert.equal(await getSide(999, R), null);
  assert.equal(await deleteEntry(other.id, R, e.id), null, 'not through another company');
  await clear(co.id);
  assert.ok(!existsSync(file), 'the attachment goes with the entry');
});

test('a pending entry past its due date is overdue, and the totals follow', async () => {
  const { master, co, tauqeer } = await setup();
  const late = await saveEntry(master, co.id, R, null, entry(tauqeer, { amount: 100, due_date: '2020-01-01' }), pdf());
  const soon = await saveEntry(master, co.id, R, null, entry(tauqeer, { amount: 200 }), pdf());
  const done = await saveEntry(master, co.id, R, null, entry(tauqeer, { amount: 50, due_date: '2020-01-01', status: 'paid', method: 'cheque' }), pdf());
  assert.equal(late.status, 'overdue');
  assert.equal(done.status, 'paid', 'paid is never overdue');
  let side = await getSide(co.id, R);
  assert.deepEqual(side.totals, { pending: 200, overdue: 100, paid: 50 });
  assert.deepEqual(side.entries.map((e) => e.id), [late.id, soon.id, done.id], 'soonest due first, paid last');
  assert.deepEqual(await companies(), [{ id: co.id, name: 'Ain Al Reem', receivable: { pending: 200, overdue: 100, paid: 50 }, payable: { pending: 0, overdue: 0, paid: 0 } }]);

  assert.equal((await setStatus(master, co.id, R, late.id, 'paid')).status, 'paid');
  assert.equal(await setStatus(master, co.id, 'payable', soon.id, 'paid'), null, 'not from the other side');
  await assert.rejects(setStatus(master, co.id, R, soon.id, 'overdue'), /pending or paid/);
  side = await getSide(co.id, R);
  assert.deepEqual(side.totals, { pending: 200, overdue: 0, paid: 150 });
  await clear(co.id);
});

test('changing an entry keeps its attachment unless a new one comes', async () => {
  const { master, co, cash, tauqeer } = await setup();
  const bank = await addAccount(master, co.id, R, { name: 'Bank' });
  const e = await saveEntry(master, co.id, R, null, entry(tauqeer), pdf());
  const [first] = await filesOf();

  const moved = await saveEntry(master, co.id, R, e.id, entry(bank, { amount: 99, method: 'bank', status: 'paid' }), null);
  assert.deepEqual([moved.account, moved.under, moved.amount, moved.method, moved.status, moved.file_name], ['Bank', '', 99, 'bank', 'paid', 'receipt.pdf']);
  assert.deepEqual(await filesOf(), [first]);

  const swapped = await saveEntry(master, co.id, R, e.id, entry(cash), pdf('new.pdf'));
  assert.equal(swapped.file_name, 'new.pdf');
  assert.ok(!existsSync(first), 'the old attachment is not left behind');
  assert.equal(await saveEntry(master, co.id, 'payable', e.id, entry(bank), null), null);
  await clear(co.id);
});

test('what has entries is hidden, not removed', async () => {
  const { master, co, cash, tauqeer } = await setup();
  const e = await saveEntry(master, co.id, R, null, entry(tauqeer), pdf());
  await assert.rejects(deleteAccount(co.id, R, tauqeer.id), /Hide it instead/);
  await assert.rejects(deleteAccount(co.id, R, cash.id), /still has accounts/);
  await assert.rejects(deleteCompany(co.id), /has entries/);
  assert.equal(await deleteAccount(co.id, 'payable', tauqeer.id), null);

  assert.equal((await changeAccount(co.id, R, tauqeer.id, { hidden: true })).hidden, true);
  await assert.rejects(saveEntry(master, co.id, R, null, entry(tauqeer), pdf()), /is hidden/);
  assert.equal((await saveEntry(master, co.id, R, e.id, entry(tauqeer, { amount: 5 }), null)).amount, 5, 'an entry already on it can still be changed');
  const renamed = await changeAccount(co.id, R, tauqeer.id, { name: 'Cash to Mr T', account_no: '', hidden: false });
  assert.deepEqual([renamed.name, renamed.account_no], ['Cash to Mr T', null]);
  assert.equal((await getSide(co.id, R)).entries[0].account, 'Cash to Mr T');
  await assert.rejects(changeAccount(co.id, R, tauqeer.id, { name: '' }), /cannot be empty/);

  await clear(co.id);
  assert.deepEqual(await deleteAccount(co.id, R, tauqeer.id), { ok: true });
  await addAccount(master, co.id, R, { name: 'Unused', parent_id: cash.id });
  assert.deepEqual(await deleteCompany(co.id), { ok: true }, 'an empty company goes, with its unused accounts');
  assert.deepEqual(await companies(), []);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM recurring_accounts').get()).n, 0);
});
