import test from 'node:test';
import assert from 'node:assert/strict';
import { readReturnedDoc, checkAgainstCase } from '../server/renewalAi.js';

// The model's answer, as readReturnedDoc gets it.
const model = (answer, seen = {}) => async (system, content) => { seen.system = system; seen.content = content; return answer; };
const visaCase = { kind: 'renew', employee_code: 'E00056', employee_name: 'Abdul Karim Jan Khan', proposal: { terms: { expected_expiry: '2028-11-20' } } };
const contractCase = { kind: 'renew', employee_code: 'E00056', employee_name: 'Abdul Karim Jan Khan', proposal: { mode: 'update', terms: { new_end: '2028-10-31', basic: 900, allowance: 700 } } };
const read = (over = {}) => ({ name: 'ABDUL KARIM JAN KHAN', employee_code: null, passport_no: 'BS4951402', start: '2026-11-01', end: '2028-11-20',
  basic: null, allowance: null, total: null, signed: null, confidence: 'high', ...over });

test('the paper goes to the model as a PDF or a picture, and comes back in one shape', async () => {
  const seen = {};
  const r = await readReturnedDoc({ mime: 'application/pdf', data: 'JVBERi0=' }, { ask: model({ name: 'A', end: '2028-11-20', basic: '900', signed: 'yes', confidence: 'medium' }, seen) });
  assert.equal(seen.content[0].type, 'document');
  assert.deepEqual(r, { name: 'A', employee_code: null, passport_no: null, start: null, end: '2028-11-20', basic: 900, allowance: null, total: null,
    position: null, location: null, hours: null, benefits: null, signed: null, confidence: 'low' },
    'odd values become null, an unknown confidence is low');
  await readReturnedDoc({ mime: 'image/jpeg', data: 'x' }, { ask: model({}, seen) });
  assert.equal(seen.content[0].type, 'image');
});

test('a contract gives its other terms too: job title, work location, hours, benefits', async () => {
  const seen = {};
  const r = await readReturnedDoc({ mime: 'application/pdf', data: 'JVBERi0=' }, {
    ask: model({ basic: 500, allowance: 2500, total: 3000, position: ' Project Engineer ', location: 'Dubai', hours: '8 hours a day, 6 days a week',
      benefits: 'Air ticket every 2 years, medical insurance', confidence: 'high' }, seen),
  });
  assert.deepEqual([r.position, r.location, r.hours, r.benefits], ['Project Engineer', 'Dubai', '8 hours a day, 6 days a week', 'Air ticket every 2 years, medical insurance']);
  assert.match(seen.system, /job title/i, 'the model is asked for them');
});

test('matching document passes', () => {
  const r = checkAgainstCase(read(), visaCase, { contract: false });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('document for another employee is held', () => {
  const r = checkAgainstCase(read({ name: 'Sara Lopez' }), visaCase, { contract: false });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Sara Lopez.*Abdul Karim Jan Khan/);
  assert.equal(checkAgainstCase(read({ employee_code: 'E00999' }), visaCase, { contract: false }).ok, false, 'another code too');
  assert.equal(checkAgainstCase(read({ name: 'Abdul Karim Khan' }), visaCase, { contract: false }).ok, true, 'a name written shorter is still them');
});

test('end date not the approved one is held', () => {
  const r = checkAgainstCase(read({ end: '2028-01-01' }), visaCase, { contract: false });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /2028-01-01.*2028-11-20/);
  assert.equal(checkAgainstCase(read({ end: null }), visaCase, { contract: false }).ok, false, 'no date read: held');
});

test('unsigned is held, for a contract', () => {
  const ok = read({ end: '2028-10-31', basic: 900, allowance: 700, signed: true });
  assert.equal(checkAgainstCase(ok, contractCase, { contract: true }).ok, true);
  const r = checkAgainstCase({ ...ok, signed: false }, contractCase, { contract: true });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not signed/);
  assert.equal(checkAgainstCase({ ...ok, signed: null }, contractCase, { contract: true }).ok, false, 'not sure it is signed: held');
});

test('pay on the contract that is not the approved pay is held', () => {
  const r = checkAgainstCase(read({ end: '2028-10-31', basic: 800, allowance: 700, signed: true }), contractCase, { contract: true });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /basic 800.*900/);
});

test('low confidence always goes to HR', () => {
  const r = checkAgainstCase(read({ confidence: 'low' }), visaCase, { contract: false });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not sure/);
});
