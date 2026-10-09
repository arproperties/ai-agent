import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create, listUnits } from '../server/properties.js';
import { leasingRoutes, todayHere, createBooking } from '../server/leasing.js';
import { inspectionRoutes } from '../server/inspections.js';

test.after(() => closeDb());

// The whole of a unit's round, over the same routes the screens call: it is made ready, a
// lease is drafted, the tenant is inspected in and the lease confirmed, they are inspected out,
// it is made ready again, and the next tenant moves in.

const plus = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const INSPECT = ['Kitchen', 'Bedrooms', 'Walls & paint'];
const WORK = ['Cleaning', 'Painting'];
const all = (areas, condition) => areas.map((area) => ({ area, condition }));

async function serve(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'user' }; next(); });
  app.use('/api/leasing', inspectionRoutes); // as in server/index.js
  app.use('/api/leasing', leasingRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/leasing`;
  const call = async (method, path, body) => {
    const form = body instanceof FormData;
    const res = await fetch(url + path, { method, headers: form || !body ? {} : { 'Content-Type': 'application/json' }, body: form ? body : body && JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  return { close: () => server.close(), get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

test('a unit goes round: made ready, a draft, move-in, confirmed, move-out, made ready again, and the next tenant', async () => {
  await reset();
  const staff = await makeUser('Staff');
  const building = await create('building', { name: 'Tower' }, (await create('company', { name: 'ACE' })).id);
  const unit = await create('unit', { unit_no: '101' }, building.id);
  const other = await create('unit', { unit_no: '102' }, building.id);
  const today = todayHere();
  const api = await serve(staff);
  const state = async (bookingId) => api.get(`/units/${unit.id}/inspections${bookingId ? `?booking=${bookingId}` : ''}`);
  const card = async () => (await listUnits(building.id)).find((u) => u.id === unit.id);
  // A lease as the form sends it: its details, and the two documents it is not saved without.
  let phones = 0;
  const lease = (unitId, name, start, end, status = 'draft') => {
    const form = new FormData();
    form.append('booking', JSON.stringify({ unit_id: unitId, start_date: start, end_date: end, rent_amount: 4500, status, tenant: { full_name: name, phone: `+97150000000${(phones += 1)}` } }));
    for (const f of ['driver_license', 'proof_of_employment']) form.append(f, new Blob(['pdf'], { type: 'application/pdf' }), `${f}.pdf`);
    return api.post('/bookings', form);
  };

  try {
    // 1. The unit is empty and new: the make-ready comes first. Begun, it is not done until every job is.
    assert.deepEqual([(await state()).next, (await state()).list], [{ kind: 'make_ready' }, []]);
    const work = await api.post(`/units/${unit.id}/inspections`, { kind: 'make_ready', items: [{ area: 'Cleaning', condition: 'done' }, { area: 'Painting' }] });
    assert.deepEqual([work.status, work.complete, (await state()).next, (await card()).needs_make_ready], [200, false, { kind: 'make_ready' }, true]);
    assert.equal((await api.put(`/inspections/${work.id}`, { items: all(WORK, 'done') })).complete, true);
    assert.deepEqual([(await state()).next, (await card()).needs_make_ready], [null, false], 'ready, and waiting for a lease');

    // 2. Someone comes to see it and thinks it over: nothing is written down, and the unit still waits.
    assert.deepEqual([(await state()).lease, (await state()).list.length], [null, 1]);

    // 3. Sara takes the unit. The form cannot confirm a lease: it is a draft until her move-in inspection is done.
    const straight = await lease(unit.id, 'Sara', today, plus(today, 364), 'confirmed');
    assert.deepEqual([straight.status, straight.error], [409, 'Save the lease as a draft, do the move-in inspection, then confirm it.']);
    const sara = await lease(unit.id, 'Sara', today, plus(today, 364));
    assert.deepEqual([sara.status, sara.moved_in, sara.docs], ['draft', false, 2]);
    const tooSoon = await api.post(`/bookings/${sara.id}/confirm`);
    assert.deepEqual([tooSoon.status, tooSoon.error], [409, 'Do the move-in inspection first, then confirm the lease.']);
    assert.deepEqual([(await state()).lease.id, (await state()).next], [sara.id, { kind: 'move_in', late: false }]);

    // 4. The move-in, begun at the door and finished later, with a picture of the kitchen.
    const moveIn = await api.post(`/units/${unit.id}/inspections`, { kind: 'move_in', booking_id: sara.id, notes: 'Keys: 2', items: [{ area: 'Kitchen', condition: 'good' }, { area: 'Bedrooms' }, { area: 'Walls & paint' }] });
    assert.deepEqual([moveIn.status, moveIn.tenant, moveIn.ref, moveIn.complete, (await state()).next.kind], [200, 'Sara', sara.ref, false, 'move_in']);
    const photo = new FormData();
    photo.append('area', 'Kitchen');
    photo.append('photos', new Blob(['jpg'], { type: 'image/jpeg' }), 'kitchen.jpg');
    assert.equal((await api.post(`/inspections/${moveIn.id}/photos`, photo)).photos.length, 1);
    assert.equal((await api.post(`/units/${unit.id}/inspections`, { kind: 'move_in', booking_id: sara.id, items: all(INSPECT, 'good') })).status, 409, 'one move-in a lease');
    assert.equal((await api.post(`/bookings/${sara.id}/confirm`)).status, 409, 'begun is not done');
    const found = await api.put(`/inspections/${moveIn.id}`, { items: all(INSPECT, 'good') });
    assert.deepEqual([found.complete, found.photos.length, (await api.get(`/bookings/${sara.id}`)).moved_in, (await state()).next], [true, 1, true, { kind: 'confirm' }]);
    assert.equal((await api.post(`/bookings/${sara.id}/confirm`)).status, 'confirmed', 'inspected in, the lease is confirmed');

    // 5. Sara lives there: the only thing ahead is her move-out. The unit is not asked to be made ready.
    assert.deepEqual([(await state()).next, (await card()).needs_make_ready, (await card()).move_in_due], [{ kind: 'move_out', late: false }, false, false]);

    // 6. She leaves (early: the lease is ended today). The move-out sits beside her move-in, and the kitchen is damaged.
    assert.equal((await api.post(`/bookings/${sara.id}/end`, { end_date: today })).end_date, today);
    // Until she is inspected out the unit is not vacant: it shows as hers, and cannot be leased.
    await assert.rejects(createBooking({ unit_id: unit.id, start_date: plus(today, 1), end_date: plus(today, 365), rent_amount: 4500, status: 'confirmed', tenant: { full_name: 'Hasty' } }, staff),
      { message: `Unit 101 is not vacant: Sara's move-out inspection is not done (${sara.ref}). Do it first.` });
    const free = Object.values(await api.get(`/available?building_id=${building.id}&start=${plus(today, 1)}&end=${plus(today, 365)}`)).find((u) => u?.id === unit.id);
    assert.deepEqual([free.free, free.taken_by.tenant], [false, 'Sara']);
    assert.deepEqual([(await listUnits(building.id, plus(today, 1))).find((u) => u.id === unit.id)].map((u) => [u.current_tenant, u.move_out_due]), [['Sara', true]]);
    const moveOut = await api.post(`/units/${unit.id}/inspections`, { kind: 'move_out', booking_id: sara.id, items: [{ area: 'Kitchen', condition: 'damaged', note: 'Worktop burnt' }, ...all(INSPECT.slice(1), 'good')] });
    assert.deepEqual([moveOut.status, moveOut.complete, moveOut.tenant], [200, true, 'Sara']);
    const after = await state(sara.id);
    const kitchen = (kind) => after.list.find((i) => i.kind === kind && i.booking_id === sara.id).items[0].condition;
    assert.deepEqual([kitchen('move_in'), kitchen('move_out'), after.lease.moved_out], ['good', 'damaged', true]);

    // 7. Empty again: it has to be made ready before it is let.
    assert.deepEqual([(await state()).next, (await card()).needs_make_ready], [{ kind: 'make_ready' }, true]);
    const again = await api.post(`/units/${unit.id}/inspections`, { kind: 'make_ready', notes: 'Worktop replaced', items: all(WORK, 'done') });
    assert.deepEqual([again.complete, again.tenant, (await state()).next, (await card()).needs_make_ready], [true, null, null, false]);

    // 8. Omar is next, from tomorrow: drafted, inspected in today (any day will do), then confirmed.
    const omar = await lease(unit.id, 'Omar', plus(today, 1), plus(today, 365));
    assert.deepEqual([omar.status, (await state()).lease.id, (await state()).next], ['draft', omar.id, { kind: 'move_in', late: false }]);
    assert.equal((await api.post(`/units/${unit.id}/inspections`, { kind: 'move_in', booking_id: omar.id, items: all(INSPECT, 'good') })).complete, true);
    assert.deepEqual([(await state()).next, (await api.post(`/bookings/${omar.id}/confirm`)).status], [{ kind: 'confirm' }, 'confirmed']);

    // The unit's history is all of it, newest first, each inspection with its tenant.
    const end = await state();
    assert.deepEqual(end.next, { kind: 'move_out', late: false });
    assert.deepEqual(end.list.map((i) => [i.kind, i.tenant, i.complete]),
      [['move_in', 'Omar', true], ['make_ready', null, true], ['move_out', 'Sara', true], ['move_in', 'Sara', true], ['make_ready', null, true]]);
  } finally { api.close(); }
});
