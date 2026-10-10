import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync } from 'node:fs';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create } from '../server/properties.js';
import { createBooking } from '../server/leasing.js';
import { workOrderRoutes, getWorkOrder, removeWorkOrder } from '../server/workOrders.js';

// The work order routes over real HTTP: the router is mounted as index.js mounts it, behind a
// stand-in for the auth middleware, with the same shape of error answer.

let user = { id: 0, role: 'master' }; // the test changes who is calling
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = user; next(); });
app.use('/api/leasing', workOrderRoutes);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/leasing`;

test.after(async () => {
  await new Promise((ok) => server.close(ok));
  await closeDb();
});

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${base}${path}`, init);
  const type = res.headers.get('content-type') || '';
  return { res, status: res.status, body: type.includes('json') ? await res.json() : null };
}
const asMaster = (id) => { user = { id, role: 'master' }; };
const asStaff = (id) => { user = { id, role: 'staff' }; };

// Sara has unit 101 from 15 September to 14 November. Unit 102 is empty.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const building = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, building.id);
  const u2 = await create('unit', { unit_no: '102' }, building.id);
  const bk = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  asMaster(staff);
  return { staff, building, u1, u2, bk };
}

const raise = async (body) => {
  const r = await call('POST', '/work-orders', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

// A tiny but valid PNG, and a plain text file.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const form = (...files) => {
  const f = new FormData();
  for (const [name, data, type] of files) f.append('files', new Blob([data], { type }), name);
  return f;
};

test('a work order is raised, read, listed and filtered over HTTP', async () => {
  const { u1, u2, bk } = await tower();
  const ac = await raise({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_by: 'Sara' });
  assert.equal(ac.status, 'open');
  assert.equal(ac.tenant, 'Sara');
  assert.equal(ac.booking_id, bk.id);
  assert.equal(ac.unit_no, '101');
  assert.match(ac.ref, /^WO-\d{4}-0001$/);
  const paint = await raise({ unit_id: u2.id, detail: 'Repaint the hallway', assigned_to: 'Painters Co' });
  assert.equal(paint.status, 'assigned');
  assert.equal(paint.tenant, null);

  // A raise with nothing wrong written is refused with a readable message.
  const none = await call('POST', '/work-orders', { unit_id: u1.id, detail: ' ' });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Say what is wrong/);

  asMaster(user.id);
  const asM = await call('GET', `/work-orders/${ac.id}`);
  assert.equal(asM.status, 200);
  assert.equal(asM.body.id, ac.id);
  assert.equal(asM.body.master, true);
  assert.deepEqual(asM.body.events.map((e) => e.kind), ['created']);
  asStaff(user.id);
  assert.equal((await call('GET', `/work-orders/${ac.id}`)).body.master, false);

  const list = await call('GET', '/work-orders');
  assert.equal(list.status, 200);
  assert.equal(list.body.master, false);
  assert.deepEqual(list.body.work_orders.map((w) => w.id), [paint.id, ac.id].sort((a, b) => b - a), 'newest first');
  asMaster(user.id);
  assert.equal((await call('GET', '/work-orders')).body.master, true);

  const ids = async (qs) => (await call('GET', `/work-orders${qs}`)).body.work_orders.map((w) => w.id);
  assert.deepEqual(await ids('?status=active'), [paint.id, ac.id]);
  assert.deepEqual(await ids('?status=assigned'), [paint.id]);
  assert.deepEqual(await ids('?q=cooling'), [ac.id]);
  assert.deepEqual(await ids('?q=painters'), [paint.id]);
  assert.deepEqual(await ids('?q=nothing-like-this'), []);

  await db.prepare("UPDATE lease_work_orders SET status = 'closed' WHERE id = ?").run(paint.id);
  assert.deepEqual(await ids('?status=active'), [ac.id], 'a closed one is not active');
});

test('/work-orders/units and /work-orders/link are not swallowed by /:id', async () => {
  const { u1, u2, building } = await tower();
  const units = await call('GET', '/work-orders/units');
  assert.equal(units.status, 200);
  assert.ok(Array.isArray(units.body));
  assert.deepEqual(units.body.map((u) => [u.id, u.unit_no, u.building_id, u.building]), [[u1.id, '101', building.id, 'Tower'], [u2.id, '102', building.id, 'Tower']]);

  const link = await call('GET', `/work-orders/link?unit_id=${u1.id}&on=2026-10-01`);
  assert.equal(link.status, 200);
  assert.equal(link.body.tenant, 'Sara');
  assert.match(link.body.ref, /\S/);
  const empty = await call('GET', `/work-orders/link?unit_id=${u2.id}&on=2026-10-01`);
  assert.deepEqual(empty.body, { tenant: null, ref: null });
});

