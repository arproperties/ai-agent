import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { userDocuments, userDocument, userConversation, userMemories } from '../server/admin.js';

test.after(() => closeDb());

// Master browses a person's workspace through these. requireMaster on the router is
// what makes them master-only; the user_id scoping here is so that asking for the
// wrong person's row fails cleanly rather than quietly answering about someone else.

async function fixture() {
  await reset();
  const master = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const sara = await makeUser('Sara');
  const tom = await makeUser('Tom');
  const hr = await makeAgent(master, 'HR');
  return { master, sara, tom, hr };
}

const conversation = async (userId, title) => {
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, title);
  return id;
};
const message = (convId, role, content) =>
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, role, content);

test('userDocuments lists only that person\'s files', async () => {
  const { sara, tom, hr } = await fixture();
  await makeDoc(sara, hr, 'sara-payslip.pdf');
  await makeDoc(sara, null, 'sara-passport.pdf');
  await makeDoc(tom, hr, 'tom-contract.pdf');

  const names = (await userDocuments(sara)).map((d) => d.name).sort();
  assert.deepEqual(names, ['sara-passport.pdf', 'sara-payslip.pdf']);
});

test('userDocument returns one file in full', async () => {
  const { sara, hr } = await fixture();
  const id = await makeDoc(sara, hr, 'sara-payslip.pdf');
  await db.prepare("UPDATE documents SET summary = 'March payslip', folder = 'HR & Employees' WHERE id = ?").run(id);

  const doc = await userDocument(sara, id);
  assert.equal(doc.name, 'sara-payslip.pdf');
  assert.equal(doc.summary, 'March payslip');
  assert.equal(doc.folder, 'HR & Employees');
});

test('userDocument will not answer about the wrong person', async () => {
  const { sara, tom, hr } = await fixture();
  const id = await makeDoc(tom, hr, 'tom-contract.pdf');
  assert.equal(await userDocument(sara, id), undefined, 'asking under the wrong user must find nothing');
});

test('userConversation returns the transcript', async () => {
  const { sara } = await fixture();
  const conv = await conversation(sara, 'Rent increase question');
  await message(conv, 'user', 'My landlord wants 12% more, is that allowed?');
  await message(conv, 'assistant', 'RERA caps increases by the rental index.');

  const out = await userConversation(sara, conv);
  assert.equal(out.title, 'Rent increase question');
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(out.messages[0].content, /12%/);
});

test('userConversation will not answer about the wrong person', async () => {
  const { sara, tom } = await fixture();
  const conv = await conversation(tom, 'Tom private chat');
  await message(conv, 'user', 'something of toms');

  assert.equal(await userConversation(sara, conv), null, "Tom's chat must not come back under Sara");
});

test('userMemories lists only that person\'s memory', async () => {
  const { sara, tom } = await fixture();
  await db.prepare('INSERT INTO memories (user_id, text) VALUES (?, ?)').run(sara, 'User prefers short answers');
  await db.prepare('INSERT INTO memories (user_id, text) VALUES (?, ?)').run(tom, 'User is based in Sharjah');

  const texts = (await userMemories(sara)).map((m) => m.text);
  assert.deepEqual(texts, ['User prefers short answers']);
});

test('a person with an empty workspace reads as empty, not as an error', async () => {
  const { sara } = await fixture();
  assert.deepEqual(await userDocuments(sara), []);
  assert.deepEqual(await userMemories(sara), []);
});
