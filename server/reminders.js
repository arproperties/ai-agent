import { db } from './db.js';
import { sendPush } from './push.js';
import { dueRoutines } from './routines.js';

// The reminder that actually reaches you.
//
// A to-do's remind_at used to be a time and nothing else: when it arrived the todo became
// due, and due work showed up as a badge and a line on the first screen. That is still
// true and still the fallback — this only adds a buzz on the phone at the moment the time
// comes, for whoever has switched notifications on.
//
// It is a minute timer, the same shape as the outbox, and it is the honest cost of this
// feature: a reminder now depends on a process staying awake, where before it depended on
// nothing at all. If this timer stops, the badge and the first screen carry on working.
//
// Nothing is sent twice. Every reminder that has been dealt with is written down against
// the exact time it was due, so a todo moved to next week buzzes again then, and one that
// has already buzzed stays quiet however many times this runs.

const EVERY = 60_000;
// How late is too late. A server that was off overnight must not wake someone to eleven
// buzzes about yesterday, so anything older than this is written down as dealt with and
// never sent. It is still due, and still on the list, where it always was.
const CATCHUP = 6 * 3600;

let timer = null;
const now = () => Math.floor(Date.now() / 1000);

/** Todos whose time has come and which have not been notified for THIS reminder time. */
const todosDue = (at) => db.prepare(`
  SELECT t.id, t.user_id, t.text, t.remind_at due_at
  FROM todos t
  LEFT JOIN reminders_sent s ON s.todo_id = t.id AND s.due_at = t.remind_at
  WHERE NOT t.done AND t.remind_at IS NOT NULL AND t.remind_at <= ? AND s.id IS NULL
  ORDER BY t.remind_at`).all(at);

/**
 * The same question for routines, which cannot be asked in one query: whether a routine
 * is due is worked out in routines.js from its interval and what has been ticked off, not
 * stored. There are few enough people for that to be cheaper than it sounds.
 */
async function routinesDue(at) {
  const owners = await db.prepare('SELECT DISTINCT user_id FROM routines WHERE NOT paused').all();
  const out = [];
  for (const { user_id } of owners) {
    for (const r of await dueRoutines(user_id, at)) {
      if (r.due_at) out.push({ id: r.id, user_id, text: r.text, due_at: r.due_at, routine: true });
    }
  }
  const seen = await db.prepare(`SELECT routine_id, due_at FROM reminders_sent WHERE routine_id = ANY(?::int[])`)
    .all(out.map((r) => r.id));
  const done = new Set(seen.map((s) => `${s.routine_id}:${s.due_at}`));
  return out.filter((r) => !done.has(`${r.id}:${r.due_at}`));
}

/** Write down that these have been dealt with, whether or not a phone was woken. */
const remember = (items) => db.prepare(`
  INSERT INTO reminders_sent (user_id, todo_id, routine_id, due_at)
  SELECT * FROM UNNEST(?::int[], ?::int[], ?::int[], ?::bigint[])
  ON CONFLICT DO NOTHING`).run(
  items.map((i) => i.user_id),
  items.map((i) => (i.routine ? null : i.id)),
  items.map((i) => (i.routine ? i.id : null)),
  items.map((i) => i.due_at),
);

/**
 * One person's due work, as one notice.
 *
 * Three separate buzzes for three things due at nine o'clock is how an app gets its
 * notifications switched off, so anything past the first is counted rather than listed.
 */
function notify(userId, items) {
  const [first, ...rest] = items;
  const body = rest.length ? `${first.text} — and ${rest.length} more` : first.text;
  return sendPush([userId], {
    title: items.length > 1 ? `${items.length} things are due` : first.routine ? 'Routine due' : 'Reminder',
    body,
    url: '/?todos=1',
    // One tag for the lot: a later reminder replaces this notice rather than queueing
    // behind it, so the phone shows what is due now and not a history of the morning.
    tag: 'jarvis-due',
  });
}

async function tick() {
  const at = now();
  const items = [...await todosDue(at), ...await routinesDue(at)];
  if (!items.length) return;

  const byUser = new Map();
  for (const item of items) byUser.set(item.user_id, [...(byUser.get(item.user_id) || []), item]);

  for (const [userId, list] of byUser) {
    // Written down first, then sent. A process that dies in between costs one reminder;
    // the other order would cost the same reminder every minute until somebody noticed.
    await remember(list);
    const fresh = list.filter((i) => i.due_at > at - CATCHUP);
    if (fresh.length) await notify(userId, fresh).catch((e) => console.error('[reminders]', e.message));
  }
}

export function startReminders() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('[reminders]', e.message)), EVERY);
  timer.unref(); // an empty list must never be the reason this process stays alive
  return tick().catch((e) => console.error('[reminders]', e.message));
}

export const stopReminders = () => { clearInterval(timer); timer = null; };
export { tick as runRemindersOnce };
