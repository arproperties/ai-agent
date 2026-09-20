import './helpers/db.js'; // must be first: it points DATABASE_URL at the test database
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { parseId, resolveFolder, replySubject, buildRefs } from '../server/imap.js';

test.after(() => closeDb());

test('an id is a folder and a uid, and folders contain colons', () => {
  assert.deepEqual(parseId('INBOX:42'), { path: 'INBOX', uid: 42 });
  assert.deepEqual(parseId('INBOX/Clients:7'), { path: 'INBOX/Clients', uid: 7 });
  assert.deepEqual(parseId('[Gmail]/All Mail:9'), { path: '[Gmail]/All Mail', uid: 9 });
});

test('anything that is not one is refused, not guessed at', () => {
  for (const bad of ['', 'INBOX', '42', ':42', 'INBOX:', 'INBOX:abc', 'INBOX:0']) {
    assert.throws(() => parseId(bad), /Unknown email id/, `expected "${bad}" to be refused`);
  }
});

test('a folder is found by its display name or its full path, whatever the case', () => {
  const boxes = [
    { path: 'INBOX', name: 'INBOX' },
    { path: 'INBOX/Clients', name: 'Clients' },
    { path: 'Archive', name: 'Archive' },
  ];
  assert.equal(resolveFolder(boxes, 'clients').path, 'INBOX/Clients');
  assert.equal(resolveFolder(boxes, 'INBOX/Clients').path, 'INBOX/Clients');
  assert.equal(resolveFolder(boxes, '  Archive  ').path, 'Archive');
  assert.equal(resolveFolder(boxes, 'nowhere'), undefined);
});

test('Re: is added once and never stacked', () => {
  assert.equal(replySubject('Invoice 42'), 'Re: Invoice 42');
  assert.equal(replySubject('Re: Invoice 42'), 'Re: Invoice 42');
  assert.equal(replySubject('RE: Invoice 42'), 'RE: Invoice 42');
  assert.equal(replySubject('re:Invoice 42'), 're:Invoice 42');
  assert.equal(replySubject(''), 'Re: (no subject)');
});

test('References grows by one and keeps the order the thread was written in', () => {
  assert.equal(buildRefs('<a@x> <b@x>', '<c@x>'), '<a@x> <b@x> <c@x>');
  assert.equal(buildRefs('', '<c@x>'), '<c@x>');
  assert.equal(buildRefs('<a@x>\r\n <b@x>', '<c@x>'), '<a@x> <b@x> <c@x>', 'folded headers unfold');
  assert.equal(buildRefs('<a@x>', ''), '<a@x>');
  assert.equal(buildRefs('', ''), null);
});

test('a message already in the References chain is not added twice', () => {
  assert.equal(buildRefs('<a@x> <c@x>', '<c@x>'), '<a@x> <c@x>');
});
