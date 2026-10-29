import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, db, closeDb } from './helpers/db.js';
import {
  proposeLesson, decideLesson, removeLesson, lessonsFor, lessonsBlock, listLessons, proposalsFor,
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
