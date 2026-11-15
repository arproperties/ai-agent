import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, newDeviceKey, keyHash, dayEndOf, fromTracker } from '../server/tracker.js';

test.after(async () => { await closeDb(); });

test('a new device key is long, random and stored only as its hash', () => {
  const k = newDeviceKey();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newDeviceKey(), k);
  assert.match(keyHash(k), /^[0-9a-f]{64}$/);
});

test('settings start off, HR address and 19:00 filled in', async () => {
  await reset();
  const s = await settings();
  assert.equal(s.on, false);
  assert.equal(s.hr_email, 'hr@ainalreemproperty.com');
  assert.equal(s.send_at, '19:00');
  assert.equal(s.titles_on, true);
  assert.equal(dayEndOf('19:00'), '18:30');
  assert.equal(dayEndOf('00:10'), '23:40');
});

test('the door: right key sets the device and its person, wrong or missing key is 401', async () => {
  await reset();
  const uid = await makeUser('Francisca');
  const key = newDeviceKey();
  await db.prepare('INSERT INTO tracker_devices (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run(uid, 'Front desk', keyHash(key), 1);
  const run = (k) => new Promise((done) => {
    const req = { get: (h) => (h === 'X-Tracker-Key' ? k : undefined) };
    const res = { status: (c) => ({ json: (b) => done({ code: c, body: b }) }) };
    fromTracker(req, res, (err) => done(err ? { code: 500, body: err.message } : { code: 200, device: req.device, user: req.user }));
  });
  const ok = await run(key);
  assert.equal(ok.code, 200);
  assert.equal(ok.device.name, 'Front desk');
  assert.equal(ok.user.id, uid);
  assert.equal((await run('nope')).code, 401);
  assert.equal((await run(undefined)).code, 401);
  assert.ok((await db.prepare('SELECT last_seen_at FROM tracker_devices WHERE id = ?').get(ok.device.id)).last_seen_at > 0);
});
