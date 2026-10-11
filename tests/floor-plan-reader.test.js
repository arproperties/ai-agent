import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb } from './helpers/db.js';
import { create, listUnits } from '../server/properties.js';
import { savePlan, plans } from '../server/floorPlans.js';
import { proposal, readPlan, against, startReading, reading } from '../server/floorPlanReader.js';

test.after(() => closeDb());

const pdf = { buffer: Buffer.from('%PDF-1.4'), originalname: 'plans.pdf', mimetype: 'application/pdf' };
const corridor = { kind: 'corridor', label: 'Corridor', x: 0, y: 9, w: 40, d: 2 };
const READ = { width: 40, depth: 20, storey: 3.3, floors: [
  { floor: 'Ground', units: [{ unit_no: 'S1', type: 'Retail shop', area_sqm: 126, x: 0, y: 0, w: 14, d: 9 }], commons: [corridor, { kind: 'pool', x: 0, y: 0, w: 1, d: 1 }] },
  { floor: 'Floor 1', units: [{ unit_no: 'Unit 101', type: '2-Bedroom', area_sqm: '81', x: 0, y: 11, w: 9, d: 9 }, { unit_no: '102', x: 9, y: 11, w: 8, d: 9 }], commons: [corridor] },
] };

test('what the model read becomes a plan: floors named as units have them, sizes in square feet, nothing that has no place', () => {
  const p = proposal(`Here it is:\n\`\`\`json\n${JSON.stringify(READ)}\n\`\`\``);
  assert.deepEqual([p.width, p.depth, p.storey], [40, 20, 3.3]);
  assert.deepEqual(p.floors.map((f) => f.floor), ['G', '1']);
  assert.deepEqual(p.floors[0].units, [{ unit_no: 'S1', type: 'Retail shop', size_sqft: 1356, x: 0, y: 0, w: 14, d: 9 }]);
  assert.deepEqual(p.floors[0].commons, [corridor], 'a kind nobody offered is left out');
  assert.deepEqual(p.floors[1].units.map((u) => [u.unit_no, u.type, u.size_sqft]), [['101', '2-Bedroom', 872], ['102', '', undefined]]);

  // Over the edge is cut back to the outline; outside it, with no size, or seen before, is left out. A floor left with no unit goes too.
  const odd = proposal(JSON.stringify({ width: 10, depth: 10, floors: [
    { floor: 1, units: [{ unit_no: 'A', x: 8, y: -1, w: 5, d: 4 }, { unit_no: 'B', x: 12, y: 0, w: 2, d: 2 }, { unit_no: 'a', x: 0, y: 0, w: 2, d: 2 }, { unit_no: 'C', x: 0, y: 0, w: 'wide', d: 2 }, { x: 0, y: 0, w: 1, d: 1 }] },
    { floor: 2, units: [{ unit_no: 'B', x: 20, y: 0, w: 2, d: 2 }] },
  ] }));
  assert.equal(odd.storey, 3, 'the usual height when none is given');
  assert.deepEqual(odd.floors, [{ floor: '1', units: [{ unit_no: 'A', type: '', x: 8, y: 0, w: 2, d: 3 }], commons: [] }]);

  // A unit's rooms are kept to the unit: one reaching past it is cut back, one outside it is left out.
  const roomy = proposal(JSON.stringify({ width: 20, depth: 10, floors: [{ floor: '1', units: [{ unit_no: '101', x: 0, y: 0, w: 9, d: 9,
    rooms: [{ label: ' Living ', x: 3, y: 3, w: 3, d: 6 }, { label: 'Bath', x: 6, y: 6, w: 5, d: 5 }, { label: 'Next door', x: 12, y: 0, w: 3, d: 3 }, { label: 'Odd', x: 0, y: 0, w: 'x', d: 1 }] }, { unit_no: '102', x: 9, y: 0, w: 9, d: 9, rooms: [] }] }] }));
  assert.deepEqual(roomy.floors[0].units[0].rooms, [{ label: 'Living', x: 3, y: 3, w: 3, d: 6 }, { label: 'Bath', x: 6, y: 6, w: 3, d: 3 }]);
  assert.equal('rooms' in roomy.floors[0].units[1], false, 'a unit whose rooms are not drawn has none');

  for (const junk of ['', 'These are not floor plans.', '{broken', '{"floors": []}', '{"width": 40, "depth": 20, "floors": []}', JSON.stringify({ ...READ, width: 0 }), undefined]) {
    assert.throws(() => proposal(junk), /No floor plan could be read/);
  }
});

