import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './helpers/db.js';
import { PDFDocument } from 'pdf-lib';
import { dimensionMetres, inText, sideSize, buildModel, tracePlan } from '../server/plan3d.js';
import { roughModel } from '../server/dwg.js';

test.after(() => closeDb());

test('dimensions as drawings write them come out in metres', () => {
  assert.equal(dimensionMetres('12000'), 12);
  assert.equal(dimensionMetres('12,000'), 12);
  assert.equal(dimensionMetres('12 000'), 12);
  assert.equal(dimensionMetres('12.00'), 12);
  assert.equal(dimensionMetres('9.5 m'), 9.5);
  assert.equal(dimensionMetres('1200 cm'), 12);
  assert.equal(dimensionMetres('4200mm'), 4.2);
  assert.equal(dimensionMetres("40'-6\""), 12.344);
  assert.equal(dimensionMetres('A-101'), null);
  assert.equal(dimensionMetres(null), null);
});

test('a dimension counts as checked only when the file really has it written', () => {
  assert.ok(inText('12000', 'GROUND FLOOR PLAN 12,000 9000'));
  assert.ok(inText('12000', 'width 12000 mm'));
  assert.ok(!inText('12000', 'width 112000'), 'not part of a longer number');
  assert.ok(!inText('1200', '12000'), 'not the start of another');
  assert.ok(inText('12.00', 'OVERALL 12.00 M'));
  assert.ok(!inText('12000', ''));
  assert.deepEqual(sideSize({ text: '12000', chain: [], estimate_m: null }, 'PLAN 12000'), { m: 12, from: 'checked', shown: '12000' });
  assert.equal(sideSize({ text: '12000', chain: [], estimate_m: null }, 'PLAN 9000').from, 'read', 'read off the picture, not in the text');
  assert.deepEqual(sideSize({ text: null, chain: ['4200', '3600', '4200'], estimate_m: null }, '4200 3600'), { m: 12, from: 'checked', shown: '4200 + 3600 + 4200' });
  assert.equal(sideSize({ text: null, chain: [], estimate_m: 11 }, '').from, 'estimated');
  assert.equal(sideSize({ text: null, chain: [], estimate_m: null }, ''), null);
});

// A 12 × 9 m plan in the 0-1000 frame: four outer walls and one across the middle.
const box = [
  { x1: 0, y1: 0, x2: 1000, y2: 0 }, { x1: 1000, y1: 0, x2: 1000, y2: 1000 },
  { x1: 1000, y1: 1000, x2: 0, y2: 1000 }, { x1: 0, y1: 1000, x2: 0, y2: 0 }, { x1: 500, y1: 0, x2: 500, y2: 1000 },
];
const sheet = (floor, level, over = {}) => ({
  is_floor_plan: true, floor, level_m: level, storey_height_m: null,
  width: { text: '12000', chain: [], estimate_m: null }, depth: { text: '9000', chain: [], estimate_m: null }, walls: box, ...over,
});

test('the size comes from the written dimensions, worked out here, and the walls are placed in metres', () => {
  const m = buildModel([{ floor: 'Ground', plan: sheet('Ground floor', 0), pageText: 'GROUND FLOOR PLAN 12000 9000' }]);
  assert.equal(m.floors.length, 1);
  const w = m.floors[0].walls;
  const xs = w.filter((_, i) => i % 2 === 0), ys = w.filter((_, i) => i % 2 === 1);
  assert.equal(Math.max(...xs) - Math.min(...xs), 12);
  assert.equal(Math.max(...ys) - Math.min(...ys), 9);
  assert.deepEqual(w.slice(0, 4), [-6, 4.5, 6, 4.5], 'the top of the sheet is north, around the middle');
  assert.deepEqual(w.slice(16, 20), [0, 4.5, 0, -4.5], 'the wall halfway across is at 6 m');
  assert.ok(m.checked);
  assert.match(m.note, /12\.00 × 9\.00 m \(12000, written on the drawing; 9000, written on the drawing\)/);
});

