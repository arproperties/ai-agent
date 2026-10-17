import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { chatAgents, privateAgents, listedAgents, canUseAgent } from '../server/access.js';
import { setAssignments, listAssignments } from '../server/admin.js';
import { pickAgent } from '../server/router.js';

// A private agent is for the people it is ticked for, and stays out of everyone else's
// day-to-day: never lent as a hidden shelf, never picked for the master's own questions.

test.after(() => closeDb());

const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const ops = await makeAgent(masterId, 'Operations');
  const legal = await makeAgent(masterId, 'Family Law');
  await db.prepare('UPDATE agents SET private = true WHERE id = ?').run(legal);
  return { master: await user(masterId), sara: await user(await makeUser('Sara')), boss: await user(await makeUser('Boss')), ops, legal };
}

// What the People screen sends: the ticked ones as chat, every other one as knowledge.
const peopleSave = (all, ticked) => all.map((id) => (ticked.includes(id)
  ? { agentId: id, mode: 'chat', primary: id === ticked[0] }
  : { agentId: id, mode: 'knowledge' }));

test('agents are not private unless made so', async () => {
  const { ops } = await fixture();
  assert.equal((await db.prepare('SELECT private FROM agents WHERE id = ?').get(ops)).private, false);
});

test('the person it is ticked for chats with it', async () => {
  const { master, boss, ops, legal } = await fixture();
  await setAssignments(master, boss.id, peopleSave([ops, legal], [legal]));
  assert.deepEqual((await chatAgents(boss)).map((a) => a.name), ['Family Law']);
  assert.equal(await canUseAgent(boss, legal), true);
});

test('saving anyone else in People never lends them the private agent as a shelf', async () => {
  const { master, sara, ops, legal } = await fixture();
  await setAssignments(master, sara.id, peopleSave([ops, legal], [ops]));
  const rows = await listAssignments(sara.id);
  assert.deepEqual(rows.map((r) => [r.agent_id, r.mode]), [[ops, 'chat']]);
  assert.equal(await canUseAgent(sara, legal), false);
});

test("the master's own router and filing never see a private agent", async () => {
  const { master } = await fixture();
  assert.deepEqual((await chatAgents(master)).map((a) => a.name), ['Operations']);
  assert.deepEqual((await privateAgents(master)).map((a) => a.name), ['Family Law']);
  assert.deepEqual((await listedAgents(master)).map((a) => a.name), ['Operations', 'Family Law'], 'still listed, to manage');
  assert.equal(await canUseAgent(master, (await privateAgents(master))[0].id), true);
});

test('a normal user has no private-by-name agents', async () => {
  const { sara } = await fixture();
  assert.deepEqual(await privateAgents(sara), []);
});

test('the master reaches a private agent only by @name, and stays with it after', async () => {
  const { master } = await fixture();
  const team = await chatAgents(master);
  const byName = await privateAgents(master);
  const named = await pickAgent({ agents: team, byName, userId: master.id, text: '@Family Law what applies in Dubai?', recent: [] });
  assert.equal(named.agent.name, 'Family Law');
  const next = await pickAgent({ agents: team, byName, userId: master.id, text: 'and the waiting period?', recent: [], currentAgentId: byName[0].id });
  assert.equal(next.agent.name, 'Family Law', 'a conversation it was named into stays with it');
  const plain = await pickAgent({ agents: team, byName, userId: master.id, text: 'how many units are vacant?', recent: [] });
  assert.equal(plain.agent.name, 'Operations', 'one agent left to route to: no model call needed');
});
