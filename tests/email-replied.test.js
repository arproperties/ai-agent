import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { answered } from '../server/imap.js';

const d = (s) => new Date(s);
const mail = (key, o = {}) => ({ key, messageId: `<m${key}@x>`, subject: 'Unit 608 extension', from: ['jessa@x.com'], at: d('2026-10-22T07:00Z'), answeredFlag: false, ...o });

test('a sent reply pointing at the email counts, with its time', () => {
  const r = answered([mail(1)], [{ inReplyTo: '<m1@x>', references: [], subject: 'Re: other', to: [], at: d('2026-10-23T02:56Z') }]);
  assert.deepEqual(r.get(1), d('2026-10-23T02:56Z'));
});

test('a later sent email in the same subject to the sender counts', () => {
  const r = answered([mail(1, { messageId: null })], [{ references: [], subject: 'RE: Fwd: Unit 608 extension', to: ['jessa@x.com'], at: d('2026-10-23T02:56Z') }]);
  assert.ok(r.has(1));
});

test('same subject but sent earlier, or to someone else, does not count', () => {
  const sent = [
    { references: [], subject: 'Re: Unit 608 extension', to: ['jessa@x.com'], at: d('2026-10-21T00:00Z') },
    { references: [], subject: 'Re: Unit 608 extension', to: ['rona@x.com'], at: d('2026-10-23T00:00Z') },
  ];
  assert.equal(answered([mail(1, { messageId: null })], sent).has(1), false);
});

test('the answered flag counts, date unknown', () => {
  const r = answered([mail(1, { answeredFlag: true })], []);
  assert.equal(r.get(1), null);
  assert.ok(r.has(1));
});

test('a new message after the reply is still open', () => {
  const sent = [{ inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Unit 608 extension', to: ['jessa@x.com'], at: d('2026-10-22T08:00Z') }];
  const r = answered([mail(1), mail(2, { at: d('2026-10-22T09:00Z') })], sent);
  assert.ok(r.has(1));
  assert.equal(r.has(2), false);
});

test.after(() => closeDb());

// ---------- pickThread: the email a "Re: …" draft with no id answers ----------
import { pickThread } from '../server/imap.js';

const box = (id, o = {}) => ({ id, messageId: `<t${id}@x>`, refs: `<t${id}@x>`, subject: 'Unit 608 extension', from: ['jessa@x.com'], to: ['me@x.com'], at: d('2026-10-22T07:00Z'), ...o });

test('a Re: draft finds the newest email in that subject with that person', () => {
  const hit = pickThread([box('INBOX:1'), box('INBOX:2', { at: d('2026-10-24T07:00Z') }), box('Sent:3', { from: ['me@x.com'], to: ['jessa@x.com'], at: d('2026-10-23T07:00Z') })],
    { to: ['Jessa@x.com'], subject: 'RE: Unit 608 extension' });
  assert.equal(hit.id, 'INBOX:2');
});

test('my own last email in the thread counts too', () => {
  const hit = pickThread([box('INBOX:1'), box('Sent:3', { from: ['me@x.com'], to: ['jessa@x.com'], at: d('2026-10-23T07:00Z') })],
    { to: ['jessa@x.com'], subject: 'Re: Unit 608 extension' });
  assert.equal(hit.id, 'Sent:3');
});

test('another person, another subject, or a too-short subject finds nothing', () => {
  assert.equal(pickThread([box('INBOX:1')], { to: ['rona@x.com'], subject: 'Re: Unit 608 extension' }), null);
  assert.equal(pickThread([box('INBOX:1')], { to: ['jessa@x.com'], subject: 'Re: Unit 608 extension, part 2' }), null);
  assert.equal(pickThread([box('INBOX:1', { subject: 'Hi' })], { to: ['jessa@x.com'], subject: 'Re: Hi' }), null);
  assert.equal(pickThread([box('INBOX:1', { messageId: null })], { to: ['jessa@x.com'], subject: 'Re: Unit 608 extension' }), null);
});
