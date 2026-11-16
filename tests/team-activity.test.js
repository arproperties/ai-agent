import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { teamActivity, personActivity, setHidden, rangeOf } from '../server/teamActivity.js';

test.after(() => closeDb());

// Fixed clock: Monday 16 Nov 2026, 14:00 in Dubai (10:00 UTC).
const TODAY = '2026-11-16';
const NOW = Math.floor(Date.parse('2026-11-16T10:00:00Z') / 1000);
const at = (day, hh = '09:00') => Math.floor(Date.parse(`${day}T${hh}:00+04:00`) / 1000);

async function chat(userId, times, title = 'A chat') {
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title, updated_at) VALUES (?, ?, ?) RETURNING id').run(userId, title, NOW);
  for (const t of times) {
    await db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'q', ?)`).run(id, t);
    await db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', 'a', ?)`).run(id, t + 5);
  }
  return id;
}

test('ranges start on the right Dubai day', () => {
  assert.deepEqual(rangeOf('today', TODAY), { from: '2026-11-16', days: 1 });
  assert.deepEqual(rangeOf('week', TODAY), { from: '2026-11-10', days: 7 });
  assert.deepEqual(rangeOf('month', TODAY), { from: '2026-11-01', days: 16 });
});

test("counts each person's questions, emails, files and to-dos; only their own", async () => {
  await reset();
  const mo = await makeUser('Mo');
  const rona = await makeUser('Rona');
  // Mo: 3 questions today (one just after midnight Dubai, still yesterday in UTC), 1 last week.
  await chat(mo, [at(TODAY, '00:30'), at(TODAY, '09:15'), at(TODAY, '16:00'), at('2026-11-12')], 'Settlement');
  await chat(rona, [at('2026-11-14')]);
  await db.prepare(`INSERT INTO email_drafts (user_id, to_addrs, subject, body, status, sent_at) VALUES (?, '["a@x.com"]', 'Hi', 'b', 'sent', ?)`).run(mo, at(TODAY));
  await db.prepare(`INSERT INTO email_drafts (user_id, to_addrs, subject, body, status) VALUES (?, '["a@x.com"]', 'Draft', 'b', 'rejected')`).run(mo);
  await db.prepare(`INSERT INTO documents (user_id, name, status, created_at) VALUES (?, 'letter.pdf', 'ready', ?)`).run(mo, at(TODAY));
  await db.prepare(`INSERT INTO todos (user_id, text, done, done_at) VALUES (?, 'done today', true, ?)`).run(mo, at(TODAY));
  await db.prepare(`INSERT INTO todos (user_id, text, remind_at) VALUES (?, 'late', ?)`).run(mo, at('2026-11-10'));
  await db.prepare(`INSERT INTO todos (user_id, text, remind_at) VALUES (?, 'tomorrow', ?)`).run(mo, at('2026-11-17'));
  await db.prepare(`INSERT INTO todos (user_id, text) VALUES (?, 'no date')`).run(mo);

  const out = await teamActivity({ range: 'today', today: TODAY, now: NOW });
  const m = out.people.find((p) => p.id === mo);
  assert.equal(m.asked, 3);
  assert.equal(m.firstAt, at(TODAY, '00:30'));
  assert.equal(m.lastAt, at(TODAY, '16:00'));
  assert.equal(m.usual, 0); // 4 questions in 14 days rounds to 0 a day
  assert.deepEqual([m.sent, m.files, m.ticked, m.open, m.overdue], [1, 1, 1, 3, 1]);
  const r = out.people.find((p) => p.id === rona);
  assert.deepEqual([r.asked, r.sent, r.files, r.open], [0, 0, 0, 0]);
  assert.equal(out.totals.active, 1);

  const week = await teamActivity({ range: 'week', today: TODAY, now: NOW });
  assert.equal(week.people.find((p) => p.id === mo).asked, 4);
  assert.equal(week.people.find((p) => p.id === mo).activeDays, 2);

  const one = await personActivity(mo, { range: 'today', today: TODAY, now: NOW });
  assert.deepEqual(one.chats.map((c) => [c.title, c.asked]), [['Settlement', 3]]);
  assert.deepEqual(one.sent.map((e) => [e.subject, e.to]), [['Hi', 'a@x.com']]);
  assert.deepEqual(one.due.map((x) => [x.text, x.overdue]), [['late', true], ['tomorrow', false]]);
  assert.equal(one.undated, 1);
});

test('flags a busy person who is well below their usual pace, and people not using Reem', async () => {
  await reset();
  const busy = await makeUser('Busy');
  const quiet = await makeUser('Quiet');
  const times = [];
  for (let d = 3; d <= 15; d++) for (let i = 0; i < 20; i++) times.push(at(`2026-11-${String(d).padStart(2, '0')}`, `${String(8 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}`));
  times.push(at(TODAY));
  await chat(busy, times);
  await chat(quiet, [at('2026-11-01')]);

  const out = await teamActivity({ range: 'today', today: TODAY, now: NOW });
  const b = out.people.find((p) => p.id === busy);
  assert.equal(b.usual, 19);
  assert.equal(b.below, true);
  assert.equal(b.idle, false);
  const q = out.people.find((p) => p.id === quiet);
  assert.equal(q.idle, true);
  assert.equal(q.below, false);
});

test('files synced from saifsys are not counted as files the person added', async () => {
  await reset();
  const boss = await makeUser('Boss');
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, status, created_at) VALUES (?, 'licence.pdf', 'ready', ?) RETURNING id`).run(boss, at(TODAY));
  await db.prepare(`INSERT INTO saifsys_company_doc_links (saifsys_id, document_id, company_id, doc_type, file_key, version_no, changed_at, synced_at)
    VALUES (1, ?, 1, 'licence', 'k', 1, ?, ?)`).run(id, NOW, NOW).catch(() => db.prepare('INSERT INTO saifsys_company_doc_links (saifsys_id, document_id) VALUES (1, ?)').run(id));
  await db.prepare(`INSERT INTO documents (user_id, name, status, created_at) VALUES (?, 'mine.pdf', 'ready', ?)`).run(boss, at(TODAY));
  const out = await teamActivity({ range: 'today', today: TODAY, now: NOW });
  assert.equal(out.people.find((p) => p.id === boss).files, 1);
});

test('external and disabled people are never listed; hidden ones are kept apart', async () => {
  await reset();
  const ext = await makeUser('Ext');
  const gone = await makeUser('Gone');
  const shared = await makeUser('Shared');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext);
  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(gone);
  await chat(ext, [at(TODAY)]);

  await setHidden(shared, true);
  let out = await teamActivity({ range: 'today', today: TODAY, now: NOW });
  assert.deepEqual(out.people.map((p) => [p.id, p.hidden]), [[shared, true]]);
  assert.equal(out.totals.people, 0);
  assert.equal(await personActivity(ext, { today: TODAY, now: NOW }), null);

  await setHidden(shared, true); // twice is fine
  await setHidden(shared, false);
  out = await teamActivity({ range: 'today', today: TODAY, now: NOW });
  assert.equal(out.people[0].hidden, false);
});
