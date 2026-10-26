import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys, and no mail is sent
const cats = await import('../server/docCategories.js');
const rc = await import('../server/renewalCases.js');
const { caseEmail, sendCaseEmail } = await import('../server/documentRenewals.js');

test.after(() => closeDb());

const dir = mkdtempSync(join(tmpdir(), 'rem-'));
async function office() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master', name: 'Boss' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  await cats.seedCategories();
  const add = async (type, { file = true, code = 'E-0042' } = {}) => {
    const id = await makeDoc(boss.id, null, `${type}.pdf`);
    const path = join(dir, `${id}.pdf`);
    if (file) writeFileSync(path, `%PDF ${type}`);
    await db.prepare(`UPDATE documents SET type_id = (SELECT id FROM document_types WHERE label = ?), category_id = (SELECT category_id FROM document_types WHERE label = ?),
        employee_code = ?, employee_name = 'Ahmed Khan', expires_on = '2026-11-20', expiry_confirmed_at = 1, link_confirmed_at = 1, path = ?, mime = 'application/pdf' WHERE id = ?`)
      .run(type, type, code, file ? path : null, id);
    return id;
  };
  const contract = await add('Labour Contract');
  const passport = await add('Passport');
  const visa = await add('Residence Visa', { file: false });
  await add('Passport', { code: 'E-0077' }); // someone else's
  const c = await rc.startCase(boss, contract, 'renew');
  // What Reem read off the contract: its terms are the ones kept.
  await rc.propose(boss, c.id, { mode: 'keep', terms: { new_start: '2026-11-20', new_end: '2028-11-20', effective_date: '2026-11-20' }, note: 'Good worker' },
    { contract: async () => ({ basic: 2000, allowance: 3000, total: 5500, position: 'Clerk', hours: '48 hours a week', confidence: 'high' }) });
  return { boss, caseId: c.id, contract, passport, visa };
}
const mailbox = async () => ({ email: 'hr@example.com', can_write: true, smtp_host: 'smtp.example.com' });
const lookup = async () => ({ employee: { code: 'E-0042', email: 'Ahmed@Example.com', company: 'AAR Properties' } });

test('a renewal email goes to the PRO: their address in To, who and the new period, the documents to attach', async () => {
  const { boss, caseId, contract, passport, visa } = await office();
  const pro = await makeUser('Pro Person');
  await db.prepare(`UPDATE users SET email = 'Pro@Example.com' WHERE id = ?`).run(pro);
  await db.prepare(`INSERT INTO doc_renewal_case_settings (id, pro_ids) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET pro_ids = EXCLUDED.pro_ids`).run([pro]);
  const d = await caseEmail(boss, caseId, { mailbox, lookup });
  assert.deepEqual(d.to, ['pro@example.com'], 'the PRO, not the employee');
  assert.equal(d.to_who, 'pro');
  assert.match(d.subject, /Labour contract renewal – Ahmed Khan \(E-0042\)/);
  assert.match(d.body, /^Dear Pro Person,/);
  assert.match(d.body, /Please process the renewal of the labour contract of Ahmed Khan \(E-0042\), AAR Properties/);
  assert.match(d.body, /New contract: 2 years, 20 Nov 2026 to 20 Nov 2028/);
  assert.match(d.body, /Terms: same as the current contract/);
  assert.match(d.body, /Job title: Clerk/);
  assert.match(d.body, /Basic salary: AED 2,000 a month/);
  assert.match(d.body, /Total: AED 5,500 a month/, 'the contract\'s own total, when it prints one');
  assert.match(d.body, /Working hours: 48 hours a week/);
  assert.match(d.body, /Good worker/, 'HR\'s note is for the PRO');
  assert.deepEqual(d.documents.map((x) => x.id).sort(), [contract, passport, visa].sort(), 'only this employee\'s');
  assert.equal(d.from, 'hr@example.com');
});

