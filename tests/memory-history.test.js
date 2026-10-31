import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { addMemory, personalMemories, memoryChain, memoryHistory } from '../server/knowledge.js';

test.after(() => closeDb());

// A memory that a newer one corrects is kept, marked replaced: chats see only the new
// one, and the history still says what it was before. The judge stands in for the model
// that decides what is out of date, so these test the SQL and not the model.
const replacesAll = async (_text, rows) => rows.map((r) => r.id);
const replacesNone = async () => [];

test('a corrected memory is kept as history, and chats read only the new one', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const old = await addMemory(sara, 'Building A rent is 50,000', { judge: replacesNone });
  const now = await addMemory(sara, 'Building A rent is 60,000', { judge: replacesAll });

  const row = await db.prepare('SELECT replaced_at, replaced_by FROM memories WHERE id = ?').get(old);
  assert.ok(row.replaced_at, 'the old version is marked replaced, not deleted');
  assert.equal(row.replaced_by, now);

  const seen = await personalMemories({ id: sara }, 'rent', null);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /60,000 \(saved /, 'the chat gets the current version, with its date');

  const chain = await memoryChain(sara, old);
  assert.deepEqual(chain.map((m) => m.id), [old, now], 'history runs oldest first, from either end');
  assert.deepEqual((await memoryChain(sara, now)).map((m) => m.id), [old, now]);
});

test('a value that changes back is saved again, not dropped as a duplicate', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const a = await addMemory(sara, 'Building A rent is 50,000', { judge: replacesNone });
  await addMemory(sara, 'Building A rent is 60,000', { judge: replacesAll });
  const back = await addMemory(sara, 'Building A rent is 50,000', { judge: replacesAll });
  assert.ok(back, 'only current memories count as already known');
  assert.equal((await memoryChain(sara, a)).length, 3);
});

test('history and replacement never reach another person', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const tom = await makeUser('Tom');
  const his = await addMemory(tom, 'Building A rent is 50,000', { judge: replacesNone });
  // Even a judge that names Tom's memory cannot replace it: only her own are candidates.
  await addMemory(sara, 'Building A rent is 60,000', { judge: async () => [his] });
  const row = await db.prepare('SELECT replaced_at FROM memories WHERE id = ?').get(his);
  assert.equal(row.replaced_at, null);

  assert.deepEqual(await memoryChain(sara, his), []);
  const hers = await memoryHistory(sara, 'Building A rent');
  assert.ok(hers.flat().every((m) => !/50,000/.test(m.text)), "Tom's memory is not in Sara's history");
});
