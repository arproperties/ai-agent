import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  listCheques, getCheque, saveCheque, setStatus, deleteCheque, customStatuses, parseStatus, statusLabel,
  setAttachment, removeAttachment, attachmentPath,
  listRecipients, addRecipients, setRecipient, removeRecipient, recentAlerts,
  alertTo, alertMail, digestMail, sendAlert, runDueAlerts, alertTick,
  ALERT_DEFAULTS, alertSettings, saveAlertSettings, dueStep, retryBounces,
} from '../server/companyPdc.js';

test.after(() => closeDb());

const TODAY = '2026-12-01';
const A = 2; // two saifsys companies, each with its own list
const B = 3;

async function setup() {
  await reset();
  const rona = { id: await makeUser('Rona'), role: 'user' };
  const tauqeer = { id: await makeUser('Tauqeer'), role: 'user' };
  const emailOf = async (u) => (await db.prepare('SELECT email FROM users WHERE id = ?').get(u.id)).email;
  return { rona, tauqeer, emailOf };
}

const cheque = (over = {}) => ({
  direction: 'issued', party_name: ' Al Noor Trading ', cheque_no: '000123', bank: 'Mashreq', cheque_date: '2026-12-20',
  amount: '12,500.50', purpose: 'Site rent', location: 'Warsan', reference: 'INV-9', approved_by: 'Rona', issued_by: 'Mr. Amran',
  notes: 'second of four', company_name: 'Ain Al Reem Properties', ...over,
});
const add = (user, company, over, today = TODAY) => saveCheque(user, company, null, cheque(over), today);
// What would have been emailed, kept instead of sent.
const outbox = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); } }; };
const alerts = () => db.prepare('SELECT pdc_id, kind, ref_key, sent_to, result, error FROM company_pdc_alerts ORDER BY id').all();

test('a cheque is added once: tidied, pending, with "Added" as the first line of its history', async () => {
  const { rona } = await setup();
  const c = await add(rona, A);
  assert.equal(c.party_name, 'Al Noor Trading');
  assert.equal(c.amount, 12500.5);
  assert.equal(c.status, 'pending');
  assert.equal(c.status_label, 'Pending');
  assert.equal(c.status_date, TODAY);
  assert.equal(c.created_by, 'Rona');
  assert.equal(c.attachment, false);

  const { cheque: got, history } = await getCheque(rona, A, c.id);
  assert.equal(got.cheque_no, '000123');
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].from_status, history[0].to_status, history[0].note, history[0].changed_on, history[0].by], [null, 'pending', 'Added', TODAY, 'Rona']);

  const list = await listCheques(rona, A, {}, TODAY);
  assert.equal(list.cheques.length, 1);
  assert.equal(list.total, 12500.5);
  assert.deepEqual(list.months, ['2026-12']);
  assert.deepEqual([list.summary.out_n, list.summary.out_amt, list.summary.in_n, list.summary.due_n, list.summary.bounced_n], [1, 12500.5, 0, 0, 0]);
});

test('everything wrong with a cheque is said at once', async () => {
  const { rona } = await setup();
  await assert.rejects(saveCheque(rona, A, null, { direction: 'lent', amount: 'ten', cheque_date: '2026-02-30', status: 'other' }, TODAY), (e) => {
    assert.equal(e.status, 400);
    for (const part of ['issued or received', 'who the cheque is to', 'cheque number', 'cheque date', 'the amount', 'name of the status']) assert.match(e.message, new RegExp(part));
    return true;
  });
  await assert.rejects(add(rona, A, { direction: 'received', party_name: '' }), /who the cheque is from/);
  await assert.rejects(add(rona, A, { amount: '0' }), /the amount/);
  await assert.rejects(add(rona, A, { status: 'lost' }), /choose the status/);
  assert.equal((await listCheques(rona, A, {}, TODAY)).cheques.length, 0, 'nothing was saved');
});

test('the status box: a usual status, a name typed before, or a new name', () => {
  assert.deepEqual(parseStatus('cleared', ''), ['cleared', null]);
  assert.deepEqual(parseStatus('custom: With legal ', ''), ['other', 'With legal']);
  assert.deepEqual(parseStatus('other', '  Lost in post '), ['other', 'Lost in post']);
  assert.equal(parseStatus('other', '  '), null);
  assert.equal(parseStatus('custom:', ''), null);
  assert.equal(parseStatus('nonsense', ''), null);
  assert.equal(statusLabel('other', 'With legal'), 'With legal');
  assert.equal(statusLabel('on_hold', null), 'On hold');
});

test('the same cheque typed twice is refused; the other way round, another bank or another company is not', async () => {
  const { rona } = await setup();
  const c = await add(rona, A);
  await assert.rejects(add(rona, A), (e) => e.status === 409 && /Cheque 000123 of Mashreq is already in the list/.test(e.message));
  await add(rona, A, { direction: 'received' });
  await add(rona, A, { bank: 'ENBD' });
  await add(rona, B);
  // changing a cheque is not "the same cheque again"
  assert.equal((await saveCheque(rona, A, c.id, cheque({ notes: 'changed' }), TODAY)).notes, 'changed');
  // but changing it into another one's number is
  const other = await add(rona, A, { cheque_no: '000999' });
  await assert.rejects(saveCheque(rona, A, other.id, cheque(), TODAY), /already in the list/);
});

test('each company has its own list: another company cannot see, change or delete a cheque', async () => {
  const { rona, tauqeer } = await setup();
  const mine = await add(rona, A);
  await add(tauqeer, B, { cheque_no: 'B-1', amount: '900' });

  assert.deepEqual((await listCheques(rona, A, {}, TODAY)).cheques.map((c) => c.cheque_no), ['000123']);
  assert.deepEqual((await listCheques(rona, B, {}, TODAY)).cheques.map((c) => c.cheque_no), ['B-1']);
  assert.equal((await listCheques(rona, B, {}, TODAY)).summary.out_amt, 900);

  assert.equal(await getCheque(tauqeer, B, mine.id), null);
  assert.equal(await saveCheque(tauqeer, B, mine.id, cheque({ party_name: 'Taken' }), TODAY), null);
  assert.equal(await setStatus(tauqeer, B, mine.id, { to: 'cleared' }, { today: TODAY }), null);
  assert.equal(await deleteCheque(tauqeer, B, mine.id), null);
  assert.equal(await setAttachment(tauqeer, B, mine.id, { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }), null);
  assert.equal((await getCheque(rona, A, mine.id)).cheque.party_name, 'Al Noor Trading', 'untouched');
});

