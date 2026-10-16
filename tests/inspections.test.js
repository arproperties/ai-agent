import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, closeDb, makeUser } from './helpers/db.js';
import { create, remove, listUnits } from '../server/properties.js';
import { createBooking, getBooking, renewBooking, changeEnd, updateBooking } from '../server/leasing.js';
import { addInspection, updateInspection, removeInspection, unitInspections, addInspectionPhotos, getInspectionPhoto, removeInspectionPhoto, confirmInspected } from '../server/inspections.js';

test.after(() => closeDb());

const AT = '2026-10-25';
const rated = (condition = 'good') => [{ area: 'Kitchen', condition }, { area: 'Walls & paint', condition: 'good', note: 'Fresh coat' }];
const picture = (name = 'kitchen.jpg') => ({ originalname: name, mimetype: 'image/jpeg', buffer: Buffer.from('jpg') });

// Unit 101 of Tower, with Sara's lease as a draft and Omar's confirmed one after it.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, b.id);
  const u2 = await create('unit', { unit_no: '102' }, b.id);
  const draft = await createBooking({ unit_id: u1.id, start_date: '2026-11-01', end_date: '2027-10-31', rent_amount: 4500, tenant: { full_name: 'Sara' } }, staff);
  return { staff, b, u1, u2, draft };
}

test('a lease made on the form is confirmed only after its move-in inspection, done on any day and finished later; a renewal is not asked', async () => {
  const { staff, u1, draft } = await tower();
  await assert.rejects(confirmInspected(draft.id, staff), /Do the move-in inspection first/);
  assert.equal((await getBooking(draft.id)).status, 'draft');

  // Begun a week before the lease starts, with the kitchen still to look at: saved, and not yet done.
  const moveIn = (items) => addInspection(u1.id, { kind: 'move_in', booking_id: draft.id, items, notes: 'Keys: 2' }, staff, AT);
  const begun = await moveIn([{ area: 'Kitchen' }, { area: 'Walls & paint', condition: 'good' }]);
  assert.deepEqual([begun.kind, begun.date, begun.tenant, begun.ref, begun.done_by, begun.complete, begun.items[0].condition], ['move_in', AT, 'Sara', draft.ref, 'Staff', false, null]);
  assert.equal((await getBooking(draft.id)).moved_in, false);
  await assert.rejects(confirmInspected(draft.id, staff), /Do the move-in inspection first/, 'begun is not done');
  await assert.rejects(moveIn(rated()), /already has its move-in inspection/);
  assert.equal((await updateInspection(begun.id, { items: rated() }, AT)).complete, true);
  assert.equal((await getBooking(draft.id)).moved_in, true);
  const live = await confirmInspected(draft.id, staff);
  assert.equal(live.status, 'confirmed');

  // A renewal has no move-in: the tenant is already in.
  const renewal = await renewBooking(live.id, staff);
  assert.deepEqual((await unitInspections(u1.id, renewal.id, AT)).next, { kind: 'confirm' });
  const next = await confirmInspected(renewal.id, staff);
  assert.deepEqual([next.status, (await unitInspections(u1.id, next.id, next.start_date)).next], ['confirmed', { kind: 'move_out', late: false }]);
});

test('a lease made for the same tenant and unit the day after their stay ends follows on from it: no move-out, no move-in', async () => {
  const { staff, u1, draft } = await tower();
  const staffDone = (id) => addInspection(u1.id, { kind: 'move_in', booking_id: id, items: rated() }, staff, AT);
  // An Airbnb stay, moved in and confirmed, then ended early on 15 Nov.
  await staffDone(draft.id);
  const stay = await confirmInspected(draft.id, staff);
  await changeEnd(stay.id, '2026-11-15', staff);
  const lease = (extra) => ({ unit_id: u1.id, tenant_id: stay.tenant_id, start_date: '2026-11-16', end_date: '2027-11-15', rent_amount: 1100, ...extra });

  // Someone else cannot have it the next day: the unit is not vacant until Sara is inspected out.
  await assert.rejects(createBooking(lease({ tenant_id: undefined, tenant: { full_name: 'Omar' }, status: 'confirmed' }), staff), /not vacant/);
  // A gap of a few days is a new tenancy: not linked, and still blocked.
  const later = await createBooking(lease({ start_date: '2026-11-20' }), staff);
  assert.equal(later.renewed_from, null);

  // Sara herself the next day: confirmed straight away, already in.
  const on = await createBooking(lease({ status: 'confirmed' }), staff);
  assert.deepEqual([on.status, on.renewed_from], ['confirmed', stay.id]);
  assert.deepEqual((await unitInspections(u1.id, on.id, '2026-11-16')).next, { kind: 'move_out', late: false });
  await assert.rejects(renewBooking(stay.id, staff), /already has a renewal/);
});

