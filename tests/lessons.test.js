import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, db, closeDb } from './helpers/db.js';
import {
  proposeLesson, decideLesson, removeLesson, lessonsFor, lessonsBlock, listLessons, proposalsFor, lessonKit,
} from '../server/lessons.js';

test.after(() => closeDb());

const VAT = 'Always show rent including VAT.';
const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
const count = async (table) => (await db.prepare(`SELECT count(*)::int AS n FROM ${table}`).get()).n;

async function setup() {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master', name: 'Owner' };
  const a = await makeAgent(master.id, 'PM');
  return { master, a, agent: await agentRow(a) };
}

test('a rule is proposed for the answering agent and applied only on Approve', async () => {
  const { master, a, agent } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  assert.equal(p.status, 'pending');
  assert.equal(p.agent_name, 'PM');
  assert.equal((await lessonsFor(agent)).lessons.length, 0);

  const done = await decideLesson(master, p.id, { approve: true });
  assert.equal(done.status, 'approved');
  assert.deepEqual((await lessonsFor(agent)).lessons.map((l) => l.rule), [VAT]);
});

test('approving twice adds it once', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await decideLesson(master, p.id, { approve: true });
  await assert.rejects(decideLesson(master, p.id, { approve: true }), (e) => /already approved/.test(e.message) && e.status === 409);
  assert.equal(await count('agent_lessons'), 1);
});

test('only the master can propose', async () => {
  const { a } = await setup();
  const staff = { id: await makeUser('Staff'), role: 'user' };
  await assert.rejects(proposeLesson(staff, { agentId: a, rule: VAT }), (e) => e.status === 403);
});

test('an agent the master does not own is refused', async () => {
  const { master } = await setup();
  const other = await makeAgent(await makeUser('Other'), 'Theirs');
  await assert.rejects(proposeLesson(master, { agentId: other, rule: VAT }), (e) => e.status === 403);
});

test('declined, removed, pending and current rules are not proposed again', async () => {
  const { master, a } = await setup();
  const again = () => proposeLesson(master, { agentId: a, rule: '  always SHOW rent   including vat. ' });

  const pending = await proposeLesson(master, { agentId: a, rule: VAT });
  await assert.rejects(again(), /already/);

  await decideLesson(master, pending.id, { approve: true });
  await assert.rejects(again(), /already/);

  const [l] = (await listLessons(master, a)).own;
  await removeLesson(master, l.id);
  await assert.rejects(again(), /already/);

  await db.prepare('DELETE FROM agent_lessons').run();
  await db.prepare("UPDATE lesson_proposals SET status = 'declined'").run();
  await assert.rejects(again(), /already/);

  // Another scope is another rule.
  await assert.doesNotReject(proposeLesson(master, { agentId: a, rule: VAT, allAgents: true }));
});

test('personal detail is refused, on propose and on an edited approve', async () => {
  const { master, a } = await setup();
  const personal = 'Tell Rahul Sharma his rent is AED 60,000';
  await assert.rejects(proposeLesson(master, { agentId: a, rule: personal }), /names, sums or ID numbers/);
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await assert.rejects(decideLesson(master, p.id, { approve: true, rule: personal }), /names, sums or ID numbers/);
  assert.equal((await proposalsFor(master, null)).find((x) => x.id === p.id).status, 'pending');
});

test('an edited rule must be 1-300 characters', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await assert.rejects(decideLesson(master, p.id, { approve: true, rule: '  ' }), (e) => e.status === 400);
  await assert.rejects(decideLesson(master, p.id, { approve: true, rule: 'x'.repeat(301) }), (e) => e.status === 400);
  await assert.rejects(proposeLesson(master, { agentId: a, rule: 'y'.repeat(301) }), (e) => e.status === 400);
});

test('approve can move the scope to All agents, and checks duplicates again', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await decideLesson(master, p.id, { approve: true, agentId: null });
  assert.equal((await listLessons(master, a)).all[0].agent_id, null);

  const q = await proposeLesson(master, { agentId: a, rule: VAT });
  await assert.rejects(decideLesson(master, q.id, { approve: true, agentId: null }), /already/);
});

