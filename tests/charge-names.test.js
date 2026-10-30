import test from 'node:test';
import assert from 'node:assert/strict';
import { RENT_NAMES, DEPOSIT_NAME, fixedName, lookalike } from '../server/chargeNames.js';

test('the fixed names are the two rents and the deposit', () => {
  assert.deepEqual(RENT_NAMES, ['Rent', 'Rent – HUD/Agency']);
  assert.equal(DEPOSIT_NAME, 'Security deposit');
});

test('a fixed name is known however it is typed: case, spaces, kind of dash', () => {
  assert.equal(fixedName('rent'), 'Rent');
  assert.equal(fixedName('  RENT - tenant '), 'Rent', 'the old "Rent – Tenant" is the rent');
  assert.equal(fixedName('rent - hud/agency'), 'Rent – HUD/Agency');
  assert.equal(fixedName('Rent—HUD/Agency'), 'Rent – HUD/Agency');
  assert.equal(fixedName('Security Deposit'), 'Security deposit');
  assert.equal(fixedName('Pet Rent'), null);
});

test('a typo or a near-copy of a fixed name is caught', () => {
  for (const [typed, like] of [['Rnet', 'Rent'], ['Retn', 'Rent'], ['Rents', 'Rent'], ['Rent – Tenat', 'Rent'], ['Rent – HUD/Agncy', 'Rent – HUD/Agency'], ['Rent HUD', 'Rent – HUD/Agency'],
    ['Securty deposit', 'Security deposit'], ['Security deposti', 'Security deposit'], ['Security deposit 2', 'Security deposit'],
    ['Rent (weekly)', 'Rent'], ['Rent extra', 'Rent']]) {
    assert.equal(lookalike(typed), like, typed);
  }
});

test('ordinary charges that only mention rent or a deposit stay free to use', () => {
  for (const name of ['Pet Rent', 'Washer Dryer Rental', 'washer dryer rental pr', 'Mailbox Key Deposit', 'Pet deposit', 'Energy deposit', 'Water/Trash PKG', 'Rental application fee', 'Parking']) {
    assert.equal(lookalike(name), null, name);
  }
});

test('a fixed name itself is not a lookalike', () => {
  for (const name of [...RENT_NAMES, DEPOSIT_NAME, 'rent', 'security deposit']) assert.equal(lookalike(name), null, name);
});
