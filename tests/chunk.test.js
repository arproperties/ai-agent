import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { chunk, stitch } from '../server/knowledge.js';

test.after(() => closeDb());

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// ~9,000 characters of numbered sentences, a newline every few, like an extracted contract.
const sentences = Array.from({ length: 150 }, (_, i) => `Clause ${i} says the tenant of unit ${1000 + i} pays AED ${50000 + i} a year.`);
const long = sentences.map((s, i) => s + (i % 6 === 5 ? '\n' : ' ')).join('');

test('a short text is one piece', () => {
  assert.deepEqual(chunk('The notice period is 30 days.'), ['The notice period is 30 days.']);
});

test('each piece starts with the end of the one before it', () => {
  const pieces = chunk(long);
  assert.ok(pieces.length > 4);
  for (let i = 1; i < pieces.length; i++) {
    const head = pieces[i].slice(0, 60);
    assert.ok(pieces[i - 1].includes(head), `piece ${i} repeats nothing of piece ${i - 1}`);
    assert.ok(pieces[i - 1].length - pieces[i - 1].lastIndexOf(head) >= 100, `piece ${i} overlaps by too little`);
  }
});

test('no piece is longer than the size asked for, and a piece starts on a whole word', () => {
  for (const p of chunk(long)) assert.ok(p.length <= 1500);
  const words = chunk(long).map((p) => p.split(' ')[0]);
  for (const w of words) assert.ok(long.split(/\s+/).includes(w), `"${w}" is half a word`);
});

test('a sentence that falls on a cut is whole in at least one piece', () => {
  const pieces = chunk(long);
  for (const s of sentences) assert.ok(pieces.some((p) => p.includes(s)), `split everywhere: ${s}`);
});

test('text with no spaces or newlines still ends', () => {
  const pieces = chunk('x'.repeat(5000));
  assert.ok(pieces.length >= 4 && pieces.length < 10);
});

test('stitch puts overlapping pieces back together without repeating anything', () => {
  assert.equal(squash(stitch(chunk(long))), squash(long));
});

test('stitch joins pieces that never overlapped, as files indexed before the fix are stored', () => {
  assert.equal(stitch(['The rent is due', 'on the first of March.']), 'The rent is due\non the first of March.');
  // a piece of exactly the full size was cut mid-text, not at a line end
  const full = 'a'.repeat(1500);
  assert.equal(stitch([full, 'bcd']), `${full}bcd`);
});