test('the link is made too when the stay is ended early after the lease draft, or the draft is moved to the next day', async () => {
  const { staff, u1, draft } = await tower();
  await addInspection(u1.id, { kind: 'move_in', booking_id: draft.id, items: rated() }, staff, AT);
  const stay = await confirmInspected(draft.id, staff);
  const base = { unit_id: u1.id, tenant_id: stay.tenant_id, end_date: '2028-10-31', rent_amount: 1100 };

  // The draft first, starting 1 Dec; then the stay is ended on 30 Nov.
  const a = await createBooking({ ...base, start_date: '2026-12-01' }, staff);
  assert.equal(a.renewed_from, null);
  await changeEnd(stay.id, '2026-11-30', staff);
  assert.equal((await getBooking(a.id)).renewed_from, stay.id);
  assert.deepEqual((await unitInspections(u1.id, a.id, AT)).next, { kind: 'confirm' });
  assert.equal((await confirmInspected(a.id, staff)).status, 'confirmed');

  // A draft a day late, moved back to the day after: linked then.
  const { staff: by, u1: u, draft: d } = await tower();
  await addInspection(u.id, { kind: 'move_in', booking_id: d.id, items: rated() }, by, AT);
  const s = await confirmInspected(d.id, by);
  const b = await createBooking({ ...base, unit_id: u.id, tenant_id: s.tenant_id, start_date: '2027-11-02' }, by);
  assert.equal(b.renewed_from, null);
  assert.equal((await updateBooking(b.id, { start_date: '2027-11-01' }, by)).renewed_from, s.id);
});

test('what is written down is checked: a kind, a date not ahead, every area named once and rated', async () => {
  const { staff, u1, u2, draft } = await tower();
  const add = (body) => addInspection(u1.id, { kind: 'move_in', items: rated(), ...body }, staff, AT);
  await assert.rejects(add({ kind: 'visit' }), /make-ready, a move-in or a move-out/);
  await assert.rejects(add({ date: '2026-10-26' }), /cannot be in the future/);
  await assert.rejects(add({ items: [] }), /at least one area/);
  assert.deepEqual((await add({ items: [{ area: 'Kitchen', condition: 'done' }] })).items, [{ area: 'Kitchen', condition: null, note: null }], 'done is a make-ready word');
  await assert.rejects(add({ items: [{ area: 'Kitchen', condition: 'good' }, { area: 'kitchen', condition: 'fair' }] }), /on the list twice/);
  await assert.rejects(addInspection(u2.id, { kind: 'move_in', booking_id: draft.id, items: rated() }, staff, AT), /for another unit/);
  await assert.rejects(add({ kind: 'move_out', booking_id: draft.id }), /for a confirmed lease/);
  await assert.rejects(addInspection(999, { kind: 'move_in', items: rated() }, staff, AT), /Unit not found/);
});

