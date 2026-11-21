import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb } from './helpers/db.js';
import { saveContact, findContacts, listContacts, whatsappKit } from '../server/whatsapp.js';

test.after(() => closeDb());

// Runs a tool the way the chat does and returns { text, error, cards }.
async function call(user, name, input) {
  const cards = [];
  const kit = whatsappKit(user, { onCard: (c) => cards.push(c) });
  const r = await kit.run({ id: 't1', name, input });
  return { text: r.content, error: !!r.is_error, cards };
}

test('a number said once is kept, and the name alone finds it', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  const first = await call(me, 'whatsapp_draft', { to: '971 544387902', name: 'Ahmed', message: 'Hi Ahmed' });
  assert.equal(first.error, false);
  assert.equal(first.cards.length, 1);
  assert.equal(first.cards[0].phone, '971544387902');
  assert.match(first.cards[0].url, /^https:\/\/wa\.me\/971544387902\?text=Hi%20Ahmed$/);

  const next = await call(me, 'whatsapp_draft', { to: 'ahmed', message: 'The cheque is ready' });
  assert.equal(next.error, false);
  assert.equal(next.cards[0].phone, '971544387902');
  assert.equal(next.cards[0].name, 'Ahmed');
  assert.equal(new URL(next.cards[0].url).searchParams.get('text'), 'The cheque is ready');
});

test('a name with no saved number is not guessed: the agent is told to ask', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  const r = await call(me, 'whatsapp_draft', { to: 'Mariam', message: 'Hello' });
  assert.equal(r.error, true);
  assert.match(r.text, /no WhatsApp number saved for "Mariam"/);
  assert.match(r.text, /Ask the user/);
  assert.equal(r.cards.length, 0);
});

test('a number WhatsApp cannot open is refused, and no card is made', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  for (const to of ['04 123 4567', '07911 123456']) {
    const r = await call(me, 'whatsapp_draft', { to, message: 'Hello' });
    assert.equal(r.error, true, to);
    assert.match(r.text, /not a number WhatsApp can open/);
    assert.equal(r.cards.length, 0);
  }
});

test('a number given without a name opens WhatsApp but is not saved under one', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  const r = await call(me, 'whatsapp_draft', { to: '0544387902', message: 'Hi' });
  assert.equal(r.error, false);
  assert.equal(r.cards[0].name, null);
  assert.deepEqual(await listContacts(me.id), []);
  assert.match(r.text, /save_whatsapp_contact/);
});

test('saving a name again replaces the number; two people with one name part are asked which', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  await saveContact(me.id, 'Ahmed Khan', '0544387902');
  await saveContact(me.id, 'ahmed  khan', '0501234567');
  assert.deepEqual(await listContacts(me.id), [{ name: 'ahmed khan', phone: '971501234567' }]);

  await saveContact(me.id, 'Ahmed Ali', '0559876543');
  assert.equal((await findContacts(me.id, 'Ahmed')).length, 2);
  const r = await call(me, 'whatsapp_draft', { to: 'Ahmed', message: 'Hi' });
  assert.equal(r.error, true);
  assert.match(r.text, /More than one/);
  assert.equal((await call(me, 'whatsapp_draft', { to: 'Ahmed Ali', message: 'Hi' })).cards[0].phone, '971559876543');
});

test('nobody sees anyone else\'s numbers', async () => {
  await reset();
  const a = { id: await makeUser('Alice') };
  const b = { id: await makeUser('Bob') };
  await saveContact(a.id, 'Ahmed', '0544387902');
  assert.deepEqual(await findContacts(b.id, 'Ahmed'), []);
  assert.deepEqual(await listContacts(b.id), []);
  const r = await call(b, 'whatsapp_draft', { to: 'Ahmed', message: 'Hi' });
  assert.equal(r.error, true);
  assert.equal(r.cards.length, 0);
});

test('save_whatsapp_contact saves without opening WhatsApp', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  const r = await call(me, 'save_whatsapp_contact', { name: 'Sara', phone: '+44 7911 123456' });
  assert.equal(r.error, false);
  assert.equal(r.cards.length, 0);
  assert.deepEqual(await listContacts(me.id), [{ name: 'Sara', phone: '447911123456' }]);
  assert.equal((await call(me, 'save_whatsapp_contact', { name: 'Bad', phone: '123' })).error, true);
});

test('an empty message is not drafted', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  const r = await call(me, 'whatsapp_draft', { to: '0544387902', message: '  ' });
  assert.equal(r.error, true);
  assert.equal(r.cards.length, 0);
});

test('a saved number can be forgotten, and then it is asked for again', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  await saveContact(me.id, 'Francis', '0554501483');
  const listed = await call(me, 'list_whatsapp_contacts', {});
  assert.match(listed.text, /Francis: \+971554501483/);

  const gone = await call(me, 'forget_whatsapp_contact', { name: 'francis' });
  assert.equal(gone.error, false);
  assert.match(gone.text, /Removed the saved WhatsApp number for francis/);
  assert.deepEqual(await listContacts(me.id), []);

  const again = await call(me, 'whatsapp_draft', { to: 'Francis', message: 'Hi' });
  assert.equal(again.error, true);
  assert.match(again.text, /no WhatsApp number saved/);
  assert.match((await call(me, 'forget_whatsapp_contact', { name: 'Francis' })).text, /no saved WhatsApp number/);
});

test('forgetting only touches the person\'s own numbers', async () => {
  await reset();
  const a = { id: await makeUser('Alice') };
  const b = { id: await makeUser('Bob') };
  await saveContact(a.id, 'Ahmed', '0544387902');
  await call(b, 'forget_whatsapp_contact', { name: 'Ahmed' });
  assert.equal((await listContacts(a.id)).length, 1);
});

test('a draft from a saved number says it came from the saved list, so a wrong one is caught', async () => {
  await reset();
  const me = { id: await makeUser('Owner') };
  await saveContact(me.id, 'Ahmed', '0544387902');
  const r = await call(me, 'whatsapp_draft', { to: 'Ahmed', message: 'Hi' });
  assert.match(r.text, /saved earlier/);
  assert.match(r.text, /nothing opens by itself/i);
  assert.equal(r.cards.length, 1);
});
