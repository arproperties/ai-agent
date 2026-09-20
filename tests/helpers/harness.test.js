import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './db.js';

test.after(() => closeDb());

test('reset() empties the database and restarts ids', async () => {
  await reset();
  const first = await makeUser('Alice');
  await reset();
  const second = await makeUser('Bob');
  assert.equal(first, second, 'ids should restart from 1 after a reset');

  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM users').get();
  assert.equal(n, 1, 'only the user created after the reset should remain');
});

test('the factories link rows together', async () => {
  await reset();
  const userId = await makeUser('Alice');
  const agentId = await makeAgent(userId, 'Lawyer');
  const docId = await makeDoc(userId, agentId, 'tenancy.pdf');

  const doc = await db.prepare('SELECT user_id, agent_id, name FROM documents WHERE id = ?').get(docId);
  assert.deepEqual(doc, { user_id: userId, agent_id: agentId, name: 'tenancy.pdf' });
});
