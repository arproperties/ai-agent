import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { retrievalScope } from '../server/knowledge.js';

test.after(() => closeDb());

// Exercises the scope as SQL against real rows, which is the only way to know the
// clause is right. Uses chunks directly rather than going through embeddings.
async function chunkIds(user, agentId) {
  const { shelfIds } = await import('../server/access.js');
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT t.id, t.text FROM chunks t WHERE ${scope.sql} ORDER BY t.id`).all(...scope.params);
  return rows.map((r) => r.text);
}

const chunk = (userId, agentId, text, shared = false) =>
  db.prepare('INSERT INTO chunks (user_id, agent_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, agentId, text, shared);

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  return { master, sara, lawyer, hr };
}

test('a user reads all of their own chunks regardless of agent', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(sara.id, lawyer, 'sara lawyer note');
  await chunk(sara.id, hr, 'sara hr note');          // not assigned, but still hers
  await chunk(sara.id, null, 'sara library note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts.sort(), ['sara hr note', 'sara lawyer note', 'sara library note'].sort());
});

test("a user never reads another user's chunks", async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'master private note');   // shared = false
  await chunk(sara.id, lawyer, 'sara note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts, ['sara note'], 'master\'s private chunk must not be visible');
});

test('a user reads shared chunks on shelves they were assigned', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'legal shelf policy', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('legal shelf policy'));
});

test('a user does NOT read shared chunks on shelves they were not assigned', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, hr, 'hr payroll policy', true);

  assert.ok(!(await chunkIds(sara, lawyer)).includes('hr payroll policy'));
});

test('a knowledge-mode assignment grants shelf access without the agent', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');
  await chunk(master.id, hr, 'hr handbook notice period', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('hr handbook notice period'));
});

test('a shared chunk with no agent reaches everyone', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, null, 'company holiday calendar', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('company holiday calendar'));
});

test('master reads all of their own chunks, shared or not', async () => {
  const { master, lawyer, hr } = await fixture();
  await chunk(master.id, lawyer, 'master private', false);
  await chunk(master.id, hr, 'master shared', true);

  const texts = await chunkIds(master, lawyer);
  assert.deepEqual(texts.sort(), ['master private', 'master shared'].sort());
});

test("master does not read a user's private chunks through recall", async () => {
  const { master, sara, lawyer } = await fixture();
  await chunk(sara.id, lawyer, 'sara private diary');

  assert.ok(!(await chunkIds(master, lawyer)).includes('sara private diary'),
    'master oversight is the admin router, not a widening of recall');
});
