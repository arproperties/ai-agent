import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { reset, closeDb, makeUser, giveActions, giveModules } from './helpers/db.js';
import { moduleGate } from '../server/modules.js';
import { actionGate } from '../server/actions.js';
import { create, remove } from '../server/properties.js';
import { leasingRoutes } from '../server/leasing.js';
import { listProspects, addProspect, updateProspect, removeProspect, prospectRoutes } from '../server/prospects.js';

// The routes over real HTTP, behind both gates as index.js mounts them.
let user = { id: 0, role: 'master' };
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = user; next(); });
app.use('/api', moduleGate);
app.use('/api', actionGate);
app.use('/api/leasing', prospectRoutes);
app.use('/api/leasing', leasingRoutes);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/leasing`;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// Kept-alive sockets left open, or a forced exit while a handle is still closing, crash node on
// Windows (libuv async.c): close them, then wait a moment, as tests/drawing.test.js does.
test.after(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
  await closeDb();
  await new Promise((ok) => setTimeout(ok, 300));
});

async function tower() {
  await reset();
  const c = await create('company', { name: 'A' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const other = await create('building', { name: 'Annex' }, c.id);
  return { b, other, u1: await create('unit', { unit_no: '101' }, b.id), u2: await create('unit', { unit_no: '102' }, b.id), x1: await create('unit', { unit_no: '1' }, other.id) };
}

test('adds a prospect with only a name and a phone; status starts New', async () => {
  await tower();
  const p = await addProspect({ full_name: ' Sara ', phone: '409 555 0101' });
  assert.equal(p.full_name, 'Sara');
  assert.deepEqual([p.status, p.leased, p.due, p.booking_id, p.lease_ref], ['new', false, false, null, null]);
});

test('refuses a prospect without a name, or without any way to reach them', async () => {
  await tower();
  await assert.rejects(addProspect({ phone: '409 555 0101' }), /Give the prospect's name\./);
  await assert.rejects(addProspect({ full_name: 'Sara' }), /Give a phone number or an email\./);
  const p = await addProspect({ full_name: 'Sara', email: 'sara@example.com' });
  await assert.rejects(updateProspect(p.id, { email: '' }), /Give a phone number or an email\./, 'an edit cannot take the last way to reach them away');
});

test('a unit wanted fills in its building; a unit from another building is refused', async () => {
  const { b, u1, x1 } = await tower();
  const p = await addProspect({ full_name: 'Sara', phone: '4095550101', unit_id: u1.id });
  assert.deepEqual([p.building_id, p.building, p.unit_no], [b.id, 'Tower', '101']);
  await assert.rejects(addProspect({ full_name: 'Omar', phone: '4095550102', unit_id: x1.id, building_id: b.id }), /That unit is not in that building\./);
  const justBuilding = await addProspect({ full_name: 'Omar', phone: '4095550102', building_id: b.id });
  assert.deepEqual([justBuilding.building, justBuilding.unit_id], ['Tower', null]);
});

test('lost needs a reason; an unknown status is refused', async () => {
  await tower();
  const p = await addProspect({ full_name: 'Sara', phone: '4095550101' });
  await assert.rejects(updateProspect(p.id, { status: 'lost' }), /Say why the prospect was lost\./);
  assert.equal((await updateProspect(p.id, { status: 'lost', lost_reason: 'Found cheaper' })).status, 'lost');
  await assert.rejects(updateProspect(p.id, { status: 'leased' }), /Unknown status: leased/);
  assert.equal((await updateProspect(p.id, { status: 'viewing' })).lost_reason, null, 'back from lost, the reason goes');
  await assert.rejects(updateProspect(999, { notes: 'x' }), /Prospect not found/);
});

test('due when the follow-up day has come, not when lost', async () => {
  await tower();
  const p = await addProspect({ full_name: 'Sara', phone: '4095550101', follow_up: '2026-10-29' });
  assert.equal((await listProspects({}, '2026-10-29'))[0].due, true);
  assert.equal((await listProspects({}, '2026-10-28'))[0].due, false);
  await updateProspect(p.id, { status: 'lost', lost_reason: 'Moved away' });
  assert.equal((await listProspects({}, '2026-10-30'))[0].due, false);
  await assert.rejects(addProspect({ full_name: 'Omar', phone: '4095550102', follow_up: '29/10/2026' }), /not a date/);
});

test('search and the status filter; due ones first', async () => {
  await tower();
  await addProspect({ full_name: 'Sara', phone: '4095550101' });
  const omar = await addProspect({ full_name: 'Omar', email: 'omar@example.com', follow_up: '2026-10-01' });
  await updateProspect(omar.id, { status: 'viewing' });
  assert.deepEqual((await listProspects({ q: '0101' })).map((p) => p.full_name), ['Sara']);
  assert.deepEqual((await listProspects({ q: 'OMAR@' })).map((p) => p.full_name), ['Omar']);
  assert.deepEqual((await listProspects({ status: 'viewing' })).map((p) => p.full_name), ['Omar']);
  assert.deepEqual((await listProspects({}, '2026-10-29')).map((p) => p.full_name), ['Omar', 'Sara']);
});

test('the wanted unit deleted later leaves the prospect, without a unit', async () => {
  const { u1 } = await tower();
  await addProspect({ full_name: 'Sara', phone: '4095550101', unit_id: u1.id });
  await remove('unit', u1.id);
  const [p] = await listProspects();
  assert.deepEqual([p.full_name, p.unit_id, p.unit_no, p.building], ['Sara', null, null, 'Tower']);
});

test('removing a prospect', async () => {
  await tower();
  const p = await addProspect({ full_name: 'Sara', phone: '4095550101' });
  assert.deepEqual(await removeProspect(p.id), { ok: true });
  await assert.rejects(removeProspect(p.id), /Prospect not found/);
});

test('over HTTP: the Prospects module and the Add, Edit and Delete ticks decide', async () => {
  const { u1 } = await tower();
  const staff = await makeUser('Diana');
  await giveModules(staff, 'prospects');
  await giveActions(staff, 'add', 'edit');
  user = { id: staff, role: 'staff' };

  const made = await call('POST', '/prospects', { full_name: 'Sara', phone: '4095550101', unit_id: u1.id });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal((await call('GET', '/prospects')).body.length, 1);
  assert.equal((await call('PUT', `/prospects/${made.body.id}`, { status: 'viewing' })).body.status, 'viewing');
  assert.equal((await call('DELETE', `/prospects/${made.body.id}`)).status, 403, 'no Delete tick');
  assert.equal((await call('POST', '/bookings', { unit_id: u1.id })).status, 403, 'prospects is not leasing');
  const refused = await call('POST', '/prospects', { full_name: 'Omar' });
  assert.deepEqual([refused.status, refused.body.error], [400, 'Give a phone number or an email.']);
  user = { id: 0, role: 'master' };
});