test('replace removes the old lesson and adds the new one together', async () => {
  const { master, a, agent } = await setup();
  const first = await proposeLesson(master, { agentId: a, rule: 'Write emails in Arabic first.' });
  await decideLesson(master, first.id, { approve: true });
  const [old] = (await listLessons(master, a)).own;

  const p = await proposeLesson(master, { agentId: a, rule: 'Write emails in English first.', replaces: old.id });
  assert.equal(p.replaces_lesson_id, old.id);
  assert.equal(p.replaces_rule, 'Write emails in Arabic first.');
  await decideLesson(master, p.id, { approve: true, replace: true });
  assert.deepEqual((await lessonsFor(agent)).lessons.map((l) => l.rule), ['Write emails in English first.']);

  const [cur] = (await listLessons(master, a)).own;
  const q = await proposeLesson(master, { agentId: a, rule: 'Sign emails as the team.', replaces: cur.id });
  await decideLesson(master, q.id, { approve: true, replace: false });
  assert.equal((await lessonsFor(agent)).lessons.length, 2);
});

test('a replaces id that is not a current lesson of this owner is dropped', async () => {
  const { master, a } = await setup();
  const p0 = await proposeLesson(master, { agentId: a, rule: 'Old rule.' });
  await decideLesson(master, p0.id, { approve: true });
  const [gone] = (await listLessons(master, a)).own;
  await removeLesson(master, gone.id);

  const other = { id: await makeUser('Other'), role: 'master' };
  const oa = await makeAgent(other.id, 'Theirs');
  const op = await proposeLesson(other, { agentId: oa, rule: 'Their rule.' });
  await decideLesson(other, op.id, { approve: true });
  const [theirs] = (await listLessons(other, oa)).own;

  for (const [i, replaces] of [gone.id, theirs.id, 9999].entries()) {
    const p = await proposeLesson(master, { agentId: a, rule: `New rule ${i}.`, replaces });
    assert.equal(p.replaces_lesson_id, null);
  }
});

test("lessonsFor: own plus All-agents, newest 50, never removed or another owner's", async () => {
  const { master, a, agent } = await setup();
  for (let i = 0; i < 55; i++) {
    await db.prepare('INSERT INTO agent_lessons (owner_id, agent_id, rule, created_at) VALUES (?, ?, ?, ?)')
      .run(master.id, i % 2 ? a : null, `rule ${i}`, 1000 + i);
  }
  await db.prepare('INSERT INTO agent_lessons (owner_id, agent_id, rule, created_at, removed_at) VALUES (?, ?, ?, ?, ?)')
    .run(master.id, a, 'removed one', 5000, 5001);
  const other = await makeUser('Other');
  await db.prepare('INSERT INTO agent_lessons (owner_id, agent_id, rule, created_at) VALUES (?, NULL, ?, ?)').run(other, 'not mine', 6000);

  const { owner, lessons } = await lessonsFor(agent);
  assert.equal(owner, 'Owner');
  assert.equal(lessons.length, 50);
  assert.equal(lessons[0].rule, 'rule 5');
  assert.equal(lessons.at(-1).rule, 'rule 54');
  assert.ok(!lessons.some((l) => l.rule === 'removed one' || l.rule === 'not mine'));
});

test('a deleted agent takes its pending card with it', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await db.prepare('DELETE FROM agents WHERE id = ?').run(a);
  assert.equal(await decideLesson(master, p.id, { approve: true }), null);
});

test('lessonsBlock is empty without lessons and lists them otherwise', () => {
  assert.equal(lessonsBlock('Owner', []), '');
  const b = lessonsBlock('Owner', [{ rule: 'A.' }, { rule: 'B.' }]);
  assert.ok(b.includes('<lessons>') && b.includes('Owner') && b.includes('- A.') && b.includes('- B.'));
});

