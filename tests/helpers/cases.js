// Stubs shared by the case-folder tests: a mailbox and an AI that never leave the process.
// Import tests/helpers/db.js before this file, as every test does.
import { db, makeUser } from './db.js';
import { propose, decide } from '../../server/caseFolders.js';

export const mail = (o) => ({ messageId: null, from: 'a@x.com', to: 'b@x.com', text: '', attachments: [], ...o, at: new Date(o.at) });

export const CASE = [
  mail({ key: 'INBOX:1', messageId: '<1@x>', at: '2026-10-01T09:00:00Z', subject: 'Soutex E - 205791 filing', text: 'Ahmed Ali vs Gulf Trading LLC. We filed today.' }),
  mail({ key: 'Sent:2', messageId: '<2@x>', at: '2026-10-03T09:00:00Z', subject: 'Re: Soutex E-205791', text: 'Hearing is on the 20th.' }),
];
export const SUMMARY = '## Parties\nAhmed Ali / Gulf Trading LLC\n## What has happened\n- filed\n## Latest position\nHearing set for the 20th\n## Pending / awaiting reply\nNone';

/** collectCase does the filtering, as on live; `fail` makes every read throw that message. */
export function stubBox(mails, { canSend = false, address = 'jeff@x.com' } = {}) {
  const box = {
    mails: [...mails], calls: 0, kind: 'imap', address, canSend, fail: null,
    matching: async () => { box.calls++; if (box.fail) throw new Error(box.fail); return box.mails; },
    recent: async () => { box.calls++; if (box.fail) throw new Error(box.fail); return box.mails; },
  };
  return box;
}

export function stubAsk() {
  return async (prompt, { system }) => {
    if (/summarise a legal case/.test(system)) return SUMMARY;
    if (/list the case/i.test(system)) return '[]';
    return JSON.stringify({ case_number: 'Soutex E - 205791', party_a: 'Ahmed Ali', party_b: 'Gulf Trading LLC' });
  };
}

export async function externalUser(name) {
  const id = await makeUser(name);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** A saved folder of the Soutex case for this user, made the way the card makes it. */
export async function savedFolder(user, deps) {
  const [card] = await propose(user, { case_number: '205791' }, {}, deps);
  await decide(user, card.id, { save: true }, deps);
  return db.prepare('SELECT * FROM case_folders WHERE user_id = ?').get(user.id);
}
