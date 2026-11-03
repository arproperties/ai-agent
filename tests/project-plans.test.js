import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, makeDoc, closeDb, db } from './helpers/db.js';
import { saveProject } from '../server/projects.js';
import { progressOf } from '../server/projectProgress.js';
import {
  setAi, work, proposePlan, answerPlan, changePlan, getPlan, startPlan, cancelPlan, cleanPlan, countedProblems,
  lateOf, watchPlans, decideAlert, projectPlanView, planKit, dropRepeats,
} from '../server/projectPlans.js';
import { dubaiDate } from '../server/saifsys/client.js';

test.after(() => closeDb());

const pushes = [];
const push = async (ids, msg) => { pushes.push({ ids, ...msg }); return ids.length; };
const noRun = () => {};

// What "Claude" answers in these tests, by the tool it was asked for. plan() can be swapped per test.
const FLOORS = ['Basement', 'Ground', '1st', '2nd', '3rd', 'Roof'];
const goodPlan = () => ({
  start_day: '2026-11-02',
  summary: 'Basement first, then up a floor at a time.',
  phases: [{ name: 'Programme', goal: 'Weeks per floor', checks: ['Every step has weeks'] }],
  steps: [
    { floor: 'Basement', stage: 'concrete', name: 'Concrete: columns, walls and slab', who: 'Structure', week_from: 1, week_to: 3, hold_point: 'Rebar checked before pour (consultant)', points: ['Rebar', 'Formwork'] },
    { floor: 'Basement', stage: 'blockwork', name: 'Blockwork', who: 'Masons', week_from: 4, week_to: 6, hold_point: 'First courses checked (consultant)', points: ['Plant rooms first'] },
    { floor: 'Basement', stage: 'mep', name: 'MEP first fix', week_from: 5, week_to: 7, hold_point: 'MEP in walls checked before plaster (consultant)' },
    { floor: 'Basement', stage: 'finishes', name: 'Waterproofing test', week_from: 7, week_to: 7, hold_point: 'Flood test signed (consultant)' },
    { floor: 'Ground', stage: 'concrete', name: 'Ground slab', week_from: 4, week_to: 6 },
  ],
  materials: [{ item: 'Hollow block 200mm', counted_in: 'pcs', quantity: 9000, floor: 'Basement', needed_week: 4, order_by_week: 2 }],
  manpower: [{ trade: 'Masons', count: 8, week_from: 1, week_to: 7 }],
  risks: [{ risk: 'Summer heat', owner: 'Site manager', action: 'Pour at night' }],
});
let plan = goodPlan;
let calls = [];
const fakeAi = async (args) => {
  calls.push(args);
  const tool = args.tool_choice?.name;
  const answer = tool === 'project_facts' ? {
    name: 'School (B+G+3) JVC', summary: 'A private school.', floors: FLOORS.map((name) => ({ name })),
    facts: [{ label: 'Plot', value: 'JVC14SCP100' }], questions: ['Start date?', 'Budget?'],
  } : tool === 'project_plan' ? plan() : tool === 'plan_check' ? { problems: [] } : null;
  return {
    model: 'claude-sonnet-5-5', stop_reason: tool ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 10_000, output_tokens: 2_000 },
    content: tool ? [{ type: 'tool_use', name: tool, input: answer }] : [{ type: 'text', text: 'Notes: B+G+3 school.' }],
  };
};

async function setup() {
  await reset();
  pushes.length = 0;
  calls = [];
  plan = goodPlan;
  setAi(fakeAi);
  const master = { id: await makeUser('Owner'), role: 'master' };
  const francisca = { id: await makeUser('Francisca'), role: 'user' };
  const arzhel = { id: await makeUser('Arzhel'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  const agent = await makeAgent(master.id, 'Project Director');
  const p = await saveProject(master, null, {
    name: 'JVC School', agent_id: agent,
    members: [{ user_id: francisca.id, role: 'store' }, { user_id: arzhel.id, role: 'manager' }],
  });
  // The drawing set, as the Shelf keeps it: a DWG is read from its kept text.
  const doc = await makeDoc(master.id, null, 'Arch-TRK.dwg');
  await db.prepare(`UPDATE documents SET path = '/nowhere/Arch-TRK.dwg', mime = 'application/acad' WHERE id = ?`).run(doc);
  await db.prepare('INSERT INTO document_texts (document_id, text) VALUES (?, ?)').run(doc, 'SCHOOL (B+G+3) JVC, plot JVC14SCP100, levels -4.10 to +20.20');
  return { master, francisca, arzhel, other, projectId: p.project.id, doc };
}

/** From one file to a plan ready to start, the way the chat does it. */
async function ready(s) {
  const card = await proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun });
  await work(card.id, { push });
  await answerPlan(s.master, { answers: 'Start 2 Nov 2026, budget 40m' }, { run: noRun });
  await work(card.id, { push });
  return card.id;
}

