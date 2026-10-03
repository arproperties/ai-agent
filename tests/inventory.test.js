import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { saveBuilding, deleteBuilding } from '../server/buildings.js';
import {
  overview, getInventory, addArea, deleteArea, saveItem, deleteItem, history, setPhoto, unitsOf, inventoryKit,
} from '../server/inventory.js';

test.after(() => closeDb());

// A stand-in for saifsys: its buildings, and the unit numbers of each.
const SITES = [{ id: 3, name: 'Park Place' }, { id: 7, name: 'Townhouse A' }, { id: 8, name: 'Townhouse B' }];
const UNITS = { 'Park Place': ['304', '1001', '204'], 'Townhouse A': ['1', '2'], 'Townhouse B': ['1'] };
function saifsys({ down = false } = {}) {
  const state = { down };
  const ask = async (module, action) => {
    if (module === 'operations' && action === 'buildings') return { ok: true, buildings: SITES };
    if (module === 'realestate' && action === 'directory') {
      if (state.down) throw Object.assign(new Error('saifsys did not answer'), { status: 502 });
      return { ok: true, buildings: Object.entries(UNITS).map(([name, units]) => ({ name, units })), tenants: [] };
    }
    throw new Error(`unexpected ${module}/${action}`);
  };
  return { ask, state };
}

async function setup() {
  await reset();
  const { ask, state } = saifsys();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const jessa = { id: await makeUser('Jessa'), role: 'user' };
  const sabha = { id: await makeUser('Sabha'), role: 'user' };
  const park = await saveBuilding(master, null, { name: 'Park Place', admin_id: jessa.id, sites: [3] }, ask);
  const town = await saveBuilding(master, null, { name: 'Townhouses', admin_id: sabha.id, sites: [7, 8] }, ask);
  return { ask, state, master, jessa, sabha, park, town };
}

test('the units are the ones saifsys has, in counting order', async () => {
  const { ask, park, town, master } = await setup();
  assert.deepEqual(await unitsOf(park, ask), ['204', '304', '1001']);
  assert.deepEqual(await unitsOf(town, ask), ['Townhouse A · 1', 'Townhouse A · 2', 'Townhouse B · 1'], 'two buildings under one name can both have a unit 1');
  const bare = await saveBuilding(master, null, { name: 'Bare' }, ask);
  assert.deepEqual(await unitsOf(bare, ask), []);
});

test('an item goes in a unit or an area, and comes back with its place', async () => {
  const { ask, jessa, park } = await setup();
  const lobby = await addArea(jessa, park.id, { name: '  Lobby ' });
  assert.equal(lobby.name, 'Lobby');
  await assert.rejects(addArea(jessa, park.id, { name: 'lobby' }), /already has an area called lobby/);
  await assert.rejects(addArea(jessa, park.id, { name: ' ' }), /Give the area a name/);

  const ac = await saveItem(jessa, park.id, null, { place: 'u:304', name: ' Split  AC ', counted_in: 'pcs', quantity: 2, notes: 'Gree' }, ask);
  assert.deepEqual({ ...ac, updated_at: 0 }, {
    id: ac.id, name: 'Split AC', place: { key: 'u:304', label: 'Unit 304' }, counted_in: 'pcs', quantity: 2, condition: 'good',
    notes: 'Gree', photo: false, updated_at: 0, updated_by: 'Jessa',
  });
  const sofa = await saveItem(jessa, park.id, null, { place: `a:${lobby.id}`, name: 'Sofa' }, ask);
  assert.deepEqual(sofa.place, { key: `a:${lobby.id}`, label: 'Lobby' });
  assert.equal(sofa.quantity, 1, 'one unless said');
  assert.equal(sofa.counted_in, null);

  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:304', name: '' }, ask), /Say what it is/);
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:999', name: 'X' }, ask), /no unit 999 in saifsys/);
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'a:9999', name: 'X' }, ask), /Pick the area/);
  await assert.rejects(saveItem(jessa, park.id, null, { name: 'X' }, ask), /Say where it is/);
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:304', name: 'X', counted_in: 'buckets' }, ask), /counted in/);
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:304', name: 'X', quantity: -1 }, ask), /0 or more/);
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:304', name: 'X', condition: 'old' }, ask), /good, damaged or missing/);

  const inv = await getInventory(jessa, park.id, ask);
  assert.deepEqual(inv.units, ['204', '304', '1001']);
  assert.deepEqual(inv.areas, [lobby]);
  assert.deepEqual(inv.items.map((i) => i.name), ['Sofa', 'Split AC']);
  assert.ok(inv.counted_in.some((c) => c.value === 'kg' && c.group === 'Weight'));
});

