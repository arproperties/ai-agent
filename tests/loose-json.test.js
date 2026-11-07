import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import { looseJson } from '../server/files.js';

// A model's filing reply with a quoted nickname copied into the summary unescaped: the
// deposition of Brian Frazier v. Javied "Jeff" Akhtar failed to file every time for this.

test('a clean reply is read as it is', () => {
  assert.deepEqual(looseJson('Here:\n{"title": "Lease", "tags": ["a"]}'), { title: 'Lease', tags: ['a'] });
});

test('quotes inside a value are mended, the rest kept', () => {
  const out = `{"title": "Brian Frazier deposition – 12 June 2024",
 "folder": "Legal",
 "summary": "Deposition of Brian Frazier in Frazier v. Javied "Jeff" Akhtar, cause B-0210947.",
 "tags": ["deposition", "frazier"],
 "date": "2024-06-12"}`;
  const d = looseJson(out);
  assert.equal(d.summary, 'Deposition of Brian Frazier in Frazier v. Javied "Jeff" Akhtar, cause B-0210947.');
  assert.deepEqual(d.tags, ['deposition', 'frazier']);
  assert.equal(d.date, '2024-06-12');
});

test('quotes already escaped stay as they are', () => {
  assert.equal(looseJson('{"title": "The \\"Jeff\\" file",\n "x": "y"}').title, 'The "Jeff" file');
});

test('a reply that is not JSON at all still fails', () => {
  assert.throws(() => looseJson('no json here'), /no JSON/);
  assert.throws(() => looseJson('{"title": broken}'));
});
