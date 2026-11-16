import { Router } from 'express';
import { db } from './db.js';
import { dubaiDate } from './saifsys/client.js';

// Settings → Team activity, the master's alone: how each person is using Reem. It counts
// questions, sent emails, new files and to-dos from the tables those features already keep;
// it reads titles and subjects but never opens a chat or a file, so it is not in the
// person's "who looked" list (that is admin.js recordAccess, for opening their things).
// External people are left out entirely: their things are private, even from the master.

const DAY = (col) => `(to_timestamp(${col}) AT TIME ZONE 'Asia/Dubai')::date`;
const RANGES = ['today', 'week', 'month'];

/** The first day of the range and how many days of it have happened, in Dubai. */
export function rangeOf(range, today = dubaiDate()) {
  const d = new Date(`${today}T12:00:00Z`);
  if (range === 'week') d.setUTCDate(d.getUTCDate() - 6);
  if (range === 'month') d.setUTCDate(1);
  const from = d.toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - d.getTime()) / 864e5) + 1;
  return { from, days };
}

// Files that arrived from saifsys by themselves are not work the person did.
const OWN_FILE = `NOT EXISTS (SELECT 1 FROM saifsys_doc_links l WHERE l.document_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM saifsys_company_doc_links l WHERE l.document_id = d.id)`;

const n = (x) => Number(x) || 0;
const t = (x) => (x == null ? null : Number(x));

/** One row per person: the range's work beside their usual pace. */
export async function teamActivity({ range = 'today', today = dubaiDate(), now = Math.floor(Date.now() / 1000) } = {}) {
  if (!RANGES.includes(range)) range = 'today';
  const { from, days } = rangeOf(range, today);
  // "Usual" is their average a day over the last 14 days, today included.
  const d14 = new Date(`${today}T12:00:00Z`); d14.setUTCDate(d14.getUTCDate() - 13);
  const usualFrom = d14.toISOString().slice(0, 10);

  const rows = await db.prepare(`
    WITH asked AS (
      SELECT c.user_id AS uid,
        COUNT(*) FILTER (WHERE ${DAY('m.created_at')} BETWEEN ?::date AND ?::date) AS asked,
        COUNT(DISTINCT ${DAY('m.created_at')}) FILTER (WHERE ${DAY('m.created_at')} BETWEEN ?::date AND ?::date) AS active_days,
        MIN(m.created_at) FILTER (WHERE ${DAY('m.created_at')} BETWEEN ?::date AND ?::date) AS first_at,
        MAX(m.created_at) FILTER (WHERE ${DAY('m.created_at')} BETWEEN ?::date AND ?::date) AS last_at,
        COUNT(*) FILTER (WHERE ${DAY('m.created_at')} BETWEEN ?::date AND ?::date) AS last14,
        MAX(m.created_at) AS last_chat
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' GROUP BY c.user_id),
    sent AS (SELECT user_id AS uid, COUNT(*) AS n FROM email_drafts
      WHERE status = 'sent' AND ${DAY('sent_at')} BETWEEN ?::date AND ?::date GROUP BY user_id),
    files AS (SELECT d.user_id AS uid, COUNT(*) AS n FROM documents d
      WHERE ${DAY('d.created_at')} BETWEEN ?::date AND ?::date AND ${OWN_FILE} GROUP BY d.user_id),
    todo AS (SELECT user_id AS uid,
        COUNT(*) FILTER (WHERE done AND ${DAY('done_at')} BETWEEN ?::date AND ?::date) AS ticked,
        COUNT(*) FILTER (WHERE NOT done) AS open,
        COUNT(*) FILTER (WHERE NOT done AND remind_at < ?) AS overdue
      FROM todos GROUP BY user_id)
    SELECT u.id, u.name, u.email, u.role, u.last_seen_at, (h.user_id IS NOT NULL) AS hidden,
      a.asked, a.active_days, a.first_at, a.last_at, a.last14, a.last_chat,
      s.n AS sent, f.n AS files, td.ticked, td.open, td.overdue
    FROM users u
    LEFT JOIN team_activity_hidden h ON h.user_id = u.id
    LEFT JOIN asked a ON a.uid = u.id
    LEFT JOIN sent s ON s.uid = u.id
    LEFT JOIN files f ON f.uid = u.id
    LEFT JOIN todo td ON td.uid = u.id
    WHERE NOT u.disabled AND NOT u.external
    ORDER BY u.name`).all(
    from, today, from, today, from, today, from, today, usualFrom, today,
    from, today, from, today, from, today, now,
  );

  const weekAgo = now - 7 * 86400;
  const people = rows.map((r) => {
    const usual = Math.round(n(r.last14) / 14);
    const asked = n(r.asked);
    const pace = asked / days;
    return {
      id: r.id, name: r.name || r.email, email: r.email, master: r.role === 'master', hidden: !!r.hidden,
      asked, activeDays: n(r.active_days), firstAt: t(r.first_at), lastAt: t(r.last_at), usual,
      lastChat: t(r.last_chat), lastSeen: t(r.last_seen_at),
      sent: n(r.sent), files: n(r.files), ticked: n(r.ticked), open: n(r.open), overdue: n(r.overdue),
      // Well below their own normal: only said of people who normally use Reem a fair amount.
      below: usual >= 5 && pace < usual * 0.5,
      idle: !r.last_chat || Number(r.last_chat) < weekAgo,
    };
  });
  const shown = people.filter((p) => !p.hidden);
  const sum = (k) => shown.reduce((a, p) => a + p[k], 0);
  return {
    range, from, today, days,
    totals: { active: shown.filter((p) => p.asked > 0).length, people: shown.length, asked: sum('asked'), sent: sum('sent'), files: sum('files'), ticked: sum('ticked') },
    people,
  };
}

