import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { saveBuilding, deleteBuilding } from '../server/buildings.js';
import {
  overview, getInventory, addArea, deleteArea, saveItem, deleteItem, history, setPhoto, unitsOf, inventoryKit, propose, decide, getProposal,
} from '../server/inventory.js';

test.after(() => closeDb());

// A stand-in for saifsys: its buildings, and the unit numbers of each.
const SITES = [{ id: 3, name: 'Park Place' }, { id: 7, name: 'Townhouse A' }, { id: 8, name: 'Townhouse B' }];
const UNITS = { 'Park Place': ['304', '1001', '204', '205', '206 (Staff)'], 'Townhouse A': ['1', '2'], 'Townhouse B': ['1'] };
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
  assert.deepEqual(await unitsOf(park, ask), ['204', '205', '206 (Staff)', '304', '1001']);
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
  assert.deepEqual(inv.units, ['204', '205', '206 (Staff)', '304', '1001']);
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
  const call = async (user, input = {}) => (await (await inventoryKit(user, {}, ask)).run({ id: 't', name: 'inventory', input }));

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

test('from chat: many items for one unit is one card, and nothing is added until Add', async () => {
  const { ask, jessa, sabha, park } = await setup();
  const p = await propose(jessa, { building: 'park', places: ['unit 304'], items: [{ name: 'Fridge' }, { name: 'Split AC', quantity: 2, counted_in: 'pcs' }, { name: 'Bed', condition: 'damaged', notes: 'Broken leg' }] }, { conversationId: null }, ask);
  assert.equal(p.status, 'pending');
  assert.equal(p.building, 'Park Place');
  assert.equal(p.total, 3);
  assert.deepEqual(p.groups.map((g) => g.places), [['Unit 304']]);
  assert.deepEqual(p.groups[0].items.map((i) => [i.name, i.quantity, i.counted_in, i.condition]), [['Fridge', 1, null, 'good'], ['Split AC', 2, 'pcs', 'good'], ['Bed', 1, null, 'damaged']]);
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 0, 'a card is not the inventory');

  assert.equal(await getProposal(sabha, p.id), null, 'someone else\'s card');
  assert.equal(await decide(sabha, p.id, true), null);

  const done = await decide(jessa, p.id, true);
  assert.equal(done.status, 'added');
  assert.equal(done.added, 3);
  const inv = await getInventory(jessa, park.id, ask);
  assert.deepEqual(inv.items.map((i) => [i.name, i.place.label, i.quantity, i.updated_by]), [['Bed', 'Unit 304', 1, 'Jessa'], ['Fridge', 'Unit 304', 1, 'Jessa'], ['Split AC', 'Unit 304', 2, 'Jessa']]);
  assert.equal((await history(jessa, park.id, inv.items[0].id))[0].what, 'Added');
  await assert.rejects(decide(jessa, p.id, true), /already added/);

  const no = await propose(jessa, { places: ['204'], items: [{ name: 'TV' }] }, {}, ask);
  assert.equal((await decide(jessa, no.id, false)).status, 'cancelled');
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 3);
});

test('from chat: a range of units takes the ones that exist, and skips what is already listed', async () => {
  const { ask, jessa, park } = await setup();
  await saveItem(jessa, park.id, null, { place: 'u:205', name: 'fridge' }, ask);

  const p = await propose(jessa, { unit_range: { from: 200, to: 210 }, items: [{ name: 'Fridge' }, { name: 'AC', quantity: 2 }] }, {}, ask);
  assert.deepEqual(p.groups.map((g) => g.places), [['Unit 204', 'Unit 206 (Staff)'], ['Unit 205']], 'the units getting the same things are said together');
  assert.equal(p.total, 5);
  assert.equal(p.skipped, 1);
  assert.deepEqual(p.groups[1].items.map((i) => [i.name, i.exists]), [['Fridge', true], ['AC', false]]);

  assert.equal((await decide(jessa, p.id, true)).added, 5);
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 6);

  // Saying it again adds nothing.
  const again = await propose(jessa, { unit_range: { from: 200, to: 210 }, items: [{ name: 'Fridge' }, { name: 'AC' }] }, {}, ask);
  assert.equal(again.total, 0);
  assert.equal((await decide(jessa, again.id, true)).added, 0);

  await assert.rejects(propose(jessa, { unit_range: { from: 500, to: 510 }, items: [{ name: 'Fridge' }] }, {}, ask), /no units numbered 500 to 510/);
  await assert.rejects(propose(jessa, { unit_range: { from: 1, to: 2000 }, items: Array.from({ length: 200 }, (_, n) => ({ name: `Thing ${n}` })) }, {}, ask), /Do it in parts/);
});

