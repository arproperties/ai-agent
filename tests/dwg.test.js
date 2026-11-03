import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { extractText } from '../server/knowledge.js';
import { readDrawing, isDrawing, MAX_DRAWING_MB } from '../server/dwg.js';

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

test('a drawing over the limit is refused before it is converted', async () => {
  const big = Buffer.alloc(MAX_DRAWING_MB * 1024 * 1024 + 1);
  await assert.rejects(readDrawing(big, 'huge.dwg'), /too big to read/);
});
