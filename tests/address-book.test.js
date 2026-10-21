import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAddresses, nearest, isKnown, addressPrompt } from '../server/addressBook.js';

test('real mailboxes pass, outside addresses are left alone', () => {
  assert.doesNotThrow(() => checkAddresses(['accounts@ainalreempro.com', 'Rona@AinalreemPro.com', 'someone@gmail.com']));
  assert.ok(isKnown('tauqeer@madaralwadi.com'));
});

test('a guessed company address is refused with the real one', () => {
  assert.throws(() => checkAddresses(['account@ainalreempro.com']), /Did you mean accounts@ainalreempro\.com/);
  assert.throws(() => checkAddresses(['mohammed@ainalreempro.com']), /mohamed@ainalreempro\.com/);
  assert.throws(() => checkAddresses(['tenant.care@ainalreempro.com']), /tenantcare@ainalreempro\.com/);
});

test('francis and francisca are both offered', () => {
  assert.deepEqual(nearest('fran@ainalreempro.com').sort(), ['francis@ainalreempro.com', 'francisca@ainalreempro.com']);
});

test('the prompt lists every mailbox', () => {
  const p = addressPrompt();
  assert.ok(p.includes('accounts@ainalreempro.com') && p.includes('parkplace.watch@ainalreempro.com'));
});
