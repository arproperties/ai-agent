import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { connectedMailbox, EMAIL_READ_TOOLS, EMAIL_WRITE_TOOLS, statusFor, replyRecipients } from '../server/email.js';
import { getDraft, listDrafts, decideDraft } from '../server/drafts.js';

test.after(() => closeDb());

async function mailbox(canWrite) {
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc, smtp_host, can_write)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, 'sara@acme.ae', 'imap.titan.email', 'sara@acme.ae', 'enc', 'smtp.titan.email', canWrite);
  return userId;
}

const names = (defs) => defs.map((t) => t.name).sort();

test('no mailbox, no tools', async () => {
  await reset();
  assert.equal(await connectedMailbox(await makeUser('Sara')), null);
});

test('a read-only mailbox is never shown a tool that could act', async () => {
  await reset();
  const m = await connectedMailbox(await mailbox(false));

  assert.equal(m.canWrite, false);
  assert.deepEqual(names(m.definitions), ['read_email', 'search_email']);
  assert.equal(await m.run({ id: 'x', name: 'send_email', input: { draft_id: 1 } }).then((r) => r.is_error), true,
    'and asking for one by name is refused, not improvised');
});

test('opting in adds exactly the six', async () => {
  await reset();
  const m = await connectedMailbox(await mailbox(true));

  assert.equal(m.canWrite, true);
  assert.deepEqual(names(m.definitions),
    ['create_draft', 'mark_read', 'mark_unread', 'move_email', 'read_email', 'reply_email', 'search_email', 'send_email']);
});

test('there is no tool that deletes', () => {
  const all = [...EMAIL_READ_TOOLS, ...EMAIL_WRITE_TOOLS].map((t) => t.name);
  assert.ok(!all.some((n) => /delete|remove|purge|expunge/i.test(n)));
});

test('every tool says what it does and takes a schema', () => {
  for (const t of [...EMAIL_READ_TOOLS, ...EMAIL_WRITE_TOOLS]) {
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.input_schema.type, 'object', `${t.name} needs a schema`);
  }
});

test('the sending tools promise, in the description, that they do not send', () => {
  for (const name of ['create_draft', 'reply_email', 'send_email']) {
    const t = EMAIL_WRITE_TOOLS.find((x) => x.name === name);
    assert.match(t.description, /approv/i, `${name} must tell the model about the approval step`);
  }
});

test('create_draft writes a pending draft and tells the screen about it', async () => {
  await reset();
  const userId = await mailbox(true);
  const seen = [];
  const m = await connectedMailbox(userId, { agentId: null, conversationId: null, onDraft: (d) => seen.push(d) });

  const out = await m.run({ id: 'tu1', name: 'create_draft', input: { to: ['bob@example.com'], subject: 'Hi', body: 'Hello' } });

  assert.equal(out.is_error, undefined);
  assert.match(out.content, /not been sent/i);
  const [d] = await listDrafts(userId, {});
  assert.equal(d.status, 'pending');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, d.id);
  assert.deepEqual(seen[0].to, ['bob@example.com']);
});

test('writing a draft is recorded in the action log', async () => {
  await reset();
  const userId = await mailbox(true);
  const m = await connectedMailbox(userId, { agentId: null, conversationId: null });

  await m.run({ id: 'tu1', name: 'create_draft', input: { to: ['bob@example.com'], subject: 'Hi', body: 'Hello' } });

  const [d] = await listDrafts(userId, {});
  const rows = await db.prepare('SELECT * FROM email_action_log WHERE user_id = ?').all(userId);
  const row = rows.find((r) => r.action === 'draft');
  assert.ok(row, 'the spec asks for a row per action, and writing an email is one');
  assert.equal(row.draft_id, d.id);
  assert.match(row.recipients, /bob@example\.com/);
  assert.equal(row.ok, true);
});

