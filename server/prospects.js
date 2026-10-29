import { Router } from 'express';
import { db } from './db.js';
import { bad, isDate, bookingRef, todayHere } from './leasing.js';
import { usPhone } from './usFormat.js';

// Prospects: people interested in a unit, before they are tenants (Rent Manager's Prospects).
// A prospect is a name and a way to reach them, what they want and when, and how far along
// they are. No tenant is made for one: Make lease opens the lease form filled in from it, and
// the lease saved from it is booking_id (linkProspect in leasing.js). "Leased" is never typed:
// a prospect is leased while that lease is there and not cancelled, so a draft deleted or a
// lease cancelled puts it back where it was.

export const STATUSES = [['new', 'New'], ['viewing', 'Viewing booked'], ['applied', 'Applied'], ['lost', 'Lost']];
const KEYS = STATUSES.map(([k]) => k);
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

const SELECT = `SELECT p.id, p.full_name, p.phone, p.email, p.building_id, p.unit_id, ${day('p.move_in_date')} AS move_in_date, p.source,
    p.status, p.lost_reason, p.notes, ${day('p.follow_up')} AS follow_up, p.booking_id, p.created_by, p.created_at,
    bl.name AS building, bl.company_id, u.unit_no, b.status AS lease_status, ${day('b.start_date')} AS lease_start
  FROM lease_prospects p
  LEFT JOIN prop_buildings bl ON bl.id = p.building_id
  LEFT JOIN prop_units u ON u.id = p.unit_id
  LEFT JOIN lease_bookings b ON b.id = p.booking_id`;
const shape = ({ lease_status, lease_start, ...p }, today) => {
  const leased = !!p.booking_id && lease_status !== 'cancelled';
  return { ...p, leased, lease_ref: leased ? bookingRef({ id: p.booking_id, start_date: lease_start }) : null,
    due: !leased && p.status !== 'lost' && !!p.follow_up && p.follow_up <= today };
};

async function getProspect(id, today = todayHere()) {
  const p = await db.prepare(`${SELECT} WHERE p.id = ?`).get(Number(id) || 0);
  if (!p) throw bad('Prospect not found', 404);
  return shape(p, today);
}

/** The fields sent, checked against what the prospect has now (`was`; none for a new one). */
async function fields(body = {}, was = null) {
  const out = {};
  for (const f of ['full_name', 'phone', 'email', 'source', 'lost_reason']) if (f in body) out[f] = text(body[f]);
  if ('notes' in body) out.notes = text(body.notes, 4000);
  if (out.phone) out.phone = usPhone(out.phone);
  for (const [f, name] of [['move_in_date', 'The move-in date'], ['follow_up', 'The follow-up date']]) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (v && !isDate(v)) throw bad(`${name} is not a date.`);
    out[f] = v || null;
  }
  if ('status' in body) {
    if (!KEYS.includes(body.status)) throw bad(`Unknown status: ${body.status}`);
    out.status = body.status;
  }
  // The unit says the building; a building alone is fine, and a building changed drops a unit not in it.
  if ('unit_id' in body || 'building_id' in body) {
    const unitId = 'unit_id' in body ? Number(body.unit_id) || null : was?.unit_id ?? null;
    const buildingId = 'building_id' in body ? Number(body.building_id) || null : null;
    if (unitId) {
      const u = await db.prepare('SELECT building_id FROM prop_units WHERE id = ?').get(unitId);
      if (!u) throw bad('Unit not found', 404);
      if (buildingId && buildingId !== u.building_id) {
        if ('unit_id' in body) throw bad('That unit is not in that building.');
        Object.assign(out, { unit_id: null, building_id: buildingId });
      } else Object.assign(out, { unit_id: unitId, building_id: u.building_id });
    } else Object.assign(out, { unit_id: null, building_id: buildingId ?? ('building_id' in body ? null : was?.building_id ?? null) });
  }

  const now = { ...was, ...out };
  if (!now.full_name) throw bad("Give the prospect's name.");
  if (!now.phone && !now.email) throw bad('Give a phone number or an email.');
  if ((now.status || 'new') === 'lost' && !now.lost_reason) throw bad('Say why the prospect was lost.');
  if (now.status && now.status !== 'lost' && now.lost_reason) out.lost_reason = null;
  return out;
}

/** Prospects: the ones to follow up today first, then by follow-up day, then newest. `q` matches name, phone, email, notes. */
export async function listProspects({ q, status } = {}, today = todayHere()) {
  const where = [];
  const args = [];
  if (KEYS.includes(status)) { where.push('p.status = ?'); args.push(status); }
  const words = String(q ?? '').trim().toLowerCase();
  if (words) { where.push(`lower(concat_ws(' ', p.full_name, p.phone, p.email, p.notes)) LIKE ?`); args.push(`%${words}%`); }
  const rows = (await db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC`).all(...args)).map((p) => shape(p, today));
  const at = (p) => p.follow_up || '9999-12-31';
  return rows.sort((a, b) => Number(b.due) - Number(a.due) || at(a).localeCompare(at(b)));
}

export async function addProspect(body, by, today = todayHere()) {
  const row = { ...(await fields(body)), created_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_prospects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  return getProspect(id, today);
}

export async function updateProspect(id, body, today = todayHere()) {
  const was = await db.prepare('SELECT * FROM lease_prospects WHERE id = ?').get(Number(id) || 0);
  if (!was) throw bad('Prospect not found', 404);
  const row = await fields(body, was);
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE lease_prospects SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), was.id);
  return getProspect(was.id, today);
}

/** The prospect goes; a lease made from it stays. */
export async function removeProspect(id) {
  const r = await db.prepare('DELETE FROM lease_prospects WHERE id = ?').run(Number(id) || 0);
  if (!r.changes) throw bad('Prospect not found', 404);
  return { ok: true };
}

// ---------- routes ----------

export const prospectRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

prospectRoutes.get('/prospects', wrap(async (req, res) => res.json(await listProspects(req.query))));
prospectRoutes.post('/prospects', wrap(async (req, res) => res.json(await addProspect(req.body, req.user.id))));
prospectRoutes.put('/prospects/:id', wrap(async (req, res) => res.json(await updateProspect(req.params.id, req.body))));
prospectRoutes.delete('/prospects/:id', wrap(async (req, res) => res.json(await removeProspect(req.params.id))));