test('from chat: places are found the way people say them, or asked about', async () => {
  const { ask, master, jessa, park } = await setup();
  const lobby = await addArea(jessa, park.id, { name: 'Main Lobby' });
  const places = async (user, input) => (await propose(user, { items: [{ name: 'Chair' }], ...input }, {}, ask)).groups.flatMap((g) => g.places);

  assert.deepEqual(await places(jessa, { places: ['206', 'Flat no. 204', 'lobby'] }), ['Unit 206 (Staff)', 'Unit 204', 'Main Lobby']);
  assert.deepEqual(await places(jessa, { new_areas: ['Roof', 'main lobby'] }), ['Roof (new area)', 'Main Lobby'], 'an area that is there is not made again');
  await assert.rejects(places(jessa, { places: ['999'] }), /no unit or area called "999"/);
  await assert.rejects(places(jessa, { places: ['Gym'] }), /Its areas: Main Lobby.*new_areas/);
  await assert.rejects(places(jessa, {}), /Say where/);
  await assert.rejects(propose(jessa, { places: ['204'], items: [] }, {}, ask), /Say what to add/);
  await assert.rejects(propose(jessa, { places: ['204'], items: [{ name: 'X', counted_in: 'buckets' }] }, {}, ask), /counted in/);

  // The building: theirs only, and asked about when it could be several.
  await assert.rejects(places(jessa, { building: 'Townhouses', places: ['1'] }), /No building of this user matches.*Theirs: Park Place/);
  await assert.rejects(places(master, { places: ['204'] }), /Which building\? This user has Park Place, Townhouses/);
  await assert.rejects(places(master, { building: 'town', places: ['1'] }), /could be unit Townhouse A · 1 or unit Townhouse B · 1/);
  assert.deepEqual(await places(master, { building: 'town', places: ['Townhouse B · 1', '2'] }), ['Unit Townhouse B · 1', 'Unit Townhouse A · 2']);

  // A new area is made when Add is tapped, not before.
  const p = await propose(jessa, { new_areas: ['Roof'], places: ['lobby'], items: [{ name: 'Water tank' }] }, {}, ask);
  assert.deepEqual((await getInventory(jessa, park.id, ask)).areas, [lobby]);
  assert.equal((await decide(jessa, p.id, true)).added, 2);
  const inv = await getInventory(jessa, park.id, ask);
  assert.deepEqual(inv.areas.map((a) => a.name), ['Main Lobby', 'Roof']);
  assert.deepEqual(inv.items.map((i) => i.place.label).sort(), ['Main Lobby', 'Roof']);
});

test('from chat: a card whose area or building has gone adds nothing and stays to be cancelled', async () => {
  const { ask, master, jessa, park } = await setup();
  const lobby = await addArea(jessa, park.id, { name: 'Lobby' });
  const p = await propose(jessa, { places: ['204', 'Lobby'], items: [{ name: 'Chair' }] }, {}, ask);
  await deleteArea(jessa, park.id, lobby.id);
  await assert.rejects(decide(jessa, p.id, true), /Lobby has since been removed/);
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 0, 'not half of it');
  assert.equal((await getProposal(jessa, p.id)).status, 'pending');

  await saveBuilding(master, park.id, { name: 'Park Place', admin_id: master.id, sites: [3] }, ask);
  await assert.rejects(decide(jessa, p.id, true), /no longer keep/);
  assert.equal((await decide(jessa, p.id, false)).status, 'cancelled');
});