test('one file: read, questions asked, then the plan written and checked; only the master', async () => {
  const s = await setup();
  await assert.rejects(proposePlan(s.francisca, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun }), { status: 403 });
  const card = await proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun });
  assert.equal(card.status, 'reading');
  assert.equal(card.project.name, 'JVC School');
  await work(card.id, { push });
  let c = await getPlan(s.master, card.id);
  assert.equal(c.status, 'asking');
  assert.deepEqual(c.questions, ['Start date?', 'Budget?']);
  assert.match(pushes.at(-1).body, /2 questions/);
  // The facts were asked for with the project's own floor names.
  assert.match(calls.at(-1).messages[0].content[0].text, /Basement, Ground, 1st/);
  // The same file twice is refused while the first plan is open.
  await assert.rejects(proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun }), /already being made/);

  await answerPlan(s.master, { answers: 'Start 2 Nov 2026' }, { run: noRun });
  await work(card.id, { push });
  c = await getPlan(s.master, card.id);
  assert.equal(c.status, 'planned', c.error);
  assert.equal(c.plan.counts.steps, 5);
  assert.deepEqual(c.problems, []);
  assert.ok(c.spent > 0);
  assert.equal(await getPlan(s.francisca, card.id), null);
  assert.equal(await getPlan(s.other, card.id), null);
});

test('a plan that keeps failing its checks is never kept; staff get no plan tools', async () => {
  const s = await setup();
  plan = () => ({ ...goodPlan(), steps: [{ floor: 'Mezzanine', stage: 'concrete', name: 'Slab', week_from: 1, week_to: 2 }] });
  const card = await proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun });
  await work(card.id, { push });
  await answerPlan(s.master, { answers: 'none' }, { run: noRun });
  await work(card.id, { push });
  const c = await getPlan(s.master, card.id);
  assert.equal(c.status, 'failed');
  assert.match(c.error, /Mezzanine/);
  assert.equal(c.plan, null);
  assert.equal(planKit(s.francisca).definitions.length, 0);
  assert.equal(planKit(s.master).definitions.length, 4);
});

test('the limit stops the work and the plan waits; raising it lets it go on', async () => {
  const s = await setup();
  const card = await proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'JVC' }, { run: noRun });
  await work(card.id, { push });
  await db.prepare('UPDATE project_plans SET spend_limit = spent WHERE id = ?').run(card.id);
  await answerPlan(s.master, { answers: 'go' }, { run: noRun });
  await work(card.id, { push });
  let c = await getPlan(s.master, card.id);
  assert.equal(c.status, 'asking');
  assert.match(c.error, /limit/);
  await assert.rejects(answerPlan(s.master, { raise_limit_to: 99 }, { run: noRun }), /50 at most/);
  await answerPlan(s.master, { raise_limit_to: 10 }, { run: noRun });
  await work(card.id, { push });
  c = await getPlan(s.master, card.id);
  assert.equal(c.status, 'planned');
  assert.equal(c.spend_limit, 10);
});

test('Start merges into the project once: what the site recorded stays, nothing is deleted', async () => {
  const s = await setup();
  // The project already has its template steps, and the store keeper already reported one.
  await progressOf(s.master, s.projectId);
  const before = (await db.prepare('SELECT count(*)::int AS n FROM project_steps WHERE project_id = ?').get(s.projectId)).n;
  await db.prepare(`UPDATE project_steps SET status = 'in_progress', percent = 40 WHERE project_id = ? AND floor = 'Basement' AND name = 'Blockwork'`).run(s.projectId);
  const id = await ready(s);
  await assert.rejects(startPlan(s.francisca, id, { push }).then((r) => { if (!r) throw Object.assign(new Error('no'), { status: 404 }); }), { status: 404 });
  const started = await startPlan(s.master, id, { push });
  assert.equal(started.status, 'started');
  assert.deepEqual(started.merged, { added: 2, updated: 3 }); // the template also has Concrete, Blockwork and MEP first fix
  await assert.rejects(startPlan(s.master, id, { push }), { status: 409 });
  const after = await db.prepare('SELECT * FROM project_steps WHERE project_id = ?').all(s.projectId);
  assert.equal(after.length, before + 2);
  const block = after.find((x) => x.floor === 'Basement' && x.name === 'Blockwork');
  assert.equal(block.status, 'in_progress');
  assert.equal(block.percent, 40);
  const shift = (await db.prepare('SELECT start_day FROM projects WHERE id = ?').get(s.projectId)).start_day === '2026-11-02' ? 0 : null;
  if (shift === 0) assert.deepEqual([block.week_from, block.week_to], [4, 6]);
  assert.match(pushes.at(-1).title, /the plan is set/);
  assert.deepEqual(pushes.at(-1).ids.sort(), [s.francisca.id, s.arzhel.id].sort());
  assert.ok(started.report_doc_id, 'the plan PDF is on the Shelf');
});

