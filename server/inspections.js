import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile } from './properties.js';
import { bad, isDate, bookingRef, todayHere, getBooking, confirmBooking } from './leasing.js';

// A unit's condition over time. Three things are written down, each as a list of areas with
// photos: the make-ready (the work done on the empty unit before it is let), the move-in inspection
// (how the tenant found it) and the move-out inspection (how they left it). Nothing is ever
// replaced: every lease adds its own, so the unit's page is its whole history, and any two
// of them can be set side by side.
//
// They come in that order, lease after lease: the make-ready while the unit is empty, the
// move-in of the lease's draft, the move-out when the tenant leaves, and the make-ready again.
// A lease made on the form is confirmed only once its move-in inspection is done (a renewal is
// not asked: the tenant is already in; Riley confirms without one), and the unit
// is not vacant again until the move-out inspection (HELD, server/properties.js).
// A move-in or move-out can be saved part done and finished later (`complete` says which).

export const KINDS = { make_ready: ['done', 'pending'], move_in: ['good', 'fair', 'damaged'], move_out: ['good', 'fair', 'damaged'] };
const NAME = { make_ready: 'make-ready', move_in: 'move-in inspection', move_out: 'move-out inspection' };
const PICTURE = /^image\/(png|jpe?g|webp|gif)$/;
const PHOTO_DIR = `${DATA_DIR}/properties/inspections`;
const MAX_AREAS = 40;
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

const SELECT = `SELECT i.id, i.unit_id, i.booking_id, i.kind, to_char(i.inspected_on, 'YYYY-MM-DD') AS date, i.tenant, i.notes, i.items, i.complete,
    i.created_at, w.name AS done_by, to_char(b.start_date, 'YYYY-MM-DD') AS start_date
  FROM prop_inspections i
  LEFT JOIN users w ON w.id = i.created_by
  LEFT JOIN lease_bookings b ON b.id = i.booking_id`;
const shape = ({ start_date, items, ...i }, photos = []) => ({ ...i, ref: i.booking_id ? bookingRef({ id: i.booking_id, start_date }) : null,
  items: JSON.parse(items || '[]'), photos: photos.filter((p) => p.inspection_id === i.id).map(({ inspection_id, ...p }) => p) });

export async function getInspection(id) {
  const i = await db.prepare(`${SELECT} WHERE i.id = ?`).get(Number(id) || 0);
  if (!i) throw bad('That inspection was not found.', 404);
  return shape(i, await db.prepare('SELECT id, inspection_id, area FROM prop_inspection_photos WHERE inspection_id = ? ORDER BY id').all(i.id));
}

const mustBeUnit = async (id) => {
  const u = await db.prepare(`SELECT u.id, u.unit_no, u.type, u.floor, bl.id AS building_id, bl.name AS building
    FROM prop_units u JOIN prop_buildings bl ON bl.id = u.building_id WHERE u.id = ?`).get(Number(id) || 0);
  if (!u) throw bad('Unit not found', 404);
  return u;
};

/** The areas as sent, each with a rating this kind allows. Unrated work in a make-ready is pending; an unrated area of an inspection is still to be looked at. */
function areas(kind, list) {
  if (!Array.isArray(list) || !list.length) throw bad('Add at least one area.');
  if (list.length > MAX_AREAS) throw bad(`An inspection can have ${MAX_AREAS} areas.`);
  const seen = new Set();
  return list.map((it) => {
    const area = text(it?.area, 60);
    if (!area) throw bad('Every area needs a name.');
    if (seen.has(area.toLowerCase())) throw bad(`${area} is on the list twice.`);
    seen.add(area.toLowerCase());
    const condition = KINDS[kind].includes(it.condition) ? it.condition : kind === 'make_ready' ? 'pending' : null;
    return { area, condition, note: text(it.note, 500) };
  });
}

function fields(kind, body, today) {
  const date = String(body.date ?? '').trim() || today;
  if (!isDate(date)) throw bad('The date is not a date.');
  if (date > today) throw bad('The date cannot be in the future.');
  const items = areas(kind, body.items);
  return { inspected_on: date, notes: text(body.notes, 2000), items: JSON.stringify(items), complete: items.every((it) => it.condition && it.condition !== 'pending') };
}

/**
 * Write down a unit's condition. With `booking_id` it is that lease's inspection (one move-in
 * and one move-out each); a make-ready belongs to the unit alone.
 */
