import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { isMaster, chatAgents, shelfIds, canUseAgent } from '../server/access.js';

test.after(() => closeDb());

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
  const finance = await makeAgent(masterId, 'Finance');
  return { master, sara, lawyer, hr, finance };
}

test('isMaster reads the role column', async () => {
  const { master, sara } = await fixture();
  assert.equal(isMaster(master), true);
  assert.equal(isMaster(sara), false);
});

test('a user chats only with agents assigned in chat mode', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  const names = (await chatAgents(sara)).map((a) => a.name);
  assert.deepEqual(names, ['Lawyer'], 'a knowledge-mode agent must not appear');
});

test('a user with no assignments chats with nothing', async () => {
  const { sara } = await fixture();
  assert.deepEqual(await chatAgents(sara), []);
});

test('master chats with every agent they own, without assignments', async () => {
  const { master } = await fixture();
  const names = (await chatAgents(master)).map((a) => a.name);
  assert.deepEqual(names, ['Lawyer', 'HR', 'Finance']);
});

test('the primary agent sorts first', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(hr, sara.id, 'chat');
  await assign(lawyer, sara.id, 'chat');
  await db.prepare('UPDATE agent_assignments SET is_primary = true WHERE agent_id = ? AND user_id = ?').run(lawyer, sara.id);

  assert.equal((await chatAgents(sara))[0].name, 'Lawyer');
});

test('shelfIds covers both modes', async () => {
  const { sara, lawyer, hr, finance } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  const ids = (await shelfIds(sara)).sort();
  assert.deepEqual(ids, [lawyer, hr].sort(), 'a knowledge shelf is readable even though its agent is hidden');
  assert.ok(!ids.includes(finance), 'an unassigned shelf must not be readable');
});

test('canUseAgent follows assignment, in either mode', async () => {
  const { sara, lawyer, hr, finance } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  assert.equal(await canUseAgent(sara, lawyer), true);
  assert.equal(await canUseAgent(sara, hr), true);
  assert.equal(await canUseAgent(sara, finance), false);
});

test('master can use every agent they own and nothing they do not', async () => {
  const { master, sara, lawyer } = await fixture();
  const strayId = await makeAgent(sara.id, 'Stray');
  assert.equal(await canUseAgent(master, lawyer), true);
  assert.equal(await canUseAgent(master, strayId), false);
});
