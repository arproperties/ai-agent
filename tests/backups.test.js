import { db, reset, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { hashPassword } from '../server/auth.js';
import { backupRoutes, remindIfDue } from '../server/backups.js';

// The routes as index.js mounts them, behind requireMaster; here the signed-in master is set by hand.
let base, server, me;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/backups', (req, res, next) => { req.user = me; next(); }, backupRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/backups`;
});
test.after(async () => { server.close(); await closeDb(); });

async function master() {
  await reset();
  const { id } = await db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('boss@example.com', 'Boss', ?, 'master') RETURNING id`)
    .run(await hashPassword('secret123'));
  me = { id, role: 'master' };
}
const unlock = (password) => fetch(`${base}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });

test('nothing downloads without the password typed again; a wrong one is refused', async () => {
  await master();
  assert.equal((await fetch(`${base}/files`)).status, 403);
  assert.equal((await fetch(`${base}/files?t=made-up`)).status, 403);
  assert.equal((await unlock('nope')).status, 401);
  const r = await unlock('secret123');
  assert.equal(r.status, 200);
  assert.ok((await r.json()).token);
});

test('another person cannot use the master\'s unlock', async () => {
  await master();
  const { token } = await (await unlock('secret123')).json();
  const boss = me;
  me = { id: boss.id + 1, role: 'master' };
  assert.equal((await fetch(`${base}/files?t=${token}`)).status, 403);
  me = boss;
});

test('the files come as one zip, and the date is kept once it has all gone out', async () => {
  await master();
  const { token } = await (await unlock('secret123')).json();
  const r = await fetch(`${base}/files?t=${token}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="reem-files-\d{4}-\d{2}-\d{2}\.zip"/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'a zip');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok((await (await fetch(base)).json()).files_at, 'the download is counted');
});

test('the weekly buzz: only after 7 days without a download, then not again for a week', async () => {
  await master();
  await (await fetch(base)).json(); // starts the clock
  const start = (await db.prepare('SELECT started_at FROM backup_state').get()).started_at;
  const day = 86400;
  assert.equal(await remindIfDue(start + 6 * day), false);
  assert.equal(await remindIfDue(start + 7 * day), true);
  assert.equal(await remindIfDue(start + 8 * day), false, 'once a week at most');
  await db.prepare('UPDATE backup_state SET database_at = ?, files_at = ?').run(start + 13 * day, start + 13 * day);
  assert.equal(await remindIfDue(start + 15 * day), false, 'both downloaded lately');
  assert.equal(await remindIfDue(start + 20 * day), true, 'a week on from the last download');
});

// Last: the wrong-password count is kept in memory, and every test here is the same account.
test('five wrong passwords stop the tries for a while', async () => {
  await master();
  for (let i = 0; i < 5; i++) await unlock('nope');
  assert.equal((await unlock('secret123')).status, 429);
});
