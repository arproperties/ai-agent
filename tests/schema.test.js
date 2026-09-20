import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';

test.after(() => closeDb());

const column = (table, name) => db.prepare(
  'SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = ? AND column_name = ?'
).get(table, name);

test('users gains role, disabled and created_by', async () => {
  assert.ok(await column('users', 'role'), 'users.role is missing');
  assert.ok(await column('users', 'disabled'), 'users.disabled is missing');
  assert.ok(await column('users', 'created_by'), 'users.created_by is missing');
});

test('a new user defaults to the user role and is not disabled', async () => {
  await reset();
  const id = await makeUser('Alice');
  const u = await db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id);
  assert.deepEqual(u, { role: 'user', disabled: false });
});

test('documents and chunks gain a shared flag defaulting to false', async () => {
  assert.ok(await column('documents', 'shared'), 'documents.shared is missing');
  assert.ok(await column('chunks', 'shared'), 'chunks.shared is missing');
});

test('agent_assignments links a user to an agent with a mode', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');

  await db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(hr, sara, 'chat');
  const row = await db.prepare('SELECT agent_id, user_id, mode, is_primary FROM agent_assignments WHERE user_id = ?').get(sara);
  assert.deepEqual(row, { agent_id: hr, user_id: sara, mode: 'chat', is_primary: false });
});

test('an agent can only be assigned to a user once', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');
  const ins = 'INSERT INTO agent_assignments (agent_id, user_id) VALUES (?, ?)';

  await db.prepare(ins).run(hr, sara);
  await assert.rejects(() => db.prepare(ins).run(hr, sara), /duplicate key/);
});

test('mode only accepts chat or knowledge', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');

  await assert.rejects(
    () => db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(hr, sara, 'admin'),
    /violates check constraint/
  );
});

test('deleting a user removes their assignments but not the agent', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');
  await db.prepare('INSERT INTO agent_assignments (agent_id, user_id) VALUES (?, ?)').run(hr, sara);

  await db.prepare('DELETE FROM users WHERE id = ?').run(sara);
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM agent_assignments').get();
  assert.equal(n, 0, 'the assignment should have been cascaded away');
  assert.ok(await db.prepare('SELECT 1 FROM agents WHERE id = ?').get(hr), 'the agent must survive');
});