test('reading a file: a PDF or a picture is sent, anything else is refused before it is', async () => {
  const seen = [];
  const read = async (block) => { seen.push(block); return JSON.stringify(READ); };
  assert.equal((await readPlan(pdf, { read })).floors.length, 2);
  assert.deepEqual([seen[0].type, seen[0].source.media_type], ['document', 'application/pdf']);
  await readPlan({ ...pdf, mimetype: 'image/png' }, { read });
  assert.equal(seen[1].type, 'image');
  await assert.rejects(readPlan({ ...pdf, mimetype: 'application/msword' }, { read }), /PDF or a picture/);
  await assert.rejects(readPlan(undefined, { read }), /PDF or a picture/);
  assert.equal(seen.length, 2);
});

test('a reading is set against the building, and kept: its new units are made, each where the plan has it', async () => {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Ayla' }, c.id);
  await create('unit', { unit_no: '101', floor: '1' }, b.id);
  await create('unit', { unit_no: 's1' }, b.id); // the plan writes it S1
  await create('unit', { unit_no: '999' }, b.id); // not on the plan

  const draft = await against(b.id, proposal(JSON.stringify(READ)));
  assert.deepEqual(draft.add, [{ unit_no: '102', floor: '1', type: '', size_sqft: undefined }], 'only what the building does not have');
  assert.deepEqual(Object.keys(draft.units).sort(), ['101', '102', 's1'], 'a unit the building has keeps the number it has there');
  assert.deepEqual(draft.floors, [{ floor: 'G', units: ['s1'] }, { floor: '1', units: ['101', '102'] }]);
  assert.deepEqual(draft.unplaced, ['999']);
  assert.deepEqual(draft.commons, { G: [corridor], 1: [corridor] });
  assert.deepEqual(await plans(), {}, 'nothing is kept by reading');

  const { floors, unplaced, ...body } = draft;
  const kept = await savePlan(b.id, body);
  const units = await listUnits(b.id);
  assert.deepEqual(units.map((u) => u.unit_no).sort(), ['101', '102', '999', 's1']);
  const made = units.find((u) => u.unit_no === '102');
  assert.equal(made.floor, '1');
  assert.deepEqual(kept.units[made.id], { x: 9, y: 11, w: 8, d: 9 });
  assert.equal(Object.keys(kept.units).length, 3);

  // A unit that cannot be made stops the whole plan: nothing of it is kept.
  await reset();
  const c2 = await create('company', { name: 'ACE' });
  const b2 = await create('building', { name: 'Ayla' }, c2.id);
  await assert.rejects(savePlan(b2.id, { width: 40, depth: 20, add: [{ unit_no: '101' }, { unit_no: '' }], units: { 101: { x: 0, y: 0, w: 9, d: 9 } } }), /Unit number is required/);
  assert.deepEqual(await listUnits(b2.id), []);
  assert.deepEqual(await plans(), {});
});

test('a reading runs on its own: a ticket at once, then done or failed in words that can be shown', async () => {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Ayla' }, c.id);
  const settled = async (id) => { for (let i = 0; i < 100; i++) { const r = reading(id); if (r.status !== 'reading') return r; await new Promise((ok) => setTimeout(ok, 10)); } throw new Error('never finished'); };

  let let_go;
  const slow = await startReading(b.id, pdf, { read: () => new Promise((ok) => { let_go = () => ok(JSON.stringify(READ)); }) });
  assert.deepEqual(reading(slow.id), { status: 'reading' });
  let_go();
  const done = await settled(slow.id);
  assert.equal(done.status, 'done');
  assert.equal(done.plan.add.length, 3);

  const none = await startReading(b.id, pdf, { read: async () => 'These are not floor plans.' });
  assert.deepEqual(await settled(none.id), { status: 'failed', error: 'No floor plan could be read from this file. Try a clearer copy, with the unit numbers and the dimensions showing.' });
  const down = await startReading(b.id, pdf, { read: async () => { throw new Error('overloaded_error: secret detail'); } });
  assert.deepEqual(await settled(down.id), { status: 'failed', error: 'The floor plan could not be read just now. Try again in a minute.' }, 'what went wrong inside is not shown');

  await assert.rejects(startReading(b.id, { ...pdf, mimetype: 'text/plain' }), /PDF or a picture/);
  await assert.rejects(startReading(999, pdf), /Not found/);
  assert.throws(() => reading('no-such-ticket'), /no longer here/);
});
