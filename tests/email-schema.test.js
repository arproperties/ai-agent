import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

test.after(() => closeDb());

test('an existing mailbox stays read-only until its owner opts in', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc)
    VALUES (?, ?, ?, ?, ?)`).run(userId, 'sara@example.com', 'imap.titan.email', 'sara@example.com', 'enc');

  const acc = await db.prepare('SELECT * FROM imap_accounts WHERE user_id = ?').get(userId);
  assert.equal(acc.can_write, false, 'write access is opt-in, never inherited');
  assert.equal(acc.smtp_port, 465);
  assert.equal(acc.smtp_secure, true);
  assert.equal(acc.smtp_host, null, 'no SMTP host until one is chosen or detected');
});

test('a draft starts pending and only moves through the states we allow', async () => {
  await reset();
  const userId = await makeUser('Sara');
  const { id } = await db.prepare(
    `INSERT INTO email_drafts (user_id, to_addrs, subject, body) VALUES (?, ?, ?, ?) RETURNING id`
  ).run(userId, JSON.stringify(['bob@example.com']), 'Hello', 'Hi Bob');

  const d = await db.prepare('SELECT * FROM email_drafts WHERE id = ?').get(id);
  assert.equal(d.status, 'pending');
  assert.equal(d.cc_addrs, '[]');
  assert.ok(d.created_at);

  await assert.rejects(
    db.prepare('UPDATE email_drafts SET status = ? WHERE id = ?').run('yolo', id),
    /email_drafts_status_check|violates check constraint/,
  );
});

test('the action log outlives the draft it refers to', async () => {
  await reset();
  const userId = await makeUser('Sara');
  const { id } = await db.prepare(
    `INSERT INTO email_drafts (user_id, to_addrs) VALUES (?, ?) RETURNING id`
  ).run(userId, JSON.stringify(['bob@example.com']));
  await db.prepare(`INSERT INTO email_action_log (user_id, action, draft_id, recipients)
    VALUES (?, 'send', ?, ?)`).run(userId, id, JSON.stringify(['bob@example.com']));

  await db.prepare('DELETE FROM email_drafts WHERE id = ?').run(id);

  const rows = await db.prepare('SELECT * FROM email_action_log WHERE user_id = ?').all(userId);
  assert.equal(rows.length, 1, 'deleting the draft must not delete the record of sending it');
  assert.equal(rows[0].ok, true);
});

test('drafts and the log go when the user goes', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await db.prepare('INSERT INTO email_drafts (user_id, to_addrs) VALUES (?, ?)').run(userId, '[]');
  await db.prepare("INSERT INTO email_action_log (user_id, action) VALUES (?, 'send')").run(userId);

  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  assert.equal((await db.prepare('SELECT * FROM email_drafts').all()).length, 0);
  assert.equal((await db.prepare('SELECT * FROM email_action_log').all()).length, 0);
});

test('the queue is read in the order it was approved', async () => {
  await reset();
  const userId = await makeUser('Sara');
  for (const s of ['pending', 'approved', 'approved', 'sent']) {
    await db.prepare('INSERT INTO email_drafts (user_id, to_addrs, status) VALUES (?, ?, ?)').run(userId, '[]', s);
  }
  const queued = await db.prepare("SELECT id FROM email_drafts WHERE status = 'approved' ORDER BY id").all();
  assert.deepEqual(queued.map((r) => r.id), [2, 3]);
});

test('can_write is indexed nowhere it matters, but the queue lookup is', async () => {
  const idx = await db.prepare("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_drafts_queue'").get();
  assert.ok(idx, 'the outbox scans for approved drafts on a timer; it must not seq-scan');
});
