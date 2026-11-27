import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  createDuePayments, saveEntry, setActive, deleteEntry, createNow, setPaid, addReceipt, deleteReceipt, updateDue, deleteDue,
  saveBuilding, saveAccount, addTransfer, deleteTransfer, setAttachment, removeAttachment, addReceiptFile, deleteReceiptFile,
  listActivity, ACTIVITY, attachmentPath,
} from '../server/recurringPayments.js';

test.after(() => closeDb());

// Ayla Residence is building 1; Cash to Mr Amran is account 1, Cash to Mr Tauqeer 2.
async function setup() {
  await reset();
  const jessa = { id: await makeUser('Jessa'), role: 'user' };
  const sabha = { id: await makeUser('Sabha'), role: 'user' };
  await saveBuilding(jessa, null, { name: 'Ayla Residence' });
  for (const name of ['Cash to Mr Amran', 'Cash to Mr Tauqeer']) await saveAccount(jessa, null, { name });
  return { jessa, sabha };
}
const washer = { title: 'Washing machine rent', building_id: 1, unit: 'Laundry room', amount: '150', day: 5, first_month: '2026-10' };
const pdf = { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a slip') };
const dueId = async (entryId, month) => (await db.prepare('SELECT id FROM recurring_payment_dues WHERE payment_id = ? AND month = ?').get(entryId, month)).id;
// The list as it happened, oldest first: [who, what, month, amount, detail].
const story = async (query = {}) => (await listActivity(null, query)).activity.reverse().map((a) => [a.by, a.action, a.month, a.amount, a.detail]);

test('every kind of line counts under one of the four numbers', () => {
  assert.deepEqual([...new Set(Object.values(ACTIVITY))].sort(), ['added', 'changed', 'deleted', 'received']);
});

test('an entry, its payments and the money on them: each step is written down, with who did it', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');   // October's line is made with it
  await createDuePayments('2026-11-06');                          // November's, by Reem on the day
  const oct = await dueId(e.id, '2026-10');
  const nov = await dueId(e.id, '2026-11');
  const part = await addReceipt(sabha, oct, { amount: '50', account_id: 2, paid_on: '2026-10-07' }, '2026-10-07');
  await addReceipt(sabha, oct, { account_id: 2, paid_on: '2026-10-09' }, '2026-10-09');     // the rest
  await deleteReceipt(jessa, part.receipt_id);
  await setPaid(jessa, nov, true, { account_id: 1, paid_on: '2026-11-06' }, '2026-11-06');
  await setPaid(jessa, nov, false);
  await setPaid(jessa, nov, false);                                                         // nothing to remove: no line
  await updateDue(jessa, nov, { due_date: '2026-11-10', amount: '175' });
  await updateDue(jessa, nov, { due_date: '2026-11-10', amount: '175' });                   // nothing changed: no line
  await deleteDue(jessa, nov);
  await createNow(sabha, e.id, '2026-11-12');                                               // brought back by hand

  assert.deepEqual(await story(), [
    ['Jessa', 'entry_added', null, 150, 'Day 5 of the month, from 2026-10'],
    ['Jessa', 'payment_created', '2026-10', 150, 'Due 2026-10-05'],
    ['Reem (automatic)', 'payment_created', '2026-11', 150, 'Due 2026-11-05'],
    ['Sabha', 'money_received', '2026-10', 50, 'Into Cash to Mr Tauqeer on 2026-10-07; part of 150.00'],
    ['Sabha', 'money_received', '2026-10', 100, 'Into Cash to Mr Tauqeer on 2026-10-09; part of 150.00'],
    ['Jessa', 'receipt_deleted', '2026-10', 50, 'It was in Cash to Mr Tauqeer, received on 2026-10-07'],
    ['Jessa', 'money_received', '2026-11', 150, 'Paid in full into Cash to Mr Amran on 2026-11-06'],
    ['Jessa', 'marked_pending', '2026-11', 150, 'Set back to pending: 1 receipt removed, and the money is out of the accounts'],
    ['Jessa', 'payment_changed', '2026-11', 175, 'Due date: 2026-11-05 → 2026-11-10; Amount: 150.00 → 175.00'],
    ['Jessa', 'payment_deleted', '2026-11', 175, 'It was due 2026-11-10'],
    ['Sabha', 'payment_created', '2026-11', 150, 'Created by hand, due 2026-11-05'],
  ]);
  const first = (await listActivity(null, {})).activity.at(-1);
  assert.deepEqual([first.title, first.building, first.unit, first.type, first.ref_kind, first.ref_id, first.old], ['Washing machine rent', 'Ayla Residence', 'Laundry room', 'added', 'entry', e.id, false]);
});