test('the list is filtered by type, status, month, the next seven days and a search', async () => {
  const { rona } = await setup();
  await add(rona, A, { cheque_no: 'I-1', cheque_date: '2026-12-05', amount: '100' });                       // issued, pending, due within 7 days
  await add(rona, A, { cheque_no: 'I-2', cheque_date: '2027-01-15', amount: '200', party_name: '100% Cotton LLC' });
  const r1 = await add(rona, A, { cheque_no: 'R-1', direction: 'received', cheque_date: '2026-11-20', amount: '300', issued_by: 'Julie' }); // overdue
  const r2 = await add(rona, A, { cheque_no: 'R-2', direction: 'received', cheque_date: '2026-12-25', amount: '400', location: 'Ayla 219' });
  await setStatus(rona, A, r1.id, { to: 'deposited' }, { today: TODAY });
  await setStatus(rona, A, r2.id, { to: 'other', to_other: 'With legal' }, { today: TODAY });
  const nos = async (q) => (await listCheques(rona, A, q, TODAY)).cheques.map((c) => c.cheque_no);

  assert.deepEqual(await nos({}), ['R-1', 'I-1', 'R-2', 'I-2'], 'by cheque date');
  assert.deepEqual(await nos({ dir: 'received' }), ['R-1', 'R-2']);
  assert.deepEqual(await nos({ status: 'open' }), ['R-1', 'I-1', 'I-2']);
  assert.deepEqual(await nos({ status: 'deposited' }), ['R-1']);
  assert.deepEqual(await nos({ status: 'other' }), ['R-2']);
  assert.deepEqual(await nos({ status: 'custom:With legal' }), ['R-2']);
  assert.deepEqual(await nos({ status: 'custom:Nothing' }), []);
  assert.deepEqual(await nos({ month: '2027-01' }), ['I-2']);
  assert.deepEqual(await nos({ due: '7' }), ['R-1', 'I-1'], 'dated up to seven days from today, overdue among them');
  assert.deepEqual(await nos({ status: 'pending', due: '7' }), ['I-1']);
  assert.deepEqual(await nos({ q: 'julie' }), ['R-1'], 'issued by');
  assert.deepEqual(await nos({ q: 'ayla' }), ['R-2'], 'location');
  assert.deepEqual(await nos({ q: '100%' }), ['I-2'], 'a % typed is a % looked for, not "anything"');
  assert.deepEqual(await nos({ q: 'i-' }), ['I-1', 'I-2']);

  const list = await listCheques(rona, A, { dir: 'received' }, TODAY);
  assert.equal(list.total, 700, 'the total is of what is shown');
  assert.deepEqual(list.months, ['2027-01', '2026-12', '2026-11']);
  assert.deepEqual(list.customs, ['With legal']);
  // the four numbers count every cheque of the company, whatever the filter
  assert.deepEqual([list.summary.out_n, list.summary.out_amt], [2, 300]);
  assert.deepEqual([list.summary.in_n, list.summary.in_amt], [1, 300], 'received and pending or deposited');
  assert.deepEqual([list.summary.due_n, list.summary.due_amt], [1, 100], 'pending and dated within seven days');
});

test('a change of status is kept in the history; the same status, or a date in the future, is refused', async () => {
  const { rona, tauqeer } = await setup();
  const c = await add(rona, A);
  const { cheque: after } = await setStatus(tauqeer, A, c.id, { to: 'deposited', on: '2026-11-30', note: ' Deposited at ENBD ' }, { today: TODAY });
  assert.deepEqual([after.status, after.status_date], ['deposited', '2026-11-30']);
  await assert.rejects(setStatus(rona, A, c.id, { to: 'deposited' }, { today: TODAY }), (e) => e.status === 409 && /already Deposited/.test(e.message));
  await assert.rejects(setStatus(rona, A, c.id, { to: 'cleared', on: '2026-12-02' }, { today: TODAY }), /not in the future/);
  await assert.rejects(setStatus(rona, A, c.id, { to: '' }, { today: TODAY }), /choose the new status/);
  await assert.rejects(setStatus(rona, A, c.id, { to: 'other', to_other: ' ' }, { today: TODAY }), /type the name of the new status/);

  await setStatus(rona, A, c.id, { to: 'other', to_other: 'With legal' }, { today: TODAY });
  await assert.rejects(setStatus(rona, A, c.id, { to: 'custom:with LEGAL' }, { today: TODAY }), /already With legal/);
  await setStatus(rona, A, c.id, { to: 'cleared' }, { today: TODAY });
  assert.deepEqual(await customStatuses(A), ['With legal'], 'a name typed once can be picked again, even after the cheque moved on');
  assert.deepEqual(await customStatuses(B), [], 'and only in its own company');

  // newest change first, by the date the change was made on: the deposit was dated the day before the cheque was added
  const { history } = await getCheque(rona, A, c.id);
  assert.deepEqual(history.map((h) => [h.from_label, h.to_label, h.by, h.changed_on]), [
    ['With legal', 'Cleared', 'Rona', TODAY], ['Deposited', 'With legal', 'Rona', TODAY], [null, 'Pending', 'Rona', TODAY],
    ['Pending', 'Deposited', 'Tauqeer', '2026-11-30'],
  ]);
  assert.equal(history[3].note, 'Deposited at ENBD');
});

test('a deleted cheque leaves the list but stays as a record, and its number can be typed again', async () => {
  const { rona, tauqeer } = await setup();
  const c = await add(rona, A);
  await setAttachment(rona, A, c.id, { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }, 'cheque.pdf');
  const file = await attachmentPath(A, c.id);
  assert.deepEqual(await deleteCheque(tauqeer, A, c.id), { ok: true, cheque_no: '000123', party_name: 'Al Noor Trading' });

  assert.equal(await getCheque(rona, A, c.id), null);
  assert.equal((await listCheques(rona, A, {}, TODAY)).cheques.length, 0);
  assert.equal((await listCheques(rona, A, {}, TODAY)).summary.out_n, 0);
  assert.equal(await deleteCheque(rona, A, c.id), null, 'not twice');
  assert.equal(existsSync(file), false, 'a deleted cheque keeps no file');

  const row = await db.prepare('SELECT deleted_at, deleted_by, attachment FROM company_pdcs WHERE id = ?').get(c.id);
  assert.ok(row.deleted_at > 0);
  assert.equal(row.deleted_by, tauqeer.id);
  assert.equal(row.attachment, null);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM company_pdc_history WHERE pdc_id = ?').get(c.id)).n, 1, 'its history stays with it');

  assert.ok((await add(rona, A)).id > c.id, 'the same number again is a new cheque');
});

