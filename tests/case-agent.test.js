import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { pickAgent } from '../server/router.js';
import { agentCases, caseHome } from '../server/caseFocus.js';
import { setAgentCase } from '../server/agents.js';

test.after(() => closeDb());

// A chat about a case always goes to the case agent, so one case's work is not split across
// agents. What would go quietly wrong: @Name no longer working, a person without the case
// agent being sent to it, or the Cases tab showing someone else's cases on a shared agent.

const general = { id: 1, name: 'Reem', persona: 'general' };
const attorney = { id: 2, name: 'Soutex Case Attorney', persona: 'cases', handles_cases: true };

test('a case chat goes to the case agent; @Name still wins', async () => {
  const base = { agents: [general, attorney], userId: 0, recent: [], currentAgentId: general.id };
  assert.equal((await pickAgent({ ...base, text: 'what next?', caseKey: 'e205791' })).agent.id, attorney.id);
  assert.equal((await pickAgent({ ...base, text: '@Reem draft a reply', caseKey: 'e205791' })).agent.id, general.id);
  // The master's private case agent counts too: they can reach it.
  assert.equal((await pickAgent({ ...base, agents: [general], byName: [attorney], text: 'next', caseKey: 'e205791' })).agent.id, attorney.id);
});

test('an agent bound to a case gets every chat on it and answers nothing else', async () => {
  const soutex = { id: 3, name: 'Soutex', persona: 'x', case_key: 'e205791', case_number: 'E-205791' };
  const howard = { id: 4, name: 'Howard', persona: 'x', case_key: 'e198822', case_number: '198822' };
  const base = { agents: [general, soutex, howard], userId: 0, recent: [] };
  // A chat on the case: Soutex, even when Howard or Reem is named, or Reem had it.
  assert.equal((await pickAgent({ ...base, text: 'next?', caseKey: 'e205791', currentAgentId: general.id })).agent.id, soutex.id);
  assert.equal((await pickAgent({ ...base, text: '@Howard help', caseKey: 'e205791' })).agent.id, soutex.id);
  // Named in a chat with no case yet: it answers (chat.js then gives the chat its case).
  assert.equal((await pickAgent({ ...base, text: '@Soutex hi' })).agent.id, soutex.id);
  // Named in another case's chat with no agent of its own: refused, the rest route as usual.
  assert.equal((await pickAgent({ ...base, agents: [general, soutex], text: '@Soutex hi', caseKey: 'e999999' })).agent.id, general.id);
  // Never picked on its own for a chat that is not its case.
  assert.equal((await pickAgent({ ...base, agents: [general, soutex], text: 'proverbs please', currentAgentId: soutex.id })).agent.id, general.id);
});

test("the person an agent is given to alone may set its case; not a shared one, not someone else's", async () => {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const jeff = { id: await makeUser('Jeff'), role: 'user' };
  const sara = { id: await makeUser('Sara'), role: 'user' };
  const mine = await makeAgent(boss.id, 'Frazier');
  const shared = await makeAgent(boss.id, 'Expert');
  const give = (u, a) => db.prepare(`INSERT INTO agent_assignments (user_id, agent_id, mode) VALUES (?, ?, 'chat')`).run(u, a);
  await give(jeff.id, mine);
  await give(jeff.id, shared);
  await give(sara.id, shared);

  assert.equal((await setAgentCase(jeff, mine, 'B2017947')).case_key, 'b2017947');
  await assert.rejects(setAgentCase(jeff, shared, '123456'), (e) => e.status === 403);
  await assert.rejects(setAgentCase(sara, mine, '999999'), (e) => e.status === 404);
  assert.equal((await setAgentCase(boss, shared, '123456')).case_number, '123456', 'the master may always');
  assert.equal((await setAgentCase(jeff, mine, '')).case_key, null, 'emptied: any chat again');
});

test('without the case agent, a case chat routes as before', async () => {
  const out = await pickAgent({ agents: [general], userId: 0, text: 'case 205791', recent: [], caseKey: 'e205791' });
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
