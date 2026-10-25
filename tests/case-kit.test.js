import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { externalFence } from '../server/access.js';
import { propose, decide } from '../server/caseFolders.js';
import { caseKit } from '../server/caseKit.js';
import { caseRouter } from '../server/caseRoutes.js';

// Case folders from the chat: the pull_case / update_case tools, and the card's routes.
// Stub mailboxes and a stub AI only: nothing here reaches a real inbox or Claude.

test.after(() => closeDb());

const mail = (o) => ({ messageId: null, from: 'a@x.com', to: 'b@x.com', text: '', attachments: [], ...o, at: new Date(o.at) });
const CASE = [
  mail({ key: 'INBOX:1', messageId: '<1@x>', at: '2026-10-01T09:00:00Z', subject: 'Soutex E - 205791 filing', text: 'Ahmed Ali vs Gulf Trading LLC. We filed today.' }),
  mail({ key: 'Sent:2', messageId: '<2@x>', at: '2026-10-03T09:00:00Z', subject: 'Re: Soutex E-205791', text: 'Hearing is on the 20th.' }),
];
const SUMMARY = '## Parties\nAhmed Ali / Gulf Trading LLC\n## What has happened\n- filed\n## Latest position\nHearing set\n## Pending / awaiting reply\nNone';
const stubBox = (mails) => ({ mails: [...mails], kind: 'imap', address: 'jeff@x.com', canSend: false, matching: async function () { return this.mails; }, recent: async function () { return this.mails; } });
const ask = async (prompt, { system }) => {
  if (/summarise a legal case/.test(system)) return SUMMARY;
  if (/list the case/i.test(system)) return '[]';
  return JSON.stringify({ case_number: 'Soutex E - 205791', party_a: 'Ahmed Ali', party_b: 'Gulf Trading LLC' });
};

let jeff; let amran; let staff; let conv; let box; let deps;
const external = async (name) => {
  const id = await makeUser(name);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
test.beforeEach(async () => {
  await reset();
  jeff = await external('Jeff');
  amran = await external('Amran');
  staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  conv = (await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(jeff.id, 'Cases')).id;
  box = stubBox(CASE);
  deps = { mailbox: async () => box, ask };
});

const use = (name, input = {}) => ({ type: 'tool_use', id: 't1', name, input });

// ---------- the chat tools ----------

test('only an external person gets the case tools', async () => {
  assert.deepEqual((await caseKit(staff, {})).definitions, []);
  const kit = await caseKit(jeff, {});
  assert.deepEqual(kit.definitions.map((d) => d.name), ['pull_case', 'update_case']);
  assert.equal(kit.status('pull_case'), 'Looking through your inbox for the case…');
  // Someone else asking for the tool by name gets nothing done.
  const r = await (await caseKit(staff, {}, deps)).run(use('pull_case', { case_number: '205791' }));
  assert.equal(r.is_error, true);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_proposals').get()).n, 0);
});

test('pull_case puts one card in front of the user, and says it is not saved', async () => {
  const cards = [];
  const kit = await caseKit(jeff, { conversationId: conv, onCard: (c) => cards.push(c) }, deps);
  const r = await kit.run(use('pull_case', { case_number: '205791' }));
  assert.equal(r.is_error, undefined);
  assert.equal(r.tool_use_id, 't1');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC');
  assert.equal(cards[0].count, 2);
  const row = await db.prepare('SELECT conversation_id FROM case_proposals WHERE id = ?').get(cards[0].id);
  assert.equal(row.conversation_id, conv);
  assert.match(r.content, /2 emails/);
  assert.ok(r.content.endsWith('NOT saved yet - tell the user in one short line to check the card and tap Save. Never say it is saved.'));
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_folders').get()).n, 0);
});

test('pull_case on a case that has a folder brings it up to date, with no card', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  box.mails.push(mail({ key: 'INBOX:3', messageId: '<3@x>', at: new Date().toISOString(), subject: 'Soutex E - 205791 judgment', text: 'Judgment out.' }));
  const cards = [];
  const r = await (await caseKit(jeff, { conversationId: conv, onCard: (c) => cards.push(c) }, deps)).run(use('pull_case', { case_number: '205791' }));
  assert.equal(cards.length, 0);
  assert.match(r.content, /already has a folder/);
  assert.match(r.content, /1 new email/);
  assert.doesNotMatch(r.content, /NOT saved yet/);
});