test('Reem: add_inventory shows the card and says it is not added yet', async () => {
  const { ask, jessa, park } = await setup();
  const cards = [];
  const kit = await inventoryKit(jessa, { conversationId: null, onCard: (p) => cards.push(p) }, ask);
  assert.deepEqual(kit.definitions.map((d) => d.name), ['inventory', 'add_inventory']);

  const out = await kit.run({ id: 't', name: 'add_inventory', input: { building: 'Park Place', unit_range: { from: 204, to: 206 }, items: [{ name: 'Fridge' }, { name: 'AC', quantity: 2 }] } });
  assert.match(out.content, /^Ready as card #1: 6 items for Park Place \(Unit 204, Unit 205, Unit 206 \(Staff\)\)\. NOT added yet/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].total, 6);
  assert.equal((await getInventory(jessa, park.id, ask)).items.length, 0);

  const wrong = await kit.run({ id: 't', name: 'add_inventory', input: { places: ['999'], items: [{ name: 'Fridge' }] } });
  assert.equal(wrong.is_error, true);
  assert.equal(cards.length, 1, 'no card for something that cannot be added');
});

test('from chat: a picture sent with the message becomes the item\'s own photo on Add', async () => {
  const { ask, jessa, sabha, park } = await setup();
  const dir = `${tmpdir()}/reem-inventory-test`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/fridge.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const doc = async (userId, name, mime, path = `${dir}/fridge.jpg`) => (await db.prepare(
    'INSERT INTO documents (user_id, name, title, kind, mime, path) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').run(userId, name, name, 'image', mime, path)).id;
  const photoId = await doc(jessa.id, 'IMG_0412.jpg', 'image/jpeg');
  await doc(jessa.id, 'plan.pdf', 'application/pdf');
  await doc(sabha.id, 'hers.jpg', 'image/jpeg');

  await assert.rejects(propose(jessa, { places: ['206'], items: [{ name: 'Fridge', photo: 'nothing.jpg' }] }, {}, ask), /no picture called "nothing.jpg"/);
  await assert.rejects(propose(jessa, { places: ['206'], items: [{ name: 'Fridge', photo: 'hers.jpg' }] }, {}, ask), /no picture called/, 'someone else\'s file');
  await assert.rejects(propose(jessa, { places: ['206'], items: [{ name: 'Fridge', photo: 'plan.pdf' }] }, {}, ask), /must be a JPG or PNG/);

  const p = await propose(jessa, { places: ['206'], items: [{ name: 'Fridge', photo: 'img_0412.JPG' }, { name: 'Bed' }] }, {}, ask);
  assert.deepEqual(p.groups[0].items.map((i) => i.photo_doc), [photoId, undefined]);
  assert.equal((await decide(jessa, p.id, true)).added, 2);

  const inv = await getInventory(jessa, park.id, ask);
  assert.deepEqual(inv.items.map((i) => [i.name, i.photo]), [['Bed', false], ['Fridge', true]]);
  const { photo } = await db.prepare('SELECT photo FROM inventory_items WHERE name = ?').get('Fridge');
  assert.ok(existsSync(photo));
  assert.notEqual(photo, `${dir}/fridge.jpg`, 'its own copy, not the Shelf\'s file');

  // A picture whose file has gone does not stop the item being added.
  const gone = await doc(jessa.id, 'gone.jpg', 'image/jpeg', `${dir}/not-there.jpg`);
  const q = await propose(jessa, { places: ['204'], items: [{ name: 'TV', photo: 'gone.jpg' }] }, {}, ask);
  assert.equal(q.groups[0].items[0].photo_doc, gone);
  assert.equal((await decide(jessa, q.id, true)).added, 1);
  assert.equal((await getInventory(jessa, park.id, ask)).items.find((i) => i.name === 'TV').photo, false);

  rmSync(photo, { force: true });
  rmSync(dir, { recursive: true, force: true });
});
