import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { saveQuestion, deleteMessage } from '../server/chat.js';

test.after(() => closeDb());

async function conversation() {
  await reset();
  const userId = await makeUser('Sara');
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, 'Case');
  return id;
}
const rows = (convId) => db.prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);
const answer = (convId, text) => db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`).run(convId, text);

test('a question asked again before it was answered is kept once', async () => {
  const convId = await conversation();
  const first = await saveQuestion(convId, 'Can you open it and summarise it?', []);
  const again = await saveQuestion(convId, 'Can you open it and summarise it?', []);

  assert.equal(first.repeat, false);
  assert.equal(again.repeat, true);
  assert.equal(again.id, first.id);
  assert.equal((await rows(convId)).length, 1);
});

test('the same words after a reply are a new message', async () => {
  const convId = await conversation();
  const first = await saveQuestion(convId, 'Yes', []);
  await answer(convId, 'Done. Shall I do the next one?');
  const second = await saveQuestion(convId, 'Yes', []);

  assert.equal(second.repeat, false);
  assert.notEqual(second.id, first.id);
  assert.equal((await rows(convId)).length, 3);
});

test('different words, or anything with a file, are never folded together', async () => {
  const convId = await conversation();
  await saveQuestion(convId, 'Read this', []);
  assert.equal((await saveQuestion(convId, 'Read that', [])).repeat, false);
  assert.equal((await saveQuestion(convId, 'Read that', [{ name: 'a.pdf', kind: 'doc', docId: 1 }])).repeat, false);
  assert.equal((await saveQuestion(convId, 'Read that', [])).repeat, false, 'the one before it carried a file');
  assert.equal((await rows(convId)).length, 4);
});

test('an unanswered question from long ago is not the same question', async () => {
  const convId = await conversation();
  const first = await saveQuestion(convId, 'Any news?', []);
  await db.prepare('UPDATE messages SET created_at = created_at - 3600 WHERE id = ?').run(first.id);

  assert.equal((await saveQuestion(convId, 'Any news?', [])).repeat, false);
});

test('a message is deleted by the person whose chat it is, and by nobody else', async () => {
  const convId = await conversation();
  const { user_id: owner } = await db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(convId);
  const eve = await makeUser('Eve');
  const q = await saveQuestion(convId, 'Voice note said wrong', []);
  await answer(convId, 'A reply');

  assert.equal(await deleteMessage(eve, q.id), false);
  assert.equal((await rows(convId)).length, 2);
  assert.equal(await deleteMessage(owner, q.id), true);
  assert.deepEqual((await rows(convId)).map((m) => m.role), ['assistant']);
  assert.equal(await deleteMessage(owner, q.id), false, 'already gone');
});
