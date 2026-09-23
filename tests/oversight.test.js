import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { userDocuments, userDocument, userConversation, userMemories, userChats, userChat, userChatFile } from '../server/admin.js';

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

// ---------- team chat ----------
// The point of these is the last one: master reading a team chat must leave it exactly
// as it was. Everything the ticks and the unread counts are drawn from lives in
// dm_members, so "silent" is a testable claim - those rows do not move.

const directChat = async (a, b) => {
  const { id } = await db.prepare(`INSERT INTO dm_chats (kind, direct_key, created_by) VALUES ('direct', ?, ?) RETURNING id`)
    .run(`${Math.min(a, b)}:${Math.max(a, b)}`, a);
  await db.prepare('INSERT INTO dm_members (chat_id, user_id) VALUES (?, ?), (?, ?)').run(id, a, id, b);
  return id;
};
const groupChat = async (name, members) => {
  const { id } = await db.prepare(`INSERT INTO dm_chats (kind, name, created_by) VALUES ('group', ?, ?) RETURNING id`).run(name, members[0]);
  for (const u of members) await db.prepare('INSERT INTO dm_members (chat_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
};
const say = async (chatId, userId, body) => {
  const { id } = await db.prepare('INSERT INTO dm_messages (chat_id, user_id, body) VALUES (?, ?, ?) RETURNING id').run(chatId, userId, body);
  return id;
};

test('userChats lists the chats a person is in, named as their app names them', async () => {
  const { sara, tom } = await fixture();
  const direct = await directChat(sara, tom);
  await say(direct, tom, 'are you in tomorrow?');
  const group = await groupChat('Leasing', [sara, tom]);
  await say(group, sara, 'the Marina keys are with me');

  const chats = await userChats(sara);
  assert.deepEqual(chats.map((c) => c.name).sort(), ['Leasing', 'Tom'], 'a one-to-one is named after the other person');
  assert.equal(chats.find((c) => c.id === group).people.length, 2);
  assert.equal(chats.find((c) => c.id === direct).preview, 'are you in tomorrow?');
});

test('userChats leaves out a chat nobody has typed in, and other people\'s chats', async () => {
  const { sara, tom, master } = await fixture();
  await directChat(sara, tom);                       // opened, never used
  const theirs = await directChat(tom, master);
  await say(theirs, tom, 'not sara\'s business');

  assert.deepEqual(await userChats(sara), []);
});

test('userChat returns the transcript with who said what', async () => {
  const { sara, tom } = await fixture();
  const chat = await directChat(sara, tom);
  await say(chat, tom, 'are you in tomorrow?');
  await say(chat, sara, 'from eleven');

  const out = await userChat(sara, chat);
  assert.equal(out.name, 'Tom');
  assert.deepEqual(out.messages.map((m) => [m.userName, m.body]), [['Tom', 'are you in tomorrow?'], ['Sara', 'from eleven']]);
});

test('userChat will not answer about a chat this person is not in', async () => {
  const { sara, tom, master } = await fixture();
  const theirs = await directChat(tom, master);
  await say(theirs, tom, 'not sara\'s business');

  assert.equal(await userChat(sara, theirs), null, 'asking under the wrong person must find nothing');
});

test('a message deleted for everyone stays deleted for the master too', async () => {
  const { sara, tom } = await fixture();
  const chat = await directChat(sara, tom);
  const id = await say(chat, tom, 'said in haste');
  await db.prepare(`UPDATE dm_messages SET deleted = true, body = '' WHERE id = ?`).run(id);

  const [m] = (await userChat(sara, chat)).messages;
  assert.equal(m.deleted, true);
  assert.equal(m.body, '', 'a bubble someone removed must not come back here');
});

test('reading a team chat leaves the ticks and unread counts exactly as they were', async () => {
  const { sara, tom } = await fixture();
  const chat = await directChat(sara, tom);
  const first = await say(chat, tom, 'are you in tomorrow?');
  await say(chat, tom, 'and the day after?');
  // Sara has read the first one only: one unread, one blue tick.
  await db.prepare('UPDATE dm_members SET last_read_id = ?, last_delivered_id = ? WHERE chat_id = ? AND user_id = ?').run(first, first, chat, sara);

  const pointers = () => db.prepare('SELECT user_id, last_read_id, last_delivered_id FROM dm_members WHERE chat_id = ? ORDER BY user_id').all(chat);
  const before = await pointers();

  await userChats(sara);
  await userChat(sara, chat);
  await userChatFile(sara, first);

  assert.deepEqual(await pointers(), before, 'master reading must not move a read or delivered pointer');
});
