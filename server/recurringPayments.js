import { Router } from 'express';
import { db } from './db.js';
import { keptBuildings } from './inventory.js';

// Recurring payments: money that should come in every month from something in a building -
// a shop's rent in the camp, the washing machine in Ayla.
//
// An entry is made once: a title, the building, the shop or unit or whatever it is (typed,
// not picked), the amount, and the day of the month. From then on a line for that month is
// created on that day, pending, and somebody marks it paid when the money is in. It is a
// list to chase, nothing more: no invoice, nothing posted to the accounts.
//
// A building is one real saifsys building, the same as in the inventory, and the same
// people see it: the master every building, an administrator the saifsys buildings ticked
// on the entries they run. Reem keeps all of it; the saifsys Recurring Payments screens
// only show it, through the door in server/fromSaifsys.js.

const MAX_TITLE = 120;
const MAX_UNIT = 80;
const MAX_NOTES = 500;
const MAX_AMOUNT = 100_000_000;
const NOW = 'extract(epoch from now())::bigint';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------- days and months ----------

// Asia/Dubai, no daylight saving: "today" is the office's day, not the server's (UTC).
const OFFSET = 4 * 3600;
export const today = () => new Date(Date.now() + OFFSET * 1000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
/** The day a month's line is created. The 29th to the 31st in a shorter month is its last day. */
export const dueDate = (month, day) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
};

// ---------- the creator ----------

const insertDue = (entry, month) => db.prepare(`INSERT INTO recurring_payment_dues (payment_id, month, due_date, amount)
  VALUES (?, ?, ?, ?) ON CONFLICT (payment_id, month) DO NOTHING RETURNING id`).run(entry.id, month, dueDate(month, entry.day), entry.amount);

/**
 * Create every line whose day has come and that is not there yet: for each active entry
 * that creates its own, each month from its first one up to today. So a month missed
 * while the server was down is made on the next run, and running it twice makes nothing
 * new. Returns how many lines it made. entryId: only that entry.
 */
export async function createDuePayments(now = today(), entryId = null) {
  const entries = await db.prepare(`SELECT id, amount, day, first_month FROM recurring_payments
    WHERE active AND auto_create AND (?::int IS NULL OR id = ?::int)`).all(entryId, entryId);
  let made = 0;
  for (const e of entries) {
    for (let month = e.first_month; month <= now.slice(0, 7) && dueDate(month, e.day) <= now; month = nextMonth(month)) {
      if ((await insertDue(e, month)).changes) made += 1;
    }
  }
  return made;
}

// ---------- reading ----------

const kept = async (user) => (await keptBuildings(user)).map((b) => ({ id: b.id, name: b.name }));

const ENTRY = `SELECT p.*, (SELECT count(*)::int FROM recurring_payment_dues d WHERE d.payment_id = p.id) AS payments,
    EXISTS (SELECT 1 FROM recurring_payment_dues d WHERE d.payment_id = p.id AND d.month = ?) AS has_this_month
  FROM recurring_payments p`;
const DUE = `SELECT d.id, d.payment_id, d.month, d.due_date, d.amount, d.status, d.paid_at, u.name AS paid_by,
    p.title, p.unit, p.site_id, p.site_name
  FROM recurring_payment_dues d JOIN recurring_payments p ON p.id = d.payment_id LEFT JOIN users u ON u.id = d.paid_by`;

const shapeEntry = (p) => ({
  id: p.id, title: p.title, building: { id: p.site_id, name: p.site_name }, unit: p.unit, amount: p.amount, day: p.day,
  auto_create: p.auto_create, first_month: p.first_month, active: p.active, notes: p.notes,
  payments: p.payments, has_this_month: p.has_this_month,
});
const shapeDue = (d) => ({
  id: d.id, entry_id: d.payment_id, month: d.month, title: d.title, building: { id: d.site_id, name: d.site_name }, unit: d.unit,
  due_date: d.due_date, amount: d.amount, status: d.status, paid_at: d.paid_at, paid_by: d.paid_by,
});

/** The entry, if it is in a building this person keeps. */
async function entryOf(user, id, now = today()) {
  const p = await db.prepare(`${ENTRY} WHERE p.id = ?`).get(now.slice(0, 7), Number(id) || 0);
  return p && (await kept(user)).some((b) => b.id === p.site_id) ? p : null;
}

