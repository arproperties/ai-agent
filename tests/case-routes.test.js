import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import express from 'express';
import { mail, CASE, stubBox, stubAsk, externalUser, savedFolder } from './helpers/cases.js';
import { externalFence } from '../server/access.js';
import { caseRouter } from '../server/caseRoutes.js';
import { refresh } from '../server/caseFolders.js';
import { saveUpload } from '../server/files.js';

// The folder routes of the Shelf: listed, renamed, stopped, updated, deleted. External only.
// Stub mailboxes and a stub AI only.

test.after(() => closeDb());

let jeff; let box; let deps; let folder;
test.beforeEach(async () => {
  await reset();
  jeff = await externalUser('Jeff');
  box = stubBox(CASE);
  deps = { mailbox: async () => box, ask: stubAsk() };
  folder = await savedFolder(jeff, deps);
});

async function serve(u, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = u; next(); });
  app.use('/api', externalFence);
  app.use('/api/cases', caseRouter(deps));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/cases`;
  const send = (method) => (path, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  try {
    return await fn({ get: (path) => fetch(`${base}${path}`), post: send('POST'), put: send('PUT'), patch: send('PATCH'), del: send('DELETE') });
  } finally { server.close(); }
}

test('the folders are listed with their files, and nobody else sees the route', async () => {
  await serve(jeff, async ({ get }) => {
    const r = await get('');
    assert.equal(r.status, 200);
    const [f] = await r.json();
    assert.equal(f.id, folder.id);
    assert.equal(f.email_count, 2);
    assert.equal(f.tracking, true);
    assert.equal(f.files.length, 1);
    assert.equal(f.files[0].case_folder_id, folder.id);
    assert.equal(f.files[0].path, undefined);
  });
  const staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  const masterId = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master', external = true WHERE id = ?`).run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  for (const u of [staff, master]) {
    await serve(u, async ({ get, patch }) => {
      assert.equal((await get('')).status, 404);
      assert.equal((await patch(`/${folder.id}`, { name: 'x' })).status, 404);
    });
  }
});

test('a renamed folder still finds its new mail', async () => {
  await serve(jeff, async ({ patch, post }) => {
    const r = await patch(`/${folder.id}`, { name: 'My big case' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).name, 'My big case');
    box.mails.push(mail({ key: 'INBOX:9', messageId: '<9@x>', at: new Date().toISOString(), subject: 'Soutex E - 205791 judgment', text: 'Out.' }));
    const u = await post(`/${folder.id}/update`);
    assert.deepEqual(await u.json(), { added: 1 });
    assert.equal((await db.prepare('SELECT new_count FROM case_folders WHERE id = ?').get(folder.id)).new_count, 1);
    assert.equal((await post(`/${folder.id}/seen`)).status, 200);
    assert.equal((await db.prepare('SELECT new_count FROM case_folders WHERE id = ?').get(folder.id)).new_count, 0);
  });
  assert.equal((await db.prepare('SELECT name FROM case_folders WHERE id = ?').get(folder.id)).name, 'My big case');
  assert.deepEqual(await refresh(jeff, folder.id, deps), { added: 0 });
});

test('Keep updating off stops the folder, and the pattern is set here', async () => {
  await serve(jeff, async ({ patch, get, put }) => {
    assert.equal((await (await patch(`/${folder.id}`, { tracking: false })).json()).tracking, false);
    assert.equal((await put('/settings', { pattern: 'no number' })).status, 400);
    assert.deepEqual(await (await put('/settings', { pattern: '[Case Number] only' })).json(), { pattern: '[Case Number] only' });
    assert.deepEqual(await (await get('/settings')).json(), { pattern: '[Case Number] only' });
  });
});

test('deleting a folder removes its files from the Shelf and the disk, and leaves the rest', async () => {
  const other = Buffer.from('not about the case');
  const { doc: keep } = await saveUpload(jeff.id, null, { buffer: other, originalname: 'other.txt', mimetype: 'text/plain', size: other.length });
  const docs = await db.prepare('SELECT * FROM documents WHERE case_folder_id = ?').all(folder.id);
  assert.ok(docs.length && docs.every((d) => existsSync(d.path)));
  await serve(jeff, async ({ del }) => assert.equal((await del(`/${folder.id}`)).status, 200));
  assert.equal(await db.prepare('SELECT 1 FROM case_folders WHERE id = ?').get(folder.id), undefined);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_emails').get()).n, 0);
  for (const d of docs) {
    assert.equal(await db.prepare('SELECT 1 FROM documents WHERE id = ?').get(d.id), undefined);
    assert.equal(existsSync(d.path), false);
  }
  assert.ok(await db.prepare('SELECT 1 FROM documents WHERE id = ?').get(keep.id));
});

test('a file jeff had before the case is taken out of it, not deleted with it', async () => {
  const had = Buffer.from('his own lease');
  const { doc } = await saveUpload(jeff.id, null, { buffer: had, originalname: 'lease.txt', mimetype: 'text/plain', size: had.length });
  await db.prepare('UPDATE documents SET created_at = created_at - 3600, case_folder_id = ? WHERE id = ?').run(folder.id, doc.id);
  await serve(jeff, async ({ del }) => assert.equal((await del(`/${folder.id}`)).status, 200));
  const after = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  assert.equal(after.case_folder_id, null);
  assert.ok(existsSync(after.path));
});

test('another external user\'s folder is not found', async () => {
  const anna = await externalUser('Anna');
  await serve(anna, async ({ patch, del, post }) => {
    assert.equal((await patch(`/${folder.id}`, { name: 'Mine now' })).status, 404);
    assert.equal((await post(`/${folder.id}/update`)).status, 404);
    assert.equal((await del(`/${folder.id}`)).status, 404);
  });
  assert.notEqual((await db.prepare('SELECT name FROM case_folders WHERE id = ?').get(folder.id)).name, 'Mine now');
});
