import { db, reset, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authRoutes, hashPassword } from '../server/auth.js';

let base, server;
test.before(async () => {
  const app = express();
  app.set('trust proxy', true); // so each try below can come from its own address
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await closeDb(); });
test.beforeEach(() => reset());

const login = async (email, password, ip) => (await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password }),
})).status;

test('ten wrong passwords on one account lock it for everyone, whatever connection they come from', async () => {
  await db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run('boss@example.com', 'Boss', await hashPassword('secret123'));
  for (let i = 0; i < 10; i++) assert.equal(await login('boss@example.com', `guess${i}`, `10.0.0.${i}`), 401);
  assert.equal(await login('boss@example.com', 'guess', '10.0.1.1'), 429, 'a new connection is stopped too');
  assert.equal(await login('boss@example.com', 'secret123', '10.0.1.2'), 429, 'even the right password waits the 15 minutes');
  await db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run('staff@example.com', 'Staff', await hashPassword('secret456'));
  assert.equal(await login('staff@example.com', 'secret456', '10.0.0.1'), 200, 'other accounts are not affected');
});

test('an unknown email takes as long to answer as a real one', async () => {
  await db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run('real@example.com', 'Real', await hashPassword('secret123'));
  const time = async (email) => { const t = performance.now(); await login(email, 'wrong', '10.9.9.9'); return performance.now() - t; };
  await time('real@example.com'); // warm up
  const real = await time('real@example.com');
  const unknown = await time('nobody@example.com');
  assert.ok(unknown > real / 3, `unknown ${unknown.toFixed(1)} ms vs real ${real.toFixed(1)} ms`);
});
