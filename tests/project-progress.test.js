import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, closeDb, db } from './helpers/db.js';
import { saveProject, confirmCard, cancelCard, projectKit } from '../server/projects.js';
import {
  progressOf, proposeProgress, proposeSignoff, stepHistory, setStartDay, saveStep, deleteStep, moveStep, weekOf,
} from '../server/projectProgress.js';
import { dubaiDate } from '../server/saifsys/client.js';

test.after(() => closeDb());

const pushes = [];
const push = async (ids, msg) => { pushes.push({ ids, ...msg }); return ids.length; };

// The JVC school again: Francisca keeps the store on site, Tauqeer decides from the office.
async function setup() {
  await reset();
  pushes.length = 0;
  const master = { id: await makeUser('Owner'), role: 'master' };
  const francisca = { id: await makeUser('Francisca'), role: 'user' };
  const tauqeer = { id: await makeUser('Tauqeer'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  const director = await makeAgent(master.id, 'Project Director');
  const p = await saveProject(master, null, {
    name: 'JVC School', agent_id: director,
    members: [{ user_id: francisca.id, role: 'store' }, { user_id: tauqeer.id, role: 'manager' }],
  });
  return { master, francisca, tauqeer, other, id: p.project.id };
}

const stepNamed = (pr, floor, name) => pr.floors.find((f) => f.name === floor).steps.find((s) => s.name === name);

test('progress starts from the template once, at week 1 today, and only people on the project see it', async () => {
  const { francisca, tauqeer, other, id } = await setup();
  const pr = await progressOf(francisca, id);
  assert.equal(pr.start_day, dubaiDate());
  assert.equal(pr.week, 1);
  assert.equal(pr.weeks, 13);
  assert.deepEqual(pr.floors.map((f) => f.name), ['Basement', 'Ground', '1st', '2nd', '3rd', 'Roof']);
  const basement = pr.floors[0];
  assert.equal(basement.steps.length, 11);
  assert.ok(basement.steps.every((s) => s.status === 'not_started' && s.percent === 0));
  assert.deepEqual([stepNamed(pr, 'Basement', 'Blockwork').week_from, stepNamed(pr, 'Basement', 'Blockwork').week_to], [1, 6]);
  assert.equal(stepNamed(pr, 'Ground', 'Blockwork').week_from, null); // weeks are the basement's only
  assert.equal(stepNamed(pr, 'Basement', 'Approvals and setting out').points.length, 4);
  // A second look, by anyone, does not seed again.
  await progressOf(tauqeer, id);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM project_steps').get()).n, 66);
  assert.equal(await progressOf(other, id), null);
});

test('a change said in chat waits on its card; Confirm records it once, with the history', async () => {
  const { francisca, id } = await setup();
  const c = await proposeProgress(francisca, {
    floor: 'basement', step: 'blockwork', percent: 40, note: 'north side done', points: ['dowels'],
  });
  assert.equal(c.kind, 'progress');
  assert.equal(c.data.status, 'in_progress');
  assert.equal(stepNamed(await progressOf(francisca, id), 'Basement', 'Blockwork').percent, 0); // a card is not progress
  await confirmCard(francisca, c.id, push);
  await assert.rejects(confirmCard(francisca, c.id, push), /already decided/);
  const s = stepNamed(await progressOf(francisca, id), 'Basement', 'Blockwork');
  assert.deepEqual([s.status, s.percent, s.note], ['in_progress', 40, 'north side done']);
  assert.equal(s.points.find((x) => x.text.startsWith('Dowels')).done, true);
  const h = await stepHistory(francisca, s.id);
  assert.equal(h.length, 1);
  assert.match(h[0].what, /In progress 40% · north side done · ticked: Dowels/);
  assert.equal(pushes.length, 0);
});

test('an unclear step or point is asked about, not guessed', async () => {
  const { francisca } = await setup();
  await assert.rejects(proposeProgress(francisca, { floor: 'Basement', step: 'MEP', status: 'in_progress' }), /more than one step/);
  await assert.rejects(proposeProgress(francisca, { step: 'Blockwork', percent: 10 }), /which floor/);
  await assert.rejects(proposeProgress(francisca, { floor: 'Basement', step: 'Blockwork', points: ['painting'] }), /No open point/);
  await assert.rejects(proposeProgress(francisca, { floor: 'Basement', step: 'Blockwork' }), /Say what changed/);
});

test('blocked needs a reason, and the managers get it once confirmed', async () => {
  const { francisca, tauqeer } = await setup();
  await assert.rejects(proposeProgress(francisca, { floor: 'Basement', step: 'Plaster', status: 'blocked' }), /why it is blocked/);
  const c = await proposeProgress(francisca, { floor: 'Basement', step: 'Plaster', status: 'blocked', note: 'waiting for MEP inspection' });
  await confirmCard(francisca, c.id, push);
  assert.deepEqual(pushes[0].ids, [tauqeer.id]);
  assert.match(pushes[0].body, /Plaster: waiting for MEP inspection/);
});

test('a step with a hold point is Done only after a manager signs it off', async () => {
  const { francisca, tauqeer, id } = await setup();
  await assert.rejects(proposeProgress(francisca, { floor: 'Basement', step: 'Approvals', status: 'done' }), /not signed off/);
  await assert.rejects(proposeSignoff(francisca, { floor: 'Basement', step: 'Approvals' }), /Only a manager/);
  const sign = await proposeSignoff(tauqeer, { floor: 'Basement', step: 'Approvals', signed_by: 'Eng. Bayat' });
  await confirmCard(tauqeer, sign.id, push);
  await assert.rejects(proposeSignoff(tauqeer, { floor: 'Basement', step: 'Approvals' }), /already signed/);
  const c = await proposeProgress(francisca, { floor: 'Basement', step: 'Approvals', status: 'done' });
  assert.equal(c.data.points.length, 4); // Done ticks every open point with it
  await confirmCard(francisca, c.id, push);
  const s = stepNamed(await progressOf(francisca, id), 'Basement', 'Approvals and setting out');
  assert.deepEqual([s.status, s.percent, s.signed.by, s.signed.note], ['done', 100, 'Tauqeer', 'Signed by Eng. Bayat']);
  assert.ok(s.points.every((x) => x.done));
  // A step with no hold point is Done straight away.
  const f = await proposeProgress(francisca, { floor: 'Basement', step: 'MEP final fix', status: 'done' });
  await confirmCard(francisca, f.id, push);
  assert.equal(stepNamed(await progressOf(francisca, id), 'Basement', 'MEP final fix').status, 'done');
});

test('a card made before the hold point changed cannot make the step Done', async () => {
  const { francisca, tauqeer, id } = await setup();
  const sign = await proposeSignoff(tauqeer, { floor: 'Basement', step: 'Approvals' });
  await confirmCard(tauqeer, sign.id, push);
  const c = await proposeProgress(francisca, { floor: 'Basement', step: 'Approvals', status: 'done' });
  const s = stepNamed(await progressOf(tauqeer, id), 'Basement', 'Approvals and setting out');
  await saveStep(tauqeer, null, s.id, { name: s.name, stage: s.stage, hold_point: 'Consultant and Trakhees check', points: s.points.map((x) => x.text) });
  await assert.rejects(confirmCard(francisca, c.id, push), /not signed off/);
  await cancelCard(francisca, c.id);
});

test('managers shape the steps; the store keeper cannot', async () => {
  const { francisca, tauqeer, id } = await setup();
  await progressOf(tauqeer, id);
  await assert.rejects(saveStep(francisca, id, null, { floor: 'Basement', stage: 'finishes', name: 'Pool tiling' }), /Only a manager/);
  let pr = await saveStep(tauqeer, id, null, { floor: 'Basement', stage: 'finishes', name: 'Pool tiling', week_from: 9, week_to: 11, points: ['Waterproofing', 'Water test', 'Tiles'] });
  const pool = stepNamed(pr, 'Basement', 'Pool tiling');
  assert.equal(pr.floors[0].steps.at(-1).id, pool.id);
  // Tick one point, then rewrite the list: the point kept word for word keeps its tick.
  const c = await proposeProgress(francisca, { floor: 'Basement', step: 'Pool tiling', points: ['Waterproofing'] });
  await confirmCard(francisca, c.id, push);
  pr = await saveStep(tauqeer, null, pool.id, { name: 'Pool tiling', week_from: 9, week_to: 11, points: ['Waterproofing', 'Water test 48h', 'Tiles'] });
  assert.deepEqual(stepNamed(pr, 'Basement', 'Pool tiling').points.map((x) => [x.text, x.done]), [['Waterproofing', true], ['Water test 48h', false], ['Tiles', false]]);
  await assert.rejects(saveStep(tauqeer, null, pool.id, { name: 'Pool tiling', week_from: 5, week_to: 2 }), /before the first/);
  pr = await moveStep(tauqeer, pool.id, { dir: -1 });
  assert.equal(pr.floors[0].steps.at(-2).id, pool.id);
  pr = await deleteStep(tauqeer, pool.id);
  assert.equal(stepNamed(pr, 'Basement', 'Pool tiling'), undefined);
  await assert.rejects(deleteStep(francisca, stepNamed(pr, 'Basement', 'Plaster').id), /Only a manager/);
});

test('moving the start day moves the weeks, and a step past its planned end is late', async () => {
  const { francisca, tauqeer, id } = await setup();
  await assert.rejects(setStartDay(francisca, id, { start_day: '2026-01-01' }), /Only a manager/);
  await assert.rejects(setStartDay(tauqeer, id, { start_day: 'soon' }), /as a date/);
  const ago = dubaiDate(Date.now() - 50 * 86400_000); // week 8
  const pr = await setStartDay(tauqeer, id, { start_day: ago });
  assert.equal(pr.week, 8);
  assert.equal(weekOf('2026-11-02', '2026-11-08'), 1);
  assert.equal(weekOf('2026-11-02', '2026-11-09'), 2);
  assert.equal(stepNamed(pr, 'Basement', 'Blockwork').late, true); // planned weeks 1-6
  assert.equal(stepNamed(pr, 'Basement', 'Ceilings').late, false); // 8-10, still in time
  assert.equal(stepNamed(pr, 'Ground', 'Blockwork').late, false); // no weeks set
});

test('the chat tools: reading for everyone on it, cards for the store keeper, sign-off for managers only', async () => {
  const { francisca, tauqeer, other, id } = await setup();
  const store = await projectKit(francisca, { agentId: null });
  const names = store.definitions.map((d) => d.name);
  assert.ok(names.includes('project_progress') && names.includes('log_progress'));
  assert.ok(!names.includes('sign_off'));
  assert.ok((await projectKit(tauqeer)).definitions.some((d) => d.name === 'sign_off'));
  assert.deepEqual((await projectKit(other)).definitions, []);

  const cards = [];
  const kit = await projectKit(francisca, { onCard: (c) => cards.push(c) });
  const read = await kit.run({ id: 't1', name: 'project_progress', input: {} });
  assert.match(read.content, /No progress has been confirmed in Reem yet/);
  assert.match(read.content, /Basement, step by step/);
  assert.match(read.content, /Next on Basement: Concrete/);
  const made = await kit.run({ id: 't2', name: 'log_progress', input: { floor: 'Basement', step: 'Concrete', status: 'done' } });
  assert.match(made.content, /NOT recorded yet/);
  assert.equal(cards.length, 1);
  await confirmCard(francisca, cards[0].id, push);
  const after = await kit.run({ id: 't3', name: 'project_progress', input: { floor: 'basement' } });
  assert.match(after.content, /Next on Basement: Approvals and setting out/);
  assert.match(after.content, /Latest confirmed updates/);
  assert.equal(stepNamed(await progressOf(francisca, id), 'Basement', 'Concrete: columns, walls and slab').status, 'done');
});
