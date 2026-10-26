import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');
const { alertOnce, alertTick, dueStep, recipientsFor, alertSettings, saveAlertSettings } = await import('../server/documentAlerts.js');

test.after(() => closeDb());

test('the daily alerts wait for the sending switch, and a day skipped while it was off is not lost', async () => {
  await reset();
  let on = false;
  let runs = 0;
  const state = { lastDay: null };
  const deps = { gate: async () => on, today: '2026-10-24', hour: 9, run: async () => { runs++; return 1; } };
  assert.equal(await alertTick(state, deps), null, 'off: nothing goes out');
  assert.equal(runs, 0);
  on = true;
  assert.equal(await alertTick(state, deps), 1, 'turned on later the same day: that day still goes');
  assert.equal(await alertTick(state, deps), null, 'once a day');
  assert.equal(runs, 1);
  assert.equal(await alertTick({ lastDay: null }, { ...deps, hour: 7 }), null, 'not before the hour');
});

const TODAY = '2026-10-24';
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const SETTINGS = { days: [60, 30, 14], overdue_every_days: 7, hour: 8 };

// What alertOnce sent: pushes and to-dos, by person.
function outbox() {
  const pushes = [];
  const todos = [];
  return {
    pushes, todos,
    push: async (ids, msg) => { pushes.push({ ids: [...ids].sort((a, b) => a - b), ...msg }); },
    todo: async (userId, t) => { todos.push({ userId, ...t }); },
  };
}

async function office() {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss);
  const hr = await makeUser('Hr');
  const staff = await makeUser('Staff');
  await cats.seedCategories();
  await setModuleAccess(hr, ['document_renewals']);
  return { boss, hr, staff };
}
const typeId = async (label) => (await db.prepare('SELECT id FROM document_types WHERE label = ?').get(label)).id;
async function doc(ownerId, { type = 'Residence Visa', code = 'E-0042', name = 'Ahmed Khan', expires, confirmed = true, title } = {}) {
  const id = await makeDoc(ownerId, null, title || `${type}.pdf`);
  if (type) {
    const t = await typeId(type);
    await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
      employee_code = ?, employee_name = ?, link_confirmed_at = 1 WHERE id = ?`).run(t, t, code, name, id);
  }
  await db.prepare('UPDATE documents SET expires_on = ?, expiry_confirmed_at = ? WHERE id = ?').run(expires, confirmed ? 1 : null, id);
  return id;
}

// ---------- which step is due ----------

test('sends at 60, 30 and 14 days', () => {
  const at = (n, sent = []) => dueStep({ expires_on: plus(n), expiry_confirmed_at: 1 }, TODAY, SETTINGS, new Set(sent));
  assert.equal(at(61), null, 'too far off');
  assert.equal(at(60), 'd60');
  assert.equal(at(45), 'd60');
  assert.equal(at(30), 'd30');
  assert.equal(at(20), 'd30', 'first seen at 20 days: the 30-day alert, not the 60 as well');
  assert.equal(at(14), 'd14');
  assert.equal(at(0), 'd14', 'runs out today');
  assert.equal(at(45, ['d60']), null, 'already sent');
});

test('expired then every 7 days', () => {
  const at = (n, sent = []) => dueStep({ expires_on: plus(n), expiry_confirmed_at: 1 }, TODAY, SETTINGS, new Set(sent));
  assert.equal(at(-1), 'expired');
  assert.equal(at(-3, ['expired']), null);
  assert.equal(at(-7, ['expired']), `overdue:${TODAY}`);
  assert.equal(at(-10, ['expired', `overdue:${plus(-3)}`]), null);
  assert.equal(at(-14, ['expired', `overdue:${plus(-7)}`]), `overdue:${TODAY}`);
  assert.equal(at(-100), 'expired', 'long expired and never told: told once, not 14 times');
});

test('unconfirmed date sends a confirm alert, not a countdown', () => {
  assert.equal(dueStep({ expires_on: plus(10), expiry_confirmed_at: null }, TODAY, SETTINGS, new Set()), 'confirm');
  assert.equal(dueStep({ expires_on: plus(10), expiry_confirmed_at: null }, TODAY, SETTINGS, new Set(['confirm'])), null);
});

test('not renewing, a newer file, or no date: nothing is due', () => {
  for (const d of [
    { expires_on: plus(10), expiry_confirmed_at: 1, not_renewing_at: 5 },
    { expires_on: plus(10), expiry_confirmed_at: 1, superseded_by: 9 },
    { expires_on: null, expiry_confirmed_at: null },
  ]) assert.equal(dueStep(d, TODAY, SETTINGS, new Set()), null);
});

// ---------- who is told ----------

test('categorised files go to master and Document Renewals holders only', async () => {
  const { boss, hr, staff } = await office();
  const ext = await makeUser('Jeff');
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'document_renewals')").run(ext);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext);
  const id = await doc(staff, { expires: plus(10) });
  const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  assert.deepEqual((await recipientsFor(d)).sort((a, b) => a - b), [boss, hr], 'not the uploader, not the external holder');
});

test('personal file goes to its owner only', async () => {
  const { staff } = await office();
  const id = await doc(staff, { type: null, expires: plus(10) });
  assert.deepEqual(await recipientsFor(await db.prepare('SELECT * FROM documents WHERE id = ?').get(id)), [staff]);
});

test('an external person\'s own categorised file alerts only them', async () => {
  await office();
  const ext = await makeUser('Jeff');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext);
  const id = await doc(ext, { expires: plus(10) });
  assert.deepEqual(await recipientsFor(await db.prepare('SELECT * FROM documents WHERE id = ?').get(id)), [ext]);
});

// ---------- the run ----------

test('restart does not resend', async () => {
  const { boss, hr, staff } = await office();
  await doc(staff, { expires: plus(14) });
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.equal(o.pushes.length, 1);
  assert.deepEqual(o.pushes[0].ids, [boss, hr].sort((a, b) => a - b));
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM document_alerts').get()).n, 1);
});

test('push has no document text', async () => {
  const { staff } = await office();
  const id = await doc(staff, { expires: plus(14), title: 'secret-passport-number-P1234567.pdf' });
  await db.prepare("UPDATE documents SET title = 'Passport P1234567 of Ahmed Khan', summary = 'Number P1234567' WHERE id = ?").run(id);
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  const [p] = o.pushes;
  assert.equal(p.title, 'Residence Visa – Ahmed Khan');
  assert.equal(p.body, 'Runs out in 14 days (7 Nov 2026)');
  assert.doesNotMatch(JSON.stringify(p), /P1234567/);
  assert.equal(p.url, '/?docrenewals=E-0042');
  assert.equal(p.tag, `expiry-${id}`);
});

test('a to-do lands at 14 days for each person told', async () => {
  const { boss, hr, staff } = await office();
  await doc(staff, { expires: plus(14) });
  await doc(staff, { type: 'Passport', code: 'E-0077', name: 'Sara Lopez', expires: plus(30) });
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.deepEqual(o.todos.map((t) => t.userId).sort((a, b) => a - b), [boss, hr].sort((a, b) => a - b));
  assert.match(o.todos[0].text, /Renew the Residence Visa of Ahmed Khan/);
});

test('many at once are one summary push each, not dozens', async () => {
  const { boss, hr, staff } = await office();
  for (let i = 0; i < 5; i++) await doc(staff, { code: `E-${i}`, name: `P${i}`, expires: plus(-i - 1) });
  await doc(staff, { code: 'E-9', name: 'Due', expires: plus(10) });
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.equal(o.pushes.length, 1, 'boss and HR get the same summary, sent once to both');
  assert.deepEqual(o.pushes[0].ids, [boss, hr].sort((a, b) => a - b));
  assert.equal(o.pushes[0].title, '6 documents need attention');
  assert.equal(o.pushes[0].body, '5 expired, 1 due within 14 days');
  assert.equal(o.pushes[0].url, '/?docrenewals=1');
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM document_alerts').get()).n, 6, 'each still recorded, so none is sent again');
});

test('a category added later alerts like the seeded ones', async () => {
  const { boss, hr, staff } = await office();
  const cat = await cats.addCategory({ role: 'master' }, { label: 'Vehicle Documents', private: false, links_to: 'subject' });
  const t = await cats.addType({ role: 'master' }, cat, { label: 'Car Mulkiya' });
  const id = await makeDoc(staff, null, 'm.pdf');
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = ?, subject = 'Dubai A 12345', link_confirmed_at = 1, expires_on = ?, expiry_confirmed_at = 1 WHERE id = ?`)
    .run(t, cat, plus(30), id);
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.equal(o.pushes[0].title, 'Car Mulkiya – Dubai A 12345');
  assert.deepEqual(o.pushes[0].ids, [boss, hr].sort((a, b) => a - b));
});

