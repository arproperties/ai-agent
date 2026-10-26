import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mail, CASE, stubBox, stubAsk, externalUser, savedFolder } from './helpers/cases.js';
import { lookAll } from '../server/caseWatch.js';

// The watcher: every tracked folder of every external user, each one's failure kept to itself.
// Stub mailboxes and a stub AI only.

test.after(() => closeDb());

const NEW = mail({ key: 'INBOX:9', messageId: '<9@x>', at: new Date().toISOString(), subject: 'Soutex E - 205791 judgment', text: 'Judgment is out.' });

test.beforeEach(() => reset());

test('a broken mailbox is written down, and the next folder still gets its new email', async () => {
  const jeff = await externalUser('Jeff');
  const anna = await externalUser('Anna');
  const boxes = { [jeff.id]: stubBox(CASE), [anna.id]: stubBox(CASE) };
  const deps = { mailbox: async (userId) => boxes[userId], ask: stubAsk() };
  const fj = await savedFolder(jeff, deps);
  const fa = await savedFolder(anna, deps);
  const filesBefore = (await db.prepare('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?').get(fj.id)).n;

  boxes[jeff.id].fail = 'AUTHENTICATIONFAILED Invalid credentials';
  boxes[anna.id].mails.push(NEW);
  assert.deepEqual(await lookAll(deps), { checked: 2, failed: 1 });

  const j = await db.prepare('SELECT * FROM case_folders WHERE id = ?').get(fj.id);
  assert.match(j.last_error, /AUTHENTICATIONFAILED/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM documents WHERE case_folder_id = ?').get(fj.id)).n, filesBefore);
  const a = await db.prepare('SELECT * FROM case_folders WHERE id = ?').get(fa.id);
  assert.equal(a.last_error, null);
  assert.equal(a.new_count, 1);
  assert.ok(await db.prepare('SELECT 1 FROM case_emails WHERE folder_id = ? AND mail_key = ?').get(fa.id, 'INBOX:9'));
});

test('a staff user\'s folder and a stopped folder are never looked at', async () => {
  const jeff = await externalUser('Jeff');
  const staff = await makeUser('Staff');
  let asked = 0;
  const deps = { mailbox: async () => { asked++; return stubBox(CASE); }, ask: stubAsk() };
  await db.prepare(`INSERT INTO case_folders (user_id, name, case_number, case_key) VALUES (?, 'Staff case', 'Soutex E - 205791', 'soutexe205791')`).run(staff);
  const f = await savedFolder(jeff, deps);
  await db.prepare('UPDATE case_folders SET tracking = false WHERE id = ?').run(f.id);
  asked = 0;
  assert.deepEqual(await lookAll(deps), { checked: 0, failed: 0 });
  assert.equal(asked, 0);
});
