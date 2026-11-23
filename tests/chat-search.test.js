import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { searchChats, readChatMessage, chatQuery, chatSearchKit } from '../server/chatSearch.js';

test.after(() => closeDb());
test.beforeEach(() => reset());

async function chat(userId, title, ...messages) {
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, title);
  const ids = [];
  for (const [role, content] of messages) {
    ids.push((await db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id').run(id, role, content)).id);
  }
  return { id, ids };
}

test('two-letter words like AC are searched, not dropped', () => {
  assert.equal(chatQuery('AC technician interview packet'), 'ac | technician | interview | packet');
  assert.equal(chatQuery('  !! '), '');
});

// The boss asked for "the AC technician interview packet"; the reply that holds it is
// titled "HVAC Technician Interview Pack". Any of the words is enough to find it.
test('finds a half-remembered piece of work by any of its words', async () => {
  const boss = await makeUser('Boss');
  const { ids } = await chat(boss, 'Act as a senior HVAC engineer',
    ['user', 'Make me an interview pack for technicians'],
    ['assistant', '# HVAC Technician Interview Pack\n\n## PART 1 — Technical Questions\nQ1. Walk me through your PM checklist.']);
  await chat(boss, 'Lunch', ['user', 'where shall we eat']);

  const found = await searchChats(boss, 'AC technician interview packet');
  assert.equal(found.length, 1);
  assert.equal(found[0].title, 'Act as a senior HVAC engineer');
  assert.ok(found[0].hits.some((h) => h.id === ids[1]));
});

test("never finds another person's chats", async () => {
  const boss = await makeUser('Boss');
  const rona = await makeUser('Rona');
  await chat(rona, 'Interview', ['assistant', 'Technician interview pack, Part 1']);
  assert.deepEqual(await searchChats(boss, 'technician interview'), []);
});

test('leaves out the chat the question is asked in', async () => {
  const boss = await makeUser('Boss');
  const here = await chat(boss, 'Now', ['user', 'find the interview packet']);
  const before = await chat(boss, 'Before', ['assistant', 'The interview packet, Parts 1 to 5']);
  const found = await searchChats(boss, 'interview packet', { exceptConversation: here.id });
  assert.deepEqual(found.map((c) => c.conversationId), [before.id]);
});

test('reads a message with the question it answered, and only from their own chats', async () => {
  const boss = await makeUser('Boss');
  const rona = await makeUser('Rona');
  const { ids } = await chat(boss, 'HVAC', ['user', 'Make the AC packet'], ['assistant', 'PART 1 — Technical Questions']);
  const out = await readChatMessage(boss, { id: ids[1] });
  assert.match(out, /From the chat "HVAC"/);
  assert.match(out, /They had asked: Make the AC packet/);
  assert.match(out, /PART 1 — Technical Questions/);
  await assert.rejects(() => readChatMessage(rona, { id: ids[1] }), /No message/);
});

test('a long message comes in parts', async () => {
  const boss = await makeUser('Boss');
  const long = Array.from({ length: 3000 }, (_, i) => `Line ${i} of the packet.`).join('\n');
  const { ids } = await chat(boss, 'Packet', ['assistant', long]);
  const first = await readChatMessage(boss, { id: ids[0] });
  assert.match(first, /Part 1 of \d+\. Read part 2 next/);
});

test('the kit answers with numbered messages to read', async () => {
  const boss = await makeUser('Boss');
  const { ids } = await chat(boss, 'HVAC', ['assistant', 'Technician interview pack']);
  const kit = chatSearchKit({ id: boss });
  const r = await kit.run({ id: 't1', name: 'search_chats', input: { query: 'interview packet' } });
  assert.ok(!r.is_error);
  assert.match(r.content, new RegExp(`#${ids[0]} Reem replied`));
  const none = await kit.run({ id: 't2', name: 'search_chats', input: { query: 'swimming pool' } });
  assert.match(none.content, /No earlier chat/);
});