/** Every entry in the buildings this person keeps, and those buildings to pick from. */
export async function listEntries(user, now = today()) {
  const buildings = await kept(user);
  const rows = await db.prepare(`${ENTRY} WHERE p.site_id = ANY(?::int[]) ORDER BY lower(p.site_name), lower(p.title), p.id`)
    .all(now.slice(0, 7), buildings.map((b) => b.id));
  return { month: now.slice(0, 7), buildings, entries: rows.map(shapeEntry) };
}

/**
 * One month's lines in this person's buildings, with what is still pending and what has
 * been paid. The totals are the month's (and the building's and the shop or unit's, when
 * one is picked), whatever status is being looked at. No month said = this month.
 * units: every shop or unit typed on an entry of the buildings looked at, to pick from.
 */
export async function listDues(user, query = {}, now = today()) {
  const buildings = await kept(user);
  const month = MONTH.test(query.month || '') ? query.month : now.slice(0, 7);
  const one = Number(query.building) || 0;
  const ids = buildings.map((b) => b.id).filter((id) => !one || id === one);
  const unit = line(query.unit, MAX_UNIT).toLowerCase();
  const units = (await db.prepare(`SELECT min(unit) AS unit FROM recurring_payments WHERE site_id = ANY(?::int[]) AND unit IS NOT NULL
    GROUP BY lower(unit) ORDER BY lower(unit)`).all(ids)).map((r) => r.unit);
  const rows = (await db.prepare(`${DUE} WHERE d.month = ? AND p.site_id = ANY(?::int[]) ORDER BY d.due_date, lower(p.title), d.id`).all(month, ids))
    .map(shapeDue).filter((d) => !unit || (d.unit || '').toLowerCase() === unit);
  const of = (status) => rows.filter((d) => d.status === status);
  const sum = (list) => Math.round(list.reduce((t, d) => t + d.amount, 0) * 100) / 100;
  return {
    month,
    buildings,
    units,
    dues: ['pending', 'paid'].includes(query.status) ? of(query.status) : rows,
    totals: { pending: sum(of('pending')), paid: sum(of('paid')), pending_count: of('pending').length, paid_count: of('paid').length },
  };
}

// ---------- writing ----------