export async function addInspection(unitId, body = {}, by, today = todayHere()) {
  const unit = await mustBeUnit(unitId);
  const kind = body.kind;
  if (!KINDS[kind]) throw bad('An inspection is a make-ready, a move-in or a move-out.');
  const row = { ...fields(kind, body, today), unit_id: unit.id, kind, created_by: by ?? null };
  if (body.booking_id && kind !== 'make_ready') {
    const b = await getBooking(body.booking_id);
    if (b.unit_id !== unit.id) throw bad('That lease is for another unit.');
    if (await db.prepare('SELECT 1 FROM prop_inspections WHERE booking_id = ? AND kind = ?').get(b.id, kind)) throw bad(`${b.ref} already has its ${NAME[kind]}. Open it to change it.`, 409);
    if (b.status === 'cancelled') throw bad('That lease is cancelled.', 409);
    if (kind === 'move_out' && b.status !== 'confirmed') throw bad('A move-out inspection is for a confirmed lease.', 409);
    row.booking_id = b.id;
    row.tenant = b.tenant;
  }
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO prop_inspections (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
  return getInspection(id);
}

/** Change its date, notes or areas. Photos of an area that is taken off, or renamed, go with it. */
export async function updateInspection(id, body = {}, today = todayHere()) {
  const now = await getInspection(id);
  const row = fields(now.kind, { date: now.date, notes: now.notes, items: now.items, ...body }, today);
  await db.prepare('UPDATE prop_inspections SET inspected_on = ?, notes = ?, items = ?, complete = ? WHERE id = ?').run(row.inspected_on, row.notes, row.items, row.complete, now.id);
  const kept = new Set(JSON.parse(row.items).map((it) => it.area));
  for (const p of now.photos.filter((p) => !kept.has(p.area))) await removeInspectionPhoto(p.id);
  return getInspection(id);
}

export async function removeInspection(id) {
  const files = await db.prepare('SELECT file_path FROM prop_inspection_photos WHERE inspection_id = ?').all(Number(id) || 0);
  const r = await db.prepare('DELETE FROM prop_inspections WHERE id = ?').run(Number(id) || 0);
  if (!r.changes) throw bad('That inspection was not found.', 404);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}

/** Add pictures under one of its areas: as many as are sent. */
export async function addInspectionPhotos(id, area, files) {
  const i = await getInspection(id);
  const at = i.items.find((it) => it.area === String(area ?? '').trim());
  if (!at) throw bad('That area is not on this inspection.');
  if (!files?.length) throw bad('Choose a picture.');
  for (const f of files) if (!PICTURE.test(f.mimetype || '')) throw bad(`${f.originalname} is not a picture.`);
  for (const file of files) {
    const f = saveFile(file, PHOTO_DIR);
    await db.prepare('INSERT INTO prop_inspection_photos (inspection_id, area, file_path, file_mime) VALUES (?, ?, ?, ?)').run(i.id, at.area, f.file_path, f.file_mime);
  }
  return getInspection(id);
}

export const getInspectionPhoto = async (id) => {
  const p = await db.prepare('SELECT id, file_path, file_mime FROM prop_inspection_photos WHERE id = ?').get(Number(id) || 0);
  if (!p) throw bad('Not found', 404);
  return p;
};

export async function removeInspectionPhoto(id) {
  const p = await getInspectionPhoto(id);
  await db.prepare('DELETE FROM prop_inspection_photos WHERE id = ?').run(p.id);
  rmSync(p.file_path, { force: true });
  return { ok: true };
}

/**
 * Whether the unit has to be made ready before it is let again: its last tenant has moved
 * out, or a make-ready was begun, and no finished make-ready or move-in has come since.
 */
export const needsMakeReady = (list) => {
  const last = list[0]; // newest first
  return !!last && (last.kind === 'move_out' ? last.complete : last.kind === 'make_ready' && !last.complete);
};

/**
 * What comes next for the unit, given the lease it is about. An empty unit is made ready first
 * (nothing is next once that is done, until a lease comes); then the lease's move-in, then a
 * draft is confirmed (`confirm`), then the move-out. `late` once the day it was due has gone by.
 * A lease for a unit not made ready: the make-ready is still first, and the move-in can be
 * done as well (`also`); once its first day has gone, it is too late for one.
 * A renewal has no move-in: the tenant is already in.
 */
export function nextStep(list, lease, today = todayHere()) {
  const last = list.find((i) => i.kind !== 'move_in'); // newest first; a move-in begun since does not undo the make-ready
  const ready = last?.kind === 'make_ready' && last.complete;
  if (!lease || lease.status === 'cancelled' || lease.moved_out) return ready ? null : { kind: 'make_ready' };
  if (!lease.moved_in && !lease.renewed_from) {
    if (!ready && today <= lease.start_date) return { kind: 'make_ready', also: 'move_in' };
    return { kind: 'move_in', late: today > lease.start_date };
  }
  return lease.status === 'draft' ? { kind: 'confirm' } : { kind: 'move_out', late: today > lease.end_date };
}

/**
 * The lease a unit's page is about when it is not opened from one: the tenant who is in; else
 * the confirmed lease to come; else a draft waiting for its move-in; else the one that last ended.
 */
async function leaseOf(unitId, today) {
  const one = async (where, order) => (await db.prepare(`SELECT id FROM lease_bookings WHERE unit_id = ? AND ${where} ORDER BY ${order} LIMIT 1`).get(unitId, today))?.id;
  const last = await one("status = 'confirmed' AND start_date <= ?", 'start_date DESC, id DESC');
  if (last && !(await getBooking(last)).moved_out) return last;
  return (await one("status = 'confirmed' AND start_date > ?", 'start_date, id')) || (await one("status = 'draft' AND end_date >= ?", 'start_date, id')) || last;
}

/**
 * One unit's whole history, newest first, and what comes next. `bookingId` is the lease it was
 * opened from; without one it is the unit's own (leaseOf).
 */
export async function unitInspections(unitId, bookingId, today = todayHere()) {
  const unit = await mustBeUnit(unitId);
  const leaseId = Number(bookingId) || await leaseOf(unit.id, today);
  const lease = leaseId ? await getBooking(leaseId) : null;
  if (lease && lease.unit_id !== unit.id) throw bad('That lease is for another unit.');
  const photos = await db.prepare(`SELECT p.id, p.inspection_id, p.area FROM prop_inspection_photos p
    JOIN prop_inspections i ON i.id = p.inspection_id WHERE i.unit_id = ? ORDER BY p.id`).all(unit.id);
  const list = (await db.prepare(`${SELECT} WHERE i.unit_id = ? ORDER BY i.inspected_on DESC, i.id DESC`).all(unit.id)).map((i) => shape(i, photos));
  return { unit, lease, next: nextStep(list, lease, today), needs_make_ready: needsMakeReady(list), list };
}

/** A draft made on the form is confirmed once its move-in inspection is done; a renewal is not asked. */
export async function confirmInspected(id, by) {
  const b = await getBooking(id);
  if (b.status === 'draft' && !b.renewed_from && !b.moved_in) throw bad('Do the move-in inspection first, then confirm the lease.', 409);
  return confirmBooking(id, by);
}

export const inspectionRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_PHOTOS = 10; // in one go; more can be added after
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: MAX_PHOTOS } });