test('floors stand at their written levels, lowest first; a sheet that is not a plan is left out', () => {
  const m = buildModel([
    { plan: sheet('First floor', 3.5), pageText: '12000 9000' },
    { plan: sheet('Ground floor', 0), pageText: '12000 9000' },
    { plan: { ...sheet('Section A-A', null), is_floor_plan: false }, pageText: '' },
  ]);
  assert.deepEqual(m.floors.map((f) => [f.name, f.base, f.height]), [['Ground floor', 0, 3.5], ['First floor', 3.5, 3.5]]);
  assert.match(m.note, /heights from the levels/);
});

test('with no dimension on the drawing it says the size is an estimate; with no plan it says so', () => {
  const m = buildModel([{ plan: sheet('Ground floor', null, { width: { text: null, chain: [], estimate_m: 10 }, depth: { text: null, chain: [], estimate_m: 8 } }), pageText: '' }]);
  assert.ok(!m.checked);
  assert.match(m.note, /estimated, no dimension on the drawing/);
  assert.match(m.note, /may be off/);
  assert.match(m.note, /Floor height 3\.2 m by default/);
  assert.match(buildModel([{ plan: { ...sheet('x', 0), walls: box.slice(0, 2) }, pageText: '' }]).error, /No floor plan/);
});

test('a PDF set: the plan pages are picked, each traced from its own page, with its own text', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([400, 300]).drawText(i === 2 ? 'SECTION' : `FLOOR ${i} 12000 9000`, { x: 20, y: 150 });
  const dir = mkdtempSync(join(tmpdir(), 'reem-plan3d-'));
  try {
    const path = join(dir, 'set.pdf');
    writeFileSync(path, await pdf.save());
    const seen = [];
    const steps = [];
    const m = await tracePlan({ name: 'set.pdf', path }, (s) => steps.push(s), {
      pick: async (_buf, texts) => { assert.equal(texts.length, 3); return [{ page: 0, floor: 'Ground' }, { page: 1, floor: 'First' }]; },
      trace: async (block) => { seen.push(block.type); return sheet(`Floor ${seen.length}`, (seen.length - 1) * 3.4); },
    });
    assert.deepEqual(seen, ['document', 'document']);
    assert.equal(m.floors.length, 2);
    assert.ok(m.checked, 'each page has its own 12000 and 9000 in its text');
    assert.equal(m.floors[1].base, 3.4);
    assert.ok(steps.some((s) => /2 floor plans/.test(s)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a drawing whose layers are not named for walls has its wall layers picked, at its own size', async () => {
  const dxf = (...pairs) => Buffer.from(pairs.flat().join('\n') + '\n');
  const line = (layer, x1, y1, x2, y2) => [['0', 'LINE'], ['8', layer], ['10', x1], ['20', y1], ['11', x2], ['21', y2]];
  const plan = dxf(['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '4'], ['0', 'ENDSEC'], ['0', 'SECTION'], ['2', 'ENTITIES'],
    ...line('BLK200', 0, 0, 8000, 0), ...line('BLK200', 8000, 0, 8000, 5000), ...line('BLK200', 8000, 5000, 0, 5000), ...line('BLK200', 0, 5000, 0, 0),
    ...line('FURN', 1000, 1000, 2000, 1000), ['0', 'ENDSEC'], ['0', 'EOF']);
  let asked = null;
  const m = await roughModel(plan, 'flat.dxf', { pickLayers: async (list) => { asked = list; return ['BLK200', 'NOT-THERE']; } });
  assert.match(asked[0], /^BLK200: 4 lines, 26 m long/);
  assert.deepEqual(m.layers, ['BLK200']);
  assert.match(m.note, /Size as drawn: 8\.00 × 5\.00 m/);
  assert.match(m.note, /layer BLK200, which Reem judged/);
  assert.match((await roughModel(plan, 'flat.dxf')).error, /no layer named for walls/, 'without a picker it says what is missing');
});
