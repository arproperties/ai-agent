import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';
import { focusTurn, beat, timeOn, timeByCase, caseFiles, BEAT_CAP } from '../server/caseFocus.js';

test.after(() => closeDb());

// The case timer and the files beside the chat. What would go quietly wrong: a sleeping
// laptop booking hours, time landing on a case the chat is not about, another person's
// time or files showing, or a reference case's files in the primary case's panel.

const makeConv = async (userId) => (await db.prepare(`INSERT INTO conversations (user_id, title) VALUES (?, 'Chat') RETURNING id`).run(userId)).id;
const caseChat = async (user, text) => {
  const conv = await makeConv(user.id);
  await focusTurn(user, conv, { text });
  return conv;
};
// 10:00 Dubai on 26 Oct 2026, as seconds
const T = Math.floor(Date.UTC(2026, 9, 26, 6, 0, 0) / 1000);

test('a beat adds the time since the last one, and a long gap adds only the cap', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await caseChat(user, 'case 205791');
  assert.equal((await beat(user.id, conv, { start: true, now: T })).added, 0, 'starting counts nothing');
  assert.equal((await beat(user.id, conv, { now: T + 30 })).added, 30);
  assert.equal((await beat(user.id, conv, { now: T + 90 })).added, 60, 'a background tab beating once a minute still counts');
  assert.equal((await beat(user.id, conv, { now: T + 90 + 3600 })).added, BEAT_CAP, 'a laptop asleep for an hour adds only the cap');
  // Resume after a pause: the pause is not counted.
  const resumed = await beat(user.id, conv, { start: true, now: T + 9000 });
  assert.equal(resumed.added, 0);
  assert.equal(resumed.today, 30 + 60 + BEAT_CAP);
});

test('two chats about one case add up to one total', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const a = await caseChat(user, 'case 205791');
  const b = await caseChat(user, 'case 205791 again');
  await beat(user.id, a, { start: true, now: T }); await beat(user.id, a, { now: T + 30 });
  await beat(user.id, b, { start: true, now: T }); await beat(user.id, b, { now: T + 45 });
  const t = await timeOn(user.id, { number: '205791' }, '2026-10-26');
  assert.equal(t.total, 75);
  assert.equal(t.chats, 2);
  assert.equal(t.days.length, 7);
  assert.equal(t.days.at(-1).seconds, 75);
});

test('a beat just after midnight in Dubai lands on the new day, not the UTC one', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const conv = await caseChat(user, 'case 205791');
  const justAfter = Math.floor(Date.UTC(2026, 9, 26, 20, 0, 30) / 1000); // 00:00:30 on the 27th in Dubai, still the 26th in UTC
  await beat(user.id, conv, { start: true, now: justAfter - 30 });
  await beat(user.id, conv, { now: justAfter });
  const { d } = await db.prepare('SELECT day::text d FROM case_time WHERE seconds > 0').get();
  assert.equal(d, '2026-10-27');
});

test('no beat for a chat without a case, or for somebody else', async () => {
  await reset();
  const user = { id: await makeUser('Jeff'), name: 'Jeff' };
  const plain = await caseChat(user, 'hello');
  assert.equal(await beat(user.id, plain, { start: true }), null);
  const conv = await caseChat(user, 'case 205791');
  const other = await makeUser('Other');
  assert.equal(await beat(other, conv, { start: true }), null);
  assert.equal(await caseFiles(other, conv), null);
});

test("Time on cases is the person's own, by case", async () => {
  await reset();
  const jeff = { id: await makeUser('Jeff'), name: 'Jeff' };
  const other = { id: await makeUser('Other'), name: 'Other' };
  const a = await caseChat(jeff, 'case 205791');
  await beat(jeff.id, a, { start: true, now: T }); await beat(jeff.id, a, { now: T + 60 });
  const o = await caseChat(other, 'case 205791');
  await beat(other.id, o, { start: true, now: T }); await beat(other.id, o, { now: T + 100 });
  const rows = await timeByCase(jeff.id, '2026-10-01', '2026-10-31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 60);
  assert.equal(rows[0].total, 60);
  assert.equal((await timeByCase(jeff.id, '2026-09-01', '2026-09-30'))[0].seconds, 0, 'outside the range: nothing in range, still all time');
});

test("the panel shows the case folder's files and files named for the case, never a reference case's or anyone else's", async () => {
  await reset();
  const jeff = { id: await makeUser('Jeff'), name: 'Jeff' };
  const { id: folder } = await db.prepare(`INSERT INTO case_folders (user_id, name, case_number, case_key)
    VALUES (?, 'Case - E-205791', 'E-205791', 'e205791') RETURNING id`).run(jeff.id);
  const summary = await makeDoc(jeff.id, null, 'Case - E-205791 - Jeff vs Mitchell.pdf');
  const email = await makeDoc(jeff.id, null, 'Email from Ashlyn.pdf');
  await db.prepare('UPDATE documents SET case_folder_id = ? WHERE id IN (?, ?)').run(folder, summary, email);
  await db.prepare('UPDATE case_folders SET summary_doc_id = ? WHERE id = ?').run(summary, folder);
  const saved = await makeDoc(jeff.id, null, 'Notes on 205791.docx');
  await makeDoc(jeff.id, null, 'Case 198822 judgment.pdf'); // a reference case
  await makeDoc(jeff.id, null, 'Invoice 2057910.pdf'); // a longer number
  await makeDoc(await makeUser('Other'), null, 'Their copy of E-205791.pdf');

  const conv = await caseChat(jeff, 'case E-205791');
  await focusTurn(jeff, conv, { text: 'compare with case 198822' });
  const { files } = await caseFiles(jeff.id, conv);
  assert.deepEqual(files.map((f) => f.id).sort(), [summary, email, saved].sort());
  assert.equal(files[0].id, summary, 'the summary comes first');
  assert.equal(files[0].summary, true);
});