inspectionRoutes.get('/units/:id/inspections', wrap(async (req, res) => res.json(await unitInspections(req.params.id, req.query.booking))));
inspectionRoutes.post('/units/:id/inspections', wrap(async (req, res) => res.json(await addInspection(req.params.id, req.body, req.user.id))));
inspectionRoutes.put('/inspections/:id', wrap(async (req, res) => res.json(await updateInspection(req.params.id, req.body))));
inspectionRoutes.delete('/inspections/:id', wrap(async (req, res) => res.json(await removeInspection(req.params.id))));
inspectionRoutes.post('/inspections/:id/photos', upload.array('photos', MAX_PHOTOS), wrap(async (req, res) => res.json(await addInspectionPhotos(req.params.id, req.body?.area, req.files))));
inspectionRoutes.delete('/inspection-photos/:id', wrap(async (req, res) => res.json(await removeInspectionPhoto(req.params.id))));
// Ahead of the plain confirm in leasing.js: the form's Confirm goes through the inspection.
inspectionRoutes.post('/bookings/:id/confirm', wrap(async (req, res) => res.json(await confirmInspected(req.params.id, req.user.id))));
inspectionRoutes.get('/inspection-photos/:id', wrap(async (req, res) => {
  const p = await getInspectionPhoto(req.params.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // a photo never changes; a new one has a new address
  res.type(p.file_mime).sendFile(p.file_path);
}));