test('one copy of the cheque is kept with it; a new one replaces the old', async () => {
  const { rona } = await setup();
  const c = await add(rona, A);
  const pdf = { mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
  const jpg = { mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) };
  await assert.rejects(setAttachment(rona, A, c.id, { mimetype: 'text/html', buffer: Buffer.from('<p>') }), /picture \(JPG, PNG\) or a PDF/);
  assert.equal(await setAttachment(rona, A, 999, pdf), null);

  assert.deepEqual(await setAttachment(rona, A, c.id, pdf, 'front.pdf'), { ok: true });
  const first = await attachmentPath(A, c.id);
  assert.ok(existsSync(first));
  assert.equal(await attachmentPath(B, c.id), null, 'another company cannot open it');
  assert.deepEqual([(await getCheque(rona, A, c.id)).cheque.attachment, (await getCheque(rona, A, c.id)).cheque.original_name], [true, 'front.pdf']);

  await setAttachment(rona, A, c.id, jpg);
  assert.equal(existsSync(first), false, 'the old file is gone');
  const second = await attachmentPath(A, c.id);
  assert.match(second, /\.jpg$/);

  assert.deepEqual(await removeAttachment(rona, A, c.id), { ok: true });
  assert.equal(existsSync(second), false);
  assert.equal((await getCheque(rona, A, c.id)).cheque.attachment, false);
});

test('the alert list: addresses are added once, in small letters, per company, and switched per kind', async () => {
  const { rona } = await setup();
  assert.deepEqual(await addRecipients(rona, A, { emails: 'Accounts@Ainalreem.com, not-an-address; boss@ainalreem.com', on_due: true, on_bounce: false }),
    { added: 2, bad: ['not-an-address'] });
  assert.deepEqual(await addRecipients(rona, A, { emails: 'accounts@ainalreem.com', on_due: true, on_bounce: true }), { added: 0, bad: [] });
  await assert.rejects(addRecipients(rona, A, { emails: ' ,; ' }), /at least one email/);
  await addRecipients(rona, B, { emails: 'other@company.com', on_due: true, on_bounce: true });

  const list = await listRecipients(A);
  assert.deepEqual(list.map((r) => [r.email, r.on_due, r.on_bounce]), [['accounts@ainalreem.com', true, false], ['boss@ainalreem.com', true, false]]);
  assert.equal((await listCheques(rona, A, {}, TODAY)).alert_recipients, 2);

  assert.equal(await setRecipient(rona, B, list[0].id, { what: 'bounce', on: true }), null, 'not from another company');
  assert.deepEqual(await setRecipient(rona, A, list[0].id, { what: 'bounce', on: true }), { ok: true });
  assert.deepEqual(await setRecipient(rona, A, list[1].id, { what: 'due', on: false }), { ok: true });
  assert.deepEqual((await listRecipients(A)).map((r) => [r.on_due, r.on_bounce]), [[true, true], [false, false]]);

  assert.equal(await removeRecipient(rona, B, list[1].id), null);
  assert.deepEqual(await removeRecipient(rona, A, list[1].id), { ok: true });
  assert.deepEqual((await listRecipients(A)).map((r) => r.email), ['accounts@ainalreem.com']);
  assert.deepEqual((await listRecipients(B)).map((r) => r.email), ['other@company.com']);
});

test('a bounced cheque is emailed about at once, to whoever added it and the bounce list, each time it bounces', async () => {
  const { rona, tauqeer, emailOf } = await setup();
  const c = await add(rona, A);
  await addRecipients(rona, A, { emails: 'bounce@ainalreem.com', on_due: false, on_bounce: true });
  await addRecipients(rona, A, { emails: 'due-only@ainalreem.com', on_due: true, on_bounce: false });
  await addRecipients(rona, B, { emails: 'other-company@x.com', on_due: true, on_bounce: true });
  const box = outbox();

  const { cheque: after, alert } = await setStatus(tauqeer, A, c.id, { to: 'bounced', note: 'Insufficient funds' }, { today: TODAY, send: box.send });
  assert.equal(after.status, 'bounced');
  assert.deepEqual(alert, { result: 'sent', to: [await emailOf(rona), 'bounce@ainalreem.com'], got: [await emailOf(rona), 'bounce@ainalreem.com'] });
  assert.deepEqual(box.sent.map((m) => m.to), [await emailOf(rona), 'bounce@ainalreem.com']);
  assert.match(box.sent[0].subject, /^\[Company's PDC\] Cheque 000123 · Al Noor Trading · AED 12,500\.50 has BOUNCED$/);
  assert.match(box.sent[0].html, /Insufficient funds/);
  assert.match(box.sent[0].html, /Ain Al Reem Properties/);
  assert.match(box.sent[0].text, /Status: Bounced/);

  // put right, then it bounces again: told again
  await setStatus(rona, A, c.id, { to: 'deposited' }, { today: TODAY, send: box.send });
  assert.equal(box.sent.length, 2, 'only a bounce is emailed');
  await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: box.send });
  assert.equal(box.sent.length, 4);
  assert.deepEqual((await alerts()).map((a) => [a.kind, a.result]), [['bounced', 'sent'], ['bounced', 'sent']]);
  assert.deepEqual((await recentAlerts(A)).map((a) => [a.kind, a.cheque_no, a.result]), [['bounced', '000123', 'sent'], ['bounced', '000123', 'sent']]);
  assert.deepEqual(await recentAlerts(B), []);
});

test('a bounce whose email fails still saves the status, and says the email failed', async () => {
  const { rona } = await setup();
  const c = await add(rona, A);
  const { cheque: after, alert } = await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: async () => { throw new Error('Outgoing mail is not set up'); } });
  assert.equal(after.status, 'bounced');
  assert.equal(alert.result, 'failed');
  assert.deepEqual((await alerts()).map((a) => [a.result, a.error]), [['failed', 'Outgoing mail is not set up']]);
});

test('a bounce email that failed is sent by the next daily check, while the cheque is still bounced', async () => {
  const { rona, emailOf } = await setup();
  const down = async () => { throw new Error('mail is down'); };
  const still = await add(rona, A, { cheque_no: 'STILL', cheque_date: '2027-03-01' });
  const fixed = await add(rona, A, { cheque_no: 'FIXED', cheque_date: '2027-03-01' });
  const other = await add(rona, B, { cheque_no: 'OTHER', cheque_date: '2027-03-01' });
  await setStatus(rona, A, still.id, { to: 'bounced', note: 'Signature differs' }, { today: TODAY, send: down });
  await setStatus(rona, A, fixed.id, { to: 'bounced' }, { today: TODAY, send: down });
  await setStatus(rona, B, other.id, { to: 'bounced' }, { today: TODAY, send: down });
  await setStatus(rona, A, fixed.id, { to: 'replaced' }, { today: TODAY, send: down }); // put right since: nothing left to say
  const box = outbox();

  // "Check now" on company A's screen: its lost bounce goes out, with the note it was given
  const res = await runDueAlerts({ today: '2026-12-02', send: box.send, companyId: A });
  assert.deepEqual(res.map((r) => [r.cheque_no, r.kind, r.result]), [['STILL', 'bounced', 'sent']]);
  assert.deepEqual(box.sent.map((m) => m.to), [await emailOf(rona)]);
  assert.match(box.sent[0].subject, /Cheque STILL .* has BOUNCED$/);
  assert.match(box.sent[0].html, /Signature differs/);

  // the timer covers every company; what was sent is not sent again
  assert.deepEqual((await runDueAlerts({ today: '2026-12-02', send: box.send })).map((r) => [r.cheque_no, r.result]), [['OTHER', 'sent']]);
  assert.deepEqual(await runDueAlerts({ today: '2026-12-03', send: box.send }), []);
  assert.equal(box.sent.length, 2);
  assert.deepEqual((await alerts()).map((a) => [a.pdc_id, a.result]), [[still.id, 'sent'], [other.id, 'sent']], 'the one put right is no longer owed, and not kept');
});

