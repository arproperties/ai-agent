import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { logAction, sendQuota, actionLog, PER_HOUR, PER_DAY } from '../server/drafts.js';

test.after(() => closeDb());

const now = () => Math.floor(Date.now() / 1000);

/** Write `n` send rows aged `agoSeconds` old, bypassing logAction so time can be faked. */
async function sends(userId, n, agoSeconds, ok = true) {
  for (let i = 0; i < n; i++) {
    await db.prepare(`INSERT INTO email_action_log (user_id, action, ok, created_at) VALUES (?, 'send', ?, ?)`)
      .run(userId, ok, now() - agoSeconds);
  }
}

test('a fresh mailbox may send', async () => {
  await reset();
  const userId = await makeUser('Sara');
  const q = await sendQuota(userId);
  assert.equal(q.hour, 0);
  assert.equal(q.allowed, true);
});

test('the hourly limit stops sending, and only for that user', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const tom = await makeUser('Tom');
  await sends(sara, PER_HOUR, 60);

  assert.equal((await sendQuota(sara)).allowed, false, 'Sara has used her hour');
  assert.equal((await sendQuota(tom)).allowed, true, 'Tom has not');
});

test('the window slides — an hour-old send no longer counts against the hour', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await sends(userId, PER_HOUR, 3700);

  const q = await sendQuota(userId);
  assert.equal(q.hour, 0);
  assert.equal(q.day, PER_HOUR, 'but it still counts against the day');
  assert.equal(q.allowed, true);
});

test('the daily limit stops sending even when the hour is clear', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await sends(userId, PER_DAY, 7200);

  const q = await sendQuota(userId);
  assert.equal(q.hour, 0);
  assert.equal(q.allowed, false, 'Titan counts the day, so we do too');
});

test('a failed send does not eat the allowance', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await sends(userId, PER_HOUR, 60, false);
  assert.equal((await sendQuota(userId)).allowed, true);
});

test('marking and moving are not sending', async () => {
  await reset();
  const userId = await makeUser('Sara');
  for (let i = 0; i < PER_HOUR + 5; i++) await logAction(userId, { action: 'mark_read', target: 'INBOX:9' });
  assert.equal((await sendQuota(userId)).allowed, true, 'the limit is about outbound mail');
});

test('the caller is told when to come back', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await sends(userId, PER_HOUR, 600); // ten minutes ago

  const q = await sendQuota(userId);
  assert.equal(q.allowed, false);
  assert.ok(q.retryInSeconds > 0 && q.retryInSeconds <= 3000, `expected ~50 minutes, got ${q.retryInSeconds}`);
});

test('the log records who, what, to whom and which message — and no secrets', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await logAction(userId, {
    agentId: 7, action: 'send', draftId: 3,
    recipients: ['bob@example.com'], messageId: '<a@b>', target: 'INBOX:12',
  });

  const [row] = await actionLog(userId);
  assert.equal(row.action, 'send');
  assert.equal(row.agent_id, 7);
  assert.deepEqual(JSON.parse(row.recipients), ['bob@example.com']);
  assert.equal(row.message_id, '<a@b>');
  assert.ok(row.created_at);
  assert.ok(!JSON.stringify(row).includes('password'));
});

test('recipients may be handed over already serialised', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await logAction(userId, { action: 'send', recipients: JSON.stringify(['bob@example.com']) });
  const [row] = await actionLog(userId);
  assert.deepEqual(JSON.parse(row.recipients), ['bob@example.com'], 'stored once, not double-encoded');
});

test('a failure is recorded with its reason', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await logAction(userId, { action: 'send', ok: false, error: 'mailbox full' });
  const [row] = await actionLog(userId);
  assert.equal(row.ok, false);
  assert.equal(row.error, 'mailbox full');
});

test('newest first', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await logAction(userId, { action: 'mark_read' });
  await logAction(userId, { action: 'move' });
  assert.deepEqual((await actionLog(userId)).map((r) => r.action), ['move', 'mark_read']);
});