test('Send: an email from the user\'s mailbox, To and Cc, with the ticked documents attached, and the case notes it', async () => {
  const { boss, caseId, contract, passport } = await office();
  let kicked = 0;
  const fetch = async (user, id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const out = await sendCaseEmail(boss, caseId, {
    to: ['pro@example.com'], cc: 'boss@example.com; hr2@example.com', subject: 'Renewal', body: 'Please renew.', document_ids: [contract, passport],
  }, { fetch, mailbox, kick: () => { kicked++; }, allowed: true });
  assert.equal(out.status, 'approved', 'the person pressed Send: it goes out');
  assert.deepEqual(out.to, ['pro@example.com']);
  assert.deepEqual(out.cc, ['boss@example.com', 'hr2@example.com']);
  assert.equal(out.files.length, 2);
  assert.ok(out.files.every((f) => f.here));
  assert.match(out.attachments[0], /Labour Contract/);
  assert.equal(kicked, 1);
  const ev = await db.prepare(`SELECT * FROM doc_renewal_case_events WHERE case_id = ? AND kind = 'emailed'`).get(caseId);
  assert.ok(ev);
});

test('a document of someone else cannot be attached', async () => {
  const { boss, caseId } = await office();
  const other = (await db.prepare(`SELECT id FROM documents WHERE employee_code = 'E-0077'`).get()).id;
  await assert.rejects(sendCaseEmail(boss, caseId, { to: 'a@example.com', subject: 's', body: 'b', document_ids: [other] }, { mailbox, kick: () => {}, allowed: true }), /not one of/);
});

test('no mailbox that can send: nothing is drafted', async () => {
  const { boss, caseId } = await office();
  await assert.rejects(sendCaseEmail(boss, caseId, { to: 'a@example.com', subject: 's', body: 'b', document_ids: [] }, { mailbox: async () => null, kick: () => {}, allowed: true }), /Connect your email/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM email_drafts').get()).n, 0);
});

test('nobody to send to is said', async () => {
  const { boss, caseId } = await office();
  await assert.rejects(sendCaseEmail(boss, caseId, { to: '', subject: 's', body: 'b', document_ids: [] }, { mailbox, kick: () => {}, allowed: true }), /recipient/);
});

test('sending switched off (the default): nothing is drafted and nothing goes out', async () => {
  const { boss, caseId, contract } = await office();
  let kicked = 0;
  await assert.rejects(sendCaseEmail(boss, caseId, { to: 'pro@example.com', subject: 's', body: 'b', document_ids: [contract] }, { mailbox, kick: () => { kicked++; } }), /switched off/);
  assert.equal(kicked, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM email_drafts').get()).n, 0);
});

test('the master\'s switch in settings lets Send go out', async () => {
  const { boss, caseId, contract } = await office();
  await rc.saveCaseSettings(boss, { send_on: true });
  let kicked = 0;
  const fetch = async (user, id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const out = await sendCaseEmail(boss, caseId, { to: 'pro@example.com', subject: 's', body: 'b', document_ids: [contract] }, { fetch, mailbox, kick: () => { kicked++; } });
  assert.equal(out.status, 'approved');
  assert.equal(kicked, 1);
});

test('a termination email has its reason and last day, and no documents', async () => {
  const { boss, contract } = await office();
  const c = await rc.startCase(boss, contract, 'cancel').catch(async () => {
    // the renewal case is open on it: turn it into a termination
    const open = await db.prepare('SELECT id FROM doc_renewal_cases WHERE document_id = ? AND closed_at IS NULL').get(contract);
    return rc.decide(boss, open.id, { choice: 'cancel' });
  });
  await rc.propose(boss, c.id, { mode: 'cancel', terms: { reason: 'Resigned', last_working_day: '2026-12-09', notice_days: 30 } });
  const d = await caseEmail(boss, c.id, { mailbox, lookup });
  assert.match(d.subject, /termination/);
  assert.match(d.body, /your labour contract with AAR Properties will come to an end/);
  assert.match(d.body, /Your last working day: 9 Dec 2026/);
  assert.deepEqual(d.documents, []);
  const passport = (await db.prepare(`SELECT id FROM documents WHERE employee_code = 'E-0042' AND type_id = (SELECT id FROM document_types WHERE label = 'Passport')`).get()).id;
  await assert.rejects(sendCaseEmail(boss, c.id, { to: 'a@example.com', subject: 's', body: 'b', document_ids: [passport] }, { mailbox, kick: () => {}, allowed: true }), /not one of/);
});

test('a termination email goes to the employee: their email in To, nothing to attach', async () => {
  const { boss, contract } = await office();
  const open = await db.prepare('SELECT id FROM doc_renewal_cases WHERE document_id = ? AND closed_at IS NULL').get(contract);
  const c = await rc.decide(boss, open.id, { choice: 'cancel' });
  await rc.propose(boss, c.id, { mode: 'cancel', terms: { reason: 'Resigned', last_working_day: '2026-12-09' } });
  const d = await caseEmail(boss, c.id, { mailbox, lookup });
  assert.deepEqual(d.to, ['ahmed@example.com']);
  assert.equal(d.to_who, 'employee');
  assert.match(d.body, /^Dear Ahmed Khan,/);
  assert.doesNotMatch(d.body, /Resigned/, 'the reason stays with HR');
  assert.deepEqual(d.documents, []);
});
