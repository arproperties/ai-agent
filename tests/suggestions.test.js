import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { scan, pending, accept, dismiss } from '../server/suggestions.js';
import { listTodos } from '../server/todos.js';

test.after(() => closeDb());

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const iso = (secs) => new Date(secs * 1000).toISOString();

async function said(userId, text) {
  const { id: conv } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, 'x');
  return (await db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id').run(conv, 'user', text)).id;
}

const mail = [{ id: 'INBOX:7', from: 'DEWA <bills@dewa.gov.ae>', subject: 'Bill due', at: new Date(), text: 'Pay AED 900 by Friday' }];
const inbox = async () => mail;

test('it suggests from email and chat, and only what it was actually shown', async () => {
  await reset();
  const me = await makeUser('Sara');
  const msg = await said(me, 'I promised Ali I would send the contract tomorrow');
  let prompt = '';
  const ask = async (p) => {
    prompt = p;
    return JSON.stringify([
      { ref: 'email:INBOX:7', text: 'Pay the DEWA bill', remind_at: iso(now() + 24 * HOUR), why: 'Due Friday' },
      { ref: `chat:${msg}`, text: 'Send Ali the contract', remind_at: null, why: 'You promised' },
      { ref: 'email:INBOX:999', text: 'Made up', remind_at: null },
    ]);
  };
  assert.equal(await scan(me, { ask, inbox }), 2);
  assert.match(prompt, /Pay AED 900/);
  assert.match(prompt, /send the contract tomorrow/);
  assert.deepEqual((await pending(me)).map((s) => s.text).sort(), ['Pay the DEWA bill', 'Send Ali the contract']);
});

test('it looks at most every few hours, and never suggests the same thing twice', async () => {
  await reset();
  const me = await makeUser('Sara');
  let calls = 0;
  const ask = async () => { calls++; return JSON.stringify([{ ref: 'email:INBOX:7', text: 'Pay the DEWA bill', remind_at: null }]); };
  await scan(me, { ask, inbox });
  await scan(me, { ask, inbox });
  assert.equal(calls, 1);

  await db.prepare('UPDATE suggestion_scans SET scanned_at = scanned_at - ?').run(7 * HOUR);
  await scan(me, { ask, inbox });
  assert.equal(calls, 2);
  assert.equal((await pending(me)).length, 1);
});

test('nothing new to read means no call at all', async () => {
  await reset();
  const me = await makeUser('Sara');
  let calls = 0;
  await scan(me, { ask: async () => { calls++; return '[]'; }, inbox: async () => [] });
  assert.equal(calls, 0);
});

test('Remind me makes it a todo; ✕ just hides it; neither works on someone else', async () => {
  await reset();
  const me = await makeUser('Sara');
  const other = await makeUser('Omar');
  const when = now() + 5 * HOUR;
  await scan(me, { ask: async () => JSON.stringify([
    { ref: 'email:INBOX:7', text: 'Pay the DEWA bill', remind_at: iso(when), why: 'Due Friday' },
  ]), inbox });
  const [s] = await pending(me);
  assert.equal(await accept(other, s.id), null);
  const todo = await accept(me, s.id);
  assert.equal(todo.remind_at, when);
  assert.equal((await listTodos(me))[0].text, 'Pay the DEWA bill');
  assert.equal((await pending(me)).length, 0);
  assert.equal(await dismiss(me, s.id), false); // already dealt with
});

test('a broken answer from the model is shrugged off', async () => {
  await reset();
  const me = await makeUser('Sara');
  assert.equal(await scan(me, { ask: async () => 'sorry, no', inbox }), 0);
});
