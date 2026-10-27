import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';
import { checked, scanCase, deadlinesFor, sourcesOf } from '../server/caseDeadlines.js';

test.after(() => closeDb());

// Legal dates read from a case's own files and emails. What would go quietly wrong: a date the
// papers do not say, another person's emails being read, a paid read on every look, or a failed
// read wiping the dates that were there.

const primary = { number: 'E-205791', key: 'e205791' };
const withText = async (userId, name, text) => {
  const id = await makeDoc(userId, null, name);
  await db.prepare('INSERT INTO document_texts (document_id, text) VALUES (?, ?)').run(id, text);
  return { id, name, title: name };
};
const folder = async (userId) => (await db.prepare(`INSERT INTO case_folders (user_id, name, case_number, case_key)
  VALUES (?, 'Case - E-205791', 'E-205791', 'e205791') RETURNING id`).run(userId)).id;
const email = (folderId, body, at = 1761400000) => db.prepare(`INSERT INTO case_emails (folder_id, mail_key, at, sender, subject, body)
  VALUES (?, ?, ?, 'Ashlyn', 'Docs', ?)`).run(folderId, `k${Math.random()}`, at, body);
const settle = () => new Promise((r) => setTimeout(r, 50));

test('a date is kept only when its words are in the source it names', () => {
  const sources = [{ ref: 'f1', name: 'Order.pdf', docId: 1, text: 'The   Court ORDERS that the hearing is set for “2 March 2027” at 9 a.m.' }];
  const out = checked([
    { due: '2027-03-02', what: 'Hearing', source: 'f1', quote: 'the hearing is set for "2 March 2027"' }, // spacing and quote marks differ: kept
    { due: '2027-03-02', what: 'Hearing', source: 'f1', quote: 'the hearing is set for "2 March 2027"' }, // the same again: once
    { due: '2027-04-01', what: 'Answer due', source: 'f1', quote: 'answer is due on 1 April' }, // not in the file: dropped
    { due: '2027-02-30', what: 'Bad day', source: 'f1', quote: 'the hearing is set' }, // no such day: dropped
    { due: '2027-03-02', what: 'Hearing', source: 'f9', quote: 'the hearing is set' }, // no such source: dropped
  ], sources);
  assert.equal(out.length, 1);
  assert.equal(out[0].due, '2027-03-02');
  assert.equal(out[0].source_name, 'Order.pdf');
  assert.equal(out[0].doc_id, 1);
});

test("a case is read from its own files and its own folder's emails only", async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const other = await makeUser('Other');
  const file = await withText(jeff, 'Case - E-205791.pdf', 'Repose runs out 02/03/2027.');
  await email(await folder(jeff), 'Please send the survey by 27 October 2026.');
  await email(await folder(other), 'Their own private email about E-205791.');
  const sources = await sourcesOf(jeff, primary, [file]);
  assert.deepEqual(sources.map((s) => s.ref[0]), ['f', 'e']);
  assert.ok(!sources.some((s) => s.text.includes('private')));
});

test('a read replaces the dates; a failed read keeps the old ones', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const file = await withText(jeff, 'Case - E-205791.pdf', 'On the 2017 site plan the statute of repose runs out 02/03/2027.');
  const ask = async (sources) => [{ due: '2027-03-02', what: 'Statute of repose runs out', source: sources[0].ref, quote: 'the statute of repose runs out 02/03/2027' }];
  await scanCase(jeff, primary, [file], { ask });
  let { deadlines } = await deadlinesFor(jeff, primary, [file], { scan: async () => {} });
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].due, '2027-03-02');
  assert.equal(deadlines[0].doc_id, file.id);

  await scanCase(jeff, primary, [file], { ask: async () => { throw new Error('overloaded'); } });
  const after = await deadlinesFor(jeff, primary, [file], { scan: async () => {} });
  assert.equal(after.deadlines.length, 1, 'the dates found before are still shown');
  assert.match(after.error, /Check again/);
});

test('a case is read again only when something new has come in, or when asked', async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const file = await withText(jeff, 'Case - E-205791.pdf', 'Hearing on 2 March 2027.');
  await scanCase(jeff, primary, [file], { ask: async () => [] });
  let reads = 0;
  const scan = () => new Promise((r) => setTimeout(() => { reads += 1; r(); }, 20)); // a read takes a moment
  await deadlinesFor(jeff, primary, [file], { scan });
  await settle();
  assert.equal(reads, 0, 'nothing new: not read again');

  const more = await withText(jeff, 'Notes on 205791.docx', 'Mediation 17 Aug 2026.');
  const r = await deadlinesFor(jeff, primary, [file, more], { scan });
  assert.equal(r.scanning, true);
  await settle();
  assert.equal(reads, 1, 'a new file: read again');

  await deadlinesFor(jeff, primary, [file], { force: true, scan });
  await settle();
  assert.equal(reads, 2, 'Check again: read again');
});

test("another person's dates are never shown", async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const other = await makeUser('Other');
  const theirs = await withText(other, 'Case - E-205791.pdf', 'Hearing on 2 March 2027.');
  await scanCase(other, primary, [theirs], { ask: async (s) => [{ due: '2027-03-02', what: 'Hearing', source: s[0].ref, quote: 'Hearing on 2 March 2027' }] });
  const mine = await deadlinesFor(jeff, primary, [], { scan: async () => {} });
  assert.equal(mine.deadlines.length, 0);
});
