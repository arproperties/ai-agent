import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, closeDb, db } from './helpers/db.js';
import { saveProject, confirmCard, projectKit, remindManpower, proposeManpower } from '../server/projects.js';
import { progressOf, proposeProgress } from '../server/projectProgress.js';
import { areasOf } from '../server/projectAreas.js';
import {
  issuesOf, saveIssue, closeIssueOnScreen, proposeIssue, proposeClose, proposeInspection, WALL_CHECKS,
} from '../server/projectIssues.js';

test.after(() => closeDb());

const pushes = [];
const push = async (ids, msg) => { pushes.push({ ids, ...msg }); return ids.length; };

async function setup(name = 'JVC School') {
  await reset();
  pushes.length = 0;
  const master = { id: await makeUser('Owner'), role: 'master' };
  const francisca = { id: await makeUser('Francisca'), role: 'user' };
  const tauqeer = { id: await makeUser('Tauqeer'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  const director = await makeAgent(master.id, 'Project Director');
  const p = await saveProject(master, null, {
    name, agent_id: director,
    members: [{ user_id: francisca.id, role: 'store' }, { user_id: tauqeer.id, role: 'manager' }],
  });
  return { master, francisca, tauqeer, other, id: p.project.id };
}

test('the JVC project starts with the drawing-check questions, once; another project starts empty', async () => {
  const { francisca, other, id } = await setup();
  const r = await issuesOf(francisca, id);
  assert.equal(r.issues.length, 4);
  assert.ok(r.issues.every((i) => i.status === 'open' && i.floor === 'Basement' && i.step === 'Blockwork'));
  assert.match(r.issues.map((i) => i.text).join(' '), /Pool deck level/);
  await issuesOf(francisca, id);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM project_issues').get()).n, 4);
  assert.equal(await issuesOf(other, id), null);

  const next = await setup('Al Barsha Villa');
  assert.equal((await issuesOf(next.francisca, next.id)).issues.length, 0);
  await progressOf(next.francisca, next.id);
  assert.equal((await areasOf(next.id)).length, 0); // the JVC take-off is JVC's only
});

test('an issue is raised from a card; only a manager closes it, with the answer', async () => {
  const { francisca, tauqeer, id } = await setup();
  const c = await proposeIssue(francisca, { text: 'Pump room door frame is the wrong size', floor: 'basement', step: 'doors' });
  assert.equal(c.data.step, 'Doors, floors and paint');
  assert.equal((await issuesOf(francisca, id)).issues.length, 4); // a card is not an issue
  await confirmCard(francisca, c.id, push);
  const mine = (await issuesOf(francisca, id)).issues.find((i) => i.text.startsWith('Pump room door'));
  assert.equal(mine.opened_by, 'Francisca');
  await assert.rejects(proposeClose(francisca, { issue: 'door frame', answer: 'replaced' }), /Only a manager/);
  await assert.rejects(proposeClose(tauqeer, { issue: 'zzz', answer: 'x' }), /No open issue/);
  const close = await proposeClose(tauqeer, { issue: `#${mine.id}`, answer: 'Supplier replaces it Thursday' });
  await confirmCard(tauqeer, close.id, push);
  const closed = (await issuesOf(tauqeer, id)).issues.find((i) => i.id === mine.id);
  assert.deepEqual([closed.status, closed.answer, closed.closed_by], ['closed', 'Supplier replaces it Thursday', 'Tauqeer']);
  // On the screen too, and never twice.
  const pool = (await issuesOf(tauqeer, id)).issues.find((i) => /Pool deck/.test(i.text));
  await assert.rejects(closeIssueOnScreen(francisca, pool.id, { answer: '−3.00' }), /Only a manager/);
  await closeIssueOnScreen(tauqeer, pool.id, { answer: 'Consultant: −3.00' });
  await assert.rejects(closeIssueOnScreen(tauqeer, pool.id, { answer: 'again' }), /already closed/);
  await saveIssue(francisca, id, { text: 'Generator louvre size?', asked: 'Consultant' });
  assert.equal((await issuesOf(francisca, id)).issues.filter((i) => i.status === 'open').length, 4);
});

test('a wall check: what was ticked passes, the rest fails and goes to the managers', async () => {
  const { francisca, tauqeer, id } = await setup();
  await assert.rejects(proposeInspection(francisca, { failed: ['colour'] }), /Which check/);
  const c = await proposeInspection(francisca, { floor: 'Basement', area: 'Pump room', failed: ['joints full', 'ties'], note: 'east wall' });
  assert.deepEqual(c.data.failed, ['Joints full, about 10 mm', 'Tied to columns every 2-3 courses']);
  // On the card she ticks everything but the joints: the ties turned out fine.
  await confirmCard(francisca, c.id, push, { passed: WALL_CHECKS.filter((x) => !x.startsWith('Joints full')) });
  const [check] = (await issuesOf(francisca, id)).checks;
  assert.deepEqual(check.failed, ['Joints full, about 10 mm']);
  assert.deepEqual(pushes[0].ids, [tauqeer.id]);
  assert.match(pushes[0].title, /wall check failed \(Basement, Pump room\)/);
  // All passed: nobody is bothered.
  const ok = await proposeInspection(francisca, { area: 'Generator room' });
  await confirmCard(francisca, ok.id, push, { passed: WALL_CHECKS });
  assert.equal(pushes.length, 1);
});

test('the chat tools for issues and checks, and open issues in the progress answer', async () => {
  const { francisca, tauqeer } = await setup();
  const names = (await projectKit(francisca)).definitions.map((d) => d.name);
  assert.ok(['project_issues', 'log_issue', 'log_wall_check'].every((n) => names.includes(n)));
  assert.ok(!names.includes('close_issue'));
  assert.ok((await projectKit(tauqeer)).definitions.some((d) => d.name === 'close_issue'));
  const kit = await projectKit(francisca, {});
  const read = await kit.run({ id: 't', name: 'project_issues', input: {} });
  assert.match(read.content, /Open issues \(4\)/);
  const progress = await kit.run({ id: 'p', name: 'project_progress', input: {} });
  assert.match(progress.content, /Open issues \(4;/);
});

test('the 5 pm reminder asks for the day\'s progress too, once progress is in use', async () => {
  const { francisca, id } = await setup();
  await progressOf(francisca, id);
  const at = Date.now();
  const fivePm = Date.parse(`${new Date(at + 4 * 3600_000).toISOString().slice(0, 10)}T13:30:00Z`);
  // Manpower sent today, no progress: one push, asking for progress only.
  const m = await proposeManpower(francisca, { rows: [{ trade: 'Masons', count: 8 }] });
  await db.prepare(`UPDATE project_proposals SET data = jsonb_set(data, '{day}', to_jsonb(?::text)) WHERE id = ?`).run(new Date(fivePm + 4 * 3600_000).toISOString().slice(0, 10), m.id);
  await confirmCard(francisca, m.id, push);
  assert.equal(await remindManpower(push, fivePm), 1);
  assert.match(pushes.at(-1).body, /anything done or blocked/);
  assert.doesNotMatch(pushes.at(-1).body, /manpower/);
  // The next day, both sent: no push.
  await db.prepare('UPDATE projects SET reminded_on = NULL WHERE id = ?').run(id);
  const c = await proposeProgress(francisca, { floor: 'Basement', step: 'Blockwork', percent: 10 });
  await confirmCard(francisca, c.id, push);
  await db.prepare('UPDATE project_proposals SET decided_at = ? WHERE id = ?').run(Math.floor(fivePm / 1000) - 3600, c.id);
  assert.equal(await remindManpower(push, fivePm), 0);
});
