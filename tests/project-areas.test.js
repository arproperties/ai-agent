import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { saveProject, getProject, proposeDelivery, acceptDelivery, proposeOut, confirmCard, projectKit } from '../server/projects.js';
import { progressOf } from '../server/projectProgress.js';
import { areasOf, stockWithNeeds, shortages, proposeArea, saveArea, deleteArea } from '../server/projectAreas.js';

test.after(() => closeDb());

async function setup() {
  await reset();
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

async function deliver(user, item, quantity, extra = {}) {
  const c = await proposeDelivery(user, { item, quantity, supplier: 'Ducon', ...extra });
  return acceptDelivery(user, c.id, { passed: c.data.checks });
}

const total = (areas, item) => areas.filter((a) => a.item === item).reduce((n, a) => n + Number(a.needed), 0);

test('the basement gets the take-off once, under the name already used in stock', async () => {
  const { francisca, id } = await setup();
  await deliver(francisca, 'Hollow Block 200MM', 500); // recorded before the areas existed
  const pr = await progressOf(francisca, id);
  const basement = pr.floors[0].areas;
  assert.equal(basement.length, 12);
  assert.equal(total(basement, 'Hollow Block 200MM'), 9820);
  assert.equal(total(basement, 'Hollow block 100mm'), 940);
  assert.equal(total(basement, 'Cement OPC'), 121);
  assert.equal(total(basement, 'Washed sand'), 16.6);
  assert.equal(pr.floors[1].areas.length, 0);
  await progressOf(francisca, id);
  assert.equal((await areasOf(id)).length, 12);
});

test('stock shows what the areas need and what is still to order', async () => {
  const { francisca, id } = await setup();
  await progressOf(francisca, id);
  await deliver(francisca, 'Hollow block 200mm', 3000);
  const stock = await stockWithNeeds(id);
  const blocks = stock.find((s) => s.item === 'Hollow block 200mm');
  assert.deepEqual([blocks.on_site, blocks.needed, blocks.to_order], [3000, 9820, 6820]);
  const cement = stock.find((s) => s.item === 'Cement OPC'); // needed, nothing delivered yet
  assert.deepEqual([cement.received, cement.needed, cement.to_order], [0, 121, 121]);
  assert.equal((await getProject(francisca, id)).stock.length, 4);
});

test('material given out can name its room, and counts against that room', async () => {
  const { francisca, id } = await setup();
  await progressOf(francisca, id);
  await deliver(francisca, 'Hollow block 200mm', 3000);
  await assert.rejects(proposeOut(francisca, { item: 'Hollow block 200mm', quantity: 100, area: 'kitchen' }), /No area called "kitchen"/);
  await assert.rejects(proposeOut(francisca, { item: 'Hollow block 200mm', quantity: 100, area: 'store' }), /more than one area/);
  const c = await proposeOut(francisca, { item: 'hollow block 200mm', quantity: 900, area: 'pump room' });
  assert.deepEqual([c.data.area, c.data.floor], ['Pump room', 'Basement']);
  await confirmCard(francisca, c.id);
  const pump = (await areasOf(id)).find((a) => a.name === 'Pump room');
  assert.equal(Number(pump.given), 900);
  assert.equal((await getProject(francisca, id)).moves[0].area, 'Pump room');
});

test('a room\'s progress is a card; done moves every material of that room', async () => {
  const { francisca, other, id } = await setup();
  await progressOf(francisca, id);
  await assert.rejects(proposeArea(other, { area: 'Pump room', percent: 50 }), /on no project/);
  await assert.rejects(proposeArea(francisca, { area: 'Pump room' }), /how far/);
  const c = await proposeArea(francisca, { area: 'pump room', percent: 60, note: 'east and north walls' });
  assert.equal((await areasOf(id)).find((a) => a.name === 'Pump room').percent, 0); // a card is not progress
  await confirmCard(francisca, c.id);
  assert.equal((await areasOf(id)).find((a) => a.name === 'Pump room').percent, 60);
  const m = await proposeArea(francisca, { area: 'mortar', done: true });
  await confirmCard(francisca, m.id);
  assert.deepEqual((await areasOf(id)).filter((a) => a.name === 'Mortar, whole floor').map((a) => a.percent), [100, 100]);
});

test('what runs short: rooms planned up to next week against what is on site', async () => {
  const { francisca, id } = await setup();
  await progressOf(francisca, id); // week 1
  await deliver(francisca, 'Hollow block 200mm', 3000);
  const blocks = (await shortages(id, 1)).find((s) => s.item === 'Hollow block 200mm');
  // Weeks 1-2: generator 680, pump 1070, garbage 1710, two stores 1050 + 990, equipment 1780.
  assert.deepEqual([blocks.need, blocks.on_site, blocks.short], [7280, 3000, 4280]);
  // A finished room no longer needs anything.
  const c = await proposeArea(francisca, { area: 'garbage', done: true });
  await confirmCard(francisca, c.id);
  assert.equal((await shortages(id, 1)).find((s) => s.item === 'Hollow block 200mm').short, 4280 - 1710);
  const kit = await projectKit(francisca, {});
  const status = await kit.run({ id: 't', name: 'project_status', input: {} });
  assert.match(status.content, /Running short/);
  assert.match(status.content, /order about 2,570/);
  assert.match(status.content, /still to order 6,820/);
});

test('managers correct the take-off; the store keeper cannot', async () => {
  const { francisca, tauqeer, id } = await setup();
  await progressOf(tauqeer, id);
  const pump = (await areasOf(id)).find((a) => a.name === 'Pump room');
  await assert.rejects(saveArea(francisca, null, pump.id, { name: 'Pump room', item: pump.item, needed: 1200 }), /Only a manager/);
  await assert.rejects(saveArea(tauqeer, null, pump.id, { name: 'Pump room', item: pump.item, needed: 'lots' }), /as a number/);
  let areas = await saveArea(tauqeer, null, pump.id, { name: 'Pump room', item: pump.item, counted_in: 'pcs', needed: 1200, week_from: 1, week_to: 2 });
  assert.equal(Number(areas.find((a) => a.id === pump.id).needed), 1200);
  areas = await saveArea(tauqeer, id, null, { floor: 'Basement', name: 'Pool plant room', item: 'Hollow block 200mm', needed: 400, week_from: 6, week_to: 6 });
  assert.equal(areas.at(-1).name, 'Pool plant room');
  areas = await deleteArea(tauqeer, areas.at(-1).id);
  assert.ok(!areas.some((a) => a.name === 'Pool plant room'));
});