test('the settings start as the Real Estate reminders, and each company changes its own', async () => {
  const { rona } = await setup();
  const usual = { enabled: true, hour: 8, due_days: [7, 3, 1, 0], overdue_every_days: 7, deposited_days: [3, 7, 14], bounce_now: true };
  assert.deepEqual(await alertSettings(A), usual);
  assert.deepEqual({ ...ALERT_DEFAULTS }, usual);

  // typed the way the form sends them: text, in any order, a number twice
  assert.deepEqual(await saveAlertSettings(rona, A, { enabled: '1', hour: '17', due_days: '1, 10 ,5,5', overdue_every_days: '0', deposited_days: '', bounce_now: '0' }),
    { enabled: true, hour: 17, due_days: [10, 5, 1], overdue_every_days: 0, deposited_days: [], bounce_now: false });
  assert.deepEqual(await alertSettings(B), usual, 'another company keeps its own');

  // what is left out stays as it is
  assert.deepEqual(await saveAlertSettings(rona, A, { hour: 9, enabled: false }),
    { enabled: false, hour: 9, due_days: [10, 5, 1], overdue_every_days: 0, deposited_days: [], bounce_now: false });

  await assert.rejects(saveAlertSettings(rona, A, { hour: '24' }), /hour the daily email is sent: type a whole number from 0 to 23/);
  await assert.rejects(saveAlertSettings(rona, A, { due_days: '7, soon' }), /Days before the cheque date: type whole numbers from 0 to 90/);
  await assert.rejects(saveAlertSettings(rona, A, { deposited_days: '0' }), /Days after a deposit that has not cleared: type whole numbers from 1 to 180/);
  await assert.rejects(saveAlertSettings(rona, A, { overdue_every_days: '-1' }), /How often an overdue cheque is repeated/);
  await assert.rejects(saveAlertSettings(rona, A, { due_days: '1 2 3 4 5 6 7 8 9 10 11 12 13' }), /twelve numbers at most/);
  assert.equal((await alertSettings(A)).hour, 9, 'a refused change changes nothing');

  assert.deepEqual(await saveAlertSettings(rona, A, { reset: true }), usual);
});

test('which reminder a cheque is due: the nearest step before its date, weekly after it, and after a deposit that has not cleared', () => {
  const s = { ...ALERT_DEFAULTS };
  const pending = (date) => ({ status: 'pending', cheque_date: date });
  assert.equal(dueStep(pending('2026-12-09'), TODAY, s), null, 'eight days ahead: not yet');
  assert.deepEqual(dueStep(pending('2026-12-08'), TODAY, s), { kind: 'due_soon', ref: '2026-12-08:d7' });
  assert.deepEqual(dueStep(pending('2026-12-06'), TODAY, s), { kind: 'due_soon', ref: '2026-12-06:d7' }, 'first seen five days ahead: the 7-day one, not the 3 as well');
  assert.deepEqual(dueStep(pending('2026-12-04'), TODAY, s), { kind: 'due_soon', ref: '2026-12-04:d3' });
  assert.deepEqual(dueStep(pending('2026-12-02'), TODAY, s), { kind: 'due_soon', ref: '2026-12-02:d1' });
  assert.deepEqual(dueStep(pending(TODAY), TODAY, s), { kind: 'due_soon', ref: `${TODAY}:d0` });
  assert.deepEqual(dueStep(pending('2026-11-30'), TODAY, s), { kind: 'overdue', ref: '2026-11-30:o0' }, 'the day after');
  assert.deepEqual(dueStep(pending('2026-11-24'), TODAY, s), { kind: 'overdue', ref: '2026-11-24:o0' }, 'seven days overdue: still the first week');
  assert.deepEqual(dueStep(pending('2026-11-23'), TODAY, s), { kind: 'overdue', ref: '2026-11-23:o1' }, 'the eighth day: again');
  assert.deepEqual(dueStep(pending('2026-11-23'), TODAY, { ...s, overdue_every_days: 0 }), { kind: 'overdue', ref: '2026-11-23:o0' }, 'set to once only');
  assert.equal(dueStep(pending('2026-12-04'), TODAY, { ...s, due_days: [] }), null, 'no days before: nothing until it is overdue');

  const deposited = (on) => ({ status: 'deposited', cheque_date: '2026-11-01', status_date: on });
  assert.equal(dueStep(deposited('2026-11-29'), TODAY, s), null, 'two days since the deposit');
  assert.deepEqual(dueStep(deposited('2026-11-28'), TODAY, s), { kind: 'not_cleared', ref: '2026-11-28:c3' });
  assert.deepEqual(dueStep(deposited('2026-11-22'), TODAY, s), { kind: 'not_cleared', ref: '2026-11-22:c7' }, 'nine days: the 7-day one');
  assert.deepEqual(dueStep(deposited('2026-10-01'), TODAY, s), { kind: 'not_cleared', ref: '2026-10-01:c14' }, 'long after: the last one, once');
  assert.equal(dueStep(deposited('2026-11-22'), TODAY, { ...s, deposited_days: [] }), null);
  assert.equal(dueStep({ status: 'cleared', cheque_date: '2026-11-01', status_date: '2026-11-02' }, TODAY, s), null);
  assert.equal(dueStep({ status: 'bounced', cheque_date: '2026-11-01', status_date: '2026-11-02' }, TODAY, s), null, 'a bounce has its own email');
});

