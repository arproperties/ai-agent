import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { messengerHandlers as h } from '../server/messenger.js';
import { transcript, parse, summarise } from '../server/dmSummary.js';

test.after(() => closeDb());

// Summarising is the only thing on the Messages screen that sends a chat to Claude, so
// what these cover is the two edges of that: who is allowed to ask (the membership
// check, which has to fail before any call is made), and what is done with the answer
// that comes back, which is untrusted text from a model.

// Same express double as tests/messenger.test.js.
async function call(handler, { user, params = {}, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let failed = null;
  await Promise.resolve(handler({ user, params, query, body }, res, (e) => { failed = e; })).catch((e) => { failed = e; });
  if (failed) return { status: failed.status || 500, body: { error: failed.message } };
  return { status: res.statusCode, body: res.body };
}

const people = (...names) => Promise.all(names.map(async (name) => ({ id: await makeUser(name), name })));

test('the transcript names people, and leaves deleted messages out of it', async () => {
  const rows = [
    { kind: 'text', body: 'Can we sign the lease on Thursday?', name: 'Sara', created_at: 1757941500, deleted: false },
    { kind: 'text', body: 'wrong chat, sorry', name: 'Tom', created_at: 1757941560, deleted: true },
    { kind: 'text', body: 'Thursday works.', name: 'Tom', created_at: 1757941620, deleted: false },
  ];
  const out = transcript(rows);
  assert.match(out, /Sara: Can we sign the lease on Thursday\?/);
  assert.match(out, /Tom: Thursday works\./);
  assert.doesNotMatch(out, /wrong chat/, 'deleted for everyone has to mean the summary too');
});

test('the transcript says a photo or file is there without pretending to have read it', () => {
  const out = transcript([
    { kind: 'image', body: '', name: 'Sara', created_at: 1757941500, deleted: false },
    { kind: 'file', body: '', file_name: 'tenancy.pdf', name: 'Sara', created_at: 1757941560, deleted: false },
    { kind: 'system', body: 'Sara added Tom', name: null, created_at: 1757941600, deleted: false },
  ]);
  assert.match(out, /Sara: \[photo\]/);
  assert.match(out, /Sara: \[file: tenancy\.pdf\]/);
  assert.match(out, /\* Sara added Tom/);
});

test('somebody outside the chat cannot summarise it', async () => {
  await reset();
  const [sara, tom, eve] = await people('Sara', 'Tom', 'Eve');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'Thursday works for the lease' } });
  await call(h.send, { user: tom, params: { id: chat.id }, body: { body: 'Agreed, Thursday.' } });

  // 404 rather than 403, and before any call to the model: Eve learns nothing, not even
  // that this chat exists.
  const r = await call(h.summarise, { user: eve, params: { id: chat.id }, body: {} });
  assert.equal(r.status, 404);
});

test('a chat with nothing in it is refused, rather than asking the model about silence', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const chat = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  await call(h.send, { user: sara, params: { id: chat.id }, body: { body: 'hi' } });

  const r = await call(h.summarise, { user: sara, params: { id: chat.id }, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not enough/i);
});

test('system lines alone are not a conversation', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const group = (await call(h.create, { user: sara, body: { name: 'Leasing', members: [tom.id] } })).body;
  await assert.rejects(() => summarise(group.id, sara.id), /not enough/i);
});

test('what comes back from the model is read defensively', () => {
  const good = parse('Here you go:\n{"headline":"Lease timing","points":["Sara asked about Thursday"],'
    + '"conclusion":"They agreed to sign on Thursday.","actions":[{"who":"Tom","what":"Book the notary"}],"open":[]}');
  assert.equal(good.conclusion, 'They agreed to sign on Thursday.');
  assert.deepEqual(good.actions, [{ who: 'Tom', what: 'Book the notary' }]);
  assert.deepEqual(good.open, []);

  assert.equal(parse('I could not do that.'), null, 'prose with no JSON is not a summary');
  assert.equal(parse('{"points":["a"]}'), null, 'a summary with neither headline nor conclusion is no use');

  // A model that answers with the wrong shapes must not put them into the page.
  const messy = parse('{"headline":"X","conclusion":"Y","points":["ok", 42, "  ", null],"actions":["nope",{"what":"do it"}],"open":"not a list"}');
  assert.deepEqual(messy.points, ['ok']);
  assert.deepEqual(messy.actions, [{ who: '', what: 'do it' }]);
  assert.deepEqual(messy.open, []);
});

test('a long-winded model answer is cut down rather than trusted', () => {
  const long = parse(JSON.stringify({
    headline: 'X',
    conclusion: 'c'.repeat(5000),
    points: Array.from({ length: 30 }, (_, i) => `point ${i}`),
    actions: [], open: [],
  }));
  assert.equal(long.conclusion.length, 800);
  assert.equal(long.points.length, 8);
});

test('the summary covers only the chat it was asked about', async () => {
  await reset();
  const [sara, tom] = await people('Sara', 'Tom');
  const a = (await call(h.create, { user: sara, body: { userId: tom.id } })).body;
  const b = (await call(h.create, { user: sara, body: { name: 'Leasing', members: [tom.id] } })).body;
  await call(h.send, { user: sara, params: { id: a.id }, body: { body: 'PRIVATE ONE TO ONE' } });
  await call(h.send, { user: tom, params: { id: a.id }, body: { body: 'noted' } });
  await call(h.send, { user: sara, params: { id: b.id }, body: { body: 'group talk' } });

  const rows = await db.prepare(`SELECT m.kind, m.body, m.deleted, m.created_at, m.file_name, u.name
    FROM dm_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.id`).all(b.id);
  assert.doesNotMatch(transcript(rows), /PRIVATE ONE TO ONE/);
});
