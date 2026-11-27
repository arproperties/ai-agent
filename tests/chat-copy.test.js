import { db, reset, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authRoutes, requireUser, hashPassword } from '../server/auth.js';
import { chatCopyRoutes } from '../server/chatCopy.js';

// One browser: a cookie jar that follows Set-Cookie the way a browser would.
function browser(base) {
  const jar = new Map();
  const post = async (path, body) => {
    const res = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: JSON.stringify(body || {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    return { status: res.status, body: await res.json() };
  };
  return { post };
}

let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api', requireUser);
  app.use('/api/conversations', chatCopyRoutes);
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

async function oldChat(userId) {
  const { id } = await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, 'Staff rota');
  await db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'user', 'Who covers Friday?', 1763716782);
  await db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'assistant', 'Sara covers Friday', 1763716841);
  return id;
}

const messagesOf = (convId) => db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);

// A chat from the private account, copied to the business one.
test('copies a chat to the other account signed in on this browser, keeping the original', async () => {
  const work = await account('Work');
  const home = await account('Home');
  const b = browser(base);
  await b.post('/auth/login', { email: work.email, password: work.password });
  await b.post('/auth/login', { email: home.email, password: home.password, add: true });
  const original = await oldChat(home.id);

  const r = await b.post(`/conversations/${original}/copy`, { to: work.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, 'Work');

  const copy = await db.prepare('SELECT user_id, title FROM conversations WHERE id = ?').get(r.body.id);
  assert.deepEqual(copy, { user_id: work.id, title: 'Staff rota' });
  // Same messages, same times, and the original is still in the private account.
  assert.deepEqual(await messagesOf(r.body.id), await messagesOf(original));
  assert.equal((await db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(original)).user_id, home.id);
});

test('refuses an account that is not signed in on this browser', async () => {
  const home = await account('Home');
  const stranger = await account('Stranger');
  const b = browser(base);
  await b.post('/auth/login', { email: home.email, password: home.password });
  const original = await oldChat(home.id);

  const r = await b.post(`/conversations/${original}/copy`, { to: stranger.id });
  assert.equal(r.status, 404);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM conversations WHERE user_id = ?').get(stranger.id)).n, 0);
});

test("refuses to copy a chat that is not the active account's own", async () => {
  const work = await account('Work');
  const home = await account('Home');
  const other = await account('Other');
  const b = browser(base);
  await b.post('/auth/login', { email: work.email, password: work.password });
  await b.post('/auth/login', { email: home.email, password: home.password, add: true });
  const notHers = await oldChat(other.id);

  const r = await b.post(`/conversations/${notHers}/copy`, { to: work.id });
  assert.equal(r.status, 404);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM conversations WHERE user_id = ?').get(work.id)).n, 0);
});