test('a changed entry says what changed; a deleted one is still in the list, with what went with it', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  await saveEntry(jessa, e.id, washer, '2026-10-06');                                          // saved with nothing changed: no line
  await saveEntry(sabha, e.id, { ...washer, title: 'Washer rent', amount: '200', unit: '', new_head: 'Laundry', notes: 'new price' }, '2026-10-06');
  await setActive(sabha, e.id, false, '2026-10-06');
  await setActive(sabha, e.id, false, '2026-10-06');                                           // already paused: no line
  await setActive(sabha, e.id, true, '2026-10-06');
  await addReceipt(sabha, await dueId(e.id, '2026-10'), { amount: '80', account_id: 1 }, '2026-10-08');
  await assert.rejects(deleteEntry(jessa, e.id), /already has payments/);
  await deleteEntry(jessa, e.id, true);

  assert.deepEqual((await story()).filter((a) => a[1].startsWith('entry_')), [
    ['Jessa', 'entry_added', null, 150, 'Day 5 of the month, from 2026-10'],
    ['Sabha', 'entry_changed', null, 200, 'Title: Washing machine rent → Washer rent; Unit: Laundry room → none; Income head: none → Laundry; Amount: 150.00 → 200.00; Notes changed'],
    ['Sabha', 'entry_paused', null, 200, null],
    ['Sabha', 'entry_resumed', null, 200, null],
    ['Jessa', 'entry_deleted', null, 200, 'With its 1 payment; 80.00 received on them is out of the accounts'],
  ]);
  const gone = (await listActivity(null, { type: 'deleted' })).activity;
  assert.deepEqual(gone.map((a) => [a.action, a.title, a.building]), [['entry_deleted', 'Washer rent', 'Ayla Residence']], 'its name is kept though the entry is gone');

  const empty = await saveEntry(jessa, null, { ...washer, title: 'Parking', auto_create: false }, '2026-10-06');
  await deleteEntry(jessa, empty.id);
  assert.equal((await story()).at(-1)[4], 'It had no payments');
});

test('transfers and attachments are in the list too', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  const oct = await dueId(e.id, '2026-10');
  const r = await addReceipt(jessa, oct, { account_id: 2 }, '2026-10-07');
  await setAttachment(jessa, 'receipt', r.receipt_id, pdf);
  await setAttachment(jessa, 'receipt', r.receipt_id, pdf);
  const more = await addReceiptFile(sabha, r.receipt_id, pdf);
  await deleteReceiptFile(sabha, more.id);
  await removeAttachment(jessa, 'receipt', r.receipt_id);
  await removeAttachment(jessa, 'receipt', r.receipt_id);                                     // none there: no line
  const t = await addTransfer(sabha, { from_id: 2, to_id: 1, amount: '120.5', date: '2026-10-08', notes: 'handover' }, '2026-10-08');
  await setAttachment(sabha, 'transfer', t.id, pdf);
  await deleteTransfer(jessa, t.id);

  assert.deepEqual((await story()).slice(3).map((a) => [a[0], a[1], a[3], a[4]]), [
    ['Jessa', 'file_added', null, 'An attachment of a payment'],
    ['Jessa', 'file_added', null, 'An attachment of a payment, in place of the one before'],
    ['Sabha', 'file_added', null, 'An attachment of a payment'],
    ['Sabha', 'file_removed', null, 'An attachment of a payment'],
    ['Jessa', 'file_removed', null, 'An attachment of a payment'],
    ['Sabha', 'transfer_added', 120.5, 'Dated 2026-10-08 · handover'],
    ['Sabha', 'file_added', 120.5, 'The attachment of a transfer'],
    ['Jessa', 'transfer_deleted', 120.5, 'Dated 2026-10-08 · handover'],
  ]);
  const files = (await listActivity(null, {})).activity.filter((a) => a.action === 'file_added');
  assert.deepEqual([files.at(-1).title, files.at(-1).month], ['Washing machine rent', '2026-10'], 'a file says which payment it is on');
  const moved = (await listActivity(null, {})).activity.find((a) => a.action === 'transfer_deleted');
  assert.equal(moved.title, 'Cash to Mr Tauqeer → Cash to Mr Amran');
  await removeAttachment(jessa, 'receipt', r.receipt_id);
});

