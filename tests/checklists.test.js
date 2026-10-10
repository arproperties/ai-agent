import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb } from './helpers/db.js';
import {
  draftItems, createChecklist, listChecklists, updateChecklist, deleteChecklist,
  startRun, tick, getRun, deleteRun, teamChecklists, dayOf,
} from '../server/checklists.js';

test.after(() => closeDb());

// Dubai wall-clock, because "today" is the user's day and not the server's.
const at = (iso) => Math.round(Date.parse(`${iso}+04:00`) / 1000);
const MON = at('2026-10-05T10:00:00');
const TUE = at('2026-10-06T10:00:00');

test('Reem decides the points from a title and description', async () => {
  let asked = '';
  const items = await draftItems({ title: ' Move  out ', description: 'Unit handover' }, async (prompt) => {
    asked = prompt;
    return 'Here you go:\n{"items": ["Collect the keys", "  ", "Read the meters", "Collect the keys"]}';
  });
  assert.match(asked, /Title: Move out\nDescription: Unit handover/);
  assert.deepEqual(items, ['Collect the keys', 'Read the meters', 'Collect the keys'], 'empty points are dropped');

  await assert.rejects(draftItems({ title: '' }, async () => '{}'), /title first/);
  await assert.rejects(draftItems({ title: 'x' }, async () => 'sorry, no'), /could not make the points/);
  await assert.rejects(draftItems({ title: 'x' }, async () => '{"items": []}'), /could not make the points/);
});

test('the day turns over at midnight in Dubai, not in UTC', () => {
  assert.equal(dayOf(at('2026-10-05T23:59:00')), '2026-10-05');
  assert.equal(dayOf(at('2026-10-06T00:01:00')), '2026-10-06');
});

test('a daily checklist comes back empty each day and keeps each day as it was', async () => {
  await reset();
  const rona = { id: await makeUser('Rona'), role: 'user' };
  const c = await createChecklist(rona.id, { title: 'Office opening', kind: 'daily', items: ['Lights', 'Check email', ''] });
  assert.equal(c.items.length, 2);

  let [mon] = await listChecklists(rona.id, MON);
  assert.equal(mon.today.id, null, 'nothing is written until the first tick');
  assert.deepEqual([mon.today.done, mon.today.total], [0, 2]);

  const run = await startRun(rona, c.id, {}, MON);
  assert.equal((await startRun(rona, c.id, {}, MON + 60)).id, run.id, 'one go per day');
  await tick(rona, run.id, run.items[0].id, true, MON);
  assert.equal((await getRun(rona, run.id)).finished_at, null);
  const full = await tick(rona, run.id, run.items[1].id, true, MON + 5);
  assert.equal(full.finished_at, MON + 5, 'finished on the last tick');
  assert.equal((await tick(rona, run.id, run.items[1].id, false, MON + 9)).finished_at, null, 'and not, once one is unticked');

  const [tue] = await listChecklists(rona.id, TUE);
  assert.deepEqual([tue.today.id, tue.today.done], [null, 0], 'Tuesday starts empty');
  const monday = tue.week.find((d) => d.day === '2026-10-05');
  assert.deepEqual([monday.run_id, monday.done, monday.total], [run.id, 1, 2], 'Monday is kept as it ended');
  await assert.rejects(tick(rona, run.id, run.items[1].id, true, TUE), /day has passed/);
});

test('editing a daily checklist carries into today and keeps the ticks made', async () => {
  await reset();
  const rona = { id: await makeUser('Rona'), role: 'user' };
  const c = await createChecklist(rona.id, { title: 'Closing', kind: 'daily', items: ['Lock up', 'Alarm'] });
  const run = await startRun(rona, c.id, {}, MON);
  await tick(rona, run.id, run.items[0].id, true, MON);

  const next = await updateChecklist(rona.id, c.id, {
    items: [{ text: 'Cash count' }, { id: c.items[0].id, text: 'Lock both doors' }],
  }, MON + 60);
  assert.deepEqual(next.items.map((i) => i.text), ['Cash count', 'Lock both doors'], 'Alarm is gone, order is as given');
  assert.deepEqual(next.today.items.map((i) => [i.text, !!i.done_at]), [['Cash count', false], ['Lock both doors', true]]);

  await assert.rejects(updateChecklist(rona.id, c.id, { items: [] }), /at least one point/);
  await assert.rejects(updateChecklist(rona.id, c.id, { kind: 'weekly' }), /daily or started when needed/);
});

test('a when-needed checklist is started as often as the job comes up', async () => {
  await reset();
  const rona = { id: await makeUser('Rona'), role: 'user' };
  const c = await createChecklist(rona.id, { title: 'Move-out', description: 'Handover', kind: 'ondemand', items: ['Keys', 'Meters'] });
  assert.equal(c.today, null);

  const a = await startRun(rona, c.id, { label: ' Unit  304 ' }, MON);
  const b = await startRun(rona, c.id, { label: 'Unit 112' }, MON);
  assert.notEqual(a.id, b.id);
  assert.equal(a.label, 'Unit 304');

  // A go keeps the points it was started with, whatever happens to the checklist after.
  await updateChecklist(rona.id, c.id, { items: ['Keys', 'Meters', 'Photos'] }, MON);
  assert.equal((await getRun(rona, a.id)).total, 2);
  assert.equal((await startRun(rona, c.id, { label: 'Unit 9' }, TUE)).total, 3);

  for (const i of a.items) await tick(rona, a.id, i.id, true, TUE); // any day, unlike a daily one
  const [list] = await listChecklists(rona.id, TUE);
  assert.deepEqual(list.runs.map((r) => [r.label, r.done, r.total]), [['Unit 9', 0, 3], ['Unit 112', 0, 2], ['Unit 304', 2, 2]]);
  assert.ok(list.runs[2].finished_at);

  assert.equal(await deleteRun(rona.id, b.id), true);
  assert.equal(await deleteChecklist(rona.id, c.id), true);
  assert.equal(await getRun(rona, a.id), null, 'its goes leave with it');
});

test('each person has their own; the master sees everyone but ticks nothing', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const rona = { id: await makeUser('Rona'), role: 'user' };
  const sam = { id: await makeUser('Sam'), role: 'user' };
  await createChecklist(master.id, { title: 'Mine', kind: 'daily', items: ['x'] });
  const c = await createChecklist(rona.id, { title: 'Opening', kind: 'daily', items: ['Lights', 'Email'] });
  const run = await startRun(rona, c.id, {}, MON);
  await tick(rona, run.id, run.items[0].id, true, MON);

  assert.equal((await listChecklists(sam.id, MON)).length, 0);
  assert.equal(await startRun(sam, c.id, {}, MON), null);
  assert.equal(await updateChecklist(sam.id, c.id, { title: 'Hijack' }), null);
  assert.equal(await getRun(sam, run.id), null);
  assert.equal(await tick(sam, run.id, run.items[1].id, true, MON), null);

  const team = await teamChecklists(master, MON);
  assert.deepEqual(team.map((p) => p.name), ['Rona'], 'only people with a checklist, and not the master themself');
  assert.deepEqual([team[0].checklists[0].today.done, team[0].checklists[0].today.total], [1, 2]);
  assert.equal((await getRun(master, run.id)).done, 1, 'the master can open it');
  assert.equal(await tick(master, run.id, run.items[1].id, true, MON), null, 'but not tick it');
});
