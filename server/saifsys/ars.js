import { db } from '../db.js';
import { createTodo } from '../todos.js';
import { askSaifsys, saifsysConfigured, dubaiDate, dubaiHour, bad } from './client.js';

// saifsys → ARS Home Rentals. Matches api/jarvis/v1/modules/ars.php on the saifsys side.
//
// Two things use it:
//   - the ars_* tools (15 lookups, view only), carried by the agents of anyone who has
//     the ARS module;
//   - the morning job (on hold — startArs is not called): once a day it reads today's
//     checkouts and puts ONE todo on each master's list, reminding at 11am.

const CHECKOUT_HOUR = 11; // the time guests leave, and when the reminder buzzes

/** The stays checking out on a date (YYYY-MM-DD, default today in Dubai). */
export async function checkouts(date) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must be YYYY-MM-DD');
  const body = await askSaifsys('ars', 'checkouts', { date: date || dubaiDate() });
  return { date: body.date, checkouts: body.checkouts || [] };
}

const place = (c) => [c.building, c.unit && `unit ${c.unit}`].filter(Boolean).join(' ') || `booking ${c.booking_number}`;

function describe({ date, checkouts: list }) {
  if (!list.length) return `No checkouts in saifsys ARS on ${date}.`;
  const lines = list.map((c) => {
    const bits = [`- ${place(c)}`, c.guest && `— ${c.guest}`, c.guest_phone && `(${c.guest_phone})`, `· ${c.booking_number}`, `· ${c.status}`];
    if (c.balance_due > 0) bits.push(`· balance due AED ${c.balance_due.toFixed(2)}`);
    return bits.filter(Boolean).join(' ');
  });
  return `${list.length} checkout${list.length > 1 ? 's' : ''} in saifsys ARS on ${date} (checkout time 11:00):\n${lines.join('\n')}`;
}

// ---------- the module's tools ----------

// View only: every tool reads, none writes. Each maps to one action in modules/ars.php;
// the answer goes back to the agent as the JSON saifsys sent, which Claude reads well
// and which keeps every figure exactly as saifsys worked it out.
const DATE = { type: 'string', description: 'YYYY-MM-DD. Work it out from the current date given to you.' };
const tool = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});

const LOOKUPS = [
  { action: 'summary', status: 'Reading the ARS dashboard…', tool: tool('ars_summary',
    'Today at ARS Home Rentals in numbers, the same as its Command Center: arrivals, departures, in-house, occupancy, ' +
    'balances due (count and total), open housekeeping and maintenance, pending deposits, new bookings in 24h, money received this month. ' +
    'Use for "how are we doing today", "give me the ARS summary".') },
  { action: 'arrivals', status: 'Checking ARS arrivals…', tool: tool('ars_arrivals',
    'Who is due to check in on a day (pending, confirmed or already checked in), with unit, guest, phone, total, paid and balance due.',
    { date: { ...DATE, description: 'The day. Omit for today.' } }) },
  { action: 'in_house', status: 'Checking who is staying…', tool: tool('ars_in_house',
    'Every guest checked in right now, with unit, checkout date, total, paid and balance due.') },
  { action: 'booking', status: 'Finding the booking…', tool: tool('ars_booking',
    'One booking in full: dates, nights, rate, total, paid, live balance, every payment, invoices, extensions, deposit, notes, ' +
    'Airbnb source, cancellation. Search by booking number, guest name, phone or unit number. Several matches come back as a list to pick from.',
    { q: { type: 'string', description: 'Booking number, guest name, phone, or unit number.' } }, ['q']) },
  { action: 'bookings', status: 'Listing ARS bookings…', tool: tool('ars_bookings',
    'A list of bookings between two dates, optionally by status. Use for "next week\'s bookings", "cancelled this month", "bookings made today". ' +
    'Up to 200 rows.',
    {
      from: { ...DATE, description: 'Start of the range. Omit for today.' },
      to: { ...DATE, description: 'End of the range. Omit for 30 days after from.' },
      by: { type: 'string', enum: ['stay', 'check_in', 'check_out', 'created'], description: 'Which date falls in the range: stay (any night overlaps, default), check_in, check_out, or created (when the booking was made).' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'checked_in', 'checked_out', 'completed', 'cancelled', 'expired'] },
    }) },
  { action: 'balances', status: 'Checking balances due…', tool: tool('ars_balances',
    'Everyone who still owes money, biggest first, with the total. Balances are live (the booking page\'s figure). ' +
    'scope active = confirmed and in-house stays (default, like the ARS payment follow-up); all = also guests who already left, last 12 months.',
    { scope: { type: 'string', enum: ['active', 'all'] } }) },
  { action: 'guest', status: 'Finding the guest…', tool: tool('ars_guest',
    'A guest\'s contact details and every stay they have had, with what they paid and still owe. Search by name, phone or email.',
    { q: { type: 'string', description: 'Guest name, phone, or email.' } }, ['q']) },
  { action: 'unit', status: 'Checking the unit…', tool: tool('ars_unit',
    'A unit\'s status: who is in it now, next bookings, blocked dates, recent stays, rate. Search by unit number or building. ' +
    'Without q, lists every ARS unit as occupied, blocked or free today.',
    { q: { type: 'string', description: 'Unit number or building name. Omit for every unit.' } }) },
  { action: 'availability', status: 'Checking free units…', tool: tool('ars_availability',
    'Which ARS units are free for a stay, with rate and max guests. to is the checkout day.',
    { from: { ...DATE, description: 'Check-in day.' }, to: { ...DATE, description: 'Checkout day, after from.' } }, ['from', 'to']) },
  { action: 'housekeeping', status: 'Checking housekeeping…', tool: tool('ars_housekeeping',
    'ARS cleaning jobs for a day and their status (confirmed, scheduled, in_progress, completed), with unit and booking.',
    { date: { ...DATE, description: 'The day. Omit for today.' }, status: { type: 'string', enum: ['confirmed', 'scheduled', 'in_progress', 'completed'] } }) },
  { action: 'maintenance', status: 'Checking maintenance…', tool: tool('ars_maintenance',
    'Repair requests on ARS units, with priority, category, description and status. Open ones by default.',
    { status: { type: 'string', enum: ['open', 'all'] } }) },
  { action: 'payments', status: 'Checking payments received…', tool: tool('ars_payments',
    'Money received from ARS guests between two dates: each payment and the total, split by method. Defaults to this month so far.',
    { from: { ...DATE, description: 'Omit for the 1st of this month.' }, to: { ...DATE, description: 'Omit for today.' } }) },
  { action: 'deposits', status: 'Checking deposits…', tool: tool('ars_deposits',
    'Security deposits on ARS bookings with totals per status. Omit status for every booking that has one.',
    { status: { type: 'string', enum: ['pending', 'received', 'partially_refunded', 'refunded', 'forfeited'] } }) },
  { action: 'activity', status: 'Reading ARS activity…', tool: tool('ars_activity',
    'The latest actions on ARS bookings (check-ins, payments, extensions, notes…), newest first. Give a booking number for that booking only.',
    { q: { type: 'string', description: 'A booking number. Omit for all bookings.' }, limit: { type: 'integer', description: 'How many, up to 100. Default 25.' } }) },
];