test('update_case refreshes the folder now, and says when there is none', async () => {
  const kit = await caseKit(jeff, { conversationId: conv }, deps);
  const none = await kit.run(use('update_case', { case_number: '205791' }));
  assert.match(none.content, /No case folder for 205791/);
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  assert.match((await kit.run(use('update_case', { case_number: 'Soutex E-205791' }))).content, /No new emails/);
  box.mails.push(mail({ key: 'INBOX:3', messageId: '<3@x>', at: new Date().toISOString(), subject: 'Soutex E - 205791 judgment', text: 'Judgment out.' }));
  const r = await kit.run(use('update_case', { case_number: '205791' }));
  assert.match(r.content, /1 new email/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_emails').get()).n, 3);
});

test('a stopped folder is said to be stopped', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await decide(jeff, card.id, { save: true }, deps);
  await db.prepare('UPDATE case_folders SET tracking = false').run();
  const r = await (await caseKit(jeff, {}, deps)).run(use('update_case', { case_number: '205791' }));
  assert.match(r.content, /stopped/i);
});

test('a failure comes back as the tool error, in plain words', async () => {
  const kit = await caseKit(jeff, { conversationId: conv }, { ...deps, mailbox: async () => null });
  const r = await kit.run(use('pull_case', { case_number: '205791' }));
  assert.equal(r.is_error, true);
  assert.equal(r.content, 'Connect your mailbox first');
});

// ---------- the card's routes ----------

async function serve(u, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = u; next(); });
  app.use('/api', externalFence);
  app.use('/api/cases', caseRouter(deps));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/cases`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  try { return await fn({ get: (path) => fetch(`${base}${path}`), post }); } finally { server.close(); }
}

test('the card lists, saves and cancels through /api/cases', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await serve(jeff, async ({ get, post }) => {
    const list = await get(`/proposals?conversation=${conv}`);
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).map((c) => c.id), [card.id]);
    assert.deepEqual(await (await get('/proposals?conversation=999')).json(), []);
    const saved = await post(`/proposals/${card.id}/save`, { name: 'Soutex – urgent', full_pdf: true, per_email: false, exclude: ['Sent:2'] });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.status, 'saved');
    assert.ok(body.folder_id);
    assert.equal(body.name, 'Soutex – urgent', 'the card shows the name it was saved as');
    assert.deepEqual(body.emails.map((e) => e.mail_key), ['INBOX:1']);
    assert.equal((await post(`/proposals/${card.id}/save`, {})).status, 409, 'a second tap saves nothing');
  });
  const folder = await db.prepare('SELECT * FROM case_folders').get();
  assert.equal(folder.name, 'Soutex – urgent');
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_emails').get()).n, 1);
});

test('Cancel through the route saves nothing', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await serve(jeff, async ({ post }) => {
    const r = await post(`/proposals/${card.id}/cancel`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'cancelled');
  });
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_folders').get()).n, 0);
});

test('staff are told the routes do not exist, and another external person cannot touch the card', async () => {
  const [card] = await propose(jeff, { case_number: '205791' }, { conversationId: conv }, deps);
  await serve(staff, async ({ get, post }) => {
    assert.equal((await get(`/proposals?conversation=${conv}`)).status, 404);
    assert.equal((await post(`/proposals/${card.id}/save`)).status, 404);
    assert.equal((await post(`/proposals/${card.id}/cancel`)).status, 404);
  });
  await serve(amran, async ({ get, post }) => {
    assert.deepEqual(await (await get(`/proposals?conversation=${conv}`)).json(), []);
    assert.equal((await post(`/proposals/${card.id}/save`)).status, 404);
    assert.equal((await post(`/proposals/${card.id}/cancel`)).status, 404);
  });
  assert.equal((await db.prepare('SELECT status FROM case_proposals').get()).status, 'pending');
});