test('listLessons splits own from All agents', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: 'Own rule.' });
  await decideLesson(master, p.id, { approve: true });
  const q = await proposeLesson(master, { agentId: a, rule: 'General rule.', allAgents: true });
  await decideLesson(master, q.id, { approve: true });
  const { own, all } = await listLessons(master, a);
  assert.deepEqual(own.map((l) => l.rule), ['Own rule.']);
  assert.deepEqual(all.map((l) => l.rule), ['General rule.']);
});

test('declining sets the status once', async () => {
  const { master, a } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  assert.equal((await decideLesson(master, p.id, { approve: false })).status, 'declined');
  await assert.rejects(decideLesson(master, p.id, { approve: true }), (e) => e.status === 409);
  assert.equal(await count('agent_lessons'), 0);
});

// ---------- the chat tool ----------

test('the kit is empty for staff and external users', async () => {
  const { agent } = await setup();
  const staff = { id: await makeUser('Staff'), role: 'user' };
  assert.equal((await lessonKit(staff, { agent })).definitions.length, 0);
  assert.equal((await lessonKit({ ...staff, external: true }, { agent })).definitions.length, 0);
});

test('the tool description lists current lessons with ids, and recently declined or removed rules', async () => {
  const { master, a, agent } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await decideLesson(master, p.id, { approve: true });
  const [cur] = (await listLessons(master, a)).own;
  const q = await proposeLesson(master, { agentId: a, rule: 'Never use emojis.' });
  await decideLesson(master, q.id, { approve: false });

  const [def] = (await lessonKit(master, { agent })).definitions;
  assert.equal(def.name, 'propose_lesson');
  assert.ok(def.description.includes(`[${cur.id}] ${VAT}`));
  assert.ok(def.description.includes('Never use emojis.'));
});

test('run proposes for the answering agent and sends the card', async () => {
  const { master, a, agent } = await setup();
  const cards = [];
  const kit = await lessonKit(master, { conversationId: null, agent, onCard: (c) => cards.push(c) });
  const out = await kit.run({ id: 't1', name: 'propose_lesson', input: { rule: VAT } });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].agent_id, a);
  assert.ok(out.content.includes('NOT applied'));
  assert.ok(!out.is_error);
});

test('run returns the refusal as is_error', async () => {
  const { master, agent } = await setup();
  const kit = await lessonKit(master, { agent, onCard: () => {} });
  await kit.run({ id: 't1', name: 'propose_lesson', input: { rule: VAT } });
  const out = await kit.run({ id: 't2', name: 'propose_lesson', input: { rule: VAT } });
  assert.equal(out.is_error, true);
  assert.match(out.content, /already/);
});

test('run with all_agents proposes for every agent', async () => {
  const { master, agent } = await setup();
  const cards = [];
  const kit = await lessonKit(master, { agent, onCard: (c) => cards.push(c) });
  await kit.run({ id: 't1', name: 'propose_lesson', input: { rule: VAT, all_agents: true } });
  assert.equal(cards[0].agent_id, null);
});

test('a staff user talking to the agent gets the same lessons block', async () => {
  const { master, a, agent } = await setup();
  const p = await proposeLesson(master, { agentId: a, rule: VAT });
  await decideLesson(master, p.id, { approve: true });
  // The block is built from the agent alone, so whoever is chatting reads the same rules.
  const t = await lessonsFor(agent);
  const block = lessonsBlock(t.owner, t.lessons);
  assert.ok(block.includes(VAT) && block.includes('Owner'));
  assert.equal(lessonsBlock((await lessonsFor(await agentRow(a))).owner, (await lessonsFor(agent)).lessons), block);
});

test('only the owner may override a rule; everyone else follows it', () => {
  const rules = [{ rule: 'Never promise a discount.' }];
  const owner = lessonsBlock('Owner', rules, { canOverride: true });
  const other = lessonsBlock('Owner', rules, { canOverride: false });
  assert.match(owner, /follow the request and mention the rule/);
  assert.doesNotMatch(other, /follow the request/);
  assert.match(other, /even if asked not to/);
  // Safe by default: a caller that forgets the flag does not hand out overrides.
  assert.doesNotMatch(lessonsBlock('Owner', rules), /follow the request/);
});
