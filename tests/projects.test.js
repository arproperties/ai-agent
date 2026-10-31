import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, closeDb, db } from './helpers/db.js';
import { projectRole, projectsOf } from '../server/access.js';
import {
  saveProject, getProject, getProposal, stockOf, manpowerOf, checksFor, projectKit, remindManpower,
  proposeDelivery, proposeOut, proposeManpower, acceptDelivery, sendToManager, decideDelivery, confirmCard, cancelCard,
} from '../server/projects.js';

test.after(() => closeDb());

const pushes = [];
const push = async (ids, msg) => { pushes.push({ ids, ...msg }); return ids.length; };

// The JVC school: Francisca keeps the store on site, Tauqeer decides from the office.
async function setup() {
  await reset();
  pushes.length = 0;
  const master = { id: await makeUser('Owner'), role: 'master' };
  const francisca = { id: await makeUser('Francisca'), role: 'user' };
  const tauqeer = { id: await makeUser('Tauqeer'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  const outsider = { id: await makeUser('Outsider'), role: 'user', external: true };
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(outsider.id);
  const director = await makeAgent(master.id, 'Project Director');
  const p = await saveProject(master, null, {
    name: 'JVC School', agent_id: director,
    members: [{ user_id: francisca.id, role: 'store' }, { user_id: tauqeer.id, role: 'manager' }],
  });
  return { master, francisca, tauqeer, other, outsider, director, id: p.project.id };
}

const blocks = (extra = {}) => ({ item: 'Hollow block 200mm', quantity: 3000, supplier: 'Ducon', ...extra });

test('only the master sets up a project, and nobody external can be put on one', async () => {
  const { master, francisca, outsider, id } = await setup();
  await assert.rejects(saveProject(francisca, null, { name: 'Mine' }), /Only the master/);
  await assert.rejects(saveProject(master, id, { name: 'JVC School', members: [{ user_id: outsider.id, role: 'store' }] }), /outside the company/);
  const p = await getProject(master, id);
  assert.deepEqual(p.project.floors, ['Basement', 'Ground', '1st', '2nd', '3rd', 'Roof']);
  assert.deepEqual(p.members.map((m) => [m.name, m.role]), [['Tauqeer', 'manager'], ['Francisca', 'store']]);
});

test('a project is seen by its members and the master, never by anyone else', async () => {
  const { master, francisca, tauqeer, other, outsider, id } = await setup();
  assert.equal(await projectRole(master, id), 'master');
  assert.equal(await projectRole(francisca, id), 'store');
  assert.equal(await projectRole(tauqeer, id), 'manager');
  assert.equal(await projectRole(other, id), null);
  assert.equal(await getProject(other, id), null);
  // A member row left behind does not let someone external in.
  await db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'store')`).run(id, outsider.id);
  assert.equal(await projectRole(outsider, id), null);
  assert.deepEqual(await projectsOf(outsider), []);
  assert.deepEqual((await projectKit(other)).definitions, []);
});

test('a delivery goes into stock only when every check is ticked and Accept is tapped', async () => {
  const { francisca, id } = await setup();
  const c = await proposeDelivery(francisca, blocks());
  assert.equal(c.status, 'pending');
  assert.deepEqual(c.data.checks, checksFor('Hollow block 200mm'));
  assert.ok(c.data.checks.includes('Approval / strength certificate'));
  assert.deepEqual(await stockOf(id), []); // a card is not stock
  await assert.rejects(acceptDelivery(francisca, c.id, { passed: c.data.checks.slice(1) }), /Send it to the manager/);
  const done = await acceptDelivery(francisca, c.id, { passed: c.data.checks });
  assert.equal(done.status, 'accepted');
  await assert.rejects(acceptDelivery(francisca, c.id, { passed: c.data.checks }), /already decided/); // a double tap adds once
  const [s] = await stockOf(id);
  assert.equal(s.on_site, 3000);
});

test('a failed check goes to the manager; Francisca cannot decide it, Tauqeer can', async () => {
  const { francisca, tauqeer, id } = await setup();
  const c = await proposeDelivery(francisca, blocks({ quantity: 2000 }));
  const sent = await sendToManager(francisca, c.id, { passed: c.data.checks.filter((x) => x !== 'Few or no broken blocks'), note: 'about 8% broken' }, push);
  assert.equal(sent.status, 'sent');
  assert.deepEqual(sent.failed, ['Few or no broken blocks']);
  assert.deepEqual(pushes[0].ids, [tauqeer.id]);
  assert.match(pushes[0].body, /broken/);
  assert.equal((await getProject(tauqeer, id)).waiting.length, 1);

  await assert.rejects(decideDelivery(francisca, c.id, { verdict: 'accept' }, push), /Only a manager/);
  await assert.rejects(decideDelivery(tauqeer, c.id, { verdict: 'reject' }, push), /Say why/);
  const r = await decideDelivery(tauqeer, c.id, { verdict: 'reject', note: 'Too many broken' }, push);
  assert.equal(r.status, 'rejected');
  assert.deepEqual(pushes[1].ids, [francisca.id]); // she hears back
  assert.deepEqual(await stockOf(id), []); // a rejected delivery adds nothing
});

test('a manager accepting with a note puts it into stock', async () => {
  const { francisca, tauqeer, id } = await setup();
  const c = await proposeDelivery(francisca, { item: 'Cement OPC', quantity: 100, counted_in: 'bags' });
  await sendToManager(francisca, c.id, { passed: [] }, push);
  const a = await decideDelivery(tauqeer, c.id, { verdict: 'accept', note: 'ask for credit on 5 torn bags' }, push);
  assert.equal(a.status, 'accepted_note');
  const [s] = await stockOf(id);
  assert.deepEqual([s.item, s.counted_in, s.on_site], ['Cement OPC', 'bags', 100]);
});

test('material given out comes off stock once confirmed, under the name already used', async () => {
  const { francisca, id } = await setup();
  const c = await proposeDelivery(francisca, blocks());
  await acceptDelivery(francisca, c.id, { passed: c.data.checks });
  const out = await proposeOut(francisca, { item: 'hollow BLOCK 200mm', quantity: 900, floor: 'ground', given_to: 'GF masons' });
  assert.equal(out.data.item, 'Hollow block 200mm');
  assert.equal(out.data.floor, 'Ground');
  assert.equal(out.on_site, 3000);
  assert.equal((await stockOf(id))[0].on_site, 3000); // not until Confirm
  await confirmCard(francisca, out.id);
  const [s] = await stockOf(id);
  assert.deepEqual([s.received, s.given, s.on_site], [3000, 900, 2100]);
});

test('a day\'s manpower replaces what was sent earlier that day', async () => {
  const { francisca, master, id } = await setup();
  const a = await proposeManpower(francisca, { date: '2026-10-28', rows: [{ trade: 'Masons', count: 3 }, { trade: 'Helpers', count: 10 }] });
  await confirmCard(francisca, a.id);
  const b = await proposeManpower(francisca, { date: '2026-10-28', rows: [{ trade: 'Masons', count: 8 }, { trade: 'Helpers', count: 15, subcontractor: 'ABC' }] });
  assert.equal(b.data.replaces, true);
  await confirmCard(francisca, b.id);
  const [day] = await manpowerOf(master, id);
  assert.equal(day.day, '2026-10-28');
  assert.equal(day.total, 23);
});

test('only the store keeper and managers record; a card can be cancelled before it is tapped', async () => {
  const { francisca, master, other } = await setup();
  await assert.rejects(proposeDelivery(other, blocks()), /no project/);
  const c = await proposeOut(francisca, { item: 'Cement', quantity: 5, counted_in: 'bags' });
  assert.equal((await cancelCard(francisca, c.id)).status, 'cancelled');
  await assert.rejects(confirmCard(francisca, c.id), /already decided/);
  // The master's own card, for the same project: allowed, and seen by Francisca as well.
  const m = await proposeManpower(master, { rows: [{ trade: 'Helpers', count: 4 }] });
  assert.ok(await getProposal(francisca, m.id));
  assert.equal(await getProposal(other, m.id), null);
});

test('the chat tools only get cards ready, and the records say where recording began', async () => {
  const { francisca, director, other } = await setup();
  const cards = [];
  const kit = await projectKit(francisca, { agentId: director, onCard: (c) => cards.push(c) });
  assert.deepEqual(kit.definitions.map((d) => d.name).sort(), ['log_delivery', 'log_manpower', 'log_material_out', 'project_records', 'project_status']);
  const before = await kit.run({ id: 't0', name: 'project_records', input: {} });
  assert.match(before.content, /Nothing has been recorded/);
  const r = await kit.run({ id: 't1', name: 'log_delivery', input: blocks() });
  assert.match(r.content, /NOT recorded yet/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'pending');
  // Someone not on the project gets no tools at all.
  assert.deepEqual((await projectKit(other)).definitions, []);
});

test('the 5 pm reminder goes once a day, only when no manpower was sent', async () => {
  const { francisca, id } = await setup();
  const at = Date.parse('2026-10-31T13:30:00Z'); // 5:30 pm in Dubai
  assert.equal(await remindManpower(push, Date.parse('2026-10-31T08:00:00Z')), 0); // noon: too early
  assert.equal(await remindManpower(push, at), 1);
  assert.deepEqual(pushes[0].ids, [francisca.id]);
  assert.equal(await remindManpower(push, at + 600_000), 0); // once a day
  const m = await proposeManpower(francisca, { date: '2026-11-01', rows: [{ trade: 'Masons', count: 8 }] });
  await db.prepare(`UPDATE project_proposals SET data = jsonb_set(data, '{day}', '"2026-11-01"') WHERE id = ?`).run(m.id);
  await confirmCard(francisca, m.id);
  assert.equal(await remindManpower(push, at + 86400_000), 0); // the next day's was sent
  assert.ok(id);
});
