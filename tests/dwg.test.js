import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { extractText } from '../server/knowledge.js';
import { readDrawing, isDrawing, MAX_DRAWING_MB, uploadLimitMB, lengthOf, areaOf, pipeKey } from '../server/dwg.js';

test.after(() => closeDb());

// A DXF is pairs of lines: a group code, then its value.
const dxf = (...pairs) => Buffer.from(pairs.flat().join('\n') + '\n');
const sample = dxf(
  ['0', 'SECTION'], ['2', 'BLOCKS'],
  ['0', 'BLOCK'], ['2', 'MANHOLE'], ['8', '0'],
  ['0', 'TEXT'], ['8', '0'], ['1', 'MH'],
  ['0', 'ENDBLK'],
  ['0', 'BLOCK'], ['2', 'UNUSED'],
  ['0', 'TEXT'], ['8', '0'], ['1', 'NEVER PLACED'],
  ['0', 'ENDBLK'],
  ['0', 'ENDSEC'],
  ['0', 'SECTION'], ['2', 'ENTITIES'],
  ['0', 'TEXT'], ['8', 'DRN-TEXT'], ['1', '%%c150 UPVC'],
  ['0', 'TEXT'], ['8', 'DRN-TEXT'], ['1', '%%c150 UPVC'],
  ['0', 'MTEXT'], ['8', 'NOTES'], ['3', '{\\fArial|b1;ALL PIPES '], ['1', 'TO FALL\\P1:100}'],
  ['0', 'DIMENSION'], ['8', 'DIM'], ['1', '<> MM'], ['42', '1250.4'],
  ['0', 'DIMENSION'], ['8', 'DIM'], ['42', '3.456'],
  ['0', 'INSERT'], ['8', 'drainage'], ['2', 'MANHOLE'],
  ['0', 'INSERT'], ['8', 'drainage'], ['2', 'MANHOLE'],
  ['0', 'INSERT'], ['8', 'TITLE'], ['2', 'A1'],
  ['0', 'ATTRIB'], ['8', 'TITLE'], ['2', 'DWG_NO'], ['1', 'DR-102'],
  ['0', 'ENDSEC'],
  ['0', 'EOF'],
);

test('a drawing reads as its layers, notes, dimensions and symbols, repeats counted', async () => {
  const t = await readDrawing(sample, 'school.dxf');
  assert.match(t, /^CAD drawing: school\.dxf/);
  assert.match(t, /## Layer: DRN-TEXT\nText: Ø150 UPVC \(×2\)/);
  assert.match(t, /Text: ALL PIPES TO FALL 1:100/, 'MTEXT formatting is stripped and its pieces joined');
  assert.match(t, /Dimensions: 1250 MM, 3\.46/, 'a typed "<>" becomes the measured value');
  assert.match(t, /Symbols\/blocks: MANHOLE \(×2\)/);
  assert.match(t, /DWG_NO: DR-102/, 'title-block attributes are listed');
  assert.match(t, /MANHOLE: MH/, 'labels inside a placed symbol are read');
  assert.doesNotMatch(t, /NEVER PLACED/, 'a symbol drawn nowhere is left out');
});

test('drawings come through the same reader as PDFs, for chat and the Shelf', async () => {
  assert.ok(isDrawing('Plan.DWG') && isDrawing('x.dxf') && !isDrawing('x.pdf'));
  const t = await extractText({ buffer: sample, mimetype: 'application/octet-stream', originalname: 'school.dxf' });
  assert.match(t, /Ø150 UPVC/);
});

test('lines are measured per layer in metres; the sheet frame and lines inside symbols are not', async () => {
  const drawing = dxf(
    ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '4'], ['0', 'ENDSEC'], // millimetres
    ['0', 'SECTION'], ['2', 'BLOCKS'],
    ['0', 'BLOCK'], ['2', 'MH'], ['0', 'LINE'], ['8', 'PIPE'], ['10', '0'], ['20', '0'], ['11', '99999'], ['21', '0'], ['0', 'ENDBLK'],
    ['0', 'ENDSEC'],
    ['0', 'SECTION'], ['2', 'ENTITIES'],
    ['0', 'LINE'], ['8', 'PIPE'], ['10', '0'], ['20', '0'], ['11', '6000'], ['21', '8000'],                 // 10 m
    ['0', 'ARC'], ['8', 'PIPE'], ['10', '0'], ['20', '0'], ['40', '1000'], ['50', '0'], ['51', '180'],     // half of a 1 m circle: 3.14 m
    ['0', 'LWPOLYLINE'], ['8', 'WALL'], ['70', '1'], ['10', '0'], ['20', '0'], ['10', '4000'], ['20', '0'], ['10', '4000'], ['20', '3000'], // closed 3-4-5: 12 m
    ['0', 'LWPOLYLINE'], ['8', 'WALL'], ['70', '0'], ['10', '0'], ['20', '0'], ['42', '1'], ['10', '2000'], ['20', '0'], // bulge 1: half circle, 3.14 m
    ['0', 'POLYLINE'], ['8', 'WALL'], ['70', '0'], ['0', 'VERTEX'], ['10', '0'], ['20', '0'], ['0', 'VERTEX'], ['10', '0'], ['20', '5000'], ['0', 'SEQEND'], // 5 m
    ['0', 'MLINE'], ['8', 'WALL'], ['71', '1'], ['11', '0'], ['21', '0'], ['11', '3000'], ['21', '4000'],    // 5 m
    ['0', 'LINE'], ['8', 'FRAME'], ['67', '1'], ['10', '0'], ['20', '0'], ['11', '840000'], ['21', '0'],      // paper space
    ['0', 'ENDSEC'], ['0', 'EOF'],
  );
  const t = await readDrawing(drawing, 'site.dxf');
  assert.match(t, /Drawing units: millimetres/);
  assert.match(t, /^PIPE: 13\.1 m \(2 pieces\)$/m, 'the 100 m line inside the MH symbol is not counted');
  assert.match(t, /^WALL: 25\.1 m \(4 pieces\)$/m);
  assert.doesNotMatch(t, /^FRAME:/m, 'the paper-space sheet frame is not measured');
});