test('a bad recipient comes back as a tool error the model can correct, not a crash', async () => {
  await reset();
  const m = await connectedMailbox(await mailbox(true));
  const out = await m.run({ id: 'tu1', name: 'create_draft', input: { to: ['not-an-address'], body: 'hi' } });

  assert.equal(out.is_error, true);
  assert.match(out.content, /not a valid email address/);
});

test('send_email cannot send a draft the user has not approved', async () => {
  await reset();
  const userId = await mailbox(true);
  const m = await connectedMailbox(userId);
  await m.run({ id: 'a', name: 'create_draft', input: { to: ['bob@example.com'], body: 'hi' } });
  const [d] = await listDrafts(userId, {});

  const out = await m.run({ id: 'b', name: 'send_email', input: { draft_id: d.id } });

  assert.match(out.content, /waiting for/i);
  assert.equal((await getDraft(userId, d.id)).status, 'pending', 'still pending: the tool did not move it');
});

test('send_email will not reach into someone else\'s drafts', async () => {
  await reset();
  const sara = await mailbox(true);
  const tom = await mailbox(true);
  const hers = await connectedMailbox(sara);
  await hers.run({ id: 'a', name: 'create_draft', input: { to: ['bob@example.com'], body: 'hi' } });
  const [d] = await listDrafts(sara, {});

  const out = await (await connectedMailbox(tom)).run({ id: 'b', name: 'send_email', input: { draft_id: d.id } });

  assert.equal(out.is_error, true);
  assert.match(out.content, /No draft/);
});

test('send_email on an already-rejected draft says so and does nothing', async () => {
  await reset();
  const userId = await mailbox(true);
  const m = await connectedMailbox(userId);
  await m.run({ id: 'a', name: 'create_draft', input: { to: ['bob@example.com'], body: 'hi' } });
  const [d] = await listDrafts(userId, {});
  await decideDraft(userId, d.id, false);

  const out = await m.run({ id: 'b', name: 'send_email', input: { draft_id: d.id } });
  assert.match(out.content, /rejected/);
});

test('the status line names the tool in the user\'s words', () => {
  assert.match(statusFor('create_draft', {}), /draft/i);
  assert.match(statusFor('reply_email', {}), /repl/i);
  assert.match(statusFor('move_email', { folder: 'Clients' }), /Clients/);
  assert.match(statusFor('mark_read', {}), /read/i);
  assert.match(statusFor('search_email', { query: 'invoice' }), /invoice/);
  assert.equal(typeof statusFor('read_email', {}), 'string');
});

test('a reply drops your own address, whatever case the header used', () => {
  assert.deepEqual(
    replyRecipients({ from: ['Sara@ACME.ae', 'bob@example.com'], to: [] }, 'sara@acme.ae'),
    ['bob@example.com'],
  );
});

test('replying to something you sent goes to the people you sent it to', () => {
  assert.deepEqual(
    replyRecipients({ from: ['sara@acme.ae'], to: ['bob@example.com', 'jo@example.com'] }, 'sara@acme.ae'),
    ['bob@example.com', 'jo@example.com'],
    'never back to yourself',
  );
});

test('a reply with nobody left to write to comes back empty, not addressed to you', () => {
  assert.deepEqual(replyRecipients({ from: ['sara@acme.ae'], to: ['SARA@acme.ae'] }, 'sara@acme.ae'), []);
});

test('a recipient listed twice is written to once', () => {
  assert.deepEqual(
    replyRecipients({ from: ['bob@example.com', 'BOB@example.com'], to: [] }, 'sara@acme.ae'),
    ['bob@example.com'],
  );
});

test('an Outlook mailbox is never given the write tools', async () => {
  await reset();
  const userId = await makeUser('Sara');
  await db.prepare(`INSERT INTO outlook_accounts (user_id, email, refresh_token) VALUES (?, ?, ?)`)
    .run(userId, 'sara@outlook.com', 'refresh-token');

  const m = await connectedMailbox(userId);

  assert.equal(m.canWrite, false, 'sending through Graph is a separate integration that does not exist');
  assert.deepEqual(m.definitions.map((t) => t.name).sort(), ['read_email', 'search_email']);
});
