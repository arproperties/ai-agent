import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { readDrawing, roughModel, levelsIn, storeyHeight, wallLayers } from '../server/dwg.js';
import { roughModelFor } from '../server/rough3d.js';

test.after(() => closeDb());

const dxf = (...pairs) => Buffer.from(pairs.flat().join('\n') + '\n');
const line = (layer, x1, y1, x2, y2) => [['0', 'LINE'], ['8', layer], ['10', x1], ['20', y1], ['11', x2], ['21', y2]];
const text = (layer, t, x = 0, y = 0) => [['0', 'TEXT'], ['8', layer], ['10', x], ['20', y], ['40', 200], ['1', t]];

// A 10 × 6 m room in millimetres: four walls on A-WALL, their hatch on A-WALL-PATT, a door
// layer, and two floor levels written on the plan.
const plan = dxf(
  ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '4'], ['0', 'ENDSEC'],
  ['0', 'SECTION'], ['2', 'ENTITIES'],
  ...line('A-WALL', 0, 0, 10000, 0), ...line('A-WALL', 10000, 0, 10000, 6000),
  ...line('A-WALL', 10000, 6000, 0, 6000), ...line('A-WALL', 0, 6000, 0, 0),
  ...line('A-WALL-PATT', 0, 0, 10000, 6000),
  ...line('A-DOOR', 4000, 0, 4900, 0),
  ...text('A-TEXT', 'FFL +0.00', 500, 500), ...text('A-TEXT', 'F.F.L. +3.60', 500, 900), ...text('A-TEXT', '+0.15', 500, 1300),
  ['0', 'ENDSEC'], ['0', 'EOF'],
);

test('levels are read off the plan and the storey height is the rise between them', () => {
  const levels = levelsIn([{ text: 'FFL +3.45' }, { text: 'F.F.L. 0.00' }, { text: '+6.90' }, { text: '±0.00' }, { text: '110MM PIPE' }, { text: '+0.15' }]);
  assert.deepEqual(levels, [0, 0.15, 3.45, 6.9]);
  assert.equal(storeyHeight(levels), 3.45, 'a 15 cm step is not a storey');
  assert.equal(storeyHeight([0, 0.15]), null);
  assert.deepEqual(wallLayers(['A-WALL', 'A-WALL-PATT', 'sh-wall', 'WALL DIM', 'Arch_Section_Wall', 'A-DOOR', 'Block work']), ['A-WALL', 'sh-wall', 'Block work']);
});

test('a plan stands its wall lines up to the storey height from its level marks, in metres', async () => {
  const m = await roughModel(plan, 'house.dxf');
  assert.equal(m.error, undefined);
  assert.deepEqual(m.layers, ['A-WALL']);
  assert.equal(m.walls.length, 16, 'four walls, four numbers each; the hatch is not a wall');
  const xs = m.walls.filter((_, i) => i % 2 === 0);
  assert.equal(Math.max(...xs) - Math.min(...xs), 10, 'millimetres become metres');
  assert.equal(m.height, 3.6);
  assert.equal(m.heightFrom, 'levels');
  assert.match(m.note, /Wall height 3\.6 m, from the level marks in the drawing \(0\.00, \+0\.15, \+3\.60\)/);
});

test('without two floor levels the walls are 3.5 m high, and it says so', async () => {
  const flat = dxf(['0', 'SECTION'], ['2', 'ENTITIES'], ...line('WALL', 0, 0, 5, 0), ['0', 'ENDSEC'], ['0', 'EOF']);
  const m = await roughModel(flat, 'flat.dxf');
  assert.equal(m.height, 3.5);
  assert.match(m.note, /3\.5 m by default/);
  assert.match(m.note, /does not say its units; read as metres/);
});

test('a plan with doors but no wall layer gets no 3D, and the draftsman is told', async () => {
  const noWalls = dxf(['0', 'SECTION'], ['2', 'ENTITIES'], ...line('LINES', 0, 0, 5000, 0), ...line('A-DOOR', 0, 0, 900, 0), ['0', 'ENDSEC'], ['0', 'EOF']);
  const m = await roughModel(noWalls, 'nowalls.dxf');
  assert.match(m.error, /no layer named for walls .* Tell the draftsman/);
  assert.equal(m.walls, undefined, 'nothing is drawn');
  const reading = await readDrawing(noWalls, 'nowalls.dxf');
  assert.match(reading, /## Tell the draftsman[\s\S]*No layer is named for walls/);
  // A drainage drawing has no doors: it is not asked for walls.
  const drainage = dxf(['0', 'SECTION'], ['2', 'ENTITIES'], ...line('PIPE', 0, 0, 5000, 0), ['0', 'ENDSEC'], ['0', 'EOF']);
  assert.doesNotMatch(await readDrawing(drainage, 'drainage.dxf'), /named for walls/);
});

test("another person cannot get the rough 3D of someone's drawing", async () => {
  await reset();
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const owner = await user(await makeUser('Owner'));
  const other = await user(await makeUser('Other'));
  const dir = mkdtempSync(join(tmpdir(), 'reem-rough-'));
  try {
    const path = join(dir, 'house.dxf');
    writeFileSync(path, plan);
    const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, status, path, size)
      VALUES (?, 'house.dxf', 'house.dxf', 'ready', ?, ?) RETURNING id`).run(owner.id, path, plan.length);
    assert.equal((await roughModelFor(owner, id)).height, 3.6);
    assert.equal(await roughModelFor(other, id), null);
    // A PDF plan Reem has already traced comes from what was kept, and only to its owner.
    const pdf = await db.prepare(`INSERT INTO documents (user_id, name, title, status, path, hash) VALUES (?, 'plan.pdf', 'plan.pdf', 'ready', ?, 'h1') RETURNING id`).run(owner.id, path);
    await db.prepare('INSERT INTO plan_models (document_id, hash, model) VALUES (?, ?, ?)').run(pdf.id, 'h1', JSON.stringify({ floors: [], note: 'kept' }));
    assert.equal((await roughModelFor(owner, pdf.id)).note, 'kept');
    assert.equal(await roughModelFor(other, pdf.id), null);
    const doc = await db.prepare(`INSERT INTO documents (user_id, name, title, status, path) VALUES (?, 'notes.docx', 'notes.docx', 'ready', ?) RETURNING id`).run(owner.id, path);
    assert.equal(await roughModelFor(owner, doc.id), null, 'no 3D from a Word file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