test('the daily check with the usual settings: each step once, one email per person with all their cheques', async () => {
  const { rona, tauqeer, emailOf } = await setup();
  await addRecipients(rona, A, { emails: 'accounts@ainalreem.com', on_due: true, on_bounce: false });
  await addRecipients(rona, A, { emails: 'bounce-only@ainalreem.com', on_due: false, on_bounce: true });
  await add(rona, A, { cheque_no: 'SEVEN', cheque_date: '2026-12-08', amount: '1000' });                 // exactly seven days on
  const late = await add(tauqeer, A, { cheque_no: 'LATE', cheque_date: '2026-11-28', amount: '2000' });  // already past
  await add(rona, A, { cheque_no: 'FAR', cheque_date: '2026-12-09', amount: '3000' });                   // eight days on: not yet
  const paid = await add(rona, A, { cheque_no: 'DONE', cheque_date: '2026-12-02', amount: '4000' });
  await setStatus(rona, A, paid.id, { to: 'cleared' }, { today: TODAY });                                // cleared: never
  const gone = await add(rona, A, { cheque_no: 'GONE', cheque_date: '2026-12-02', amount: '5000' });
  await deleteCheque(rona, A, gone.id);                                                                  // deleted: never
  const box = outbox();
  const on = async (today) => (await runDueAlerts({ today, send: box.send })).map((r) => [r.cheque_no, r.kind]);

  // a dry run says who would be told, and neither sends nor writes
  const dry = await runDueAlerts({ today: TODAY, send: box.send, dry: true });
  assert.deepEqual(dry.map((r) => [r.cheque_no, r.kind, r.result]), [['LATE', 'overdue', 'dry'], ['SEVEN', 'due_soon', 'dry']]);
  assert.equal(box.sent.length, 0);
  assert.deepEqual(await alerts(), []);

  const res = await runDueAlerts({ today: TODAY, send: box.send });
  assert.deepEqual(res.map((r) => [r.cheque_no, r.kind, r.result]), [['LATE', 'overdue', 'sent'], ['SEVEN', 'due_soon', 'sent']]);
  // Tauqeer added LATE, Rona added SEVEN, the accounts address is on the list for both
  const byTo = Object.fromEntries(box.sent.map((m) => [m.to, m]));
  assert.deepEqual(Object.keys(byTo).sort(), [await emailOf(rona), await emailOf(tauqeer), 'accounts@ainalreem.com'].sort());
  const digest = byTo['accounts@ainalreem.com'];
  assert.equal(digest.subject, "[Company's PDC] 1 overdue, 1 due soon · AED 3,000.00");
  assert.ok(digest.html.indexOf('LATE') < digest.html.indexOf('SEVEN'), 'overdue first');
  assert.match(digest.html, /Overdue 3 days/);
  assert.match(digest.html, /In 7 days/);
  assert.equal(byTo[await emailOf(rona)].subject, "[Company's PDC] 1 due soon · AED 1,000.00");
  assert.doesNotMatch(byTo[await emailOf(rona)].html, /LATE/, 'each person gets only their own cheques');
  assert.deepEqual((await alerts()).map((a) => [a.kind, a.ref_key, a.result]), [['overdue', '2026-11-28:o0', 'sent'], ['due_soon', '2026-12-08:d7', 'sent']]);

  assert.deepEqual(await on(TODAY), [], 'again the same day: nothing new');
  assert.equal(box.sent.length, 3);
  assert.deepEqual(await on('2026-12-02'), [['FAR', 'due_soon']], 'FAR is seven days away now; SEVEN has had its 7-day one');
  assert.equal(box.sent.length, 5, 'to Rona, who added it, and the accounts address');
  assert.deepEqual(await on('2026-12-05'), [['SEVEN', 'due_soon']], 'three days before');
  assert.deepEqual(await on('2026-12-06'), [['LATE', 'overdue'], ['FAR', 'due_soon']], 'LATE is into its second week; FAR is three days away');
  assert.deepEqual(await on('2026-12-07'), [['SEVEN', 'due_soon']], 'the day before');
  assert.deepEqual(await on('2026-12-08'), [['SEVEN', 'due_soon'], ['FAR', 'due_soon']], 'SEVEN is due today, FAR tomorrow');
  assert.deepEqual(await on('2026-12-09'), [['SEVEN', 'overdue'], ['FAR', 'due_soon']]);
  assert.deepEqual(await on('2026-12-09'), []);

  // a cheque given a new date starts afresh
  await saveCheque(tauqeer, A, late.id, cheque({ cheque_no: 'LATE', cheque_date: '2026-12-12', amount: '2000' }), '2026-12-09');
  assert.deepEqual(await on('2026-12-09'), [['LATE', 'due_soon']]);
});

test('a company\'s own days are the ones kept to', async () => {
  const { rona } = await setup();
  await saveAlertSettings(rona, A, { due_days: '10, 2', overdue_every_days: '0' });
  await add(rona, A, { cheque_no: 'MINE', cheque_date: '2026-12-10' });  // nine days on
  await add(rona, B, { cheque_no: 'THEIRS', cheque_date: '2026-12-10' }); // company B keeps the usual days
  const box = outbox();
  const on = async (today) => (await runDueAlerts({ today, send: box.send })).map((r) => [r.cheque_no, r.kind]);

  assert.deepEqual(await on(TODAY), [['MINE', 'due_soon']], 'within ten days for A; not within seven for B');
  assert.deepEqual(await on('2026-12-03'), [['THEIRS', 'due_soon']], 'seven days before, for B');
  assert.deepEqual(await on('2026-12-07'), [['THEIRS', 'due_soon']], 'three days before, for B only');
  assert.deepEqual(await on('2026-12-08'), [['MINE', 'due_soon']], 'two days before, for A only');
  assert.deepEqual(await on('2026-12-09'), [['THEIRS', 'due_soon']]);
  assert.deepEqual(await on('2026-12-10'), [['THEIRS', 'due_soon']], 'A has no "on the day"');
  assert.deepEqual(await on('2026-12-11'), [['MINE', 'overdue'], ['THEIRS', 'overdue']]);
  assert.deepEqual(await on('2026-12-18'), [['THEIRS', 'overdue']], 'a week on: B repeats, A was told once');
  assert.deepEqual(await on('2027-01-30'), [['THEIRS', 'overdue']]);
});

test('a deposited cheque that has not cleared is followed up, until it clears', async () => {
  const { rona, emailOf } = await setup();
  const c = await add(rona, A, { cheque_no: 'DEP', direction: 'received', cheque_date: '2026-11-20', amount: '1600' });
  await setStatus(rona, A, c.id, { to: 'deposited', on: '2026-11-28' }, { today: TODAY });
  const box = outbox();
  const on = async (today) => (await runDueAlerts({ today, send: box.send })).map((r) => [r.cheque_no, r.kind]);

  assert.deepEqual(await on(TODAY), [['DEP', 'not_cleared']], 'three days after the deposit');
  assert.equal(box.sent[0].to, await emailOf(rona));
  assert.equal(box.sent[0].subject, "[Company's PDC] 1 deposited, not cleared · AED 1,600.00");
  assert.match(box.sent[0].html, /Deposited 3 days ago, not cleared/);
  assert.deepEqual(await on('2026-12-04'), []);
  assert.deepEqual(await on('2026-12-05'), [['DEP', 'not_cleared']], 'seven days');
  assert.deepEqual(await on('2026-12-12'), [['DEP', 'not_cleared']], 'fourteen days');
  assert.deepEqual(await on('2026-12-30'), [], 'and then no more');
  assert.deepEqual((await alerts()).map((a) => a.ref_key), ['2026-11-28:c3', '2026-11-28:c7', '2026-11-28:c14']);

  // cleared: nothing further; with the follow-ups switched off, none at all
  const d = await add(rona, A, { cheque_no: 'DEP2', direction: 'received', cheque_date: '2026-11-20' });
  await setStatus(rona, A, d.id, { to: 'deposited', on: '2026-12-20' }, { today: '2026-12-30' });
  await saveAlertSettings(rona, A, { deposited_days: '' });
  assert.deepEqual(await on('2026-12-30'), []);
  await saveAlertSettings(rona, A, { deposited_days: '5' });
  assert.deepEqual(await on('2026-12-30'), [['DEP', 'not_cleared'], ['DEP2', 'not_cleared']], 'DEP is still not cleared, under the new step');
  await setStatus(rona, A, d.id, { to: 'cleared' }, { today: '2026-12-30' });
  await saveAlertSettings(rona, A, { deposited_days: '5, 40' });
  assert.deepEqual(await on('2027-01-10'), [['DEP', 'not_cleared']], 'DEP2 has cleared');
});

