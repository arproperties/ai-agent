import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { focusTurn, focusOf } from '../server/caseFocus.js';
import { recapOf } from '../server/chatRecap.js';

test.after(() => closeDb());

// The case a chat is about is written once and never changed; whatever else is named is a
// reference. What would go quietly wrong: a later message moving the case, another
// person's case folder being matched, or Legal cases reaching someone without Legal.

const makeConv = async (userId, title = 'Chat') => (await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, title)).id;
const say = (convId, content, files = []) =>
  db.prepare(`INSERT INTO messages (conversation_id, role, content, files) VALUES (?, 'user', ?, ?)`).run(convId, content, JSON.stringify(files));
const folder = async (userId, number, a, b) => (await db.prepare(`INSERT INTO case_folders (user_id, name, case_number, case_key, party_a, party_b)
  VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).run(userId, `Case - ${number}`, number, number.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''), a, b)).id;

test('the first message sets the case; a later one adds a reference and leaves it alone', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await makeConv(user.id);
  const first = await focusTurn(user, conv, { fileNames: ['Case - E-205791 - JEFF AKHTAR ET AL vs JEREMY MITCHELL ET AL.pdf'] });
  assert.equal(first.changed, true);
  assert.equal(first.primary.number, 'E-205791');
  assert.equal(first.primary.partyA, 'JEFF AKHTAR ET AL');
  await say(conv, '', [{ name: 'Case - E-205791 - JEFF AKHTAR ET AL vs JEREMY MITCHELL ET AL.pdf' }]);

  const later = await focusTurn(user, conv, { text: 'how did case 198822 end?' });
  assert.equal(later.primary.number, 'E-205791');
  assert.deepEqual(later.references.map((r) => r.number), ['198822']);
  await say(conv, 'how did case 198822 end?');

  // Only another case, named on its own: still a reference, never the new primary.
  const only = await focusTurn(user, conv, { text: '198822' });
  assert.equal(only.primary.number, 'E-205791');
  assert.equal(only.changed, false, 'a reference already kept is not added twice');
  assert.deepEqual((await focusOf(user.id, conv)).references.map((r) => r.number), ['198822']);
});

test('"hi" first and the case second still sets it, and an old chat gets its first case', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await makeConv(user.id);
  await say(conv, 'hi');
  assert.equal((await focusTurn(user, conv, { text: 'hello again' })).primary, null);
  assert.equal((await focusTurn(user, conv, { text: 'check case 205791' })).primary.number, '205791');

  // A chat from before this existed: its first case wins, not the one in the newest message.
  const old = await makeConv(user.id);
  await say(old, 'case 111222 hearing');
  await say(old, 'and case 333444?');
  const f = await focusTurn(user, old, { text: 'what next' });
  assert.equal(f.primary.number, '111222');
  assert.deepEqual(f.references.map((r) => r.number), ['333444']);
});

test('a message naming two cases settles nothing', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await makeConv(user.id);
  assert.equal((await focusTurn(user, conv, { text: 'compare case 205791 with case 198822' })).primary, null);
  await say(conv, 'compare case 205791 with case 198822');
  const next = await focusTurn(user, conv, { text: 'start with case 198822' });
  assert.equal(next.primary.number, '198822');
  assert.deepEqual(next.references.map((r) => r.number), ['205791']);
});

test("only the person's own case folders are matched", async () => {
  await reset();
  const jeff = { id: await makeUser('Jeff'), name: 'Jeff' };
  const other = await makeUser('Other');
  await folder(other, 'Soutex E - 205791', 'Theirs A', 'Theirs B');
  const conv = await makeConv(jeff.id);
  // Without a folder of their own, a bare number with no case word is not a case at all...
  assert.equal((await focusTurn(jeff, conv, { text: 'news on 205791?' })).primary, null);
  // ...and with one, it is their typed number, with nothing taken from the other person's folder.
  const f = await focusTurn(jeff, conv, { text: 'news on case 205791?' });
  assert.equal(f.primary.number, '205791');
  assert.equal(f.primary.partyA, undefined);

  const mine = await folder(jeff.id, 'Soutex E - 205791', 'Jeff', 'Mitchell');
  const conv2 = await makeConv(jeff.id);
  const g = await focusTurn(jeff, conv2, { text: 'news on 205791?' });
  assert.equal(g.primary.number, 'Soutex E - 205791');
  assert.equal(g.primary.folderId, mine);
  assert.equal(g.primary.partyB, 'Mitchell');
});

test('legal cases are only matched for someone with Legal', async () => {
  await reset();
  const user = { id: await makeUser('Staff'), name: 'Staff' };
  await db.prepare(`INSERT INTO legal_cases (number, type_name, title, stage, status, party_name)
    VALUES ('LC-2026-0007', 'Rent', 'Unpaid rent Marina 1204', 'notice', 'open', 'Tenant X')`).run();
  const without = await focusTurn(user, await makeConv(user.id), { text: 'LC-2026-0007 status?' });
  assert.equal(without.primary?.legalCaseId, undefined);
  const withLegal = await focusTurn(user, await makeConv(user.id), { text: 'LC-2026-0007 status?', modules: ['legal'] });
  assert.equal(withLegal.primary.title, 'Unpaid rent Marina 1204');
});

test("someone else's chat is not touched", async () => {
  await reset();
  const owner = await makeUser('Owner');
  const conv = await makeConv(owner);
  const intruder = { id: await makeUser('Intruder'), name: 'Intruder' };
  assert.equal(await focusTurn(intruder, conv, { text: 'case 205791' }), null);
  assert.equal(await focusOf(intruder.id, conv), undefined);
  assert.equal((await db.prepare('SELECT primary_case FROM conversations WHERE id = ?').get(conv)).primary_case, null);
});

test('a carried chat says which case it was about', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await makeConv(user.id, 'Old case');
  await say(conv, 'case 198822 settled');
  await focusTurn(user, conv, { text: '' });
  assert.equal((await recapOf(user, conv)).case.number, '198822');
});
