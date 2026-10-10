import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocument, suggestion, cleanDetails } from '../server/documentReader.js';

const pdf = { buffer: Buffer.from('%PDF-1.4'), originalname: 'policy.pdf', mimetype: 'application/pdf' };

test('what the model read becomes a suggestion: known fields, real dates, nothing else', () => {
  const reply = `Here it is:\n\`\`\`json\n${JSON.stringify({ title: ' Property insurance ', number: 4471, issue_date: '2026-01-09', expiry_date: '2027-01-08', renew_by: 'quotes',
    insurer: 'Orient', premium: 'USD 4,200', sum_insured: { amount: 1 }, owner: 'ACE' })}\n\`\`\``;
  assert.deepEqual(suggestion(reply), { title: 'Property insurance', number: '4471', issue_date: '2026-01-09', expiry_date: '2027-01-08', renew_by: 'quotes',
    details: { insurer: 'Orient', premium: 'USD 4,200' } });
  // A date written another way, a date that does not exist, and a way of renewing nobody offered.
  assert.deepEqual(suggestion('{"title":"Licence","expiry_date":"08/01/2027","issue_date":"2026-02-31","renew_by":"auction"}'), { title: 'Licence' });
  for (const junk of ['', 'I cannot read this.', '{broken', '[1,2]', 'null', undefined]) assert.deepEqual(suggestion(junk), {});
});

test('reading a file: a PDF or a photo is sent, anything else is not, and a failure is an empty form', async () => {
  const seen = [];
  const ask = async (prompt, opts) => { seen.push(opts.content); return '{"title":"Fire insurance","expiry_date":"2027-01-08"}'; };
  assert.deepEqual(await readDocument(pdf, { ask }), { title: 'Fire insurance', expiry_date: '2027-01-08' });
  assert.deepEqual([seen[0][0].type, seen[0][0].source.media_type, seen[0][1].type], ['document', 'application/pdf', 'text']);
  await readDocument({ ...pdf, mimetype: 'image/jpeg' }, { ask });
  assert.equal(seen[1][0].type, 'image');
  assert.deepEqual(await readDocument({ ...pdf, mimetype: 'application/msword' }, { ask }), {});
  assert.deepEqual(await readDocument(undefined, { ask }), {});
  assert.equal(seen.length, 2, 'a file that cannot be read is never sent');
  assert.deepEqual(await readDocument(pdf, { ask: async () => { throw new Error('overloaded'); } }), {});
});

test('the figures kept with a document: known names only, as short lines of text', () => {
  assert.deepEqual(cleanDetails('{"insurer":" Orient ","junk":"x"}'), { insurer: 'Orient' });
  assert.deepEqual(cleanDetails({ premium: 4200, cover: '', deductible: ['a'] }), { premium: '4200' });
  for (const none of ['', '{}', [1], null, undefined]) assert.deepEqual(cleanDetails(none), {});
  assert.throws(() => cleanDetails('{not json'), /details/);
});

test('a reading that does not come back is given up on, so the form is never left waiting', { timeout: 3000 }, async () => {
  assert.deepEqual(await readDocument(pdf, { ask: () => new Promise(() => {}), timeoutMs: 20 }), {});
});