/** Any lookup by action name, with the agent's input as the query string. */
export async function lookup(action, input = {}) {
  const { ok, ...answer } = await askSaifsys('ars', action, input);
  return answer;
}

export const tools = [
  tool('ars_checkouts',
    'Look up which short-stay guests check out on a given day, live from the ARS Home Rentals module of saifsys (the company system). ' +
    'Use it whenever anyone asks about checkouts, departures, who is leaving, or which units need cleaning after a stay. ' +
    'Returns building, unit, guest, phone, booking number, status and any balance still due.',
    { date: { ...DATE, description: 'The day. Omit for today.' } }),
  ...LOOKUPS.map((l) => l.tool),
];

export const handlers = {
  ars_checkouts: async (input) => describe(await checkouts(input.date)),
  ...Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, async (input) => JSON.stringify(await lookup(l.action, input))])),
};

export const status = {
  ars_checkouts: 'Checking ARS checkouts…',
  ...Object.fromEntries(LOOKUPS.map((l) => [l.tool.name, l.status])),
};

// ---------- the morning job ----------

// It runs in the morning window only: early enough that the list is ready before 11,
// late enough that last night's bookings are in. A server that was down all morning
// does not wake up at 3pm and remind anyone about guests who left hours ago.
const WINDOW = { from: 6, to: CHECKOUT_HOUR };
const EVERY = 10 * 60_000; // a failed fetch simply tries again ten minutes later
const JOB = 'checkouts';
let timer = null;

/** Who gets the reminder: every active master. */
const recipients = () => db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT disabled ORDER BY id`).all();

/**
 * Today's checkout reminder, made at most once a day. Returns what it did, for the log
 * and the tests. `force` skips the time window, not the once-a-day rule.
 */
export async function runCheckoutJob({ at = Date.now(), force = false } = {}) {
  if (!saifsysConfigured()) return { skipped: 'not configured' };
  const day = dubaiDate(at);
  const hour = dubaiHour(at);
  if (!force && (hour < WINDOW.from || hour >= WINDOW.to)) return { skipped: 'outside the morning window' };
  if (await db.prepare('SELECT 1 FROM saifsys_runs WHERE job = ? AND day = ?').get(JOB, day)) return { skipped: 'already done today' };

  const result = await checkouts(day); // throws on a failed fetch: nothing is written, the next tick retries
  const list = result.checkouts;
  // Claimed before the todos are written, so two ticks can never both make one.
  const claimed = await db.prepare(`INSERT INTO saifsys_runs (job, day, found) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING day`).get(JOB, day, list.length);
  if (!claimed) return { skipped: 'already done today' };
  if (!list.length) return { day, checkouts: 0, todos: 0 };

  const units = list.map(place);
  const text = `${list.length} checkout${list.length > 1 ? 's' : ''} today at 11:00 — ${units.join(', ')}`;
  const notes = describe(result).split('\n').slice(1).join('\n');
  const remind = `${day}T${String(CHECKOUT_HOUR).padStart(2, '0')}:00:00+04:00`;
  const people = await recipients();
  for (const { id } of people) await createTodo(id, { text, notes, remind_at: remind });
  return { day, checkouts: list.length, todos: people.length };
}

const tick = () => runCheckoutJob()
  .then((r) => r.todos !== undefined && console.log(`[saifsys/ars] ${r.day}: ${r.checkouts} checkouts, ${r.todos} reminders`))
  .catch((e) => console.error('[saifsys/ars]', e.message));

export function startArs() {
  if (timer || !saifsysConfigured()) return;
  timer = setInterval(tick, EVERY);
  timer.unref();
  return tick();
}
export const stopArs = () => { clearInterval(timer); timer = null; };
