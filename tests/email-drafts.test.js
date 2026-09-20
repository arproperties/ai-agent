import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { cleanAddresses, createDraft, getDraft, listDrafts, decideDraft, draftOut, MAX_RECIPIENTS } from '../server/drafts.js';

test.after(() => closeDb());

async function fixture() {
  await reset();
  const userId = await makeUser('Sara');
  const otherId = await makeUser('Tom');
  const agentId = await makeAgent(userId, 'Ops');
  return { userId, otherId, agentId };
}

test('addresses are normalised, deduped and stripped of display names', () => {
  assert.deepEqual(cleanAddresses(['Bob <BOB@example.com>', ' bob@example.com ', 'jo@example.com'], 'To'),
    ['bob@example.com', 'jo@example.com']);
});

test('a comma-separated string is a list too', () => {
  assert.deepEqual(cleanAddresses('a@x.com, b@x.com; c@x.com', 'To'), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('something that is not an address is refused by name', () => {
  assert.throws(() => cleanAddresses(['bob'], 'To'), /To is not a valid email address: bob/);
  assert.throws(() => cleanAddresses(['bob@localhost'], 'To'), /not a valid email address/);
});

test('a draft with no recipient is not a draft', async () => {
  const { userId } = await fixture();
  await assert.rejects(createDraft(userId, { to: [], subject: 'x', body: 'y' }), /at least one recipient/);
});

test('recipients are capped', async () => {
  const { userId } = await fixture();
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@example.com`);
  await assert.rejects(createDraft(userId, { to: many, body: 'hi' }), /Too many recipients/);
});

test('to and cc are capped together, not separately', async () => {
  const { userId } = await fixture();
  const half = Math.ceil(MAX_RECIPIENTS / 2);
  const list = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}@example.com`);
  await assert.rejects(createDraft(userId, { to: list('a', half), cc: list('b', half + 1), body: 'hi' }), /Too many recipients/);
});

test('a new draft is pending, and carries who wrote it and where', async () => {
  const { userId, agentId } = await fixture();
  const d = await createDraft(userId, {
    agentId, conversationId: null, to: ['bob@example.com'], cc: ['jo@example.com'],
    subject: 'Invoice 42', body: 'Attached.',
  });
  assert.equal(d.status, 'pending');
  assert.equal(d.agent_id, agentId);
  assert.deepEqual(JSON.parse(d.to_addrs), ['bob@example.com']);
  assert.deepEqual(JSON.parse(d.cc_addrs), ['jo@example.com']);
});

test('one person never sees, approves or even finds another person\'s draft', async () => {
  const { userId, otherId } = await fixture();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });

  assert.equal(await getDraft(otherId, d.id), undefined);
  assert.deepEqual(await listDrafts(otherId, {}), []);
  await assert.rejects(decideDraft(otherId, d.id, true), /not found/i);
  assert.equal((await getDraft(userId, d.id)).status, 'pending', 'and it is untouched');
});

test('approving moves it into the queue; rejecting takes it out for good', async () => {
  const { userId } = await fixture();
  const a = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  const b = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });

  assert.equal((await decideDraft(userId, a.id, true)).status, 'approved');
  assert.equal((await decideDraft(userId, b.id, false)).status, 'rejected');
  assert.ok((await getDraft(userId, a.id)).decided_at, 'and when it was decided');
});

test('a decision is made once', async () => {
  const { userId } = await fixture();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'hi' });
  await decideDraft(userId, d.id, false);
  await assert.rejects(decideDraft(userId, d.id, true), /already rejected/);
});

test('listing is scoped to a conversation when asked, newest first', async () => {
  const { userId } = await fixture();
  const { id: convId } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, 'c');
  await createDraft(userId, { to: ['a@x.com'], body: '1' });
  const inConv = await createDraft(userId, { conversationId: convId, to: ['b@x.com'], body: '2' });

  const scoped = await listDrafts(userId, { conversationId: convId });
  assert.deepEqual(scoped.map((r) => r.id), [inConv.id]);
  assert.equal((await listDrafts(userId, {})).length, 2);
});

test('pending is the default listing, because that is what needs a decision', async () => {
  const { userId } = await fixture();
  const a = await createDraft(userId, { to: ['a@x.com'], body: '1' });
  await createDraft(userId, { to: ['b@x.com'], body: '2' });
  await decideDraft(userId, a.id, false);

  assert.equal((await listDrafts(userId, { status: 'pending' })).length, 1);
});

test('what the app sends to the browser has no ids it should not have', async () => {
  const { userId, agentId } = await fixture();
  const d = await createDraft(userId, { agentId, to: ['bob@example.com'], subject: 'Hi', body: 'Hello' });
  const out = draftOut(d);

  assert.deepEqual(out.to, ['bob@example.com']);
  assert.equal(out.subject, 'Hi');
  assert.equal(out.status, 'pending');
  assert.ok(!('user_id' in out) && !('to_addrs' in out), 'client shape, not the row');
});

test('a very long body is stored, not silently dropped', async () => {
  const { userId } = await fixture();
  const d = await createDraft(userId, { to: ['bob@example.com'], body: 'x'.repeat(50000) });
  assert.equal((await getDraft(userId, d.id)).body.length, 20000, 'capped at 20k, which is a long email');
});
