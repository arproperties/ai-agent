import { Router } from 'express';
import { db } from './db.js';

// Routines: the things that come back. Deliberately not todos.
//
// A todo is finished and leaves. A routine never finishes, which is why it is not a
// column on the todo table: a row that cannot use its table's main verb is not the same
// kind of thing, and recurring items sitting in the todo list for ever would mean that
// list is never empty and its badge never means anything.
//
// Nothing is stored about WHEN the next one falls due. A routine is an anchor (the first
// occurrence), an interval, and a list of the times it was actually done; everything else
// is worked out from those three. That makes ticking one off and un-ticking it exact
// opposites — one row inserted, one row deleted — with no schedule to drift or repair.
//
// Like todos, being due surfaces in the app and nowhere else. Nothing is pushed.

const MAX_TEXT = 300;
const MAX_NOTES = 2000;
const NOW = 'extract(epoch from now())::bigint';
export const UNITS = ['day', 'week', 'month', 'year'];

// Asia/Dubai. No daylight saving here, so a fixed offset is exact, and every calendar
// step below ("the 1st of next month", "same time tomorrow") is computed in the user's
// civil time rather than the server's — which is UTC in production.
const OFFSET = 4 * 3600;

// A Date whose UTC fields read as Dubai's wall clock, and the way back.
const civil = (secs) => new Date((secs + OFFSET) * 1000);
const fromCivil = (d) => Math.round(d.getTime() / 1000) - OFFSET;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The k-th occurrence after the anchor (k = 0 is the anchor itself). */
export function occurrence(anchor, every, unit, k) {
  const a = civil(anchor);
  const [y, mo, d, h, mi] = [a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), a.getUTCHours(), a.getUTCMinutes()];
  if (unit === 'day') return fromCivil(new Date(Date.UTC(y, mo, d + every * k, h, mi)));
  if (unit === 'week') return fromCivil(new Date(Date.UTC(y, mo, d + every * k * 7, h, mi)));
  const months = (unit === 'year' ? 12 : 1) * every * k;
  const ty = y + Math.floor((mo + months) / 12);
  const tm = ((mo + months) % 12 + 12) % 12;
  // The 31st stays the 31st wherever there is one. Clamping to the end of a short month
  // beats spilling into the next one, and anchoring on the original day means February
  // does not quietly turn "the 31st" into "the 28th" for good.
  return fromCivil(new Date(Date.UTC(ty, tm, Math.min(d, daysInMonth(ty, tm)), h, mi)));
}

// Months and years have no fixed length, so the jump below lands near and then walks.
// Bounded in both directions: a routine nobody has opened for years must not spin.
const AVERAGE = { day: 86400, week: 604800, month: 2629746, year: 31556952 };
const WALK = 4096;

function stepsTo(anchor, every, unit, at) {
  let k = Math.max(0, Math.floor((at - anchor) / (AVERAGE[unit] * every)));
  for (let i = 0; i < WALK && k > 0 && occurrence(anchor, every, unit, k - 1) > at; i++) k--;
  for (let i = 0; i < WALK && occurrence(anchor, every, unit, k) <= at; i++) k++;
  return k; // the first occurrence strictly after `at`
}

/** The first occurrence strictly after `at`. */
export const nextOccurrence = (anchor, every, unit, at) =>
  (anchor > at ? anchor : occurrence(anchor, every, unit, stepsTo(anchor, every, unit, at)));

/** The most recent occurrence at or before `at`, or null if it has not started yet. */
export function lastOccurrence(anchor, every, unit, at) {
  if (anchor > at) return null;
  const k = stepsTo(anchor, every, unit, at);
  return occurrence(anchor, every, unit, Math.max(0, k - 1));
}

/**
 * Whether a completion at `done` counts as having done the occurrence at `due`.
 *
 * Anything after it obviously does. So does anything from halfway through the gap
 * before it — take the morning pill at ten to nine and it is today's pill, not an
 * extra one, and at nine o'clock the routine does not ask for it again.
 */
export function covers(done, due, anchor, every, unit) {
  if (done >= due) return true;
  const k = stepsTo(anchor, every, unit, due - 1); // due is occurrence k here
  const previous = occurrence(anchor, every, unit, Math.max(0, k - 1));
  return previous < due && done >= due - (due - previous) / 2;
}

// ---------- rows ----------

