import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { draftFor, quietChats, approve, dismiss, briefOf } from '../server/caseBrief.js';
import { caseFiles } from '../server/caseFocus.js';
import { primaryCaseBlock } from '../server/primaryCase.js';

test.after(() => closeDb());

// The brief is handed to every later chat on a case as fact, so it must only ever change
// when the person approves. What would go quietly wrong: a suggestion written straight into
// the brief, a chat paid for twice, one person's suggestion approved by another, or a file
// sent in a case chat missing from the case.

const OLD = 1000; // long ago, so the chat has gone quiet
const caseChat = async (userId, number, updatedAt = OLD) => (await db.prepare(`INSERT INTO conversations (user_id, title, primary_case, updated_at)
  VALUES (?, ?, ?::jsonb, ?) RETURNING id`).run(userId, `About ${number}`, JSON.stringify({ number, key: number.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') }), updatedAt)).id;
const say = (convId, role, content) => db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, role, content);
const caseFocusFor = (userId) => db.prepare(`INSERT INTO module_access (user_id, module) VALUES (?, 'case_focus')`).run(userId);

test('a quiet case chat gives a suggestion; the brief changes only on approve', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const conv = await caseChat(jeff, 'E-205791');
  await say(conv, 'user', 'The hearing is on 5 November.');
  const asked = [];
  const summarise = async (number, brief, text) => { asked.push({ number, brief, text }); return '**Deadlines**\n- Hearing 5 November'; };

  const [c] = await db.prepare('SELECT id, user_id, primary_case, brief_upto FROM conversations WHERE id = ?').all(conv);
  const id = await draftFor(c, { userName: 'Jeff', summarise });
  assert.ok(id);
  assert.match(asked[0].text, /5 November/);
  assert.equal((await briefOf(jeff, 'e205791')).brief, null, 'nothing in the brief before approval');

  // Read once: nothing new, no second paid call.
  const [again] = await db.prepare('SELECT id, user_id, primary_case, brief_upto FROM conversations WHERE id = ?').all(conv);
  assert.equal(await draftFor(again, { summarise }), null);
  assert.equal(asked.length, 1);

  assert.equal(await approve(await makeUser('Sara'), 'e205791', id), null, "another person cannot approve Jeff's");
  const out = await approve(jeff, 'e205791', id, '**Deadlines**\n- Hearing 5 Nov (edited)');
  assert.equal(out.brief.body, '**Deadlines**\n- Hearing 5 Nov (edited)');
  assert.equal(out.suggestion, null);
});

test('a newer chat builds on the waiting suggestion and replaces it; NO CHANGE leaves none', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const a = await caseChat(jeff, 'E-205791');
  const b = await caseChat(jeff, 'E-205791');
  await say(a, 'user', 'Client is Ahmed.');
  await say(b, 'user', 'Filed the reply.');
  const read = async (id) => (await db.prepare('SELECT id, user_id, primary_case, brief_upto FROM conversations WHERE id = ?').all(id))[0];
  await draftFor(await read(a), { summarise: async () => 'first' });
  let seen = '';
  await draftFor(await read(b), { summarise: async (n, brief) => { seen = brief; return 'second'; } });
  assert.equal(seen, 'first');
  const { suggestion } = await briefOf(jeff, 'e205791');
  assert.equal(suggestion.body, 'second');
  assert.equal((await db.prepare(`SELECT count(*)::int n FROM case_brief_suggestions WHERE status = 'pending'`).get()).n, 1);

  assert.ok(await dismiss(jeff, 'e205791', suggestion.id));
  await say(a, 'user', 'thanks');
  assert.equal(await draftFor(await read(a), { summarise: async () => 'NO CHANGE' }), null);
  assert.equal((await briefOf(jeff, 'e205791')).suggestion, null);
});

test('only quiet chats with something unread, of people with Primary case, are read', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const noModule = await makeUser('Omar');
  await caseFocusFor(jeff);
  const quiet = await caseChat(jeff, '111222');
  const busy = await caseChat(jeff, '333444', 2_000_000_000); // still going
  const other = await caseChat(noModule, '555666');
  for (const c of [quiet, busy, other]) await say(c, 'user', 'hello');
  await caseChat(jeff, '777888'); // nothing in it
  assert.deepEqual((await quietChats(1_900_000_000)).map((c) => c.id), [quiet]);
});

test('files attached in any chat about the case are its files', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const agent = await makeAgent(jeff, 'Soutex');
  const a = await caseChat(jeff, 'E-205791');
  const b = await caseChat(jeff, 'E-205791');
  const other = await caseChat(jeff, '198822');
  const doc = (conv, name) => db.prepare(`INSERT INTO documents (user_id, agent_id, conversation_id, name, title, status) VALUES (?, ?, ?, ?, ?, 'ready')`)
    .run(jeff, agent, conv, name, name);
  await doc(a, 'scan_001.pdf');
  await doc(b, 'reply.docx');
  await doc(other, 'not-this-case.pdf');
  const names = (await caseFiles(jeff, b)).files.map((f) => f.name).sort();
  assert.deepEqual(names, ['reply.docx', 'scan_001.pdf']);
});

test('the approved brief goes into the case block', () => {
  const block = primaryCaseBlock('Jeff', { number: 'E-205791' }, [], '- Hearing 5 Nov');
  assert.match(block, /<case_brief>[\s\S]*Hearing 5 Nov[\s\S]*<\/case_brief>/);
  assert.doesNotMatch(primaryCaseBlock('Jeff', { number: 'E-205791' }), /case_brief/);
});
