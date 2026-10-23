import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { editReply } from '../server/chat.js';

test.beforeEach(reset);
test.after(() => closeDb());

const setup = async () => {
  const me = await makeUser('Me');
  const other = await makeUser('Other');
  const { id: conv } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(me, 'Mail');
  const add = async (role, content) => (await db.prepare('INSERT INTO messages (conversation_id, role, content, files) VALUES (?, ?, ?, ?) RETURNING id')
    .run(conv, role, content, '[]')).id;
  return { me, other, reply: await add('assistant', 'One. Two.'), question: await add('user', 'Check my mail') };
};
const content = async (id) => (await db.prepare('SELECT content FROM messages WHERE id = ?').get(id)).content;

test('the owner can save a shorter reply', async () => {
  const { me, reply } = await setup();
  assert.equal(await editReply(me, reply, 'One.'), true);
  assert.equal(await content(reply), 'One.');
});

test("not someone else's, not the user's own words, and never emptied", async () => {
  const { me, other, reply, question } = await setup();
  assert.equal(await editReply(other, reply, 'One.'), false);
  assert.equal(await editReply(me, question, 'Check'), false);
  assert.equal(await editReply(me, reply, '   '), false);
  assert.equal(await content(reply), 'One. Two.');
  assert.equal(await content(question), 'Check my mail');
});
