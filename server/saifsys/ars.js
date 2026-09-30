import { db } from '../db.js';
import { createTodo } from '../todos.js';
import { askSaifsys, saifsysConfigured, dubaiDate, dubaiHour, bad } from './client.js';

// saifsys → ARS Home Rentals. Matches api/jarvis/v1/modules/ars.php on the saifsys side.
//
// Two things use it:
//   - the ars_checkouts tool, carried by the agents of anyone who has the ARS module;
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

export const tools = [
  {
    name: 'ars_checkouts',
    description: 'Look up which short-stay guests check out on a given day, live from the ARS Home Rentals module of saifsys (the company system). ' +
      'Use it whenever anyone asks about checkouts, departures, who is leaving, or which units need cleaning after a stay. ' +
      'Returns building, unit, guest, phone, booking number, status and any balance still due.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The day, YYYY-MM-DD. Work it out from the current date given to you. Omit for today.' },
      },
    },
  },
];

export const handlers = {
  ars_checkouts: async (input) => describe(await checkouts(input.date)),
};

export const status = { ars_checkouts: 'Checking ARS checkouts…' };

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