test('PUT moves a work order on, and a wrong step is refused in words', async () => {
  const { u1 } = await tower();
  const w = await raise({ unit_id: u1.id, detail: 'Leak under the sink' });
  const put = (body, id = w.id) => call('PUT', `/work-orders/${id}`, body);

  const noOne = await put({ status: 'assigned' });
  assert.equal(noOne.status, 400);
  assert.match(noOne.body.error, /who it is assigned to/);

  const assigned = await put({ assigned_to: 'Pipes Co', status: 'assigned' });
  assert.equal(assigned.status, 200);
  assert.deepEqual([assigned.body.status, assigned.body.assigned_to], ['assigned', 'Pipes Co']);

  const noWords = await put({ status: 'done' });
  assert.equal(noWords.status, 400);
  assert.match(noWords.body.error, /Say what was done/);

  const early = await put({ status: 'closed' });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Only a work order that is done can be closed/);

  const nonsense = await put({ status: 'flying' });
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.body.error, /not a status/);

  const done = await put({ status: 'done', resolution: 'Replaced the trap' });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.status, done.body.resolution], ['done', 'Replaced the trap']);

  const back = await put({ status: 'open' });
  assert.equal(back.status, 409);
  assert.match(back.body.error, /already done/);

  const closed = await put({ status: 'closed' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.deepEqual(closed.body.events.map((e) => e.kind), ['created', 'assigned', 'status', 'status']);

  const locked = await put({ detail: 'changed my mind' });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Reopen it/);

  const gone = await put({ detail: 'x' }, 9999);
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /not found/);
  assert.equal((await call('GET', '/work-orders/9999')).status, 404);
});

test('a note adds a line to the history, and an empty one is refused', async () => {
  const { u1 } = await tower();
  const w = await raise({ unit_id: u1.id, detail: 'Door handle loose' });
  const n = await call('POST', `/work-orders/${w.id}/notes`, { note: 'Tenant not home, back Thursday' });
  assert.equal(n.status, 200);
  const last = n.body.events.at(-1);
  assert.deepEqual([last.kind, last.detail, last.who], ['note', 'Tenant not home, back Thursday', 'Staff']);

  for (const body of [{ note: '   ' }, {}]) {
    const r = await call('POST', `/work-orders/${w.id}/notes`, body);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Write the note/);
  }
  assert.equal((await call('GET', `/work-orders/${w.id}`)).body.events.length, 2, 'the refused ones left nothing behind');
  assert.equal((await call('POST', '/work-orders/9999/notes', { note: 'hi' })).status, 404);
});

test('files are attached by upload, read back with their type, removed, and refused on a closed one', async () => {
  const { u1 } = await tower();
  const w = await raise({ unit_id: u1.id, detail: 'Cracked tile' });
  try {
    const up = await call('POST', `/work-orders/${w.id}/files`, form(['tile.png', PNG, 'image/png'], ['quote.txt', 'AED 300', 'text/plain']));
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.deepEqual(up.body.files.map((f) => [f.file_name, f.file_mime]), [['tile.png', 'image/png'], ['quote.txt', 'text/plain']]);
    assert.match(up.body.events.at(-1).detail, /Added tile\.png, quote\.txt/);

    const [png, txt] = up.body.files;
    const got = await fetch(`${base}/work-orders/files/${png.id}/file`);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-type'), /^image\/png/);
    assert.match(got.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/work-orders/files/9999/file`)).status, 404);

    const none = await call('POST', `/work-orders/${w.id}/files`, new FormData());
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Choose a file/);

    const del = await call('DELETE', `/work-orders/files/${txt.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });
    const after = await call('GET', `/work-orders/${w.id}`);
    assert.deepEqual(after.body.files.map((f) => f.id), [png.id]);
    assert.equal((await call('DELETE', `/work-orders/files/${txt.id}`)).status, 404);

    // Closed: no more files in, none out.
    await db.prepare("UPDATE lease_work_orders SET status = 'closed' WHERE id = ?").run(w.id);
    const late = await call('POST', `/work-orders/${w.id}/files`, form(['more.png', PNG, 'image/png']));
    assert.equal(late.status, 409);
    assert.match(late.body.error, /Reopen it/);
    assert.equal((await call('DELETE', `/work-orders/files/${png.id}`)).status, 409);
    assert.equal((await call('GET', `/work-orders/${w.id}`)).body.files.length, 1);
  } finally {
    // Leave no file on disk: open it again and delete the work order, which removes its files.
    await db.prepare("UPDATE lease_work_orders SET status = 'open', assigned_to = NULL WHERE id = ?").run(w.id);
    const paths = (await db.prepare('SELECT file_path FROM lease_work_order_files WHERE work_order_id = ?').all(w.id)).map((f) => f.file_path);
    await removeWorkOrder(w.id);
    for (const p of paths) assert.equal(existsSync(p), false);
  }
});

test('only the master deletes a work order, and only one nobody has started', async () => {
  const { staff, u1 } = await tower();
  const fresh = await raise({ unit_id: u1.id, detail: 'Raised by mistake' });
  const taken = await raise({ unit_id: u1.id, detail: 'Leak', assigned_to: 'Pipes Co' });

  asStaff(staff);
  const no = await call('DELETE', `/work-orders/${fresh.id}`);
  assert.equal(no.status, 403);
  assert.equal(no.body.error, 'Not allowed');
  assert.equal((await getWorkOrder(fresh.id)).id, fresh.id, 'still there');

  asMaster(staff);
  const started = await call('DELETE', `/work-orders/${taken.id}`);
  assert.equal(started.status, 409);
  assert.match(started.body.error, /Cancel it instead/);
  assert.equal((await getWorkOrder(taken.id)).id, taken.id);

  assert.equal((await call('DELETE', '/work-orders/9999')).status, 404);

  const ok = await call('DELETE', `/work-orders/${fresh.id}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.equal((await call('GET', `/work-orders/${fresh.id}`)).status, 404);
});
