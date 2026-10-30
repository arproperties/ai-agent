import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking, bookingPayments } from '../server/leasing.js';
import { getPayout, listPayouts, placeTransaction } from '../server/zego.js';
import { useMail, saveMailbox, mailboxState, removeMailbox, syncMail, runIfDue, nextRun } from '../server/zegoMail.js';
import { actionFor } from '../server/actions.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
test.after(() => closeDb());

const TODAY = '2026-11-08';
const NOW = new Date('2026-11-08T09:00:00Z');

const REPORT = `Bank Account,Date,Total,Trans #,Resident,Property,Unit,Init Date,Type,Bill Type,Amount
#1468,11-03-2026,"$1,500.00",,,,,,,,
,,,570000001,Sara Lee,1001 Gates at Sour Lake,,11-01-2026,Visa,Custom,"$1,200.00"
,,,570000002,Annie Pryce,1001 Gates at Sour Lake,,11-01-2026,Visa,Custom,$300.00
`;
const email = (subject, attachments, text = '') => ({ subject, date: '2026-11-03T12:00:00.000Z', text, attachments });
const csvFile = (s = REPORT) => ({ filename: 'zego-week.csv', contentType: 'text/csv', content: Buffer.from(s) });

// A Gmail as the tests want it: what each sign-in and each look finds, and what it was asked.
function fakeGmail({ inbox = [], refuse = null } = {}) {
  const seen = { checks: [], since: [] };
  useMail({
    check: async (acc) => { seen.checks.push(acc); if (refuse) throw new Error(refuse); return true; },
    reports: async (acc, since) => { seen.since.push(since.toISOString()); if (refuse) throw new Error(refuse); return inbox; },
  });
  return seen;
}

async function leases() {
  await reset();
  const master = await makeUser('Master');
  const c = await create('company', { name: 'HCI' });
  const b = await create('building', { name: 'GSL' }, c.id);
  const lease = async (unit_no, full_name) => createBooking({
    unit_id: (await create('unit', { unit_no }, b.id)).id, start_date: '2026-09-01', end_date: '2027-08-31', rent_amount: 1200, security_deposit: 0, status: 'confirmed',
    tenant: { full_name, phone: `409 555 0${unit_no}`, email: `${unit_no}@example.com` },
  }, master);
  return { master, sara: await lease('101', 'Sara Lee'), ann: await lease('104', 'Ann Price') };
}

const paid = async (bk) => (await bookingPayments(bk.id, TODAY)).flatMap((r) => r.payments);

test('connecting the Gmail tries the app password first, keeps it encrypted, and never shows it', async () => {
  const l = await leases();
  let seen = fakeGmail({ refuse: 'Email: Wrong email or password, or IMAP access is turned off in your email settings.' });
  await assert.rejects(saveMailbox({ email: 'rent@gmail.com', app_password: 'abcd efgh ijkl mnop' }, l.master), /Gmail refused the sign-in/);
  assert.equal((await mailboxState()).connected, false, 'a refused password is not kept');

  seen = fakeGmail();
  await assert.rejects(saveMailbox({ email: 'rent@gmail.com' }, l.master), /app password/);
  const s = await saveMailbox({ email: 'Rent@Gmail.com ', app_password: 'abcd efgh ijkl mnop' }, l.master);
  assert.deepEqual([s.connected, s.email, s.sender, s.auto], [true, 'rent@gmail.com', 'zego', true]);
  assert.equal(seen.checks[0].username, 'rent@gmail.com');
  assert.equal(seen.checks[0].host, 'imap.gmail.com');
  assert.ok(!JSON.stringify(s).includes('abcdefgh'));
  const stored = await db.prepare('SELECT password_enc FROM zego_mailbox').get();
  assert.ok(!stored.password_enc.includes('abcdefgh'), 'kept encrypted');

  // The weekly run switched off, the password left as it is.
  const off = await saveMailbox({ auto: false }, l.master);
  assert.equal(off.auto, false);
  assert.equal((await db.prepare('SELECT password_enc FROM zego_mailbox').get()).password_enc, stored.password_enc);
  assert.equal(seen.checks.length, 1, 'no new password, no new sign-in');

  assert.equal((await removeMailbox()).connected, false);
});

