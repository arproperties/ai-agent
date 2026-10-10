import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb } from './helpers/db.js';
import { create } from '../server/properties.js';
import { savePlan, plans } from '../server/floorPlans.js';

test.after(() => closeDb());

test('a building keeps its floor plan: each unit where it is, and what is between them', async () => {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Ayla' }, c.id);
  const plain = await create('building', { name: 'No plan' }, c.id);
  const u1 = await create('unit', { unit_no: '101', floor: '1' }, b.id);
  const u2 = await create('unit', { unit_no: 'S1', floor: 'G' }, b.id);
  await create('unit', { unit_no: '1', floor: '1' }, plain.id);
  assert.deepEqual(await plans(), {}, 'nothing has a plan yet');

  const corridor = { kind: 'corridor', label: ' Corridor ', x: 0, y: 9, w: 40, d: 2 };
  const kept = await savePlan(b.id, { width: 40, depth: 20, storey: 3.3, commons: { '*': [corridor] },
    units: { 101: { x: 0, y: 11, w: 9, d: 9 }, S1: { x: '0', y: 0, w: 14, d: 9 } } });
  assert.deepEqual([kept.width, kept.depth, kept.storey], [40, 20, 3.3]);
  assert.deepEqual(kept.commons['*'], [{ kind: 'corridor', label: 'Corridor', x: 0, y: 9, w: 40, d: 2 }]);
  assert.deepEqual(kept.units, { [u1.id]: { x: 0, y: 11, w: 9, d: 9 }, [u2.id]: { x: 0, y: 0, w: 14, d: 9 } }, 'by the unit\'s id, as numbers');
  assert.deepEqual(Object.keys(await plans()), [String(b.id)], 'only the building that has one');
});

test('a plan that cannot be right is refused, and nothing of it is kept', async () => {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Ayla' }, c.id);
  await create('unit', { unit_no: '101' }, b.id);
  const size = { width: 40, depth: 20 };
  await assert.rejects(savePlan(b.id, { units: {} }), /width and depth/);
  await assert.rejects(savePlan(999, { ...size }), /Not found/);
  await assert.rejects(savePlan(b.id, { ...size, units: { 101: { x: 35, y: 0, w: 9, d: 9 } } }), /Unit 101 is outside the building/);
  await assert.rejects(savePlan(b.id, { ...size, units: { 101: { x: 0, y: 0, w: 0, d: 9 } } }), /has no size/);
  await assert.rejects(savePlan(b.id, { ...size, units: { 101: { x: 0, y: 0, w: 9, d: 9 }, 999: { x: 9, y: 0, w: 9, d: 9 } } }), /no unit 999/);
  await assert.rejects(savePlan(b.id, { ...size, commons: { G: [{ kind: 'pool', x: 0, y: 0, w: 1, d: 1 }] } }), /Unknown kind/);
  assert.deepEqual(await plans(), {}, 'the unit placed before the one refused is not kept either');
});