test('the daily check keeps to a company when asked, and writes down a cheque with nobody to tell', async () => {
  const { rona, tauqeer } = await setup();
  await add(rona, A, { cheque_no: 'A-1', cheque_date: '2026-12-03' });
  const orphan = await add(tauqeer, B, { cheque_no: 'B-1', cheque_date: '2026-12-03' });
  await db.prepare('UPDATE company_pdcs SET created_by = NULL WHERE id = ?').run(orphan.id); // whoever added it has left
  const box = outbox();

  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send, companyId: A })).map((r) => r.cheque_no), ['A-1'], '"Check now" is for the company on the screen');
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send })).map((r) => [r.cheque_no, r.result, r.to]), [['B-1', 'no_recipients', []]]);
  assert.equal(box.sent.length, 1);
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), [], 'and it is not looked at again');
});

test('an alert that could not be sent is tried again at the next check; a step overtaken is dropped', async () => {
  const { rona } = await setup();
  await add(rona, A, { cheque_no: 'A-1', cheque_date: '2026-12-03' });
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: down })).map((r) => r.result), ['failed']);
  assert.deepEqual((await alerts()).map((a) => [a.ref_key, a.result, a.error]), [['2026-12-03:d3', 'failed', 'connect ECONNREFUSED']]);

  // the same step, later the same day: sent, and the failed line becomes the sent one
  const box = outbox();
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send })).map((r) => r.result), ['sent']);
  assert.deepEqual((await alerts()).map((a) => [a.ref_key, a.result, a.error]), [['2026-12-03:d3', 'sent', null]]);
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), []);

  // mail down for the one-day step, back for "on the day": the lost step is not sent late, and not kept as owed
  assert.deepEqual((await runDueAlerts({ today: '2026-12-02', send: down })).map((r) => r.result), ['failed']);
  assert.deepEqual((await runDueAlerts({ today: '2026-12-03', send: box.send })).map((r) => r.result), ['sent']);
  assert.deepEqual((await alerts()).map((a) => [a.ref_key, a.result]), [['2026-12-03:d3', 'sent'], ['2026-12-03:d0', 'sent']]);
  assert.equal(box.sent.length, 2);
});

test('a company can have a bounce not emailed at once', async () => {
  const { rona } = await setup();
  const c = await add(rona, A);
  await saveAlertSettings(rona, A, { bounce_now: '0' });
  const box = outbox();
  const { cheque: after, alert } = await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: box.send });
  assert.equal(after.status, 'bounced');
  assert.equal(alert, null);
  assert.equal(box.sent.length, 0);
  assert.deepEqual(await alerts(), []);
});

test('who is told: the one who added the cheque first, then the list, nobody twice', async () => {
  const { rona, emailOf } = await setup();
  const c = await add(rona, A);
  const row = await db.prepare('SELECT * FROM company_pdcs WHERE id = ?').get(c.id);
  await addRecipients(rona, A, { emails: `${(await emailOf(rona)).toUpperCase()} second@x.com`, on_due: true, on_bounce: false });
  assert.deepEqual(await alertTo(row, 'due_soon'), [await emailOf(rona), 'second@x.com']);
  assert.deepEqual(await alertTo(row, 'not_cleared'), [await emailOf(rona), 'second@x.com'], 'the follow-ups go with the due ones');
  assert.deepEqual(await alertTo(row, 'bounced'), [await emailOf(rona)]);
  assert.deepEqual((await sendAlert(row, 'bounced', 'h1', '', { send: async () => {}, today: TODAY })).result, 'sent');
  assert.deepEqual(await sendAlert(row, 'bounced', 'h1', '', { send: async () => {}, today: TODAY }), { result: 'already', to: [] });
});

test('what the emails say', () => {
  const p = { id: 7, direction: 'received', party_name: 'Julie <Ayla>', cheque_no: 'R-9', bank: null, cheque_date: '2026-12-01', amount: 1600, status: 'pending', status_other: null, purpose: null, company_name: null };
  const today = alertMail(p, 'due_soon', '', TODAY);
  assert.equal(today.subject, "[Company's PDC] Cheque R-9 · Julie <Ayla> · AED 1,600.00 is due today");
  assert.match(today.html, /Julie &lt;Ayla&gt;/, 'what was typed cannot become markup');
  assert.match(today.html, /Received from/);
  assert.doesNotMatch(today.html, /Bank/);
  assert.match(today.html, /pdc_form\.php\?id=7/);
  assert.match(alertMail({ ...p, cheque_date: '2026-12-02' }, 'due_soon', '', TODAY).subject, /is due in 1 day \(02 Dec 2026\)$/);
  assert.match(alertMail({ ...p, cheque_date: '2026-11-29' }, 'overdue', '', TODAY).subject, /is overdue \(dated 29 Nov 2026, 2 days ago\)$/);
  const d = digestMail([{ p, kind: 'due_soon' }], TODAY);
  assert.equal(d.subject, "[Company's PDC] 1 due soon · AED 1,600.00");
  assert.match(d.html, /Today/);
  assert.match(d.text, /Total: AED 1,600\.00/);
  const all = digestMail([
    { p: { ...p, cheque_no: 'W', status: 'deposited', status_date: '2026-11-24' }, kind: 'not_cleared' },
    { p: { ...p, cheque_no: 'S' }, kind: 'due_soon' },
    { p: { ...p, cheque_no: 'O', cheque_date: '2026-11-30' }, kind: 'overdue' },
  ], TODAY);
  assert.equal(all.subject, "[Company's PDC] 1 overdue, 1 due soon, 1 deposited, not cleared · AED 4,800.00");
  assert.ok(all.text.indexOf(' O ') < all.text.indexOf(' S ') && all.text.indexOf(' S ') < all.text.indexOf(' W '), 'overdue, then due, then not cleared');
  assert.match(all.text, /Deposited 7 days ago, not cleared/);
});

