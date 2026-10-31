import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { addMemory, personalMemories, pinnedMemories } from '../server/knowledge.js';

test.after(() => closeDb());

const replacesAll = async (_text, rows) => rows.map((r) => r.id);
const replacesNone = async () => [];
const pin = (id) => db.prepare('UPDATE memories SET pinned = true WHERE id = ?').run(id);

test('a pinned memory reaches every chat, and is not given twice', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const lawyer = await addMemory(boss, 'Hani Al Jasmi Advocates are our own lawyers', { judge: replacesNone });
  await addMemory(boss, 'Rona is the PA to the CEO', { judge: replacesNone });
  await pin(lawyer);

  assert.deepEqual(await pinnedMemories({ id: boss }), ['Hani Al Jasmi Advocates are our own lawyers']);
  const recalled = await personalMemories({ id: boss }, 'proceed with the email', null);
  assert.ok(!recalled.some((m) => m.includes('Al Jasmi')), 'the pinned one comes once, as a key fact');
});

test("only the person's own, current pinned memories are read", async () => {
  await reset();
  const boss = await makeUser('Boss');
  const other = await makeUser('Other');
  await pin(await addMemory(other, 'Other people facts', { judge: replacesNone }));
  const old = await addMemory(boss, 'The consultant is Eng. Bayat', { judge: replacesNone });
  await pin(old);
  await addMemory(boss, 'The consultant is Eng. Bayat Consultants, info@engbayat.com', { judge: replacesAll });

  const mine = await pinnedMemories({ id: boss });
  assert.deepEqual(mine, ['The consultant is Eng. Bayat Consultants, info@engbayat.com'], 'a corrected pinned fact stays pinned in its new version');
});