test('the list is read by days, by person and by type, with the four numbers for those days', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  const oct = await dueId(e.id, '2026-10');
  await addReceipt(sabha, oct, { amount: '50', account_id: 2 }, '2026-10-07');
  await addReceipt(sabha, oct, { amount: '30', account_id: 2 }, '2026-10-07');
  await updateDue(jessa, oct, { due_date: '2026-10-05', amount: '160' });
  // The entry was added long ago: on 1 Sep 2026, at 23:30 Dubai time (19:30 UTC).
  await db.prepare("UPDATE recurring_activity SET at = ? WHERE action = 'entry_added'").run(Date.UTC(2026, 8, 1, 19, 30) / 1000);

  const now = await listActivity(null, {});
  assert.deepEqual(now.counts, { added: { n: 1, amount: 150 }, received: { n: 2, amount: 80 }, changed: { n: 1, amount: 160 }, deleted: { n: 0, amount: 0 } });
  assert.equal(now.activity.length, 4, 'the last thirty days: not the old one');
  assert.deepEqual(now.people, [{ id: jessa.id, name: 'Jessa' }, { id: sabha.id, name: 'Sabha' }]);
  assert.deepEqual([now.more, now.automatic, now.page, now.sort], [false, false, 1, 'new']);

  const mine = await listActivity(null, { by: String(sabha.id), type: 'received' });
  assert.deepEqual(mine.activity.map((a) => a.amount), [30, 50], 'newest first');
  assert.deepEqual((await listActivity(null, { by: sabha.id, type: 'received', sort: 'old' })).activity.map((a) => a.amount), [50, 30], 'or oldest first');
  assert.deepEqual([mine.counts.added.n, mine.counts.received.n, mine.by], [0, 2, sabha.id], 'the numbers are that person\'s');

  // A person is their account, not their name: another Sabha is not mixed in with the first.
  const other = { id: await makeUser('Sabha'), role: 'user' };
  await addReceipt(other, oct, { amount: '10', account_id: 1 }, '2026-10-08');
  assert.deepEqual((await listActivity(null, { by: sabha.id, type: 'received' })).activity.map((a) => a.amount), [30, 50]);
  assert.deepEqual((await listActivity(null, { by: other.id })).activity.map((a) => a.amount), [10]);
  assert.equal((await listActivity(null, {})).people.filter((p) => p.name === 'Sabha').length, 2);
  assert.equal((await listActivity(null, { by: 'Sabha' })).activity.length, 5, 'a name is not a person: everybody is shown');
  await db.prepare('DELETE FROM recurring_activity WHERE user_id = ?').run(other.id);

  // What Reem made itself on the day can be picked on its own.
  await createDuePayments('2026-11-06');
  const auto = await listActivity(null, { by: 'auto' });
  assert.deepEqual([auto.automatic, auto.by, auto.activity.map((a) => [a.by, a.action, a.month])], [true, 'auto', [['Reem (automatic)', 'payment_created', '2026-11']]]);
  await db.prepare("DELETE FROM recurring_activity WHERE user_id IS NULL").run();
  assert.deepEqual((await listActivity(null, { type: 'changed' })).activity.map((a) => a.action), ['payment_changed']);
  assert.equal((await listActivity(null, { type: 'nonsense' })).activity.length, 4);

  // A day is Dubai's: 23:30 on 1 Sep is 1 Sep, though it is still 1 Sep 19:30 in UTC - and 2 Sep 00:30 would not be.
  assert.deepEqual((await listActivity(null, { from: '2026-09-01', to: '2026-09-01' })).activity.map((a) => a.action), ['entry_added']);
  assert.deepEqual((await listActivity(null, { from: '2026-09-02', to: '2026-09-02' })).activity, []);
  await db.prepare("UPDATE recurring_activity SET at = ? WHERE action = 'entry_added'").run(Date.UTC(2026, 8, 1, 20, 30) / 1000);
  assert.deepEqual((await listActivity(null, { from: '2026-09-02', to: '2026-09-02' })).activity.map((a) => a.action), ['entry_added']);
  const swapped = await listActivity(null, { from: '2026-09-30', to: '2026-09-01' });
  assert.deepEqual([swapped.from, swapped.to], ['2026-09-01', '2026-09-30'], 'the two days the wrong way round are put right');
});

