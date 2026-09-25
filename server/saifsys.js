import { Router } from 'express';
import { db } from './db.js';
import { createTodo } from './todos.js';

// saifsys — the property system at saifholdinggroup.com/sys — read from inside Jarvis.
//
// Jarvis only asks; saifsys answers through its own small door, api/jarvis/v1, which is
// read-only and locked with a shared key (SAIFSYS_API_KEY here, JARVIS_API_KEY there).
// Everything saifsys-shaped lives in this file, so the next thing to connect is one more
// action on that door plus one more tool below, and nothing else in Jarvis has to change.
//
// Two things use it today:
//   - the saifsys_checkouts tool, which every agent carries for every user;
//   - the morning job: once a day it reads today's checkouts and puts ONE todo on each
//     master's list, reminding at 11am, so the phone buzzes through server/reminders.js.
//     The todo is the reminder — nothing new to keep awake, and it can be ticked off.

const BASE = (process.env.SAIFSYS_URL || 'https://saifholdinggroup.com/sys').replace(/\/+$/, '');
const KEY = () => process.env.SAIFSYS_API_KEY || '';
export const saifsysConfigured = () => !!KEY();

const TIMEOUT = 15_000;
const CHECKOUT_HOUR = 11; // the time guests leave, and when the reminder buzzes
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** Today's date in Dubai as YYYY-MM-DD — the server runs on UTC. */
export const dubaiDate = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const dubaiHour = (at = Date.now()) => Number(new Date(at).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }));

/** One call through the door. action names the route; params become the query string. */
export async function askSaifsys(action, params = {}) {
  if (!saifsysConfigured()) throw bad('saifsys is not connected yet: SAIFSYS_API_KEY is missing from .env.', 503);
  const url = new URL(`${BASE}/api/jarvis/v1/`);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Jarvis-Key': KEY(), Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw bad(`saifsys did not answer (${e.name}: ${e.message}).`, 502);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw bad(`saifsys said: ${body?.error?.message || `HTTP ${res.status}`}`, res.status === 400 ? 400 : 502);
  return body;
}

/** The stays checking out on a date (YYYY-MM-DD, default today in Dubai). */
export async function checkouts(date) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must be YYYY-MM-DD');
  const body = await askSaifsys('checkouts', { date: date || dubaiDate() });
  return { date: body.date, checkouts: body.checkouts || [] };
}

const place = (c) => [c.building, c.unit && `unit ${c.unit}`].filter(Boolean).join(' ') || `booking ${c.booking_number}`;

function describe({ date, checkouts: list }) {
  if (!list.length) return `No checkouts in saifsys on ${date}.`;
  const lines = list.map((c) => {
    const bits = [`- ${place(c)}`, c.guest && `— ${c.guest}`, c.guest_phone && `(${c.guest_phone})`, `· ${c.booking_number}`, `· ${c.status}`];
    if (c.balance_due > 0) bits.push(`· balance due AED ${c.balance_due.toFixed(2)}`);
    return bits.filter(Boolean).join(' ');
  });
  return `${list.length} checkout${list.length > 1 ? 's' : ''} in saifsys on ${date} (checkout time 11:00):\n${lines.join('\n')}`;
}

// ---------- the tool every agent carries ----------

export const SAIFSYS_TOOLS = [
  {
    name: 'saifsys_checkouts',
    description: 'Look up which short-stay guests check out on a given day, live from saifsys (the company property system). ' +
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

const handlers = {
  saifsys_checkouts: async (input) => describe(await checkouts(input.date)),
};

/** Same shape as todoKit(), so chat.js routes calls to it by tool name. */
export function saifsysKit() {
  return {
    definitions: SAIFSYS_TOOLS,
    status: (name) => (name === 'saifsys_checkouts' ? 'Checking saifsys…' : null),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

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
  .then((r) => r.todos !== undefined && console.log(`[saifsys] ${r.day}: ${r.checkouts} checkouts, ${r.todos} reminders`))
  .catch((e) => console.error('[saifsys]', e.message));

export function startSaifsys() {
  if (timer || !saifsysConfigured()) return;
  timer = setInterval(tick, EVERY);
  timer.unref();
  return tick();
}
export const stopSaifsys = () => { clearInterval(timer); timer = null; };

// ---------- routes ----------

// Any signed-in user can ask; the answer is the same live list the agents see.
export const saifsysRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

saifsysRoutes.get('/checkouts', wrap(async (req, res) => {
  res.json(await checkouts(req.query.date ? String(req.query.date) : undefined));
}));