test('a unit keeps every inspection, newest first, and says what comes next: the make-ready, the move-in, then the move-out', async () => {
  const { staff, b, u1, u2, draft } = await tower();
  const T = '2026-11-25';
  const unit = async () => (await listUnits(b.id, T)).find((u) => u.id === u1.id);
  const next = async (today = T) => (await unitInspections(u1.id, null, today)).next;
  assert.deepEqual([(await unitInspections(u1.id)).list, (await unit()).needs_make_ready, (await unitInspections(u2.id)).next], [[], false, { kind: 'make_ready' }], 'an empty unit is made ready first');

  // A draft waits on a unit not made ready: the make-ready is still first, the move-in can be done as well.
  assert.deepEqual([await next(AT), await next('2026-11-01'), await next()], [{ kind: 'make_ready', also: 'move_in' }, { kind: 'make_ready', also: 'move_in' }, { kind: 'move_in', late: true }]);
  const first = await addInspection(u1.id, { kind: 'make_ready', date: '2026-10-20', items: [{ area: 'Cleaning', condition: 'done' }] }, staff, AT);
  assert.deepEqual([first.complete, await next(AT)], [true, { kind: 'move_in', late: false }]);

  // The move-in, then the lease is confirmed, then there is only the move-out ahead.
  await addInspection(u1.id, { kind: 'move_in', booking_id: draft.id, items: rated() }, staff, AT);
  assert.deepEqual(await next(AT), { kind: 'confirm' });
  await confirmInspected(draft.id, staff);
  assert.deepEqual([await next(AT), await next(), await next('2027-11-01'), (await unit()).move_in_due], [{ kind: 'move_out', late: false }, { kind: 'move_out', late: false }, { kind: 'move_out', late: true }, false]);
  const out = await addInspection(u1.id, { kind: 'move_out', booking_id: draft.id, date: '2026-11-20', items: rated('damaged') }, staff, T);
  assert.equal((await getBooking(draft.id)).moved_out, true);
  assert.deepEqual([(await unit()).needs_make_ready, await next()], [true, { kind: 'make_ready' }], 'the tenant has left');

  // Work begun but not finished still needs doing; unrated work is pending.
  const work = await addInspection(u1.id, { kind: 'make_ready', date: '2026-11-22', items: [{ area: 'Cleaning', condition: 'done' }, { area: 'Painting' }] }, staff, T);
  assert.deepEqual([work.complete, work.items[1].condition, work.tenant, work.ref], [false, 'pending', null, null]);
  assert.equal((await unitInspections(u1.id)).needs_make_ready, true);
  const done = await updateInspection(work.id, { items: [{ area: 'Cleaning', condition: 'done' }, { area: 'Painting', condition: 'done' }] }, T);
  assert.equal(done.complete, true);

  const h = await unitInspections(u1.id, null, T);
  assert.deepEqual([h.unit.unit_no, h.unit.building, h.needs_make_ready, h.next], ['101', 'Tower', false, null]);
  assert.deepEqual(h.list.map((i) => [i.kind, i.date]), [['make_ready', '2026-11-22'], ['move_out', '2026-11-20'], ['move_in', AT], ['make_ready', '2026-10-20']]);
  assert.equal(h.list[1].id, out.id);
});

test('photos sit under an area, and go with the area, the inspection or the unit', async () => {
  const { staff, u1, u2 } = await tower();
  const i = await addInspection(u1.id, { kind: 'move_in', items: rated() }, staff, AT);
  await assert.rejects(addInspectionPhotos(i.id, 'Garage', [picture()]), /not on this inspection/);
  await assert.rejects(addInspectionPhotos(i.id, 'Kitchen', [{ ...picture('lease.pdf'), mimetype: 'application/pdf' }]), /lease\.pdf is not a picture/);
  const withPhotos = await addInspectionPhotos(i.id, 'Kitchen', [picture(), picture('sink.jpg')]);
  await addInspectionPhotos(i.id, 'Walls & paint', [picture('wall.jpg')]);
  assert.deepEqual(withPhotos.photos.map((p) => p.area), ['Kitchen', 'Kitchen']);
  const paths = await Promise.all((await unitInspections(u1.id)).list[0].photos.map(async (p) => (await getInspectionPhoto(p.id)).file_path));
  assert.deepEqual(paths.map((p) => existsSync(p)), [true, true, true]);

  await removeInspectionPhoto(withPhotos.photos[0].id);
  assert.equal(existsSync(paths[0]), false);
  // The kitchen comes off the list: its last photo goes with it, the wall's stays.
  const less = await updateInspection(i.id, { items: [{ area: 'Walls & paint', condition: 'fair' }] }, AT);
  assert.deepEqual([less.photos.map((p) => p.area), existsSync(paths[1]), existsSync(paths[2])], [['Walls & paint'], false, true]);
  await removeInspection(i.id);
  assert.equal(existsSync(paths[2]), false);
  await assert.rejects(removeInspection(i.id), /was not found/);

  const j = await addInspection(u2.id, { kind: 'make_ready', items: [{ area: 'Cleaning', condition: 'done' }] }, staff, AT);
  const [kept] = (await addInspectionPhotos(j.id, 'Cleaning', [picture()])).photos;
  const { file_path } = await getInspectionPhoto(kept.id);
  await remove('unit', u2.id);
  assert.equal(existsSync(file_path), false, 'a deleted unit takes its inspection photos');
});
