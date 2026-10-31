import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { addMemory, sameNames, memoryChain } from '../server/knowledge.js';
import { scanMemories, reviewList, resolveReview } from '../server/memoryReview.js';

test.after(() => closeDb());

const none = async () => [];
const current = async (id) => (await db.prepare('SELECT replaced_at, replaced_by, pinned FROM memories WHERE id = ?').get(id));

// ---------- step 1: a correction reaches the old fact about the same person ----------

test('a correction is judged against every memory naming the same person', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const old = await addMemory(boss, 'Mohammed Shakir Ali Khan must send daily email reports to Eng. Bayat', { judge: none });
  let seen = [];
  const now = await addMemory(boss, 'Mohammed Shakir Ali Khan was only a candidate, not on the JVC School team', {
    judge: async (_t, rows) => { seen = rows.map((r) => r.id); return [old]; },
  });
  assert.ok(seen.includes(old), 'the old Shakir fact was put in front of the judge');
  const row = await current(old);
  assert.ok(row.replaced_at);
  assert.equal(row.replaced_by, now);
});

test('a name in very many memories is a topic, not a person, and is not matched on', async () => {
  await reset();
  const boss = await makeUser('Boss');
  for (let i = 0; i < 30; i++) await addMemory(boss, `Projectx item ${i} detail number ${i * 7}`, { judge: none });
  const arz = await addMemory(boss, 'Arzhel Narciso has QA/QC process skills', { judge: none });
  const ids = await sameNames(boss, 0, 'Arzhel is QA/QC at Projectx');
  assert.deepEqual(ids, [arz], 'Arzhel matches; Projectx, in 30 memories, does not');
});

test('same-name matching never reaches another person', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const tom = await makeUser('Tom');
  await addMemory(tom, 'Shakir is the site supervisor', { judge: none });
  assert.deepEqual(await sameNames(boss, 0, 'Shakir was a candidate'), []);
});

// ---------- step 2: "Please check" ----------

test('a scan lists what the check flags, and nothing is changed by it', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const a = await addMemory(boss, 'User name: Ayla', { judge: none });
  const b = await addMemory(boss, 'Taj Khan is the Site Engineer', { judge: none });
  const added = await scanMemories(boss, { check: async () => [{ id: a, reason: 'Ayla is a building, not your name' }, { id: 999999, reason: 'not hers' }] });
  assert.equal(added, 1, 'an id that is not one of her memories is ignored');
  const list = await reviewList(boss);
  assert.deepEqual(list.map((r) => [r.memory_id, r.reason]), [[a, 'Ayla is a building, not your name']]);
  assert.equal((await current(a)).replaced_at, null, 'flagging changes nothing');
  assert.equal((await current(b)).replaced_at, null);

  // Scanning again does not add the same one twice.
  await scanMemories(boss, { check: async () => [{ id: a, reason: 'again' }] });
  assert.equal((await reviewList(boss)).length, 1);
});

test('pinned facts are never flagged; they are what the check trusts', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const p = await addMemory(boss, 'Arzhel is QA/QC', { judge: none });
  await db.prepare('UPDATE memories SET pinned = true WHERE id = ?').run(p);
  const q = await addMemory(boss, 'We still need to hire a QA/QC engineer', { judge: none });
  let given;
  await scanMemories(boss, { check: async (mems, pinned) => { given = { mems: mems.map((m) => m.id), pinned: pinned.map((m) => m.id) }; return [{ id: p, reason: 'x' }]; } });
  assert.deepEqual(given, { mems: [q], pinned: [p] });
  assert.equal((await reviewList(boss)).length, 0);
});

test('keep: settled, and not flagged again', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const a = await addMemory(boss, 'Rona relays to Al Adeeb', { judge: none });
  await scanMemories(boss, { check: async () => [{ id: a, reason: 'maybe old' }] });
  const [item] = await reviewList(boss);
  await resolveReview(boss, item.id, { action: 'keep' });
  assert.equal((await reviewList(boss)).length, 0);
  let asked = [];
  await scanMemories(boss, { check: async (mems) => { asked = mems.map((m) => m.id); return [{ id: a, reason: 'again' }]; } });
  assert.deepEqual(asked, [], 'a kept memory is not even asked about');
  assert.equal((await current(a)).replaced_at, null);
});

test('fix: the corrected text replaces it, keeps its pin, and the old one stays in History', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const a = await addMemory(boss, 'Shakir is the site supervisor', { judge: none });
  await db.prepare('UPDATE memories SET pinned = true WHERE id = ?').run(a);
  await db.prepare('INSERT INTO memory_reviews (user_id, memory_id, reason) VALUES (?, ?, ?)').run(boss, a, 'he was a candidate');
  const [item] = await reviewList(boss);
  const { id } = await resolveReview(boss, item.id, { action: 'fix', text: 'Taj Khan is the site engineer; Shakir was only a candidate' });
  assert.equal((await current(a)).replaced_by, id);
  assert.equal((await current(id)).pinned, true);
  assert.deepEqual((await memoryChain(boss, id)).map((m) => m.id), [a, id]);
  await assert.rejects(resolveReview(boss, item.id, { action: 'fix', text: 'again' }).then((r) => { if (!r) throw new Error('settled'); }));
});

test('remove: it stops being used; another person cannot act on her list', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const tom = await makeUser('Tom');
  const a = await addMemory(boss, 'User name: Ayla', { judge: none });
  await scanMemories(boss, { check: async () => [{ id: a, reason: 'wrong name' }] });
  const [item] = await reviewList(boss);
  assert.equal(await resolveReview(tom, item.id, { action: 'remove' }), null, "Tom can't touch her list");
  assert.equal((await current(a)).replaced_at, null);
  await resolveReview(boss, item.id, { action: 'remove' });
  assert.ok((await current(a)).replaced_at);
  assert.equal((await reviewList(boss)).length, 0);
  await assert.rejects(resolveReview(boss, item.id, { action: 'bogus' }).then((r) => { if (!r) throw new Error('settled'); }));
});
