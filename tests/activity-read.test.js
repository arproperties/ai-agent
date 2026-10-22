import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, reset, makeUser, giveModules, closeDb } from './helpers/db.js';
import { withActor } from '../server/db.js';
import { create } from '../server/properties.js';
import { createBooking, payBooking } from '../server/leasing.js';
import { attachActivityTriggers, actorContext } from '../server/activityCapture.js';
import { listActivity, activityRoutes, collected } from '../server/activity.js';
import { moduleGate } from '../server/modules.js';
import { activityKit } from '../server/activityKit.js';

test.after(() => closeDb());

// The activity log read back in words, on its screen and to Riley.

async function office() {
  await attachActivityTriggers();
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(boss);
  const jeff = await makeUser('Jeff');
  const maria = await makeUser('Maria');
  const as = (id, fn) => withActor({ userId: id, via: 'screen' }, fn);
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'GSL' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  const bk = await createBooking({ unit_id: u.id, start_date: '2026-09-01', end_date: '2026-12-31', rent_amount: 950, status: 'confirmed',
    tenant: { full_name: 'Tom Reed', phone: '050 123 4567' } }, boss);
  const [p1] = await as(jeff, () => payBooking(bk.id, { amount: 950, method: 'cash', received_on: '2026-09-01' }, jeff, '2026-10-20'));
  const [p2] = await as(jeff, () => payBooking(bk.id, { amount: 950, method: 'cash', received_on: '2026-10-01' }, jeff, '2026-10-20'));
  return { boss, jeff, maria, as, bk, p1, p2 };
}

test('an edited payment reads "Amount USD 950 → USD 850", with who did it and to which unit', async () => {
  const { maria, as, p1 } = await office();
  await as(maria, () => db.prepare('UPDATE lease_payments SET amount = 850 WHERE id = ?').run(p1.id));
  const [e] = await listActivity({ action: 'changed' });
  assert.equal(e.who, 'Maria');
  assert.equal(e.kind, 'Payment');
  assert.deepEqual(e.changes, [{ field: 'Amount', from: 'USD 950', to: 'USD 850' }]);
  assert.match(e.about, /Unit 101 \(GSL\) · Tom Reed/);
  assert.match(e.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('the filters narrow: person, kind, action, text, dates; the system is left out unless asked', async () => {
  const { maria, as, p2 } = await office();
  await as(maria, () => db.prepare('DELETE FROM lease_payments WHERE id = ?').run(p2.id));
  assert.ok((await listActivity({ person: 'jef' })).every((e) => e.who === 'Jeff'));
  const deleted = await listActivity({ kind: 'payments', action: 'deleted' });
  assert.deepEqual(deleted.map((e) => [e.who, e.kind]), [['Maria', 'Payment']]);
  assert.equal((await listActivity({ text: 'Tom Reed' })).some((e) => e.kind === 'Tenant'), false, 'the tenant was added by nobody signed in');
  assert.ok((await listActivity({ text: 'Tom Reed', system: true })).some((e) => e.kind === 'Tenant'));
  assert.deepEqual(await listActivity({ to: '2000-01-01' }), []);
  assert.ok((await listActivity({ from: '2000-01-01' })).length > 0);
});

test('a table with no label still reads, under a tidy name', async () => {
  const { jeff, as } = await office();
  await as(jeff, () => db.prepare("INSERT INTO lease_sources (name) VALUES ('Zillow')").run());
  await db.exec("DELETE FROM lease_sources"); // by nobody: system
  const [e] = await listActivity({ kind: 'lease_sources' });
  assert.equal(e.kind, 'Tenant source');
  const { kindName } = await import('../server/activity.js');
  assert.equal(kindName('lease_window_cleanings'), 'Window cleanings');
});

test('collected: what Jeff took in the range, and his payment someone deleted', async () => {
  const { maria, as, p2 } = await office();
  const sept = await collected({ person: 'jeff', from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual([sept.person, sept.total, sept.count, sept.total_text], ['Jeff', 1900, 2, 'USD 1,900']);
  await as(maria, () => db.prepare('DELETE FROM lease_payments WHERE id = ?').run(p2.id));
  const after = await collected({ person: 'Jeff', from: '2026-09-01', to: '2026-10-31' });
  assert.equal(after.total, 950);
  assert.deepEqual(after.changed_or_deleted.map((e) => [e.who, e.action]), [['Maria', 'delete']]);
  await assert.rejects(collected({ person: 'Nobody' }), /Nobody called/);
});

test('the route: the master and holders of Activity read it, others are refused', async () => {
  const { boss, jeff, maria } = await office();
  await giveModules(jeff, 'activity');
  const app = express();
  app.use((req, res, next) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.headers['x-user'])).then((u) => { req.user = u; next(); }));
  app.use(actorContext);
  app.use(moduleGate);
  app.use('/activity', activityRoutes);
  const server = app.listen(0);
  try {
    const get = (id) => fetch(`http://127.0.0.1:${server.address().port}/activity`, { headers: { 'x-user': String(id) } });
    assert.equal((await get(boss)).status, 200);
    const r = await get(jeff);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).entries));
    assert.equal((await get(maria)).status, 403);
  } finally {
    server.close();
  }
});

test('Riley answers who deleted a payment and how much someone collected', async () => {
  const { boss, maria, as, p2 } = await office();
  await as(maria, () => db.prepare('DELETE FROM lease_payments WHERE id = ?').run(p2.id));
  const kit = activityKit({ id: boss, role: 'master' });
  assert.deepEqual(kit.definitions.map((d) => d.name), ['activity_search']);
  const who = await kit.run({ id: 't1', name: 'activity_search', input: { kind: 'payment', action: 'deleted' } });
  assert.equal(who.is_error, undefined);
  assert.match(who.content, /Maria/);
  assert.match(who.content, /deleted Payment/);
  const sum = await kit.run({ id: 't2', name: 'activity_search', input: { mode: 'collected', person: 'Jeff', from: '2026-09-01', to: '2026-10-31' } });
  assert.match(sum.content, /USD 950/);
  assert.match(sum.content, /Maria/);
  const bad = await kit.run({ id: 't3', name: 'activity_search', input: { mode: 'collected' } });
  assert.equal(bad.is_error, true);
});