const SELECT = `SELECT r.*, a.name agent_name FROM routines r LEFT JOIN agents a ON a.id = r.agent_id`;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Epoch seconds from a number, an ISO string, or a bare date (which means 9am here). */
export function startAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return n > 1e11 ? Math.round(n / 1000) : n;
  }
  const text = String(value).trim();
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T09:00:00` : text;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(dated) ? dated : `${dated}+04:00`;
  const ms = Date.parse(zoned);
  if (Number.isNaN(ms)) throw bad(`"${value}" is not a date and time I can read. Use YYYY-MM-DDTHH:MM+04:00.`);
  return Math.round(ms / 1000);
}

function schedule(every, unit) {
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  if (!UNITS.includes(u)) throw bad(`A routine repeats every day, week, month or year — not "${unit}".`);
  // Not given means once per unit. Given as 0, or as something that is not a number,
  // is a mistake worth saying out loud — `|| 1` here would have turned "every 0 days"
  // into a daily routine the user never asked for.
  const n = every === undefined || every === null || every === '' ? 1 : Math.round(Number(every));
  if (!Number.isFinite(n) || n < 1 || n > 366) throw bad('A routine repeats between every 1 and every 366 of those.');
  return { every_n: n, unit: u };
}

/** How often it comes round, in words: "Daily", "Every 3 weeks", "Yearly". */
export function cadence({ every_n, unit }) {
  if (every_n === 1) return { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[unit];
  if (unit === 'month' && every_n === 3) return 'Quarterly';
  if (unit === 'week' && every_n === 2) return 'Fortnightly';
  return `Every ${every_n} ${unit}s`;
}

/**
 * A routine as the app and the agents see it: the stored row plus everything derived
 * from it. Derived here and nowhere else, so the screen and the tools cannot disagree.
 */
export function routineOut(r, completions = [], now = Math.floor(Date.now() / 1000)) {
  const { user_id, ...row } = r;
  const mine = completions.filter((c) => c.routine_id === r.id).map((c) => c.done_at).sort((a, b) => b - a);
  const last = lastOccurrence(r.starts_at, r.every_n, r.unit, now);
  const doneThis = last !== null && mine.some((t) => covers(t, last, r.starts_at, r.every_n, r.unit));
  return {
    ...row,
    cadence: cadence(r),
    next_at: nextOccurrence(r.starts_at, r.every_n, r.unit, now),
    due_at: r.paused ? null : last,
    due: !r.paused && last !== null && !doneThis,
    done_at: doneThis ? mine.find((t) => covers(t, last, r.starts_at, r.every_n, r.unit)) : null,
    history: mine.slice(0, 60),
  };
}

const completionsFor = (userId, since) =>
  db.prepare('SELECT routine_id, done_at FROM routine_completions WHERE user_id = ? AND done_at >= ? ORDER BY done_at DESC')
    .all(userId, since);

/** Every routine this user has, each already carrying what it derives. */
export async function listRoutines(userId, { now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = await db.prepare(`${SELECT} WHERE r.user_id = ? ORDER BY r.paused, r.id`).all(userId);
  if (!rows.length) return [];
  // Two months back covers the week strip on the screen and a monthly routine's last turn.
  const done = await completionsFor(userId, now - 62 * 86400);
  // Due first, paused last, and inside each group whatever comes round soonest.
  return rows.map((r) => routineOut(r, done, now)).sort((a, b) =>
    (b.due ? 1 : 0) - (a.due ? 1 : 0) || (a.paused ? 1 : 0) - (b.paused ? 1 : 0) || a.next_at - b.next_at);
}

/** Only the ones asking to be done: what the badge counts and the first screen shows. */
export const dueRoutines = async (userId, now = Math.floor(Date.now() / 1000)) =>
  (await listRoutines(userId, { now })).filter((r) => r.due);

export async function getRoutine(userId, id, now = Math.floor(Date.now() / 1000)) {
  const r = await db.prepare(`${SELECT} WHERE r.id = ? AND r.user_id = ?`).get(Number(id), userId);
  if (!r) return null;
  return routineOut(r, await completionsFor(userId, now - 62 * 86400), now);
}

export async function createRoutine(userId, { text, notes, starts_at, every, unit, agentId = null, conversationId = null }) {
  const body = clean(text, MAX_TEXT);
  if (!body) throw bad('A routine needs something to do');
  const { every_n, unit: u } = schedule(every, unit);
  // No start given means it begins now, so the first one falls due a full interval from
  // here rather than immediately — "daily from today" should not be due the second it is made.
  const anchor = startAt(starts_at) ?? nextOccurrence(Math.floor(Date.now() / 1000), every_n, u, Math.floor(Date.now() / 1000));
  const { id } = await db.prepare(`INSERT INTO routines (user_id, agent_id, conversation_id, text, notes, starts_at, every_n, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(userId, agentId, conversationId, body, clean(notes, MAX_NOTES) || null, anchor, every_n, u);
  return getRoutine(userId, id);
}