test('one piece that is most of a layer is pointed out, with the total without it', async () => {
  const pipes = Array.from({ length: 12 }, () => [['0', 'LINE'], ['8', 'RAIN'], ['10', '0'], ['20', '0'], ['11', '1000'], ['21', '0']]).flat();
  const drawing = dxf(
    ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '4'], ['0', 'ENDSEC'],
    ['0', 'SECTION'], ['2', 'ENTITIES'], ...pipes,
    ['0', 'LWPOLYLINE'], ['8', 'RAIN'], ['70', '1'], ['10', '0'], ['20', '0'], ['10', '100000'], ['20', '0'], ['10', '100000'], ['20', '50000'], ['10', '0'], ['20', '50000'],
    ['0', 'ENDSEC'], ['0', 'EOF'],
  );
  const t = await readDrawing(drawing, 'rain.dxf');
  assert.match(t, /RAIN: 312 m \(13 pieces\)\. CHECK: a closed shape 100 m × 50\.0 m alone is 300 m.*without it the layer is 12\.0 m/);
  // The same, as a point to send to whoever drew it; with no title block, the drawing number too.
  assert.match(t, /## Tell the draftsman[\s\S]*1\. Layer "RAIN" has a closed shape 100 m × 50\.0 m[\s\S]*2\. No clear drawing number/);
  assert.doesNotMatch(t, /units are not set/, 'the units were given');
});

test('a drawing with no units and its lines on layer 0 asks for both', async () => {
  const lines = Array.from({ length: 3 }, (_, i) => [['0', 'LINE'], ['8', '0'], ['10', '0'], ['20', String(i)], ['11', '500'], ['21', String(i)]]).flat();
  const t = await readDrawing(dxf(['0', 'SECTION'], ['2', 'ENTITIES'], ...lines, ['0', 'ENDSEC'], ['0', 'EOF']), 'x.dxf');
  assert.match(t, /units are not set/);
  assert.match(t, /1,500 drawing units of lines are on layer "0"/);
});

test('a curve drawn as a spline is measured as AutoCAD measures it', () => {
  // A quarter of a 1 m circle, the way CAD stores it: degree 2, weighted.
  const q = { type: 'SPLINE', degree: 2, knots: [0, 0, 0, 1, 1, 1], weights: [1, Math.SQRT1_2, 1], ctrl: [{ x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }] };
  assert.ok(Math.abs(lengthOf(q) - Math.PI * 500) < 0.1, `${lengthOf(q)} mm`);
});

