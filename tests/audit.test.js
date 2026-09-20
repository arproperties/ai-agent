import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { recordAccess, accessByMe, accessOfMe } from '../server/admin.js';

test.after(() => closeDb());

// Master can read anyone's workspace. This records that it happened, and shows it to
// BOTH sides: a log only the reader can see is a diary, not an audit trail.

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const tomId = await makeUser('Tom');
  const hr = await makeAgent(masterId, 'HR');
  const doc = await makeDoc(saraId, hr, 'payslip.pdf');
  return { master, saraId, tomId, doc };
}

test('reading someone\'s file is recorded against both of them', async () => {
  const { master, saraId, doc } = await fixture();

  await recordAccess(master, saraId, 'document', doc);

  const [row] = await accessOfMe(saraId);
  assert.equal(row.actor_email, master.email);
  assert.equal(row.action, 'document');
  assert.equal(row.target_id, doc);
  assert.ok(row.created_at, 'and when');
});

test('the person sees who looked at them, the master sees what they looked at', async () => {
  const { master, saraId, doc } = await fixture();
  await recordAccess(master, saraId, 'document', doc);
  await recordAccess(master, saraId, 'conversation', 4);

  assert.equal((await accessOfMe(saraId)).length, 2, 'Sara sees both');
  assert.equal((await accessByMe(master.id, saraId)).length, 2, 'master sees both');
});

test('one person never sees what was read about another', async () => {
  const { master, saraId, tomId, doc } = await fixture();
  await recordAccess(master, saraId, 'document', doc);

  assert.deepEqual(await accessOfMe(tomId), [], "Tom must not see Sara's entries");
});

test('the master reading their own workspace is not recorded', async () => {
  const { master } = await fixture();
  const own = await makeDoc(master.id, null, 'my-own.pdf');

  await recordAccess(master, master.id, 'document', own);

  assert.deepEqual(await accessOfMe(master.id), [], 'looking at your own things is not oversight');
});

test('entries survive the document they refer to being deleted', async () => {
  const { master, saraId, doc } = await fixture();
  await recordAccess(master, saraId, 'document', doc);
  await db.prepare('DELETE FROM documents WHERE id = ?').run(doc);

  const rows = await accessOfMe(saraId);
  assert.equal(rows.length, 1, 'deleting the evidence must not delete the record of reading it');
});

test('newest first', async () => {
  const { master, saraId } = await fixture();
  await recordAccess(master, saraId, 'memory', null);
  await recordAccess(master, saraId, 'conversation', 7);

  const rows = await accessOfMe(saraId);
  assert.deepEqual(rows.map((r) => r.action), ['conversation', 'memory']);
});