test('external holder gets nothing', async () => {
  const { staff } = await office();
  const ext = await makeUser('Jeff');
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'document_renewals')").run(ext);
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext);
  await doc(staff, { expires: plus(14) });
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.ok(!o.pushes.some((p) => p.ids.includes(ext)));
  assert.ok(!o.todos.some((t) => t.userId === ext));
});

test('newer file of same type stops the old alerts', async () => {
  const { staff } = await office();
  const old = await doc(staff, { expires: plus(10) });
  const renewed = await doc(staff, { expires: plus(700) });
  await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(renewed, old);
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.equal(o.pushes.length, 0);
});

test('not renewing stops the alerts', async () => {
  const { staff } = await office();
  const id = await doc(staff, { expires: plus(-3) });
  await db.prepare('UPDATE documents SET not_renewing_at = 1 WHERE id = ?').run(id);
  const o = outbox();
  await alertOnce({ today: TODAY, push: o.push, todo: o.todo });
  assert.equal(o.pushes.length, 0);
});

// ---------- settings ----------

test('the alert days are settings, and only the master changes them', async () => {
  const { boss, hr } = await office();
  assert.deepEqual(await alertSettings(), SETTINGS);
  await assert.rejects(saveAlertSettings({ id: hr, role: 'user' }, { days: [90] }), (e) => e.status === 403);
  await saveAlertSettings({ id: boss, role: 'master' }, { days: [90, 45, 7, 'x', -2], overdue_every_days: 3, hour: 9 });
  assert.deepEqual(await alertSettings(), { days: [90, 45, 7], overdue_every_days: 3, hour: 9 });
  await assert.rejects(saveAlertSettings({ id: boss, role: 'master' }, { days: [] }), (e) => e.status === 400);
});
