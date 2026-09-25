import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { transcript, recapOf, carry, carriedIds, noteCarried, pickedIds } from '../server/chatRecap.js';

test.after(() => closeDb());

// Bringing chat A and chat B into chat C. What matters here is the three things that
// would be quietly wrong and nobody would notice: whose chats can be reached, whether a
// chat stays brought in for the rest of the conversation, and when the paid summary is
// and is not made.

const makeConv = async (userId, title) => (await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, title)).id;
const say = async (convId, role, content, { agentId = null, files = [] } = {}) =>
  (await db.prepare('INSERT INTO messages (conversation_id, agent_id, role, content, files) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(convId, agentId, role, content, JSON.stringify(files))).id;

// A transcript long enough to be worth summarising (the short ones go through as they are)
const long = (n) => 'x'.repeat(n);

test('the transcript names the person and the agent that answered', () => {
  const out = transcript([
    { role: 'user', content: 'Can we close the Marina unit on Thursday?', files: '[]', agent_name: null },
    { role: 'assistant', content: 'The seller asked for Friday.', files: '[]', agent_name: 'Layla' },
    { role: 'assistant', content: 'Noted.', files: '[]', agent_name: null },
  ], 'Reem');
  assert.match(out, /Reem: Can we close the Marina unit on Thursday\?/);
  assert.match(out, /Layla: The seller asked for Friday\./);
  assert.match(out, /Assistant: Noted\./, 'an agent since deleted still has to read as the assistant');
});

test('the transcript says a file was there without pretending to have read it', () => {
  const out = transcript([{ role: 'user', content: 'See this', files: JSON.stringify([{ name: 'tenancy.pdf' }]), agent_name: null }], 'Reem');
  assert.match(out, /\[Attached: tenancy\.pdf\]/);
});

test('a short chat is passed through as it stands, with no paid call', async () => {
  await reset();
  const id = await makeUser('Reem');
  const user = { id, name: 'Reem' };
  const a = await makeConv(id, 'Marina tower');
  const agent = await makeAgent(id, 'Layla');
  await say(a, 'user', 'What did the seller want?');
  await say(a, 'assistant', 'AED 2,350,000 and Friday completion.', { agentId: agent });

  let called = 0;
  const r = await recapOf(user, a, { summarise: async () => { called += 1; return 'never used'; } });
  assert.equal(called, 0, 'a short chat costs nothing to bring in');
  assert.equal(r.verbatim, true);
  assert.match(r.body, /AED 2,350,000/, 'the amount is the reason it was brought in — it must survive');
  assert.equal(r.title, 'Marina tower');
});

test("somebody else's chat cannot be brought in", async () => {
  await reset();
  const mine = await makeUser('Reem');
  const theirs = await makeUser('Eve');
  const hers = await makeConv(theirs, 'Eve private');
  await say(hers, 'user', 'something of mine');

  assert.equal(await recapOf({ id: mine, name: 'Reem' }, hers), null);
  const { chats } = await carry({ id: mine, name: 'Reem' }, await makeConv(mine, 'Meeting'), [hers]);
  assert.deepEqual(chats, [], 'nothing about it comes back, not even the title');
});

test('a long chat is summarised once, and again only when it has grown', async () => {
  await reset();
  const id = await makeUser('Reem');
  const user = { id, name: 'Reem' };
  const a = await makeConv(id, 'Lease renewals');
  for (let i = 0; i < 4; i++) await say(a, i % 2 ? 'assistant' : 'user', long(1500)); // past VERBATIM, so it is worth summarising

  const calls = [];
  const summarise = async (title, text) => { calls.push({ title, text }); return `notes ${calls.length}`; };

  assert.equal((await recapOf(user, a, { summarise })).body, 'notes 1');
  assert.equal((await recapOf(user, a, { summarise })).body, 'notes 1', 'the same chat is not paid for twice');
  assert.equal(calls.length, 1);

  await say(a, 'user', long(500)); // the chat moved on
  assert.equal((await recapOf(user, a, { summarise })).body, 'notes 2');
  assert.equal(calls.length, 2);
  const { through_id: through } = await db.prepare('SELECT through_id FROM chat_recaps WHERE conversation_id = ?').get(a);
  const { id: last } = await db.prepare('SELECT MAX(id) id FROM messages WHERE conversation_id = ?').get(a);
  assert.equal(through, last);
});

test('a chat brought in once keeps counting for the rest of the conversation', async () => {
  await reset();
  const id = await makeUser('Reem');
  const user = { id, name: 'Reem' };
  const a = await makeConv(id, 'Marina tower');
  const b = await makeConv(id, 'Service charges');
  const c = await makeConv(id, 'Board meeting');
  await say(a, 'user', 'Seller wants Friday completion.');
  await say(b, 'user', 'Service charge is AED 18 a square foot.');

  // First message in chat C brings both in
  const first = await say(c, 'user', 'Pull the points together for the meeting');
  const one = await carry(user, c, [a, b]);
  assert.deepEqual(one.chats.map((x) => x.title), ['Marina tower', 'Service charges']);
  assert.deepEqual(one.added.map((x) => x.id), [a, b], 'both are new, so both are written down');
  await noteCarried(first, one.added);

  // Second message picks nothing, and still has both
  await say(c, 'user', 'Now shorten it');
  const two = await carry(user, c, []);
  assert.deepEqual(two.chats.map((x) => x.title), ['Marina tower', 'Service charges']);
  assert.deepEqual(two.added, [], 'nothing new was brought in, so nothing is written twice');
  assert.deepEqual(await carriedIds(c), [a, b].sort((x, y) => x - y));

  // Picking one that is already in does not duplicate it
  const three = await carry(user, c, [a]);
  assert.equal(three.chats.length, 2);
  assert.deepEqual(three.added, []);
});

test('a chat cannot be brought into itself', async () => {
  await reset();
  const id = await makeUser('Reem');
  const c = await makeConv(id, 'Board meeting');
  await say(c, 'user', 'hello');
  const { chats } = await carry({ id, name: 'Reem' }, c, [c]);
  assert.deepEqual(chats, []);
});

test('the record survives the chat it came from being deleted', async () => {
  await reset();
  const id = await makeUser('Reem');
  const user = { id, name: 'Reem' };
  const a = await makeConv(id, 'Marina tower');
  const c = await makeConv(id, 'Board meeting');
  await say(a, 'user', 'Seller wants Friday.');
  const msg = await say(c, 'user', 'Bring that in');
  const { added } = await carry(user, c, [a]);
  await noteCarried(msg, added);

  await db.prepare('DELETE FROM conversations WHERE id = ?').run(a);
  const row = await db.prepare('SELECT source_id, title FROM carried_chats WHERE message_id = ?').get(msg);
  assert.equal(row.source_id, null);
  assert.equal(row.title, 'Marina tower', 'what was brought in stays on the record');
  const { chats } = await carry(user, c, []); // and the turn still works without it
  assert.deepEqual(chats, []);
});

test('the picked list is read defensively', () => {
  assert.deepEqual(pickedIds('[3,1,3,"2"]'), [3, 1, 2]);
  assert.deepEqual(pickedIds('not json'), []);
  assert.deepEqual(pickedIds(undefined), []);
  assert.deepEqual(pickedIds([1, 2, 3, 4, 5, 6, 7, 8]), [1, 2, 3, 4, 5, 6], 'six at a time, however many are sent');
});
