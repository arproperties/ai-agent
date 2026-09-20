import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { agentLinks } from '../server/agents.js';
import { retrievalScope } from '../server/knowledge.js';
import { shelfIds } from '../server/access.js';

test.after(() => closeDb());

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

const doc = (userId, agentId, name, shared = false) =>
  db.prepare(`INSERT INTO documents (user_id, agent_id, name, title, status, shared)
    VALUES (?, ?, ?, ?, 'ready', ?) RETURNING id`).run(userId, agentId, name, name, shared);

const chunk = (userId, agentId, text, shared = false) =>
  db.prepare('INSERT INTO chunks (user_id, agent_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, agentId, text, shared);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const hr = await makeAgent(masterId, 'HR');
  return { master, sara, hr };
}

// ---------- the root cause: agent_id is a filing label, not an owner ----------

test("deleting an agent detaches another user's documents instead of destroying them", async () => {
  const { master, sara, hr } = await fixture();
  await doc(sara.id, hr, 'sara-contract.pdf');

  await db.prepare('DELETE FROM agents WHERE id = ?').run(hr);

  const row = await db.prepare('SELECT name, agent_id FROM documents WHERE user_id = ?').get(sara.id);
  assert.deepEqual(row, { name: 'sara-contract.pdf', agent_id: null },
    "Sara's document must survive, detached to her personal library");
});

test("deleting an agent detaches another user's chunks instead of destroying them", async () => {
  const { sara, hr } = await fixture();
  await chunk(sara.id, hr, 'sara salary terms');

  await db.prepare('DELETE FROM agents WHERE id = ?').run(hr);

  const row = await db.prepare('SELECT text, agent_id FROM chunks WHERE user_id = ?').get(sara.id);
  assert.deepEqual(row, { text: 'sara salary terms', agent_id: null });
});

test('a detached shared item stops being shared, so it cannot suddenly reach everyone', async () => {
  const { master, sara, hr } = await fixture();
  const general = await makeAgent(master.id, 'General');
  await assign(general, sara.id); // Sara was never given HR
  await chunk(master.id, hr, 'confidential HR disciplinary policy', true);
  await doc(master.id, hr, 'hr-handbook.pdf', true);

  await db.prepare('DELETE FROM agents WHERE id = ?').run(hr);

  const scope = retrievalScope(sara.id, await shelfIds(sara));
  const seen = await db.prepare(`SELECT text FROM chunks t WHERE ${scope.sql}`).all(...scope.params);
  assert.deepEqual(seen, [], 'detaching must not widen a shared item to every user');

  const d = await db.prepare('SELECT shared FROM documents WHERE user_id = ?').get(master.id);
  assert.equal(d.shared, false, 'the document is detached too, so it must not stay shared');
});

// ---------- the guard: an agent other people still use is not deletable ----------

test('an agent only its owner uses has no links', async () => {
  const { master, hr } = await fixture();
  await doc(master.id, hr, 'master-notes.pdf');
  await assign(hr, master.id);

  assert.deepEqual(await agentLinks(master.id, hr), { users: 0, documents: 0 });
});

test("another user's assignment counts as a link", async () => {
  const { master, sara, hr } = await fixture();
  await assign(hr, sara.id, 'knowledge');

  assert.deepEqual(await agentLinks(master.id, hr), { users: 1, documents: 0 });
});

test("another user's documents count as links", async () => {
  const { master, sara, hr } = await fixture();
  await doc(sara.id, hr, 'sara-contract.pdf');
  await doc(sara.id, hr, 'sara-payslip.pdf');

  assert.deepEqual(await agentLinks(master.id, hr), { users: 0, documents: 2 });
});

test('agentLinks ignores an unknown agent', async () => {
  const { master } = await fixture();
  assert.deepEqual(await agentLinks(master.id, 99999), { users: 0, documents: 0 });
});