test('Start with "new" makes the project from the file, without the template on top', async () => {
  const s = await setup();
  const card = await proposePlan(s.master, { file: 'Arch-TRK.dwg', project: 'new' }, { run: noRun });
  await work(card.id, { push });
  await answerPlan(s.master, { answers: 'none' }, { run: noRun });
  await work(card.id, { push });
  const started = await startPlan(s.master, card.id, { push });
  assert.equal(started.project.name, 'School (B+G+3) JVC');
  const pr = await progressOf(s.master, started.project.id);
  assert.equal(pr.floors.reduce((n, f) => n + f.steps.length, 0), 5);
  assert.equal(pr.start_day, '2026-11-02');
});

test('a ready plan can be changed or cancelled; a started one cannot', async () => {
  const s = await setup();
  const id = await ready(s);
  await changePlan(s.master, { change: 'Ground slab 1 week later' }, { run: noRun });
  assert.equal((await getPlan(s.master, id)).status, 'planning');
  await work(id, { push });
  assert.match(calls.filter((c) => c.tool_choice?.name === 'project_plan').at(-1).messages[0].content[0].text, /Ground slab 1 week later/);
  await cancelPlan(s.master, id);
  assert.equal((await getPlan(s.master, id)).status, 'cancelled');
  await assert.rejects(startPlan(s.master, id, { push }), { status: 409 });
});

test('late against the plan: raised once, to the master and the people on site; only the master moves the weeks', async () => {
  const s = await setup();
  const id = await ready(s);
  await startPlan(s.master, id, { push });
  // Week 6 of the programme: basement concrete (weeks 1-3) not done, blocks not delivered.
  await db.prepare(`UPDATE projects SET start_day = ? WHERE id = ?`).run(dubaiDate(Date.now() - 5 * 7 * 86400_000), s.projectId);
  await db.prepare(`UPDATE project_steps SET status = 'in_progress', percent = 60 WHERE project_id = ? AND floor = 'Basement' AND name LIKE 'Concrete%'`).run(s.projectId);
  const row = await db.prepare('SELECT * FROM project_plans WHERE id = ?').get(id);
  const late = await lateOf(row);
  const concrete = late.find((a) => a.kind === 'not_finished' && /Concrete/.test(a.text));
  assert.ok(concrete);
  assert.ok(late.some((a) => a.kind === 'material' && /Hollow block/.test(a.text)));
  // Concrete ends next week (7); the blockwork after it moves by as much (4-6 → 8-10).
  const nine = new Date(); nine.setUTCHours(5, 0, 0, 0); // 9 am in Dubai
  pushes.length = 0;
  assert.equal(await watchPlans(push, nine.getTime()), 1);
  assert.equal(await watchPlans(push, nine.getTime()), 0);
  assert.deepEqual(pushes[0].ids.sort(), [s.master.id, s.francisca.id, s.arzhel.id].sort());
  await db.prepare('UPDATE project_plans SET watched_on = NULL').run();
  assert.equal(await watchPlans(push, nine.getTime()), 0, 'the same things are not raised twice');

  const view = await projectPlanView(s.francisca, s.projectId);
  assert.equal(view.can_decide, false);
  const alert = view.alerts.find((a) => a.kind === 'not_finished' && /Concrete/.test(a.text));
  await assert.rejects(decideAlert(s.arzhel, alert.id, { accept: true }), { status: 403 });
  const moved = alert.change.find((c) => c.name === 'Blockwork');
  await decideAlert(s.master, alert.id, { accept: true });
  await assert.rejects(decideAlert(s.master, alert.id, { accept: true }), { status: 409 });
  const block = await db.prepare(`SELECT week_from, week_to FROM project_steps WHERE id = ?`).get(moved.step_id);
  assert.deepEqual([block.week_from, block.week_to], moved.to);
  assert.equal(await projectPlanView(s.other, s.projectId), null);
});

test('the plan is cleaned and counted before anyone sees it', () => {
  const { plan: p, errors } = cleanPlan({ ...goodPlan(), steps: [...goodPlan().steps, { floor: 'basement', stage: 'mep', name: 'Ducts', week_from: 5, week_to: 3 }] }, FLOORS);
  assert.equal(p.steps.length, 5);
  assert.match(errors[0], /Ducts/);
  const late = { ...p, materials: [{ item: 'Cement', needed_week: 3, order_by_week: 2 }], manpower: [], risks: [{ risk: 'Rain', owner: '', action: '' }] };
  const problems = countedProblems(late);
  assert.ok(problems.some((x) => /Cement/.test(x)));
  assert.ok(problems.some((x) => /no manpower/.test(x)));
  assert.ok(problems.some((x) => /Rain/.test(x)));
  assert.deepEqual(countedProblems(p), []);
});

test('a drawing set\'s title block is read once, not on every sheet', () => {
  const sheet = (n) => `PROJECT NAME :\nSCHOOL (B+G+3) JVC\nCONSULTANT STAMP :\nSheet ${n}\nLIFT DETAILS`;
  const text = dropRepeats(Array.from({ length: 8 }, (_, i) => sheet(i + 1)).join('\n'));
  assert.equal(text.match(/SCHOOL \(B\+G\+3\) JVC/g).length, 1);
  assert.equal(text.match(/Sheet \d/g).length, 8);
});