export async function updateRoutine(userId, id, patch) {
  const r = await db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!r) return null;
  const text = 'text' in patch ? clean(patch.text, MAX_TEXT) || r.text : r.text;
  const notes = 'notes' in patch ? clean(patch.notes, MAX_NOTES) || null : r.notes;
  const starts = 'starts_at' in patch ? (startAt(patch.starts_at) ?? r.starts_at) : r.starts_at;
  const paused = 'paused' in patch ? !!patch.paused : r.paused;
  const { every_n, unit } = ('every' in patch || 'unit' in patch)
    ? schedule(patch.every ?? r.every_n, patch.unit ?? r.unit)
    : { every_n: r.every_n, unit: r.unit };
  await db.prepare(`UPDATE routines SET text = ?, notes = ?, starts_at = ?, every_n = ?, unit = ?, paused = ?, updated_at = ${NOW}
    WHERE id = ? AND user_id = ?`).run(text, notes, starts, every_n, unit, paused, r.id, userId);
  return getRoutine(userId, id);
}

export const deleteRoutine = async (userId, id) =>
  (await db.prepare('DELETE FROM routines WHERE id = ? AND user_id = ?').run(Number(id), userId)).changes > 0;

/**
 * Tick off this turn — or untick it. Ticking writes one row; unticking removes the row
 * that was covering the current occurrence. Nothing else moves, which is why the two
 * are exact opposites and neither can leave a routine in a state it cannot get out of.
 */
export async function setDone(userId, id, done, now = Math.floor(Date.now() / 1000)) {
  const r = await getRoutine(userId, id, now);
  if (!r) return null;
  if (done && !r.done_at) {
    await db.prepare('INSERT INTO routine_completions (routine_id, user_id, done_at) VALUES (?, ?, ?)').run(r.id, userId, now);
  } else if (!done && r.done_at) {
    await db.prepare('DELETE FROM routine_completions WHERE routine_id = ? AND user_id = ? AND done_at = ?').run(r.id, userId, r.done_at);
  }
  return getRoutine(userId, id, now);
}

// ---------- how a routine reads back to an agent ----------

const stamp = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

const line = (r) => {
  const state = r.paused ? 'PAUSED' : r.due ? `DUE NOW (since ${stamp(r.due_at)})` : r.done_at ? `done ${stamp(r.done_at)}` : 'not due';
  return `- #${r.id} ${r.text} — ${r.cadence}, ${state}. Next: ${stamp(r.next_at)}.${r.notes ? `\n    ${r.notes}` : ''}`;
};

export const ROUTINE_TOOLS = [
  {
    name: 'add_routine',
    description: 'Set up something that comes back on a rhythm — daily, weekly, monthly, yearly, or every N of those. ' +
      'Use this instead of add_todo whenever the user says "every", "each", "daily", "weekly", "monthly", or otherwise means ' +
      'a thing that repeats rather than a one-off task. Tell them in your reply that it is set up.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What comes round, short and actionable. E.g. "Send the VAT return".' },
        every: { type: 'integer', description: 'How many units between turns. 1 for daily/weekly/monthly. 3 with unit "month" is quarterly.' },
        unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        starts_at: {
          type: 'string',
          description: 'When the FIRST one falls due, ISO 8601 with the UAE offset, e.g. "2026-10-01T09:00:00+04:00". ' +
            'This also fixes the time of day and, for weekly, the weekday. Work it out from the current date and time you were given. Omit it to start one interval from now.',
        },
        notes: { type: 'string', description: 'Optional detail worth keeping with it.' },
      },
      required: ['text', 'unit'],
    },
  },
  {
    name: 'list_routines',
    description: "Read back the user's routines: what each one is, how often it comes round, whether this turn is done, and when the next is. " +
      'Use it when they ask what they have set up, whether they have done something yet, or what is due.',
    input_schema: { type: 'object', properties: { due_only: { type: 'boolean', description: 'Only the ones asking to be done now. Default false.' } } },
  },
  {
    name: 'complete_routine',
    description: "Tick off this turn of a routine, by the id list_routines gave you. Only when the user says they have done it. " +
      'It comes back at its next turn, as routines do.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'pause_routine',
    description: 'Stop a routine coming round, or start it again. Pausing keeps it and its history — this is how a routine is ' +
      'put down without losing it, and it can always be resumed.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, paused: { type: 'boolean', description: 'true to pause, false to resume.' } },
      required: ['id', 'paused'],
    },
  },
];

