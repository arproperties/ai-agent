import { db, reset, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authRoutes, hashPassword } from '../server/auth.js';

// One browser: a cookie jar that follows Set-Cookie the way a browser would.
function browser(base) {
  const jar = new Map();
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/api/auth${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    return { status: res.status, body: await res.json() };
  };
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await closeDb(); });
test.beforeEach(() => reset());

async function account(name) {
  const email = `${name.toLowerCase()}@example.com`;
  const { id } = await db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
    .run(email, name, await hashPassword('secret123'));
  return { id, email, password: 'secret123' };
}

test('adding a second account keeps the first signed in, and switching swaps them', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  await b.post('/login', { email: home.email, password: home.password, add: true });

  assert.equal((await b.get('/me')).body.user.id, home.id);
  assert.deepEqual((await b.get('/accounts')).body.accounts.map((a) => a.id), [work.id]);

  const s = await b.post('/switch', { id: work.id });
  assert.equal(s.body.user.id, work.id);
  assert.equal((await b.get('/me')).body.user.id, work.id);
  assert.deepEqual((await b.get('/accounts')).body.accounts.map((a) => a.id), [home.id]);
});

test('an ordinary sign-in replaces the active account, as before', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  await b.post('/login', { email: home.email, password: home.password });
  assert.deepEqual((await b.get('/accounts')).body.accounts, []);
});

test('signing out of one account hands over to the other; the second sign-out ends both', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  await b.post('/login', { email: home.email, password: home.password, add: true });

  const out = await b.post('/logout');
  assert.equal(out.body.user.id, work.id);
  assert.equal((await b.get('/me')).body.user.id, work.id);

  const out2 = await b.post('/logout');
  assert.equal(out2.body.user, undefined);
  assert.equal((await b.get('/me')).body.user, null);
});

test('only accounts parked in this browser can be switched to', async () => {
  const work = await account('Work');
  const stranger = await account('Stranger');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  const r = await b.post('/switch', { id: stranger.id });
  assert.equal(r.status, 404);
  assert.equal((await b.get('/me')).body.user.id, work.id);
});

test('a parked account whose sessions were cleared drops out of the list', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  await b.post('/login', { email: home.email, password: home.password, add: true });
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(work.id); // e.g. password changed
  assert.deepEqual((await b.get('/accounts')).body.accounts, []);
  assert.equal((await b.post('/switch', { id: work.id })).status, 404);
});

test('adding an account that is already parked does not list it twice', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/login', { email: work.email, password: work.password });
  await b.post('/login', { email: home.email, password: home.password, add: true });
  await b.post('/login', { email: work.email, password: work.password, add: true });
  assert.equal((await b.get('/me')).body.user.id, work.id);
  assert.deepEqual((await b.get('/accounts')).body.accounts.map((a) => a.id), [home.id]);
});
