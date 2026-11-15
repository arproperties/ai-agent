import { db, reset, makeUser, closeDb } from './helpers/db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { settings, newDeviceKey, keyHash, dayEndOf, fromTracker, fromTrackerRoutes, fmtSeconds, renderDigest, collect, tick, trackerRoutes, markDigested } from '../server/tracker.js';
import { trackerReach } from '../server/access.js';
import { dubaiDate } from '../server/saifsys/client.js';

// The PC's door as index.js mounts it: the key check in front of the two routes.
let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/from-tracker', fromTracker, fromTrackerRoutes);
  // The master's routes as index.js mounts them, behind requireMaster; here the master is set by hand.
  app.use('/api/tracker', (req, res, next) => { req.user = { id: 1, role: 'master', name: 'Boss' }; next(); }, trackerRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/from-tracker`;
});
test.after(async () => { server.close(); await closeDb(); });

const master = (method, path, body) => fetch(`${base.replace('/from-tracker', '/tracker')}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
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

// ---------- the timer ----------

test('collect sums a person with two PCs and lists people with no report', async () => {
  await reset();
  const today = dubaiDate();
  const a = await pairedDevice('Francisca', 'Laptop');
  const b = { ...a, ...(await (async () => { const key = newDeviceKey(); const { id } = await db.prepare('INSERT INTO tracker_devices (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id').run(a.uid, 'Desktop', keyHash(key), 1); return { id, key }; })()) };
  await pairedDevice('Ali', 'Office');
  await post('/day', { ...DAY, date: today }, a.key);
  await post('/day', { ...DAY, date: today }, b.key);
  const c = await collect(today);
  assert.deepEqual(c.people.map((p) => [p.name, p.missing || false]), [['Ali', true], ['Francisca', false]], 'everyone with a PC, by name');
  const f = c.people.find((p) => p.name === 'Francisca');
  assert.equal(f.active_seconds, DAY.active_seconds * 2, 'two PCs, one person, one line');
  assert.equal(f.apps.find((x) => x.name === 'Excel').seconds, 22800);
  assert.deepEqual(c.late, []); assert.deepEqual(c.updated, []);
});

test('collect sorts earlier days into late (never emailed) and updated (emailed before)', async () => {
  await reset();
  const today = dubaiDate();
  const { key } = await pairedDevice();
  await post('/day', { ...DAY, date: '2026-01-02' }, key);
  await post('/day', { ...DAY, date: '2026-01-03' }, key);
  await db.prepare(`UPDATE tracker_days SET digested_at = '2026-01-03' WHERE date = '2026-01-03'`).run();
  const c = await collect(today);
  assert.deepEqual(c.late.map((e) => e.date), ['2026-01-02']);
  assert.deepEqual(c.updated.map((e) => e.date), ['2026-01-03']);
});

test('tick sends once a day at the set time, to the HR address, then marks the rows digested', async () => {
  await reset();
  const { key } = await pairedDevice();
  await post('/day', { ...DAY, date: dubaiDate() }, key);
  await settings();
  await db.prepare(`UPDATE tracker_settings SET "on" = true, send_at = '00:00'`).run();
  const sent = [];
  const send = async (m) => { sent.push(m); };
  await tick({ send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'hr@ainalreemproperty.com');
  assert.match(sent[0].subject, /^Activity report — /);
  assert.ok(sent[0].html.includes('<table'));
  assert.equal(sent[0].attachments[0].filename, `activity-${dubaiDate()}.csv`);
  await tick({ send });
  assert.equal(sent.length, 1, 'not twice in a day');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tracker_days WHERE pending').get()).n, 0);
  assert.equal((await settings()).sent_on, dubaiDate());
});

test('tick does nothing while the switch is off, and keeps rows pending when mail fails or HR has no address', async () => {
  await reset();
  const { key } = await pairedDevice();
  await post('/day', { ...DAY, date: dubaiDate() }, key);
  await settings();
  const sent = [];
  await db.prepare(`UPDATE tracker_settings SET send_at = '00:00'`).run();
  await tick({ send: async (m) => { sent.push(m); } });
  assert.equal(sent.length, 0, 'off');
  await db.prepare(`UPDATE tracker_settings SET "on" = true`).run();
  await tick({ send: async () => { throw new Error('smtp down'); } });
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tracker_days WHERE pending').get()).n, 1, 'still pending after a failed send');
  assert.equal((await settings()).sent_on, '');
  await db.prepare(`UPDATE tracker_settings SET hr_email = ''`).run();
  await tick({ send: async (m) => { sent.push(m); } });
  assert.equal(sent.length, 0, 'nowhere to send');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tracker_days WHERE pending').get()).n, 1);
});

// ---------- the master's routes ----------

test('only the master reaches the tracker', () => {
  assert.equal(trackerReach({ role: 'master' }), true);
  assert.equal(trackerReach({ role: 'user' }), false);
  assert.equal(trackerReach(null), false);
});

test('settings round-trip, and nonsense is refused', async () => {
  await reset();
  assert.equal((await master('PUT', '/settings', { on: true, hr_email: 'people@example.com', send_at: '18:00', titles_on: false })).status, 200);
  const r = await (await master('GET', '')).json();
  assert.equal(r.settings.on, true); assert.equal(r.settings.hr_email, 'people@example.com');
  assert.equal(r.settings.send_at, '18:00'); assert.equal(r.settings.titles_on, false);
  assert.equal((await master('PUT', '/settings', { send_at: '25:00' })).status, 400);
  assert.equal((await master('PUT', '/settings', { hr_email: 'x' })).status, 400);
  assert.equal((await (await master('GET', '')).json()).settings.send_at, '18:00', 'the bad value changed nothing');
});

test('a new device opens the door; the page lists it without the key; deleting it shuts the door', async () => {
  await reset();
  const uid = await makeUser('Francisca');
  const made = await (await master('POST', '/devices', { user_id: uid, name: 'Front desk' })).json();
  assert.match(made.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await post('/hello', {}, made.key)).status, 200);
  await post('/day', { ...DAY, date: dubaiDate() }, made.key);
  const page = await (await master('GET', '')).json();
  assert.deepEqual(page.devices.map((d) => [d.name, d.person]), [['Front desk', 'Francisca']]);
  assert.equal(JSON.stringify(page).includes(made.key), false, 'the key is shown once, at creation, never again');
  assert.equal(page.days.length, 1); assert.equal(page.days[0].person, 'Francisca'); assert.equal(page.days[0].active_seconds, DAY.active_seconds);
  assert.deepEqual(page.people.map((p) => p.name), ['Francisca'], 'who a new device can be made for');
  assert.equal((await master('POST', '/devices', { user_id: 9999, name: 'x' })).status, 400);
  assert.equal((await master('DELETE', `/devices/${made.id}`)).status, 200);
  assert.equal((await post('/hello', {}, made.key)).status, 401);
});

test('a day that arrives while the email is being sent is not marked as emailed', async () => {
  await reset();
  const { key } = await pairedDevice();
  await post('/day', { ...DAY, date: dubaiDate() }, key);
  const { rowKeys } = await collect(dubaiDate());
  await new Promise((r) => setTimeout(r, 1100)); // received_at is in whole seconds
  await post('/day', { ...DAY, date: dubaiDate(), active_seconds: 1 }, key); // arrives after collect, before the mark
  await markDigested(rowKeys, dubaiDate());
  const row = await db.prepare('SELECT pending FROM tracker_days').get();
  assert.equal(row.pending, true, 'HR did not see this version, so it stays pending for tomorrow');
});

test('a window title that looks like a spreadsheet formula is made harmless in the CSV', () => {
  const day = { ...DAY, apps: [{ name: 'Google Chrome', seconds: 10, titles: [{ title: '=HYPERLINK("http://evil")', seconds: 10 }, { title: '-1+1', seconds: 1 }] }] };
  const d = renderDigest({ day: '2026-11-15', titlesOn: true, people: [{ name: 'Francisca', ...day }], late: [], updated: [] });
  assert.doesNotMatch(d.csv, /,=HYPERLINK/);
  assert.match(d.csv, /,"'=HYPERLINK\(""http:\/\/evil""\)",10/);
  assert.match(d.csv, /,'-1\+1,1/);
});