/** What was typed about one entry, checked. */
async function readEntry(user, input, now) {
  const title = line(input?.title, MAX_TITLE);
  if (!title) throw bad('Give the entry a title, like Washing machine rent');
  const building = (await kept(user)).find((b) => b.id === Number(input.building_id));
  if (!building) throw bad('Pick the building from the list');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('The amount must be a number more than 0');
  const day = Number(input.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw bad('The day of the month is a number from 1 to 31');
  const first = String(input.first_month ?? '').trim() || now.slice(0, 7);
  if (!MONTH.test(first)) throw bad('Pick the first month');
  // A typo in the year must not create years of payments nobody is owed.
  if (first < `${Number(now.slice(0, 4)) - 3}${now.slice(4, 7)}`) throw bad('The first month cannot be more than three years back');
  return {
    title, site_id: building.id, site_name: building.name, unit: line(input.unit, MAX_UNIT) || null, amount, day,
    auto_create: input.auto_create === undefined ? true : !!input.auto_create,
    first_month: first, notes: String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null,
  };
}

/**
 * Add an entry (id null) or change one. Lines already created keep their amount and their
 * date; the change is for the months still to come. A line whose day has already come is
 * made straight away, so an entry added on the 5th for the 1st shows this month at once.
 * null: not their entry.
 */
export async function saveEntry(user, id, input, now = today()) {
  const old = id === null ? null : await entryOf(user, id, now);
  if (id !== null && !old) return null;
  const f = await readEntry(user, input || {}, now);
  const values = [f.site_id, f.site_name, f.unit, f.title, f.amount, f.day, f.auto_create, f.first_month, f.notes, user.id];
  let entryId = old?.id;
  if (old) {
    await db.prepare(`UPDATE recurring_payments SET site_id = ?, site_name = ?, unit = ?, title = ?, amount = ?, day = ?, auto_create = ?,
      first_month = ?, notes = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(...values, old.id);
  } else {
    entryId = (await db.prepare(`INSERT INTO recurring_payments (site_id, site_name, unit, title, amount, day, auto_create, first_month, notes, updated_by, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(...values, user.id)).id;
  }
  await createDuePayments(now, entryId);
  return shapeEntry(await entryOf(user, entryId, now));
}

/** Pause an entry (no new lines; the ones it has stay) or start it again. */
export async function setActive(user, id, active, now = today()) {
  const p = await entryOf(user, id, now);
  if (!p) return null;
  await db.prepare(`UPDATE recurring_payments SET active = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`).run(!!active, user.id, p.id);
  if (active) await createDuePayments(now, p.id);
  return shapeEntry(await entryOf(user, p.id, now));
}

/** Only an entry that never created a line can go; one with lines is paused instead. */
export async function deleteEntry(user, id) {
  const p = await entryOf(user, id);
  if (!p) return null;
  if (p.payments > 0) throw bad(`"${p.title}" already has payments, so it cannot be deleted. Pause it instead.`, 409);
  await db.prepare('DELETE FROM recurring_payments WHERE id = ?').run(p.id);
  return { ok: true };
}

/** This month's line, made by hand: for an entry that does not create its own, or ahead of its day. */
export async function createNow(user, id, now = today()) {
  const p = await entryOf(user, id, now);
  if (!p) return null;
  const month = now.slice(0, 7);
  if (!p.active) throw bad(`"${p.title}" is paused. Resume it first.`, 409);
  if (month < p.first_month) throw bad(`"${p.title}" starts in a later month.`, 409);
  const { id: dueId } = await insertDue(p, month);
  if (!dueId) throw bad("This month's payment is already there.", 409);
  return shapeDue(await db.prepare(`${DUE} WHERE d.id = ?`).get(dueId));
}

/** Mark a line paid, with who and when, or put it back to pending. */
export async function setPaid(user, dueId, paid) {
  const d = await db.prepare(`${DUE} WHERE d.id = ?`).get(Number(dueId) || 0);
  if (!d || !(await kept(user)).some((b) => b.id === d.site_id)) return null;
  await db.prepare(`UPDATE recurring_payment_dues SET status = ?, paid_at = ${paid ? NOW : 'NULL'}, paid_by = ? WHERE id = ?`)
    .run(paid ? 'paid' : 'pending', paid ? user.id : null, d.id);
  return shapeDue(await db.prepare(`${DUE} WHERE d.id = ?`).get(d.id));
}

// ---------- the timer ----------

const EVERY = 60 * 60_000;
let timer = null;

/** Looks every hour for lines whose day has come. Cheap, and safe to run again. */
export function startRecurringPayments() {
  if (timer) return;
  const tick = () => createDuePayments()
    .then((made) => made && console.log(`[recurring payments] ${made} created`))
    .catch((e) => console.warn('[recurring payments]', e.message));
  timer = setInterval(tick, EVERY);
  setTimeout(tick, 15_000);
}

// ---------- routes ----------

export const recurringPaymentRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

recurringPaymentRoutes.get('/', wrap(async (req, res) => res.json(await listDues(req.user, req.query))));
recurringPaymentRoutes.get('/entries', wrap(async (req, res) => res.json(await listEntries(req.user))));
recurringPaymentRoutes.post('/entries', wrap(async (req, res) => res.json(await saveEntry(req.user, null, req.body))));
recurringPaymentRoutes.put('/entries/:id', wrap(async (req, res) => send(res, await saveEntry(req.user, req.params.id, req.body))));
recurringPaymentRoutes.delete('/entries/:id', wrap(async (req, res) => send(res, await deleteEntry(req.user, req.params.id))));
recurringPaymentRoutes.post('/entries/:id/active', wrap(async (req, res) => send(res, await setActive(req.user, req.params.id, req.body?.active))));
recurringPaymentRoutes.post('/entries/:id/dues', wrap(async (req, res) => send(res, await createNow(req.user, req.params.id))));
recurringPaymentRoutes.post('/dues/:id/paid', wrap(async (req, res) => send(res, await setPaid(req.user, req.params.id, true))));
recurringPaymentRoutes.post('/dues/:id/pending', wrap(async (req, res) => send(res, await setPaid(req.user, req.params.id, false))));
