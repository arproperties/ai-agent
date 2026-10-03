import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { fromSaifsys } from '../server/fromSaifsys.js';

test.after(() => closeDb());

// Minimal express double: the guard reads two headers and answers or calls next.
function knock(headers) {
  return new Promise((resolve, reject) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { get: (name) => lower[name.toLowerCase()] };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, user: null }); },
    };
    fromSaifsys(req, res, (err) => (err ? reject(err) : resolve({ status: null, body: null, user: req.user })));
  });
}

async function setup() {
  await reset();
  const master = await makeUser('Owner');
  const jessa = await makeUser('Jessa');
  await db.prepare('INSERT INTO hr_links (user_id, employee_code, hr_name, linked_by) VALUES (?, ?, ?, ?)').run(jessa, 'E00012', 'Jessa', master);
  return { master, jessa };
}

test('the door is shut until its key is set', async () => {
  await setup();
  delete process.env.SAIFSYS_DOOR_KEY;
  assert.equal((await knock({ 'X-Saifsys-Key': '', 'X-Saifsys-Employee': 'E00012' })).status, 503);
});

test('a wrong or missing key gets nowhere', async () => {
  await setup();
  process.env.SAIFSYS_DOOR_KEY = 'right-key';
  assert.equal((await knock({ 'X-Saifsys-Employee': 'E00012' })).status, 401);
  assert.equal((await knock({ 'X-Saifsys-Key': 'wrong-key', 'X-Saifsys-Employee': 'E00012' })).status, 401);
});

test('the request becomes the Reem account linked to that employee code', async () => {
  const { jessa } = await setup();
  process.env.SAIFSYS_DOOR_KEY = 'right-key';
  const r = await knock({ 'X-Saifsys-Key': 'right-key', 'X-Saifsys-Employee': ' e00012 ' });
  assert.equal(r.status, null);
  assert.equal(r.user.id, jessa);
});

test('no code, an unlinked code and a disabled account are each refused', async () => {
  const { jessa } = await setup();
  process.env.SAIFSYS_DOOR_KEY = 'right-key';
  const key = { 'X-Saifsys-Key': 'right-key' };
  assert.equal((await knock(key)).body.code, 'no_employee');
  assert.equal((await knock({ ...key, 'X-Saifsys-Employee': 'E99999' })).body.code, 'not_linked');
  await db.prepare('UPDATE users SET disabled = true WHERE id = ?').run(jessa);
  assert.equal((await knock({ ...key, 'X-Saifsys-Employee': 'E00012' })).body.code, 'disabled');
});
