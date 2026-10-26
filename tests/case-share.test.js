import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { CASE, stubBox, stubAsk, externalUser, savedFolder } from './helpers/cases.js';
import { externalFence } from '../server/access.js';
import { caseRouter } from '../server/caseRoutes.js';
import { caseShareRouter, publicCaseRoutes } from '../server/caseShare.js';
import { saveUpload } from '../server/files.js';

// Sharing a case folder: by email (from the user's own mailbox, else from the app) and by a
// link anyone can open while it is on. Stub mailboxes, a stub AI, and no mail ever sent.

test.after(() => closeDb());

let jeff; let box; let deps; let f; let otherDoc; let sent; let kicked;
test.beforeEach(async () => {
  await reset();
  jeff = await externalUser('Jeff');
  box = stubBox(CASE, { canSend: true });
  sent = []; kicked = 0;
  deps = {
    mailbox: async () => box, ask: stubAsk(),
    sendMail: async (m) => { sent.push(m); }, kick: () => { kicked++; },
  };
  f = await savedFolder(jeff, deps);
  const b = Buffer.from('not in the case');
  otherDoc = (await saveUpload(jeff.id, null, { buffer: b, originalname: 'other.txt', mimetype: 'text/plain', size: b.length })).doc;
});

// One server; each call says who is signed in (null: nobody, for the public link).
async function serve(fn) {
  let who = null;
  const app = express();
  app.use(express.json());
  app.use('/api/case-share', publicCaseRoutes);
  app.use((req, res, next) => { if (!who) return res.status(401).json({ error: 'Sign in' }); req.user = who; next(); });
  app.use('/api', externalFence);
  app.use('/api/cases', caseShareRouter(deps));
  app.use('/api/cases', caseRouter(deps));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method) => async (u, path, body) => {
    who = u;
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
    r.data = /json/.test(r.headers.get('content-type') || '') ? await r.json() : await r.text();
    return r;
  };
  try { return await fn({ get: call('GET'), post: call('POST'), del: call('DELETE') }); } finally { server.close(); }
}
const pathOf = (url) => new URL(url).pathname;

test('a link shows only its own folder, and stops when turned off', async () => {
  await serve(async ({ get, post }) => {
    const { data: { url, on } } = await post(jeff, `/api/cases/${f.id}/link`, { on: true });
    assert.equal(on, true);
    assert.match(url, /\/api\/case-share\/[A-Za-z0-9_-]{32}$/);
    const page = await get(null, pathOf(url));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.ok(page.data.includes(f.name));
    const file = await get(null, `${pathOf(url)}/files/${f.summary_doc_id}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal((await get(null, `${pathOf(url)}/files/${otherDoc.id}`)).status, 404);

    await post(jeff, `/api/cases/${f.id}/link`, { on: false });
    assert.equal((await get(null, pathOf(url))).status, 404);
    assert.equal((await get(null, `${pathOf(url)}/files/${f.summary_doc_id}`)).status, 404);
    // On again: the same link.
    assert.equal((await post(jeff, `/api/cases/${f.id}/link`, { on: true })).data.url, url);
    assert.equal((await get(null, '/api/case-share/not-a-token')).status, 404);
  });
});

test('the page escapes what it shows', async () => {
  await db.prepare('UPDATE case_folders SET name = ? WHERE id = ?').run('<script>alert(1)</script> & co', f.id);
  await db.prepare('UPDATE documents SET name = ? WHERE id = ?').run('"><img src=x onerror=alert(1)>.pdf', f.summary_doc_id);
  await serve(async ({ get, post }) => {
    const { data: { url } } = await post(jeff, `/api/cases/${f.id}/link`, { on: true });
    const page = (await get(null, pathOf(url))).data;
    assert.ok(!page.includes('<script>alert'));
    assert.ok(!page.includes('<img src=x'));
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co'));
  });
});

test('a link to a deleted folder is gone', async () => {
  await serve(async ({ get, post, del }) => {
    const { data: { url } } = await post(jeff, `/api/cases/${f.id}/link`, { on: true });
    assert.equal((await del(jeff, `/api/cases/${f.id}`)).status, 200);
    assert.equal((await get(null, pathOf(url))).status, 404);
  });
});

test('email goes from the mailbox when it can send, else from the app with reply-to', async () => {
  await serve(async ({ post }) => {
    const r = await post(jeff, `/api/cases/${f.id}/email`, { to: 'lawyer@firm.com', cc: 'boss@firm.com' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { via: 'mailbox' });
    const d = await db.prepare('SELECT * FROM email_drafts WHERE user_id = ?').get(jeff.id);
    assert.equal(d.status, 'approved');
    assert.equal(d.from_addr, 'jeff@x.com');
    assert.equal(d.subject, f.name);
    assert.match(d.body, /Hearing set for the 20th/);
    assert.doesNotMatch(d.body, /##/);
    const [att] = typeof d.attachments === 'string' ? JSON.parse(d.attachments) : d.attachments;
    assert.match(att.filename, /\.pdf$/);
    assert.equal(att.contentType, 'application/pdf');
    assert.equal(Buffer.from(att.content, 'base64').subarray(0, 4).toString(), '%PDF');
    assert.equal(kicked, 1);
    assert.equal(sent.length, 0);

    deps.mailbox = async () => null;
    const a = await post(jeff, `/api/cases/${f.id}/email`, { to: 'lawyer@firm.com', subject: 'The file', body: 'See attached.' });
    assert.deepEqual(a.data, { via: 'app' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyTo, jeff.email);
    assert.deepEqual(sent[0].to, ['lawyer@firm.com']);
    assert.equal(sent[0].subject, 'The file');
    assert.equal(sent[0].text, 'See attached.');
    assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
    assert.equal(sent[0].attachments[0].content.subarray(0, 4).toString(), '%PDF');

    assert.equal((await post(jeff, `/api/cases/${f.id}/email`, { to: '' })).status, 400);
  });
});

test('a staff user, or another external user, cannot share', async () => {
  const staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  const anna = await externalUser('Anna');
  await serve(async ({ post }) => {
    for (const u of [staff, anna]) {
      assert.equal((await post(u, `/api/cases/${f.id}/link`, { on: true })).status, 404);
      assert.equal((await post(u, `/api/cases/${f.id}/email`, { to: 'x@y.com' })).status, 404);
    }
  });
  assert.equal((await db.prepare('SELECT share_on FROM case_folders WHERE id = ?').get(f.id)).share_on, false);
  assert.equal(sent.length + kicked, 0);
});
