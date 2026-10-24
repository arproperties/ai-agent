import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb } from './helpers/db.js';
import {
  checkAddresses, nearest, isKnown, addressPrompt, loadAddresses,
  addAddress, removeAddress, listAddresses, propose, decide, addressKit,
} from '../server/addressBook.js';

test.after(() => closeDb());

test('real mailboxes pass, outside addresses are left alone', async () => {
  await reset();
  await assert.doesNotReject(checkAddresses(['accounts@ainalreempro.com', 'Rona@AinalreemPro.com', 'someone@gmail.com']));
  assert.ok(isKnown('tauqeer@madaralwadi.com'));
});

test('a guessed company address is refused with the real one', async () => {
  await reset();
  await assert.rejects(checkAddresses(['account@ainalreempro.com']), /Did you mean accounts@ainalreempro\.com/);
  await assert.rejects(checkAddresses(['mohammed@ainalreempro.com']), /mohamed@ainalreempro\.com/);
  await assert.rejects(checkAddresses(['tenant.care@ainalreempro.com']), /tenantcare@ainalreempro\.com/);
});

test('the refusal tells the master how to add it, and anyone else to ask the master', async () => {
  await reset();
  await assert.rejects(checkAddresses(['info@madaralwadi.com'], { canAdd: true }), /add_company_address/);
  await assert.rejects(checkAddresses(['info@madaralwadi.com']), /ask the master/);
});

test('francis and francisca are both offered', async () => {
  await reset();
  await loadAddresses();
  assert.deepEqual(nearest('fran@ainalreempro.com').sort(), ['francis@ainalreempro.com', 'francisca@ainalreempro.com']);
});

test('the prompt lists every mailbox, added ones too', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  await addAddress(master, ' Info@MadarAlWadi.com ');
  await loadAddresses();
  const p = addressPrompt();
  assert.ok(p.includes('accounts@ainalreempro.com') && p.includes('parkplace.watch@ainalreempro.com'));
  assert.ok(p.includes('Added by the master: info@madaralwadi.com'));
});

test('the master adds and removes; built-in, outside and repeat addresses are refused', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  const row = await addAddress(master, 'info@madaralwadi.com');
  await assert.doesNotReject(checkAddresses(['info@madaralwadi.com']));
  await assert.rejects(addAddress(master, 'INFO@madaralwadi.com'), /already/);
  await assert.rejects(addAddress(master, 'accounts@ainalreempro.com'), /already/);
  await assert.rejects(addAddress(master, 'someone@gmail.com'), /nothing to add/);
  await assert.rejects(addAddress(master, 'not an email'), /not an email/);
  assert.equal((await listAddresses()).added.length, 1);

  assert.equal(await removeAddress(row.id), true);
  await assert.rejects(checkAddresses(['info@madaralwadi.com']), /not in the company address book/);
});

test('from chat: only the master gets the tool, and nothing is added until Add', async () => {
  await reset();
  const master = { id: await makeUser('Owner'), role: 'master' };
  assert.equal(addressKit({ id: await makeUser('Rona'), role: 'user' }).definitions.length, 0);

  const cards = [];
  const kit = addressKit(master, { onCard: (p) => cards.push(p) });
  const r = await kit.run({ id: 't1', name: 'add_company_address', input: { email: 'info@madaralwadi.com' } });
  assert.match(r.content, /NOT added/);
  assert.equal(cards.length, 1);
  await assert.rejects(checkAddresses(['info@madaralwadi.com']), /not in the company address book/);

  const added = await decide(master, cards[0].id, true);
  assert.equal(added.status, 'added');
  await assert.doesNotReject(checkAddresses(['info@madaralwadi.com']));
  await assert.rejects(decide(master, cards[0].id, true), /already added/);

  const p = await propose(master, 'hr2@madaralwadi.com');
  assert.equal((await decide(master, p.id, false)).status, 'cancelled');
  await assert.rejects(checkAddresses(['hr2@madaralwadi.com']), /not in/);
});
