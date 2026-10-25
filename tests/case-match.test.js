import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionsCase, folderName, caseKey, searchTerm, unquoted, caseRegex, DEFAULT_PATTERN } from '../server/caseMatch.js';

test('the same case number written differently matches', () => {
  for (const s of ['Soutex E - 205791', 'soutex e-205791', 'SoutexE205791', 'Ref: SOUTEX E – 205791.'])
    assert.ok(mentionsCase({ subject: s, text: '' }, 'Soutex E - 205791'), s);
});
test('a nearby number does not match', () => {
  for (const s of ['Soutex E - 2057910', 'Soutex E - 20579', 'XSoutex E - 205791'])
    assert.equal(mentionsCase({ subject: s, text: '' }, 'Soutex E - 205791'), false, s);
});
test('a case mentioned only in quoted history does not count', () => {
  const text = 'About case Arkan B - 1100.\n\nOn Mon, 3 Oct 2026, Ali wrote:\n> Soutex E - 205791 hearing moved';
  assert.equal(mentionsCase({ subject: 'Re: hearing', text }, 'Soutex E - 205791'), false);
  assert.ok(mentionsCase({ subject: 'Re: hearing', text: 'Soutex E - 205791 hearing moved' }, 'Soutex E - 205791'));
  assert.equal(mentionsCase({ subject: '', text: 'x\n-----Original Message-----\nSoutex E - 205791' }, 'Soutex E - 205791'), false);
});
test('folder names follow the pattern', () => {
  const c = { case_number: 'Soutex E - 205791', party_a: 'Ahmed Ali', party_b: 'Gulf Trading LLC' };
  assert.equal(folderName(DEFAULT_PATTERN, c), 'Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC');
  assert.equal(folderName('[Party A] v [Party B] ([Case Number])', c), 'Ahmed Ali v Gulf Trading LLC (Soutex E - 205791)');
  assert.equal(folderName(DEFAULT_PATTERN, { ...c, party_b: '' }), 'Case - Soutex E - 205791 - Ahmed Ali vs Party B unknown');
  assert.equal(folderName('', c), folderName(DEFAULT_PATTERN, c));
  assert.equal(caseKey('Soutex E - 205791'), 'soutexe205791');
  assert.equal(searchTerm('Soutex E - 205791'), '205791');
});
test('unquoted cuts Outlook headers, separators and > lines', () => {
  assert.equal(unquoted('hi\n> old\nthere'), 'hi\nthere');
  assert.equal(unquoted('hi\n________________________________\nold'), 'hi');
  assert.equal(unquoted('hi\nFrom: Ali\nSent: Monday\nTo: me\nold'), 'hi');
  assert.ok(caseRegex('A-1').test('a 1'));
});
