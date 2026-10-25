import { closeDb, reset, makeUser } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCase, caseMailbox } from '../server/caseMail.js';

test.after(() => closeDb());

const mail = (o) => ({ messageId: null, from: 'a@x.com', to: 'b@x.com', text: '', attachments: [], ...o, at: new Date(o.at) });
const stubBox = (mails) => {
  const box = { calls: [], matching: async (opts) => { box.calls.push(opts); return mails; } };
  return box;
};

test('collectCase keeps only the real case, oldest first, once', async () => {
  const box = stubBox([
    mail({ key: 'INBOX:3', at: '2026-10-03', subject: 'Soutex E - 205791 hearing', messageId: '<a>' }),
    mail({ key: 'Sent:9', at: '2026-10-04', subject: 'Re: Soutex E-205791', messageId: '<b>' }),
    mail({ key: 'INBOX:4', at: '2026-10-05', subject: 'Soutex E - 2057910', messageId: '<c>' }),
    mail({ key: 'All:3', at: '2026-10-03', subject: 'Soutex E - 205791 hearing', messageId: '<a>' }),
  ]);
  const got = await collectCase(box, 'Soutex E - 205791');
  assert.deepEqual(got.map((m) => m.key), ['INBOX:3', 'Sent:9']);
  assert.equal(box.calls[0].term, '205791');
});

test('collectCase sorts oldest first and passes since on', async () => {
  const since = new Date('2026-10-01');
  const box = stubBox([
    mail({ key: 'k2', at: '2026-10-09', subject: 'E-205791', messageId: '<2>' }),
    mail({ key: 'k1', at: '2026-10-02', subject: 'E-205791', messageId: '<1>' }),
    mail({ key: 'k3', at: '2026-10-05', subject: 'E-205791' }),
    mail({ key: 'k4', at: '2026-10-06', subject: 'E-205791' }),
  ]);
  const got = await collectCase(box, 'E-205791', { since });
  assert.deepEqual(got.map((m) => m.key), ['k1', 'k3', 'k4', 'k2']); // no messageId: not merged
  assert.equal(box.calls[0].since, since);
});

test('collectCase with no digits in the case number does not ask the mailbox', async () => {
  const box = stubBox([mail({ key: 'k', at: '2026-10-01', subject: 'anything' })]);
  assert.deepEqual(await collectCase(box, 'no digits'), []);
  assert.equal(box.calls.length, 0);
});

test('caseMailbox is null when no mailbox is connected', async () => {
  await reset();
  const id = await makeUser();
  assert.equal(await caseMailbox(id), null);
});