test('an administrator keeps only their own building; the master keeps all', async () => {
  const { ask, master, jessa, sabha, park, town } = await setup();
  const ac = await saveItem(jessa, park.id, null, { place: 'u:304', name: 'AC', condition: 'damaged' }, ask);
  await saveItem(master, town.id, null, { place: 'u:Townhouse A · 1', name: 'Fridge', condition: 'missing' }, ask);

  assert.deepEqual(await overview(master), [
    { id: park.id, name: 'Park Place', items: 1, damaged: 1, missing: 0 },
    { id: town.id, name: 'Townhouses', items: 1, damaged: 0, missing: 1 },
  ]);
  assert.deepEqual((await overview(jessa)).map((b) => b.name), ['Park Place']);
  assert.deepEqual(await overview({ id: await makeUser('Nobody'), role: 'user' }), []);

  assert.equal(await getInventory(sabha, park.id, ask), null);
  assert.equal(await saveItem(sabha, park.id, null, { place: 'u:304', name: 'TV' }, ask), null);
  assert.equal(await saveItem(sabha, park.id, ac.id, { place: 'u:304', name: 'Mine now' }, ask), null);
  assert.equal(await saveItem(sabha, town.id, ac.id, { place: 'u:Townhouse A · 1', name: 'Mine now' }, ask), null, 'nor by naming it under her own building');
  assert.equal(await deleteItem(sabha, park.id, ac.id), null);
  assert.equal(await history(sabha, park.id, ac.id), null);
  assert.equal(await addArea(sabha, park.id, { name: 'Roof' }), null);
  assert.equal((await getInventory(master, park.id, ask)).items.length, 1);
});

test('every change is written down with who made it', async () => {
  const { ask, master, jessa, park } = await setup();
  const store = await addArea(jessa, park.id, { name: 'Store room' });
  const ac = await saveItem(jessa, park.id, null, { place: 'u:304', name: 'AC', counted_in: 'pcs', quantity: 2 }, ask);

  await saveItem(jessa, park.id, ac.id, { place: 'u:304', name: 'AC', counted_in: 'pcs', quantity: 2 }, ask);
  assert.equal((await history(jessa, park.id, ac.id)).length, 1, 'saving with nothing changed is not a change');

  const changed = await saveItem(master, park.id, ac.id, { place: `a:${store.id}`, name: 'Split AC', counted_in: 'pcs', quantity: 1, condition: 'damaged', notes: 'Leaks' }, ask);
  assert.equal(changed.updated_by, 'Owner');
  const log = await history(jessa, park.id, ac.id);
  assert.deepEqual(log.map((l) => [l.by, l.what]), [
    ['Owner', 'Renamed from AC · Moved from Unit 304 to Store room · Quantity 2 pcs → 1 pcs · Condition good → damaged · Notes changed'],
    ['Jessa', 'Added'],
  ]);

  assert.deepEqual(await deleteItem(jessa, park.id, ac.id), { ok: true });
  assert.equal(await deleteItem(jessa, park.id, ac.id), null);
  assert.equal((await history(jessa, park.id, ac.id))[0].what, 'Removed', 'what happened to it outlives it');
});

test('saifsys being away hides the unit list, not the inventory', async () => {
  const { ask, state, jessa, park } = await setup();
  const lobby = await addArea(jessa, park.id, { name: 'Lobby' });
  const ac = await saveItem(jessa, park.id, null, { place: 'u:304', name: 'AC' }, ask);
  state.down = true;

  const inv = await getInventory(jessa, park.id, ask);
  assert.deepEqual(inv.units, []);
  assert.match(inv.units_error, /did not answer/);
  assert.equal(inv.items.length, 1);

  // What is already in a unit can still be changed, and areas need no saifsys at all.
  assert.equal((await saveItem(jessa, park.id, ac.id, { place: 'u:304', name: 'AC', condition: 'missing' }, ask)).condition, 'missing');
  assert.equal((await saveItem(jessa, park.id, null, { place: `a:${lobby.id}`, name: 'Sofa' }, ask)).name, 'Sofa');
  await assert.rejects(saveItem(jessa, park.id, null, { place: 'u:204', name: 'TV' }, ask), /did not answer/);
});