test('a sync reads the attached report, records what is sure, leaves the rest for a person, and says what it could not read', async () => {
  const l = await leases();
  const seen = fakeGmail({ inbox: [
    email('Zego payments report', [csvFile()]),
    email('Your Zego report is ready', [], 'Download it here: https://portal.gozego.com/reports/123'),
    email('Zego statement', [{ filename: 'notes.csv', contentType: 'text/csv', content: Buffer.from('a,b\n1,2\n') }]),
  ] });
  await saveMailbox({ email: 'rent@gmail.com', app_password: 'x'.repeat(16) }, l.master);
  const r = await syncMail({ today: TODAY, now: NOW });
  assert.equal(seen.since[0], '2026-10-04T09:00:00.000Z', 'the first run looks back about a month');
  assert.deepEqual([r.emails, r.reports, r.recorded, r.left, r.error], [3, 1, 1, 1, undefined]);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[0], /"Your Zego report is ready" \(2026-11-03\) has no PDF or CSV attached, only a link/);
  assert.match(r.notes[1], /notes\.csv.*does not look like a Zego payments report/);
  assert.equal((await paid(l.sara))[0].reference, 'Zego 570000001');
  assert.equal((await paid(l.ann)).length, 0, 'an unknown name is not guessed');

  // The next run looks back from this one, and finds nothing new to record in the same report.
  const again = await syncMail({ today: TODAY, now: new Date('2026-11-15T09:00:00Z') });
  assert.equal(seen.since[1], '2026-11-05T09:00:00.000Z');
  assert.deepEqual([again.recorded, again.already, again.left], [0, 1, 1]);
  assert.equal((await paid(l.sara)).length, 1);
  const s = await mailboxState();
  assert.equal(s.last_result.already, 1);
  assert.equal(s.next_run_at, '2026-11-22T09:00:00.000Z');
});

test('a payment left on no lease is placed from the payout\'s list later, with where it could go', async () => {
  const l = await leases();
  fakeGmail({ inbox: [email('Zego payments report', [csvFile()])] });
  await saveMailbox({ email: 'rent@gmail.com', app_password: 'x'.repeat(16) }, l.master);
  await syncMail({ today: TODAY, now: NOW });
  const [p] = await listPayouts();
  assert.deepEqual([p.payments, p.on_leases], [2, 1]);
  const off = (await getPayout(p.id)).transactions.find((t) => !t.on_lease);
  assert.equal(off.resident, 'Annie Pryce');
  assert.equal(off.booking_id, null);
  await placeTransaction(off.trans_no, l.ann.id, l.master, TODAY);
  assert.equal((await paid(l.ann))[0].amount, 300);
  await assert.rejects(placeTransaction(off.trans_no, l.ann.id, l.master, TODAY), /on a lease already/);
  assert.equal((await listPayouts())[0].on_leases, 2);
  // Remembered: next week the name is matched by itself.
  assert.equal((await db.prepare("SELECT tenant_id FROM zego_names WHERE name_key = 'annie pryce'").get()).tenant_id, (await db.prepare('SELECT tenant_id FROM lease_bookings WHERE id = ?').get(l.ann.id)).tenant_id);
});

test('a run that cannot sign in is kept as failed and tried again a day later; a good one waits a week', async () => {
  const l = await leases();
  fakeGmail();
  await saveMailbox({ email: 'rent@gmail.com', app_password: 'x'.repeat(16) }, l.master);
  fakeGmail({ refuse: 'Email: Wrong email or password, or IMAP access is turned off in your email settings.' });
  const r = await runIfDue(NOW);
  assert.match(r.error, /Wrong email or password/);
  const row = await db.prepare('SELECT * FROM zego_mailbox').get();
  assert.equal(row.last_ok_at, null, 'the next run still looks back a month');
  assert.equal(nextRun(row).toISOString(), '2026-11-09T09:00:00.000Z');
  assert.equal(await runIfDue(new Date('2026-11-08T20:00:00Z')), null, 'not due yet');

  fakeGmail();
  assert.equal((await runIfDue(new Date('2026-11-09T10:00:00Z'))).error, undefined);
  assert.equal(nextRun(await db.prepare('SELECT * FROM zego_mailbox').get()).toISOString(), '2026-11-16T10:00:00.000Z');

  await saveMailbox({ auto: false }, l.master);
  assert.equal(await runIfDue(new Date('2026-12-30T10:00:00Z')), null, 'switched off: only Sync now');
  await removeMailbox();
  await assert.rejects(syncMail({ now: NOW }), /Connect the Gmail/);
});

test('connecting the Gmail is an edit, Sync now and placing a payment are adds', () => {
  assert.equal(actionFor('PUT', '/accounts/zego/mailbox'), 'edit');
  assert.equal(actionFor('DELETE', '/accounts/zego/mailbox'), 'delete');
  assert.equal(actionFor('POST', '/accounts/zego/sync'), 'add');
  assert.equal(actionFor('POST', '/accounts/zego/transactions/1/lease'), 'add');
});
