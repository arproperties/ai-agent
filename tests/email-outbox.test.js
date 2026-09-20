import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { createDraft, decideDraft, getDraft, actionLog, PER_HOUR } from '../server/drafts.js';
import { deliver, drain } from '../server/outbox.js';
import { encrypt } from '../server/secrets.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
test.after(() => closeDb());

async function mailbox(canWrite = true) {
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc, smtp_host, smtp_port, smtp_secure, can_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, 'sara@acme.ae', 'imap.titan.email', 'sara@acme.ae', encrypt('hunter2'),
         'smtp.titan.email', 465, true, canWrite);
  return userId;
}

/** A stand-in for the mail server, recording what it was asked to do. */
function spy({ failSend = null, failAppend = null } = {}) {
  const calls = { sent: [], appended: [] };
  return {
    calls,
    send: async (acc, password, built) => {
      if (failSend) throw Object.assign(new Error(failSend), { responseCode: 550 });
      calls.sent.push({ host: acc.smtp_host, password, raw: built.raw.toString(), envelope: built.envelope });
    },
    append: async (userId, raw) => {
      if (failAppend) throw new Error(failAppend);
      calls.appended.push({ userId, raw: raw.toString() });
    },
  };
}

test('an approved draft goes out once, is marked sent, and is filed in Sent', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['bob@example.com'], subject: 'Invoice 42', body: 'Attached.' });
  await decideDraft(userId, d.id, true);
  const s = spy();

  const { messageId } = await deliver(await getDraft(userId, d.id), s);

  assert.equal(s.calls.sent.length, 1);
  assert.equal(s.calls.sent[0].host, 'smtp.titan.email');
  assert.deepEqual(s.calls.sent[0].envelope.to, ['bob@example.com']);
  assert.match(s.calls.sent[0].raw, /^Subject: Invoice 42$/m);

  const after = await getDraft(userId, d.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.message_id, messageId);
  assert.ok(after.sent_at);

  assert.equal(s.calls.appended.length, 1);
  assert.equal(s.calls.appended[0].raw, s.calls.sent[0].raw, 'the copy in Sent is the message that was sent');
});

test('the password is decrypted for the transport and never written down', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, true);
  const s = spy();

  await deliver(await getDraft(userId, d.id), s);

  assert.equal(s.calls.sent[0].password, 'hunter2');
  const log = JSON.stringify(await actionLog(userId));
  assert.ok(!log.includes('hunter2'), 'the log must never carry the password');
});

test('a reply threads', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, {
    to: ['bob@example.com'], subject: 'Re: Invoice 42', body: 'Thanks.',
    inReplyTo: '<orig@example.com>', refs: '<first@example.com> <orig@example.com>',
  });
  await decideDraft(userId, d.id, true);
  const s = spy();

  await deliver(await getDraft(userId, d.id), s);

  assert.match(s.calls.sent[0].raw, /^In-Reply-To: <orig@example\.com>$/m);
  assert.match(s.calls.sent[0].raw, /^References: <first@example\.com> <orig@example\.com>$/m);
});

test('a refused message is marked failed with a reason, and is not silently retried', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, true);

  await assert.rejects(deliver(await getDraft(userId, d.id), spy({ failSend: 'Mailbox unavailable' })));

  const after = await getDraft(userId, d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /refused the message/);
  assert.equal((await actionLog(userId)).find((r) => r.action === 'send').ok, false);
});

test('a Sent copy that will not file does not turn a delivered email into a failure', async () => {
  await reset();
  const userId = await mailbox();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, true);

  await deliver(await getDraft(userId, d.id), spy({ failAppend: 'no Sent folder' }));

  assert.equal((await getDraft(userId, d.id)).status, 'sent', 'the mail has gone; it cannot be un-sent');
  const copy = (await actionLog(userId)).find((r) => r.action === 'sent_copy');
  assert.equal(copy.ok, false);
  assert.match(copy.error, /no Sent folder/);
});

test('a mailbox with sending turned off cannot be made to send', async () => {
  await reset();
  const userId = await mailbox(false);
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, true);
  const s = spy();

  await assert.rejects(deliver(await getDraft(userId, d.id), s), /turned off/);
  assert.equal(s.calls.sent.length, 0, 'the toggle is checked at the last moment, not only at the first');
  assert.equal((await getDraft(userId, d.id)).status, 'failed');
});

test('the queue sends approved drafts in order and leaves everything else alone', async () => {
  await reset();
  const userId = await mailbox();
  const pending = await createDraft(userId, { to: ['a@x.com'], body: '1' });
  const first = await createDraft(userId, { to: ['b@x.com'], body: '2' });
  const second = await createDraft(userId, { to: ['c@x.com'], body: '3' });
  await decideDraft(userId, first.id, true);
  await decideDraft(userId, second.id, true);

  const order = [];
  const sent = await drain({ deliverOne: async (d) => { order.push(d.id); return { messageId: '<x>' }; } });

  assert.equal(sent, 2);
  assert.deepEqual(order, [first.id, second.id]);
  assert.equal((await getDraft(userId, pending.id)).status, 'pending');
});

test('over the limit the draft waits rather than failing', async () => {
  await reset();
  const userId = await mailbox();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < PER_HOUR; i++) {
    await db.prepare(`INSERT INTO email_action_log (user_id, action, ok, created_at) VALUES (?, 'send', true, ?)`).run(userId, now - 60);
  }
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, true);

  const sent = await drain({ deliverOne: async () => assert.fail('must not send over the limit') });

  assert.equal(sent, 0);
  assert.equal((await getDraft(userId, d.id)).status, 'approved', 'still queued, not failed - it goes when the hour turns');
});

test('one user hitting the limit does not hold up another', async () => {
  await reset();
  const sara = await mailbox();
  const tom = await mailbox();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < PER_HOUR; i++) {
    await db.prepare(`INSERT INTO email_action_log (user_id, action, ok, created_at) VALUES (?, 'send', true, ?)`).run(sara, now - 60);
  }
  const hers = await createDraft(sara, { to: ['a@x.com'], body: '1' });
  const his = await createDraft(tom, { to: ['b@x.com'], body: '2' });
  await decideDraft(sara, hers.id, true);
  await decideDraft(tom, his.id, true);

  const order = [];
  await drain({ deliverOne: async (d) => { order.push(d.id); return { messageId: '<x>' }; } });

  assert.deepEqual(order, [his.id]);
});

test('one draft blowing up does not stop the rest of the queue', async () => {
  await reset();
  const userId = await mailbox();
  const bad = await createDraft(userId, { to: ['a@x.com'], body: '1' });
  const good = await createDraft(userId, { to: ['b@x.com'], body: '2' });
  await decideDraft(userId, bad.id, true);
  await decideDraft(userId, good.id, true);

  const order = [];
  const sent = await drain({
    deliverOne: async (d) => {
      if (d.id === bad.id) throw new Error('smtp exploded');
      order.push(d.id);
      return { messageId: '<x>' };
    },
  });

  assert.equal(sent, 1);
  assert.deepEqual(order, [good.id]);
});
