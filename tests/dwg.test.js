import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { extractText } from '../server/knowledge.js';
import { readDrawing, isDrawing, MAX_DRAWING_MB, uploadLimitMB } from '../server/dwg.js';

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