test('a long list comes a hundred lines to a page, counted in full', async () => {
  const { jessa } = await setup();
  await saveEntry(jessa, null, { ...washer, auto_create: false }, '2026-10-06');
  // 250 more lines, a second apart, the newest numbered 250.
  await db.prepare(`INSERT INTO recurring_activity (at, user_id, user_name, action, title, amount)
    SELECT extract(epoch from now())::bigint - 1000 + n, ?, 'Jessa', 'money_received', 'Line ' || n, 1 FROM generate_series(1, 250) n`).run(jessa.id);

  const first = await listActivity(null, { type: 'received' });
  assert.deepEqual([first.activity.length, first.more, first.per_page], [100, true, 100]);
  assert.deepEqual([first.activity[0].title, first.activity.at(-1).title], ['Line 250', 'Line 151']);
  assert.deepEqual(first.counts.received, { n: 250, amount: 250 }, 'the numbers are of every page');
  const last = await listActivity(null, { type: 'received', page: '3' });
  assert.deepEqual([last.activity.length, last.more, last.activity.at(-1).title], [50, false, 'Line 1']);
  assert.deepEqual((await listActivity(null, { type: 'received', page: 4 })).activity, []);
  const oldest = await listActivity(null, { type: 'received', sort: 'old', page: 2 });
  assert.deepEqual([oldest.activity[0].title, oldest.sort, oldest.page], ['Line 101', 'old', 2]);
  assert.equal((await listActivity(null, { page: 'x' })).page, 1);
});

test('money is counted once: a part, then "paid in full", is the part and the rest', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  const oct = await dueId(e.id, '2026-10');
  await addReceipt(sabha, oct, { amount: '50', account_id: 2, paid_on: '2026-10-07' }, '2026-10-07');
  await setPaid(jessa, oct, true, { account_id: 2, paid_on: '2026-10-09' }, '2026-10-09');
  await setPaid(jessa, oct, true, { account_id: 2, paid_on: '2026-10-09' }, '2026-10-09');   // pressed again: nothing new
  await setPaid(jessa, oct, true, { account_id: 1, paid_on: '2026-10-10' }, '2026-10-10');   // only where and when put right

  assert.deepEqual((await story()).slice(2), [
    ['Sabha', 'money_received', '2026-10', 50, 'Into Cash to Mr Tauqeer on 2026-10-07; part of 150.00'],
    ['Jessa', 'money_received', '2026-10', 100, 'Paid in full into Cash to Mr Tauqeer on 2026-10-09; 50.00 of the 150.00 came in before'],
    ['Jessa', 'payment_changed', '2026-10', 150, 'Account: Cash to Mr Tauqeer → Cash to Mr Amran; Received on: 2026-10-09 → 2026-10-10'],
  ]);
  assert.deepEqual((await listActivity(null, {})).counts.received, { n: 2, amount: 150 }, 'what came in, not more');
});

