import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { pickAgent } from '../server/router.js';
import { agentCases, caseHome } from '../server/caseFocus.js';

test.after(() => closeDb());

// A chat about a case always goes to the case agent, so one case's work is not split across
// agents. What would go quietly wrong: @Name no longer working, a person without the case
// agent being sent to it, or the Cases tab showing someone else's cases on a shared agent.

const general = { id: 1, name: 'Reem', persona: 'general' };
const attorney = { id: 2, name: 'Soutex Case Attorney', persona: 'cases', handles_cases: true };

test('a case chat goes to the case agent; @Name still wins', async () => {
  const base = { agents: [general, attorney], userId: 0, recent: [], currentAgentId: general.id };
  assert.equal((await pickAgent({ ...base, text: 'what next?', onCase: true })).agent.id, attorney.id);
  assert.equal((await pickAgent({ ...base, text: '@Reem draft a reply', onCase: true })).agent.id, general.id);
  // The master's private case agent counts too: they can reach it.
  assert.equal((await pickAgent({ ...base, agents: [general], byName: [attorney], text: 'next', onCase: true })).agent.id, attorney.id);
});

test('without the case agent, a case chat routes as before', async () => {
  const out = await pickAgent({ agents: [general], userId: 0, text: 'case 205791', recent: [], onCase: true });
  assert.equal(out.agent.id, general.id);
});

const conv = async (userId, number, agentId) => {
  const { id } = await db.prepare(`INSERT INTO conversations (user_id, title, primary_case) VALUES (?, ?, ?::jsonb) RETURNING id`)
    .run(userId, `About ${number}`, JSON.stringify({ number, key: number.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') }));
  await db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, content) VALUES (?, ?, 'assistant', 'ok')`).run(id, agentId);
  return id;
};

test("the Cases tab shows one person's own cases with the agent, grouped by case", async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const sara = await makeUser('Sara');
  const agent = await makeAgent(jeff, 'Soutex Case Attorney');
  const other = await makeAgent(jeff, 'Reem');
  const a1 = await conv(jeff, 'E-205791', agent);
  const a2 = await conv(jeff, 'E-205791', agent);
  await conv(jeff, '198822', other); // another agent's case chat
  await conv(sara, '555666', agent); // same agent, someone else
  await db.prepare(`INSERT INTO case_time (user_id, case_key, case_number, conversation_id, day, seconds) VALUES (?, 'e205791', 'E-205791', ?, '2026-10-01', 90)`).run(jeff, a1);
  await db.prepare(`INSERT INTO case_deadlines (user_id, case_key, due, what, quote, source_name)
    VALUES (?, 'e205791', '2026-11-05', 'Hearing', 'q', 'f'), (?, 'e205791', '2026-09-01', 'Old', 'q', 'f')`).run(jeff, jeff);

  const cases = await agentCases(jeff, agent, '2026-10-28');
  assert.deepEqual(cases.map((c) => c.number), ['E-205791']);
  assert.deepEqual(cases[0].chats.map((c) => c.id).sort(), [a1, a2].sort());
  assert.equal(cases[0].seconds, 90);
  assert.deepEqual(cases[0].next, { due: '2026-11-05', what: 'Hearing' });
  assert.deepEqual((await agentCases(sara, agent)).map((c) => c.number), ['555666']);
});

test("Case Home has every chat on the case, whichever agent answered, and only the person's own", async () => {
  await reset();
  const jeff = await makeUser('Jeff');
  const sara = await makeUser('Sara');
  const attorney = await makeAgent(jeff, 'Soutex Case Attorney');
  const reem = await makeAgent(jeff, 'Reem');
  const a = await conv(jeff, 'E-205791', attorney);
  const b = await conv(jeff, 'E-205791', reem);
  await conv(jeff, '198822', attorney);
  await conv(sara, 'E-205791', attorney);
  const home = await caseHome(jeff, 'e205791');
  assert.equal(home.number, 'E-205791');
  assert.deepEqual(home.chats.map((c) => c.id).sort(), [a, b].sort());
  assert.deepEqual(home.chats.map((c) => c.agent).sort(), ['Reem', 'Soutex Case Attorney']);
  assert.equal(home.brief, null);
  assert.equal(await caseHome(jeff, 'nope'), null);
});
