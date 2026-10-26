import test from 'node:test';
import assert from 'node:assert/strict';
import { fromFileName, numbersInText, detectCase, allCases, sameCase, labelExcerpt, primaryCaseBlock } from '../server/primaryCase.js';

test("a case folder's file name gives the number and both parties", () => {
  assert.deepEqual(fromFileName('Case - E-205791 - JEFF AKHTAR ET AL vs JEREMY MITCHELL ET AL.pdf'),
    { number: 'E-205791', partyA: 'JEFF AKHTAR ET AL', partyB: 'JEREMY MITCHELL ET AL' });
  assert.deepEqual(fromFileName('Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC.pdf'),
    { number: 'Soutex E - 205791', partyA: 'Ahmed Ali', partyB: 'Gulf Trading LLC' });
  assert.equal(fromFileName('Tenancy contract 2024.pdf'), null);
  // the person's own pattern is read too
  assert.equal(fromFileName('Ahmed v Gulf (2024/1234).pdf', ['[Party A] v [Party B] ([Case Number])']).number, '2024/1234');
});

test('a case-shaped number next to a case word is found', () => {
  assert.deepEqual(numbersInText('check case 205791 please'), ['205791']);
  assert.deepEqual(numbersInText('Case no. E-205791'), ['E-205791']);
  assert.deepEqual(numbersInText('the case file 205791'), ['205791']);
  assert.deepEqual(numbersInText('Case E - 205791 hearing'), ['E - 205791']);
  assert.deepEqual(numbersInText('ما هو وضع القضية رقم 2024/1234'), ['2024/1234']);
  assert.deepEqual(numbersInText('205791'), ['205791']); // typed on its own
});

test('phones, amounts, dates, units and years are not cases', () => {
  for (const s of ['call 0501234567', 'AED 205,791 paid', 'unit 2057 is empty', 'due 26/10/2026',
    'in case 5000 is not enough', 'case 2024', 'file 0501234567', 'case due 26/10/2026', 'hello'])
    assert.deepEqual(numbersInText(s), [], s);
});

test('E-205791, E 205791 and e205791 are one case, and so is the bare number', () => {
  assert.ok(sameCase('E-205791', 'E 205791'));
  assert.ok(sameCase('E-205791', 'e205791'));
  assert.ok(sameCase('Soutex E - 205791', '205791'));
  assert.equal(sameCase('E-205791', 'E-198822'), false);
});

test('one case in a message is detected, two give nothing', () => {
  assert.equal(detectCase({ text: 'check case 205791' }).number, '205791');
  assert.equal(detectCase({ text: 'compare case 205791 with case 198822' }), null);
  assert.equal(detectCase({ text: 'hi' }), null);
  const pdf = detectCase({ text: '', fileNames: ['Case - E-205791 - JEFF AKHTAR ET AL vs JEREMY MITCHELL ET AL.pdf'] });
  assert.equal(pdf.number, 'E-205791');
  assert.equal(pdf.partyB, 'JEREMY MITCHELL ET AL');
});

test("a person's own case folder wins, with its parties, when only its number is typed", () => {
  const known = [{ number: 'Soutex E - 205791', partyA: 'Ahmed', partyB: 'Gulf', folderId: 7 }];
  const c = detectCase({ text: 'what is new on 205791?', known });
  assert.equal(c.number, 'Soutex E - 205791');
  assert.equal(c.folderId, 7);
  assert.equal(c.partyA, 'Ahmed');
});

test('a later message gives every case it names, as written', () => {
  assert.deepEqual(allCases({ text: 'how did case 198822 go, compared with case E-205791?' }).map((c) => c.number), ['198822', 'E-205791']);
});

test('excerpts are labelled by the file they come from, not by what they quote', () => {
  const primary = { number: 'E-205791' };
  const refs = [{ number: '198822' }];
  assert.match(labelExcerpt('[Case - E-205791 - A vs B] the survey', primary, refs), /^\[primary case E-205791\]/);
  assert.match(labelExcerpt('[Case - 198822 - C vs D] settled', primary, refs), /^\[reference: 198822\]/);
  assert.equal(labelExcerpt('[Lease.pdf] mentions E-205791', primary, refs), '[Lease.pdf] mentions E-205791');
  assert.equal(labelExcerpt('[x] y', null), '[x] y');
});

test('the prompt block names the case and the references, and nothing without a case', () => {
  assert.equal(primaryCaseBlock('Jeff', null), '');
  const block = primaryCaseBlock('Jeff', { number: 'E-205791', partyA: 'Jeff Akhtar', partyB: 'Jeremy Mitchell' }, [{ number: 'E 205791' }, { number: '198822' }]);
  assert.match(block, /number="E-205791" parties="Jeff Akhtar vs Jeremy Mitchell"/);
  assert.match(block, /Reference cases so far: 198822\./);
  assert.match(block, /start a new chat/);
});
