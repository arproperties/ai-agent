import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { settings, newDeviceKey, keyHash, dayEndOf, fromTracker, fromTrackerRoutes, fmtSeconds, renderDigest } from '../server/tracker.js';

// The PC's door as index.js mounts it: the key check in front of the two routes.
let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/from-tracker', fromTracker, fromTrackerRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/from-tracker`;
});
test.after(async () => { server.close(); await closeDb(); });

const post = (path, body, key) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Tracker-Key': key } : {}) }, body: JSON.stringify(body) });

// A day exactly as the contract in the plan has it.
const DAY = {
  date: '2026-11-15', first_seen: '08:52', last_seen: '17:41',
  active_seconds: 24480, idle_seconds: 3120, away_seconds: 4200,
  running: [['08:50', '12:10'], ['12:40', '17:45']],
  apps: [{ name: 'Excel', seconds: 11400, titles: [{ title: 'Rent roll Nov.xlsx', seconds: 7000 }] },
    { name: 'Google Chrome', seconds: 7500, titles: [{ title: 'Dubai Land Department', seconds: 3000 }] }],
};

/** A paired PC for the tests: the person, the device row and the plain key. */
async function pairedDevice(name = 'Francisca', device = 'Front desk') {
  const uid = await makeUser(name);
  const key = newDeviceKey();
  const { id } = await db.prepare('INSERT INTO tracker_devices (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id').run(uid, device, keyHash(key), 1);
  return { uid, id, key };
}

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

test('hello tells the PC whose it is and when the day ends', async () => {
  await reset();
  const { key } = await pairedDevice();
  const r = await post('/hello', {}, key);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'Francisca', device: 'Front desk', day_end: '18:30' });
});

test('a day is stored once per device and date; a resend replaces it and is pending again', async () => {
  await reset();
  const { key } = await pairedDevice();
  assert.equal((await post('/day', DAY, key)).status, 200);
  await db.prepare('UPDATE tracker_days SET pending = false, digested_at = ?').run('2026-11-15');
  const r = await post('/day', { ...DAY, active_seconds: 30000 }, key);
  assert.deepEqual(await r.json(), { ok: true, day_end: '18:30' });
  const rows = await db.prepare('SELECT * FROM tracker_days').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active_seconds, 30000);
  assert.equal(rows[0].pending, true, 'arrives again, so HR must hear of the change');
  assert.equal(rows[0].digested_at, '2026-11-15', 'but Reem remembers it was already emailed');
  assert.equal(rows[0].apps[0].name, 'Excel');
});

test('a bad day is refused: wrong date, negative seconds, apps not a list, titles over 5', async () => {
  await reset();
  const { key } = await pairedDevice();
  for (const bad of [{ ...DAY, date: '15/11/2026' }, { ...DAY, active_seconds: -1 }, { ...DAY, apps: 'x' },
    { ...DAY, apps: [{ name: 'A', seconds: 1, titles: Array(6).fill({ title: 't', seconds: 1 }) }] }]) {
    assert.equal((await post('/day', bad, key)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tracker_days').get()).n, 0);
});

test('a deleted device gets 401 with the pairing message', async () => {
  await reset();
  const { key } = await pairedDevice();
  await db.prepare('DELETE FROM tracker_devices').run();
  const r = await post('/day', DAY, key);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'This PC is not paired with Reem');
});

// ---------- the digest ----------

test('seconds read as hours and minutes', () => {
  assert.equal(fmtSeconds(24480), '6h 48m');
  assert.equal(fmtSeconds(3120), '52m');
  assert.equal(fmtSeconds(0), '0m');
});

test('the digest names the day, lists everyone, marks who has no report and who came late', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: true,
    people: [{ name: 'Francisca', ...DAY }, { name: 'Ali', date: '2026-11-15', missing: true }],
    late: [{ name: 'Ali', ...DAY, date: '2026-11-14' }], updated: [] });
  assert.equal(d.subject, 'Activity report — Sun 15 Nov 2026');
  assert.match(d.text, /Francisca\s+08:52\s+17:41\s+6h 48m\s+52m\s+1h 10m\s+Excel 3h 10m · Google Chrome 2h 05m/);
  assert.match(d.text, /Ali\s+—\s+—\s+no report yet/);
  assert.match(d.text, /Late: Sat 14 Nov/);
  assert.match(d.text, /tracker not running 12:10–12:40/, 'a gap in running shows');
  assert.match(d.csv, /^name,date,app,seconds,title,title_seconds\r?\n/);
  assert.match(d.csv, /Francisca,2026-11-15,Excel,11400,Rent roll Nov.xlsx,7000/);
  assert.match(d.html, /<table/);
  assert.match(d.html, /Francisca/);
});

test('titles off: no window title anywhere, in text, html or csv', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: false, people: [{ name: 'Francisca', ...DAY }], late: [], updated: [] });
  for (const part of [d.text, d.html, d.csv]) assert.doesNotMatch(part, /Rent roll/);
  assert.match(d.csv, /^Francisca,2026-11-15,Excel,11400,,$/m);
});

test('a day that changed after HR saw it is listed under Updated', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: true, people: [], late: [], updated: [{ name: 'Tauqeer', ...DAY, date: '2026-11-14' }] });
  assert.match(d.text, /Updated: Sat 14 Nov\s*\n\s*Tauqeer/);
});