test('the timer gives each company its daily check once, at its own hour, and leaves out a company that switched it off', async () => {
  const { rona } = await setup();
  const C = 5;
  await add(rona, A, { cheque_no: 'A-1' });
  await add(rona, B, { cheque_no: 'B-1' });
  await add(rona, C, { cheque_no: 'C-1' });
  await saveAlertSettings(rona, A, { hour: '17' });      // A wants it in the afternoon; B keeps eight
  await saveAlertSettings(rona, C, { enabled: '0' });    // C wants no daily email
  const state = { days: new Map() };
  const ran = [];
  const run = async ({ today, companyId }) => { ran.push(`${today} company ${companyId}`); return [{ id: companyId }]; };
  const tick = (today, hour) => alertTick(state, { today, hour, run });

  assert.deepEqual(await tick(TODAY, 7), [], 'before anyone\'s hour');
  assert.deepEqual(await tick(TODAY, 8), [{ id: B }]);
  assert.deepEqual(await tick(TODAY, 9), [], 'B is done for the day; A is not due yet');
  assert.deepEqual(await tick(TODAY, 17), [{ id: A }]);
  assert.deepEqual(await tick(TODAY, 23), []);
  assert.deepEqual(await tick('2026-12-02', 20), [{ id: A }, { id: B }], 'a late first look still does that day, for both');
  assert.deepEqual(ran, [`${TODAY} company ${B}`, `${TODAY} company ${A}`, `2026-12-02 company ${A}`, `2026-12-02 company ${B}`]);

  // switched back on, C joins in; "Check now" (runDueAlerts asked for by hand) never needed the switch
  await saveAlertSettings(rona, C, { enabled: '1' });
  assert.deepEqual(await tick('2026-12-02', 21), [{ id: C }]);
});

test('an email that reached one address and not another is tried again, for the one it missed only', async () => {
  const { rona, emailOf } = await setup();
  await addRecipients(rona, A, { emails: 'accounts@ainalreem.com', on_due: true, on_bounce: true });
  await add(rona, A, { cheque_no: 'HALF', cheque_date: '2026-12-03' });
  const reached = [];
  const flaky = async (m) => { if (m.to === 'accounts@ainalreem.com') throw new Error('mailbox full'); reached.push(m.to); };

  assert.deepEqual((await runDueAlerts({ today: TODAY, send: flaky })).map((r) => r.result), ['failed'], 'not sent until everybody has it');
  assert.deepEqual(reached, [await emailOf(rona)]);
  assert.deepEqual((await alerts()).map((a) => [a.result, a.sent_to, a.error]), [['failed', await emailOf(rona), 'mailbox full']]);
  const box = outbox();
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send })).map((r) => [r.result, r.to]), [['sent', [await emailOf(rona), 'accounts@ainalreem.com']]]);
  assert.deepEqual(box.sent.map((m) => m.to), ['accounts@ainalreem.com'], 'Rona is not sent it a second time');
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), []);

  // a bounce is the same
  const b = await add(rona, A, { cheque_no: 'BNC' });
  assert.equal((await setStatus(rona, A, b.id, { to: 'bounced' }, { today: TODAY, send: flaky })).alert.result, 'failed');
  const later = outbox();
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: later.send })).map((r) => [r.cheque_no, r.kind, r.result]), [['BNC', 'bounced', 'sent']]);
  assert.deepEqual(later.sent.map((m) => m.to), ['accounts@ainalreem.com']);
});

test('two checks at the same moment send each email once; one cut off in the middle is taken up again later', async () => {
  const { rona } = await setup();
  await add(rona, A, { cheque_no: 'ONCE', cheque_date: '2026-12-03' });
  const box = outbox();
  const [one, two] = await Promise.all([runDueAlerts({ today: TODAY, send: box.send }), runDueAlerts({ today: TODAY, send: box.send })]);
  assert.equal(box.sent.length, 1, '"Check now" pressed twice, or the timer at the same moment');
  assert.deepEqual([...one, ...two].map((r) => r.result), ['sent']);

  // the server went down while an email was on its way: the alert was left as "sending"
  const c = await add(rona, A, { cheque_no: 'CUT', cheque_date: '2026-12-03' });
  await db.prepare("INSERT INTO company_pdc_alerts (pdc_id, kind, ref_key, result) VALUES (?, 'due_soon', '2026-12-03:d3', 'sending')").run(c.id);
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), [], 'for all anyone knows it is still on its way');
  await db.prepare("UPDATE company_pdc_alerts SET created_at = created_at - 1000 WHERE result = 'sending'").run();
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send })).map((r) => [r.cheque_no, r.result]), [['CUT', 'sent']], 'a quarter of an hour on, it is taken up again');
  assert.equal(box.sent.length, 2);
});

test('an old bounce that was never emailed is not sent after a newer one; a date that does not exist is refused', async () => {
  const { rona } = await setup();
  const down = async () => { throw new Error('mail is down'); };
  const c = await add(rona, A);
  await setStatus(rona, A, c.id, { to: 'bounced', note: 'the first time' }, { today: TODAY, send: down });
  await setStatus(rona, A, c.id, { to: 'deposited' }, { today: TODAY });
  const box = outbox();
  await setStatus(rona, A, c.id, { to: 'bounced', note: 'the second time' }, { today: TODAY, send: box.send });
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), []);
  assert.equal(box.sent.length, 1);
  assert.match(box.sent[0].html, /the second time/);
  assert.deepEqual((await alerts()).map((a) => a.result), ['sent']);

  const refused = (e) => e.status === 400;
  await assert.rejects(setStatus(rona, A, c.id, { to: 'cleared', on: '2026-13-01' }, { today: TODAY }), refused);
  await assert.rejects(add(rona, A, { cheque_no: 'NO-DAY', cheque_date: '2026-01-32' }), refused);
  await assert.rejects(add(rona, A, { cheque_no: 'NO-DAY', cheque_date: '2026-02-30' }), refused);
});

test('the timer tries again at its next look what broke or could not be sent, and one company never holds up another', async () => {
  const { rona } = await setup();
  await add(rona, A, { cheque_no: 'A-1' });
  await add(rona, B, { cheque_no: 'B-1' });
  const state = { days: new Map() };
  let mood = 'broken';
  const run = async ({ companyId }) => {
    if (companyId === A && mood === 'broken') throw new Error('the database hiccuped');
    return [{ id: companyId, result: companyId === A && mood === 'mail down' ? 'failed' : 'sent' }];
  };
  const tick = (hour) => alertTick(state, { today: TODAY, hour, run });
  assert.deepEqual(await tick(8), [{ id: B, result: 'sent' }], 'A broke; B had its check all the same');
  mood = 'mail down';
  assert.deepEqual(await tick(9), [{ id: A, result: 'failed' }], 'A again, an hour on');
  mood = 'fine';
  assert.deepEqual(await tick(10), [{ id: A, result: 'sent' }], 'and again, until nothing is owed');
  assert.deepEqual(await tick(11), []);

  // A switches its daily email off. A bounce email it is still owed is tried all the same, whatever the hour.
  await saveAlertSettings(rona, A, { enabled: '0' });
  const c = await add(rona, A, { cheque_no: 'A-2' });
  await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: async () => { throw new Error('mail is down'); } });
  const box = outbox();
  const res = await alertTick({ days: new Map() }, { today: TODAY, hour: 3, run, retry: (o) => retryBounces({ ...o, send: box.send }) });
  assert.deepEqual(res.map((r) => [r.cheque_no, r.kind, r.result]), [['A-2', 'bounced', 'sent']]);
  assert.equal(box.sent.length, 1);
});

