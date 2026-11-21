import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { needsYou } from '../server/needsYou.js';

test.after(() => closeDb());

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const ago = (days) => now() - days * DAY;

async function chat(userId, title = 'A chat') {
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, title);
  return id;
}

test('everything waiting on a person is listed with its chat, oldest first', async () => {
  await reset();
  const me = await makeUser('Boss');
  const c = await chat(me);
  await db.prepare(`INSERT INTO email_drafts (user_id, conversation_id, subject, status, created_at) VALUES (?, ?, 'Renewal offer', 'pending', ?)`).run(me, c, ago(5));
  await db.prepare(`INSERT INTO team_reminders (sender_id, conversation_id, text, status, created_at) VALUES (?, ?, 'Collect the cheque', 'pending', ?)`).run(me, c, ago(2));
  await db.prepare(`INSERT INTO address_proposals (master_id, conversation_id, email, status, created_at) VALUES (?, ?, 'a@madaralwadi.com', 'pending', ?)`).run(me, c, ago(1));
  await db.prepare(`INSERT INTO lesson_proposals (master_id, conversation_id, rule, status, created_at) VALUES (?, ?, 'Always say AED', 'pending', ?)`).run(me, c, ago(3));
  await db.prepare(`INSERT INTO inventory_proposals (user_id, conversation_id, lines, status, created_at) VALUES (?, ?, '[]', 'pending', ?)`).run(me, c, ago(4));
  await db.prepare(`INSERT INTO case_proposals (user_id, conversation_id, case_number, name, emails, status, created_at) VALUES (?, ?, 'C-1', 'Park Place case', '[]', 'pending', ?)`).run(me, c, ago(6));
  await db.prepare(`INSERT INTO ars_booking_requests (user_id, conversation_id, input, quote, status, created_at) VALUES (?, ?, '{}', '{}', 'pending', ?)`).run(me, c, ago(7));
  await db.prepare(`INSERT INTO responsibility_proposals (master_id, conversation_id, action, user_id, status, created_at) VALUES (?, ?, 'add', ?, 'pending', ?)`).run(me, c, me, ago(8));

  const r = await needsYou({ id: me });
  assert.equal(r.total, 8);
  assert.deepEqual(r.items.map((i) => i.kind), ['duty', 'booking', 'case', 'email', 'stock', 'rule', 'reminder', 'address']); // oldest first
  assert.ok(r.items.every((i) => i.conversation_id === c));
  assert.equal(r.items.find((i) => i.kind === 'email').title, 'Renewal offer');
  assert.equal(r.items.find((i) => i.kind === 'email').waiting_days, 5);
  assert.equal(r.items.find((i) => i.kind === 'case').title, 'Park Place case');
});

test('what was decided is not waiting, and nobody sees what waits on someone else', async () => {
  await reset();
  const me = await makeUser('Boss');
  const other = await makeUser('Other');
  await db.prepare(`INSERT INTO email_drafts (user_id, subject, status) VALUES (?, 'Sent already', 'sent')`).run(me);
  await db.prepare(`INSERT INTO email_drafts (user_id, subject, status) VALUES (?, 'Rejected', 'rejected')`).run(me);
  await db.prepare(`INSERT INTO email_drafts (user_id, subject, status) VALUES (?, 'Theirs', 'pending')`).run(other);
  await db.prepare(`INSERT INTO lesson_proposals (master_id, rule, status) VALUES (?, 'Declined rule', 'declined')`).run(me);
  await db.prepare(`INSERT INTO address_proposals (master_id, email, status) VALUES (?, 'x@madaralwadi.com', 'added')`).run(me);

  assert.deepEqual(await needsYou({ id: me }), { total: 0, items: [] });
  const theirs = await needsYou({ id: other });
  assert.equal(theirs.total, 1);
  assert.equal(theirs.items[0].title, 'Theirs');
});

test('a card whose chat is gone still shows, without a chat to open', async () => {
  await reset();
  const me = await makeUser('Boss');
  await db.prepare(`INSERT INTO email_drafts (user_id, conversation_id, subject, status) VALUES (?, NULL, 'Orphan', 'pending')`).run(me);
  const r = await needsYou({ id: me });
  assert.equal(r.items[0].conversation_id, null);
});

test('the list is capped but the total is the real number', async () => {
  await reset();
  const me = await makeUser('Boss');
  for (let i = 0; i < 5; i++) await db.prepare(`INSERT INTO email_drafts (user_id, subject, status) VALUES (?, ?, 'pending')`).run(me, `Mail ${i}`);
  const r = await needsYou({ id: me }, 3);
  assert.equal(r.total, 5);
  assert.equal(r.items.length, 3);
});