test('a photo is kept on disk and goes when the item goes', async () => {
  const { ask, jessa, sabha, park } = await setup();
  const lobby = await addArea(jessa, park.id, { name: 'Lobby' });
  const sofa = await saveItem(jessa, park.id, null, { place: `a:${lobby.id}`, name: 'Sofa' }, ask);
  const jpg = { mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
  const path = async () => (await db.prepare('SELECT photo FROM inventory_items WHERE id = ?').get(sofa.id))?.photo;

  await assert.rejects(setPhoto(jessa, park.id, sofa.id, { mimetype: 'application/pdf', buffer: Buffer.from('x') }), /JPG or PNG/);
  assert.equal(await setPhoto(sabha, park.id, sofa.id, jpg), null);
  assert.equal((await setPhoto(jessa, park.id, sofa.id, jpg)).photo, true);
  const first = await path();
  assert.ok(existsSync(first));

  assert.equal((await setPhoto(jessa, park.id, sofa.id, null)).photo, false);
  assert.ok(!existsSync(first));
  assert.deepEqual((await history(jessa, park.id, sofa.id)).map((l) => l.what), ['Photo removed', 'Photo added', 'Added']);

  // Removing an area removes what was in it, photo and all.
  await setPhoto(jessa, park.id, sofa.id, jpg);
  const second = await path();
  assert.deepEqual(await deleteArea(jessa, park.id, lobby.id), { ok: true, removed: 1 });
  assert.ok(!existsSync(second));
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 0);
  assert.equal(await deleteArea(jessa, park.id, lobby.id), null);
});

test('deleting a building takes its inventory with it', async () => {
  const { ask, master, jessa, park } = await setup();
  await addArea(jessa, park.id, { name: 'Lobby' });
  await saveItem(jessa, park.id, null, { place: 'u:304', name: 'AC' }, ask);
  await deleteBuilding(park.id);
  for (const t of ['inventory_areas', 'inventory_items', 'inventory_log']) {
    assert.equal((await db.prepare(`SELECT count(*)::int AS n FROM ${t}`).get()).n, 0, t);
  }
  assert.deepEqual((await overview(master)).map((b) => b.name), ['Townhouses']);
});

test('Reem: what is in a place, and which places have something damaged', async () => {
  const { ask, master, jessa, sabha, park, town } = await setup();
  const lobby = await addArea(jessa, park.id, { name: 'Lobby' });
  await saveItem(jessa, park.id, null, { place: 'u:304', name: 'Split AC', counted_in: 'pcs', quantity: 2, condition: 'damaged', notes: 'Leaks' }, ask);
  await saveItem(jessa, park.id, null, { place: 'u:204', name: 'Fridge' }, ask);
  await saveItem(jessa, park.id, null, { place: `a:${lobby.id}`, name: 'Sofa' }, ask);
  await saveItem(sabha, town.id, null, { place: 'u:Townhouse A · 1', name: 'Window AC', condition: 'damaged' }, ask);
  const call = async (user, input = {}) => (await (await inventoryKit(user)).run({ id: 't', name: 'inventory', input }));

  const stranger = { id: await makeUser('Nobody'), role: 'user' };
  assert.deepEqual((await inventoryKit(stranger)).definitions, []);
  assert.equal((await call(stranger)).is_error, true);

  assert.equal((await call(jessa, { place: '304' })).content,
    'Park Place\n  Unit 304\n    - Split AC: 2 pcs, damaged (Leaks) [last changed by Jessa]');
  assert.match((await call(jessa)).content, /Lobby\n {4}- Sofa: 1, good.*\n {2}Unit 204\n {4}- Fridge.*\n {2}Unit 304/);
  assert.doesNotMatch((await call(jessa)).content, /Townhouses/);
  assert.match((await call(jessa, { building: 'town' })).content, /No building of yours matches/);
  assert.match((await call(jessa, { item: 'piano' })).content, /Nothing in the inventory matches/);

  const damaged = (await call(master, { item: 'ac', condition: 'damaged' })).content;
  assert.match(damaged, /Park Place\n {2}Unit 304\n {4}- Split AC/);
  assert.match(damaged, /Townhouses\n {2}Unit Townhouse A · 1\n {4}- Window AC/);
  assert.doesNotMatch(damaged, /Fridge|Sofa/);
});