test('an email that keeps failing is tried five times, then given up; the cheque\'s next step starts afresh', async () => {
  const { rona } = await setup();
  await add(rona, A, { cheque_no: 'STUCK', cheque_date: '2026-12-03' });
  const down = async () => { throw new Error('no such mailbox'); };
  const anHourOn = () => db.prepare('UPDATE company_pdc_alerts SET tried_at = tried_at - 3600').run();
  const results = [];
  for (let n = 1; n <= 5; n += 1) {
    results.push((await runDueAlerts({ today: TODAY, send: down }))[0].result);
    // "Check now" pressed again and again in the same hour is the same try: it uses none up
    if (n === 1) for (let press = 0; press < 8; press += 1) results.push((await runDueAlerts({ today: TODAY, send: down }))[0].result);
    await anHourOn();
  }
  assert.deepEqual(results, [...Array(12).fill('failed'), 'gave_up'], 'five different hours, however often it is pressed in between');
  assert.equal((await db.prepare('SELECT tries FROM company_pdc_alerts').get()).tries, 5);
  const box = outbox();
  assert.deepEqual(await runDueAlerts({ today: TODAY, send: box.send }), [], 'given up is an end: it is not tried every hour for ever');
  assert.deepEqual((await alerts()).map((a) => [a.ref_key, a.result, a.error]), [['2026-12-03:d3', 'gave_up', 'no such mailbox']]);
  assert.deepEqual((await runDueAlerts({ today: '2026-12-02', send: box.send })).map((r) => r.result), ['sent'], 'the day before the cheque is a new reminder');

  // the timer stops going back to the company once nothing is left that can still be sent
  const state = { days: new Map() };
  const run = async () => [{ id: 1, result: 'gave_up' }];
  assert.equal((await alertTick(state, { today: TODAY, hour: 9, run })).length, 1);
  assert.deepEqual(await alertTick(state, { today: TODAY, hour: 10, run }), []);
});

test('who already has an email is remembered through a restart, and a bounce owed is tried at the next hourly look', async () => {
  const { rona, emailOf } = await setup();
  await addRecipients(rona, A, { emails: 'accounts@ainalreem.com', on_due: true, on_bounce: true });
  await add(rona, A, { cheque_no: 'HALF', cheque_date: '2026-12-03' });
  const flaky = async (m) => { if (m.to === 'accounts@ainalreem.com') throw new Error('mailbox full'); };
  await runDueAlerts({ today: TODAY, send: flaky });                  // Rona has it, the accounts address has not
  // the next try was cut off by a restart: left as "sending", long ago
  await db.prepare("UPDATE company_pdc_alerts SET result = 'sending', created_at = created_at - 1000").run();
  const box = outbox();
  assert.deepEqual((await runDueAlerts({ today: TODAY, send: box.send })).map((r) => r.result), ['sent']);
  assert.deepEqual(box.sent.map((m) => m.to), ['accounts@ainalreem.com'], 'Rona is not sent it again');
  assert.deepEqual((await alerts()).map((a) => a.sent_to), [`${await emailOf(rona)}, accounts@ainalreem.com`]);

  // The company has had its daily check. A cheque bounces later that day with the mail down: not left till tomorrow.
  const state = { days: new Map([[A, TODAY]]) };
  const c = await add(rona, A, { cheque_no: 'LATER' });
  await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: async () => { throw new Error('mail is down'); } });
  const never = async () => { throw new Error('the daily check must not run twice'); };
  const hour = outbox();
  const res = await alertTick(state, { today: TODAY, hour: 15, run: never, retry: (o) => retryBounces({ ...o, send: hour.send }) });
  assert.deepEqual(res.map((r) => [r.cheque_no, r.kind, r.result]), [['LATER', 'bounced', 'sent']]);
  assert.equal(hour.sent.length, 2, 'to Rona and the accounts address');

  // A bounce email a restart left half sent is overtaken when the cheque is put right, and never sent with its old note.
  const d = await add(rona, A, { cheque_no: 'OLD' });
  await setStatus(rona, A, d.id, { to: 'bounced', note: 'the first time' }, { today: TODAY, send: async () => { throw new Error('mail is down'); } });
  await db.prepare("UPDATE company_pdc_alerts SET result = 'sending', created_at = created_at - 1000 WHERE pdc_id = ?").run(d.id);
  await setStatus(rona, A, d.id, { to: 'deposited' }, { today: TODAY });
  const last = outbox();
  await setStatus(rona, A, d.id, { to: 'bounced', note: 'the second time' }, { today: TODAY, send: last.send });
  assert.deepEqual(await retryBounces({ today: TODAY, send: last.send, companyId: A }), []);
  assert.equal(last.sent.length, 2);
  assert.ok(last.sent.every((m) => /the second time/.test(m.html)));
});

test('a bounce email is tried for two days before it is given up, and says who it has reached so far', async () => {
  const { rona, emailOf } = await setup();
  await addRecipients(rona, A, { emails: 'accounts@ainalreem.com', on_due: false, on_bounce: true });
  const c = await add(rona, A, { cheque_no: 'BNC' });
  const flaky = async (m) => { if (m.to === 'accounts@ainalreem.com') throw new Error('mailbox full'); };
  const { alert } = await setStatus(rona, A, c.id, { to: 'bounced' }, { today: TODAY, send: flaky });
  assert.deepEqual(alert, { result: 'failed', to: [await emailOf(rona), 'accounts@ainalreem.com'], got: [await emailOf(rona)] });

  const tryAt = async (tries) => {
    await db.prepare('UPDATE company_pdc_alerts SET tries = ?, tried_at = tried_at - 3600').run(tries - 1);
    return (await retryBounces({ today: TODAY, send: flaky, companyId: A }))[0]?.result;
  };
  assert.equal(await tryAt(6), 'failed', 'well past what a reminder gets');
  assert.equal(await tryAt(47), 'failed');
  assert.equal(await tryAt(48), 'gave_up');
  assert.deepEqual(await retryBounces({ today: TODAY, send: flaky, companyId: A }), []);
});