test('a change that cannot be written in the list does not happen', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  const oct = await dueId(e.id, '2026-10');
  const t = await addTransfer(sabha, { from_id: 2, to_id: 1, amount: '120', date: '2026-10-08' }, '2026-10-08');
  await setAttachment(sabha, 'transfer', t.id, pdf);
  const file = await attachmentPath('transfer', t.id);
  const count = async (table) => (await db.prepare(`SELECT count(*)::int AS n FROM ${table}`).get()).n;

  await db.exec('ALTER TABLE recurring_activity RENAME TO recurring_activity_away'); // the list cannot be written
  try {
    await assert.rejects(deleteTransfer(jessa, t.id));
    await assert.rejects(addReceipt(sabha, oct, { account_id: 2 }, '2026-10-07'));
    await assert.rejects(deleteEntry(jessa, e.id, true));
    await assert.rejects(saveEntry(jessa, null, { ...washer, title: 'Another' }, '2026-10-06'));
    await assert.rejects(updateDue(jessa, oct, { due_date: '2026-10-05', amount: '999' }));
  } finally {
    await db.exec('ALTER TABLE recurring_activity_away RENAME TO recurring_activity');
  }
  assert.deepEqual([await count('recurring_transfers'), await count('recurring_payment_receipts'), await count('recurring_payments'), await count('recurring_payment_dues')], [1, 0, 1, 1], 'everything is as it was');
  assert.equal((await db.prepare('SELECT amount::float8 AS amount FROM recurring_payment_dues WHERE id = ?').get(oct)).amount, 150);
  assert.ok(existsSync(file), 'and the transfer still has its file');

  // with the list back, the same thing goes through, and its file goes with it
  await deleteTransfer(jessa, t.id);
  assert.equal(existsSync(file), false);
  assert.deepEqual((await story()).at(-1).slice(0, 2), ['Jessa', 'transfer_deleted']);
});

test('two taps on the same thing at once leave one line, not two', async () => {
  const { jessa, sabha } = await setup();
  const e = await saveEntry(jessa, null, washer, '2026-10-06');
  const oct = await dueId(e.id, '2026-10');
  const r = await addReceipt(jessa, oct, { account_id: 2 }, '2026-10-07');
  const t = await addTransfer(jessa, { from_id: 2, to_id: 1, amount: '20', date: '2026-10-08' }, '2026-10-08');
  const both = async (work) => (await Promise.all([work(jessa), work(sabha)])).filter(Boolean).length;

  assert.equal(await both((who) => setActive(who, e.id, false, '2026-10-08')), 2, 'both are told it is paused');
  assert.equal(await both((who) => deleteReceipt(who, r.receipt_id)), 1, 'the second finds it gone');
  assert.equal(await both((who) => deleteTransfer(who, t.id)), 1);
  assert.equal(await both((who) => deleteDue(who, oct)), 1);
  assert.equal(await both((who) => deleteEntry(who, e.id, true)), 1);

  const lines = (await listActivity(null, {})).activity.map((a) => a.action);
  const times = (action) => lines.filter((a) => a === action).length;
  assert.deepEqual(['entry_paused', 'receipt_deleted', 'transfer_deleted', 'payment_deleted', 'entry_deleted'].map(times), [1, 1, 1, 1, 1]);
  assert.deepEqual((await listActivity(null, {})).counts.deleted, { n: 4, amount: 470 }, 'each thing deleted is counted once: 150 + 20 + 150 + 150');
});