export function routineStatus(name) {
  switch (name) {
    case 'add_routine': return 'Setting up a routine…';
    case 'list_routines': return 'Checking your routines…';
    case 'complete_routine': return 'Ticking that off…';
    case 'pause_routine': return 'Changing a routine…';
    default: return null;
  }
}

// No delete tool, for the same reason todos have none: pausing is reversible and leaves
// the record, and an agent that can erase a row can erase the evidence of having done so.
const handlers = {
  add_routine: async (userId, ctx, input) => {
    const r = await createRoutine(userId, {
      text: input.text, notes: input.notes, starts_at: input.starts_at, every: input.every ?? 1, unit: input.unit,
      agentId: ctx.agentId, conversationId: ctx.conversationId,
    });
    return `Set up as routine #${r.id}: "${r.text}", ${r.cadence.toLowerCase()}. The first one falls due ${stamp(r.due_at ?? r.next_at)}. ` +
      'It lives on their Routines list in the app, and comes up there each time it falls due. If they have switched notifications on their phone will buzz then too, but do not promise that — say it will come up.';
  },

  list_routines: async (userId, ctx, input) => {
    const all = await listRoutines(userId);
    const rows = input.due_only ? all.filter((r) => r.due) : all;
    if (!rows.length) return input.due_only ? 'No routine is due right now.' : 'They have no routines set up.';
    return `${input.due_only ? 'Due now' : 'Routines'} (${rows.length}):\n${rows.map(line).join('\n')}`;
  },

  complete_routine: async (userId, ctx, input) => {
    const before = await getRoutine(userId, input.id);
    if (!before) throw new Error(`There is no routine #${input.id}. Call list_routines to see the ids.`);
    if (before.done_at) return `#${before.id} ("${before.text}") was already ticked off this turn. Next one: ${stamp(before.next_at)}.`;
    const r = await setDone(userId, input.id, true);
    return `Ticked off this turn of #${r.id} ("${r.text}"). It comes round again ${stamp(r.next_at)}.`;
  },

  pause_routine: async (userId, ctx, input) => {
    const r = await updateRoutine(userId, input.id, { paused: !!input.paused });
    if (!r) throw new Error(`There is no routine #${input.id}. Call list_routines to see the ids.`);
    return r.paused
      ? `#${r.id} ("${r.text}") is paused and will not come round. Its history is kept and it can be resumed.`
      : `#${r.id} ("${r.text}") is running again. Next one: ${stamp(r.next_at)}.`;
  },
};

/** Same shape as the mailbox and todo kits, so chat.js routes a call by its name. */
export function routineKit(userId, ctx = {}) {
  return {
    definitions: ROUTINE_TOOLS,
    status: (name) => routineStatus(name),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(userId, ctx, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const routineRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'Routine not found' });

routineRoutes.get('/', wrap(async (req, res) => res.json(await listRoutines(req.user.id))));
routineRoutes.get('/due', wrap(async (req, res) => res.json(await dueRoutines(req.user.id))));
routineRoutes.post('/', wrap(async (req, res) => {
  res.json(await createRoutine(req.user.id, {
    text: req.body.text, notes: req.body.notes, starts_at: req.body.starts_at, every: req.body.every, unit: req.body.unit,
  }));
}));
routineRoutes.patch('/:id', wrap(async (req, res) => {
  const r = await updateRoutine(req.user.id, req.params.id, req.body);
  r ? res.json(r) : gone(res);
}));
// Ticking this turn off is its own door, not a field on the row: it writes to the history,
// not to the schedule, and PATCH would blur the two.
routineRoutes.post('/:id/done', wrap(async (req, res) => {
  const r = await setDone(req.user.id, req.params.id, req.body.done !== false);
  r ? res.json(r) : gone(res);
}));
routineRoutes.delete('/:id', wrap(async (req, res) => {
  (await deleteRoutine(req.user.id, req.params.id)) ? res.json({ ok: true }) : gone(res);
}));
