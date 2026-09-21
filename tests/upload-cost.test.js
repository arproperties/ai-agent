import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { closeDb } from './helpers/db.js';
import { pdfPages, FIRST_LOOK } from '../server/knowledge.js';
import { inlineShare } from '../server/chat.js';

test.after(() => closeDb());

async function pdfOf(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([100 + i, 100]); // widths tell the pages apart
  return Buffer.from(await doc.save());
}

const widths = async (buf) => (await PDFDocument.load(buf)).getPages().map((p) => p.getWidth());

// ---------- scanned PDFs: only the pages asked for are sent ----------

test('pdfPages keeps the first pages, in order', async () => {
  assert.deepEqual(await widths(await pdfPages(await pdfOf(10), 0, FIRST_LOOK)), [100, 101, 102, 103]);
});

test('pdfPages gives the rest of the document', async () => {
  assert.deepEqual(await widths(await pdfPages(await pdfOf(6), FIRST_LOOK, 6)), [104, 105]);
});

test('pdfPages stops at the last page', async () => {
  assert.deepEqual(await widths(await pdfPages(await pdfOf(2), 0, FIRST_LOOK)), [100, 101]);
});

// ---------- chat attachments: one budget shared between the files ----------

test('a single file gets the whole budget', () => {
  assert.equal(inlineShare(1), 24000);
});

test('several files split the budget', () => {
  assert.equal(inlineShare(3), 8000);
});

test('many files still get enough of each to recognise it', () => {
  assert.equal(inlineShare(20), 4000);
});

test('images only (no documents) does not divide by zero', () => {
  assert.equal(inlineShare(0), 24000);
});
