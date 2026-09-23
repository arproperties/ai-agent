import { Router } from 'express';
import { db } from './db.js';
import { currentUser } from './auth.js';

// What broke, for whom, and where. Until this existed a crash in somebody's browser left
// no trace anywhere: the white screen was the only report, and it only reached the person
// who could do nothing about it.

const CAPS = { message: 500, stack: 4000, url: 300, agent: 200 };
const cut = (value, max) => (value == null ? null : String(value).replace(/\u0000/g, '').slice(0, max));

/**
 * Write one error down. Never throws and never rejects: it is called from the error paths
 * of other work, including the express error handler, and an error while recording an
 * error must not replace the error anybody was actually trying to report.
 */
export async function recordError({ userId = null, source, message, stack = null, url = null, agent = null }) {
  try {
    await db.prepare(`INSERT INTO error_log (user_id, source, message, stack, url, agent)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, source === 'client' ? 'client' : 'server', cut(message, CAPS.message) || 'Unknown error',
        cut(stack, CAPS.stack), cut(url, CAPS.url), cut(agent, CAPS.agent));
  } catch (e) {
    // The database is a plausible cause of the error being reported, so this is the one
    // place that must stay quiet. The console still has it.
    console.error('[errors] could not record:', e.message);
  }
}

export const recentErrors = (limit = 100) =>
  db.prepare(`SELECT e.*, u.name user_name, u.email user_email FROM error_log e
    LEFT JOIN users u ON u.id = e.user_id
    ORDER BY e.id DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 100, 1), 500));

export const errorCount = (sinceDays = 7) =>
  db.prepare(`SELECT COUNT(*)::int n FROM error_log
    WHERE created_at > extract(epoch from now()) - ?`).get(sinceDays * 86400);

// One browser stuck in a failing render loop could write thousands of rows a minute, so
// the public endpoint is capped per address. Crossing the cap is answered normally: a
// client being throttled must not spend its time reporting that it is being throttled.
const RATE = { per: 20, windowMs: 5 * 60_000 };
const seen = new Map();
function tooMany(ip) {
  const now = Date.now();
  const e = seen.get(ip);
  if (!e || now > e.until) { seen.set(ip, { n: 1, until: now + RATE.windowMs }); return false; }
  e.n += 1;
  return e.n > RATE.per;
}

export const errorRoutes = Router();

/**
 * Mounted ahead of requireUser on purpose. The crash worth hearing about most is the one
 * on the sign-in screen, and a report that needs a session could never carry it. The
 * session is read if there is one, so a signed-in report still says who hit it.
 */
errorRoutes.post('/', async (req, res) => {
  res.json({ ok: true }); // answered first: the page is already broken, it must not also wait
  if (tooMany(req.ip)) return;
  const user = await currentUser(req).catch(() => null);
  await recordError({
    userId: user?.id ?? null,
    source: 'client',
    message: req.body?.message,
    stack: req.body?.stack,
    url: req.body?.url,
    agent: req.get('user-agent'),
  });
});

// Kept for a month. Long enough to see whether last week's crash is still happening,
// short enough that the table cannot grow without end.
setInterval(async () => {
  try {
    await db.exec(`DELETE FROM error_log WHERE created_at < extract(epoch from now()) - ${30 * 86400}`);
  } catch (e) { console.error('[errors] housekeeping:', e.message); }
}, 86400000).unref();