/** One person in more detail: what they did in the range, their last 30 days, what is due. */
export async function personActivity(userId, { range = 'today', today = dubaiDate(), now = Math.floor(Date.now() / 1000) } = {}) {
  const id = Number(userId);
  const user = await db.prepare('SELECT id, name, email, last_seen_at FROM users WHERE id = ? AND NOT external').get(id);
  if (!user) return null;
  if (!RANGES.includes(range)) range = 'today';
  const { from } = rangeOf(range, today);
  const d30 = new Date(`${today}T12:00:00Z`); d30.setUTCDate(d30.getUTCDate() - 29);
  const from30 = d30.toISOString().slice(0, 10);
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const until = tomorrow.toISOString().slice(0, 10);

  const days = await db.prepare(`SELECT to_char(${DAY('m.created_at')}, 'YYYY-MM-DD') AS day, COUNT(*) AS asked
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.role = 'user' AND ${DAY('m.created_at')} BETWEEN ?::date AND ?::date
    GROUP BY 1 ORDER BY 1`).all(id, from30, today);
  const chats = await db.prepare(`SELECT c.id, c.title, COUNT(*) AS asked, MAX(m.created_at) AS last_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.role = 'user' AND ${DAY('m.created_at')} BETWEEN ?::date AND ?::date
    GROUP BY c.id, c.title ORDER BY last_at DESC LIMIT 100`).all(id, from, today);
  const sent = await db.prepare(`SELECT id, subject, to_addrs, sent_at FROM email_drafts
    WHERE user_id = ? AND status = 'sent' AND ${DAY('sent_at')} BETWEEN ?::date AND ?::date
    ORDER BY sent_at DESC LIMIT 100`).all(id, from, today);
  const files = await db.prepare(`SELECT d.id, COALESCE(d.title, d.name) AS title, d.folder, d.created_at FROM documents d
    WHERE d.user_id = ? AND ${DAY('d.created_at')} BETWEEN ?::date AND ?::date AND ${OWN_FILE}
    ORDER BY d.created_at DESC LIMIT 100`).all(id, from, today);
  const ticked = await db.prepare(`SELECT id, text, done_at FROM todos
    WHERE user_id = ? AND done AND ${DAY('done_at')} BETWEEN ?::date AND ?::date ORDER BY done_at DESC LIMIT 100`).all(id, from, today);
  // Overdue first, then today and tomorrow; to-dos with no date are only counted.
  const due = await db.prepare(`SELECT id, text, remind_at, (remind_at < ?) AS overdue FROM todos
    WHERE user_id = ? AND NOT done AND remind_at IS NOT NULL AND ${DAY('remind_at')} <= ?::date
    ORDER BY remind_at LIMIT 200`).all(now, id, until);
  const undated = await db.prepare('SELECT COUNT(*) AS n FROM todos WHERE user_id = ? AND NOT done AND remind_at IS NULL').get(id);

  const toList = (s) => { try { return JSON.parse(s || '[]').join(', '); } catch { return s || ''; } };
  return {
    person: { id: user.id, name: user.name || user.email, email: user.email, lastSeen: t(user.last_seen_at) },
    range, from, today,
    days: days.map((d) => ({ day: d.day, asked: n(d.asked) })),
    chats: chats.map((c) => ({ id: c.id, title: c.title || 'Untitled chat', asked: n(c.asked), lastAt: t(c.last_at) })),
    sent: sent.map((e) => ({ id: e.id, subject: e.subject || '(no subject)', to: toList(e.to_addrs), at: t(e.sent_at) })),
    files: files.map((f) => ({ id: f.id, title: f.title, folder: f.folder, at: t(f.created_at) })),
    ticked: ticked.map((x) => ({ id: x.id, text: x.text, at: t(x.done_at) })),
    due: due.map((x) => ({ id: x.id, text: x.text, at: t(x.remind_at), overdue: !!x.overdue })),
    undated: n(undated?.n),
  };
}

/** Take a person off the page, or put them back. Nothing else about them changes. */
export async function setHidden(userId, hidden) {
  const id = Number(userId);
  if (hidden) await db.prepare('INSERT INTO team_activity_hidden (user_id) VALUES (?) ON CONFLICT DO NOTHING').run(id);
  else await db.prepare('DELETE FROM team_activity_hidden WHERE user_id = ?').run(id);
  return { hidden: !!hidden };
}

export const teamActivityRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

teamActivityRoutes.get('/', wrap(async (req, res) => {
  res.json(await teamActivity({ range: String(req.query.range || 'today') }));
}));

teamActivityRoutes.get('/:id', wrap(async (req, res) => {
  const out = await personActivity(req.params.id, { range: String(req.query.range || 'today') });
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));

teamActivityRoutes.put('/:id/hidden', wrap(async (req, res) => {
  res.json(await setHidden(req.params.id, !!req.body.hidden));
}));