test('areas of closed shapes, arcs included', () => {
  assert.equal(areaOf({ type: 'LWPOLYLINE', flags: 1, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }), 12);
  assert.ok(Math.abs(areaOf({ type: 'LWPOLYLINE', flags: 1, pts: [{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0, bulge: 1 }] }) - Math.PI) < 1e-9, 'a circle from two bulged points');
  assert.ok(Math.abs(areaOf({ type: 'LWPOLYLINE', flags: 1, pts: [{ x: 0, y: 0 }, { x: 2, y: 0, bulge: 1 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }) - (4 + Math.PI / 2)) < 1e-9);
  assert.equal(areaOf({ type: 'LWPOLYLINE', flags: 0, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] }), 0, 'an open polyline has no area');
});

test('pipe labels are named one way per pipe', () => {
  assert.equal(pipeKey('EACH 82MM V.PIPE'), '82MM V.PIPE');
  assert.equal(pipeKey('110 MM RW .PIPE(F/A)'), '110MM RW.PIPE');
  assert.equal(pipeKey('U.P.V.C PIPE 200MM Ø'), '200MM');
  assert.equal(pipeKey('Ø160'), '160MM');
});

test('pipe length per size follows the labelled run; openings are not pipes', async () => {
  const t = await readDrawing(dxf(
    ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '4'], ['0', 'ENDSEC'],
    ['0', 'SECTION'], ['2', 'ENTITIES'],
    ['0', 'LINE'], ['8', 'WASTE'], ['10', '0'], ['20', '0'], ['11', '10000'], ['21', '0'],
    ['0', 'LINE'], ['8', 'WASTE'], ['10', '10000'], ['20', '0'], ['11', '15000'], ['21', '0'], // joins the first: one 15 m run
    ['0', 'LINE'], ['8', 'WASTE'], ['10', '0'], ['20', '5000'], ['11', '7000'], ['21', '5000'],
    ['0', 'TEXT'], ['8', 'drainage'], ['10', '2000'], ['20', '150'], ['40', '200'], ['1', '110MM W.PIPE(T/B)'],
    ['0', 'TEXT'], ['8', 'drainage'], ['10', '1000'], ['20', '5150'], ['40', '200'], ['1', '82MM'],
    ['0', 'TEXT'], ['8', 'drainage'], ['10', '1000'], ['20', '8000'], ['40', '200'], ['1', '200X800 mm² OPENING'],
    ['0', 'LWPOLYLINE'], ['8', 'ROOMS'], ['70', '1'], ['10', '0'], ['20', '0'], ['10', '4000'], ['20', '0'], ['10', '4000'], ['20', '3000'], ['10', '0'], ['20', '3000'],
    ['0', 'ENDSEC'], ['0', 'EOF'],
  ), 'pipes.dxf');
  assert.match(t, /^110MM W\.PIPE: 15\.0 m \(1 run\)$/m);
  assert.match(t, /^82MM: 7\.0 m \(1 run\)$/m);
  assert.doesNotMatch(t, /OPENING: /);
  assert.match(t, /^ROOMS: 12\.0 m² \(1 shape\)$/m);
  assert.ok(t.indexOf('## Pipe lengths by size') < t.indexOf('## Layers'), 'the measured numbers come before the long lists');
});

test('a 32.6 MB PDF drawing set can be uploaded; a video that size cannot', () => {
  assert.equal(uploadLimitMB('Arch-TRK.pdf'), 40);
  assert.equal(uploadLimitMB('PLAN.PDF'), 40);
  assert.equal(uploadLimitMB('site.dwg'), 35);
  assert.equal(uploadLimitMB('clip.mp4'), 25);
  assert.equal(uploadLimitMB('photo.jpg'), 25);
});

test('a drawing over the limit is refused before it is converted', async () => {
  const big = Buffer.alloc(MAX_DRAWING_MB * 1024 * 1024 + 1);
  await assert.rejects(readDrawing(big, 'huge.dwg'), /too big to read/);
});
