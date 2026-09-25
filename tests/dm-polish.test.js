import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { messengerHandlers as h } from '../server/messenger.js';
import { polish, clean } from '../server/dmPolish.js';

test.after(() => closeDb());

// "Help me say this" is the second thing on the Messages screen that reaches Claude, so
// these cover the same two edges as the summary tests — who may ask, and what is done
// with the answer — plus the one promise that is particular to this feature: it hands
// the text back and posts nothing.

// Same express double as tests/messenger.test.js.
async function call(handler, { user, params = {}, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let failed = null;
  await Promise.resolve(handler({ user, params, query, body }, res, (e) => { failed = e; })).catch((e) => { failed = e; });
  if (failed) return { status: failed.status || 500, body: { error: failed.message } };
  return { status: res.statusCode, body: res.body };
}

const people = (...names) => Promise.all(names.map(async (name) => ({ id: await makeUser(name), name })));

async function chatWith(sara, tom, lines = []) {
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  for (const [who, body] of lines) await call(h.send, { user: who, params: { id: chat.id }, body: { body } });
  return chat;
}

test('somebody outside the chat cannot have it read to tidy their notes', async () => {
  await reset();
  const [sara, tom, eve] = await people('Sara', 'Tom', 'Eve');
  const chat = await chatWith(sara, tom, [[sara, 'Thursday works for the lease'], [tom, 'Agreed.']]);

  // 404 rather than 403, and before any call to the model: Eve learns nothing, not even
  // that this chat exists — and cannot use it as context for her own writing.
  const r = await call(h.polish, { user: eve, params: { id: chat.id }, body: { text: 'about the lease' } });
  assert.equal(r.status, 404);
});

test('an empty box is refused rather than asking the model to invent a message', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = await chatWith(sara, tom);

  for (const text of ['', '   ', 'k']) {
    const r = await call(h.polish, { user: sara, params: { id: chat.id }, body: { text } });
    assert.equal(r.status, 400, `"${text}" should be refused`);
  }
});

test('the notes are tidied and handed back, and nothing is posted to the chat', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = await chatWith(sara, tom, [[tom, 'What do we need from the dev team on Friday?']]);

  let seen = null;
  const model = async (prompt) => { seen = prompt; return 'Two things for Friday: a pricing tool for Subha, and a labour request workflow for Tajdar.'; };
  const out = await polish(chat.id, sara.id, 'pricing tool subha, labour workflow tajdar, need by friday', { model });

  assert.match(out.text, /pricing tool/i);
  // The notes go up, and so do the messages already on her screen — as context, labelled.
  assert.match(seen, /ROUGH NOTES/);
  assert.match(seen, /Tom: What do we need/);

  // The chat itself is untouched: the tidied text exists only in her typing box until
  // she presses send.
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM dm_messages WHERE chat_id = ?').get(chat.id);
  assert.equal(n, 1, 'tidying up must not post anything');
});

test('a new chat with nothing in it still works — there is just no context', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = await chatWith(sara, tom);

  let seen = null;
  const model = async (prompt) => { seen = prompt; return 'Morning — could you send me the tenancy contract today?'; };
  const out = await polish(chat.id, sara.id, 'need tenancy contract today', { model });

  assert.doesNotMatch(seen, /RECENT MESSAGES/);
  assert.match(out.text, /tenancy contract/);
});

test('the model announcing itself, or fencing the answer, is not part of the message', () => {
  assert.equal(clean('Here is a tidied version:\n\nSend the contract today.'), 'Send the contract today.');
  assert.equal(clean('"Send the contract today."'), 'Send the contract today.');
  assert.equal(clean('```\nSend the contract today.\n```'), 'Send the contract today.');
  // A quote inside the message is the person's own punctuation, and stays.
  assert.equal(clean('He said "no" yesterday.'), 'He said "no" yesterday.');
});

test('a message that is already long is left alone rather than rewritten', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = await chatWith(sara, tom);
  const r = await call(h.polish, { user: sara, params: { id: chat.id }, body: { text: 'x'.repeat(2500) } });
  assert.equal(r.status, 400);
});
