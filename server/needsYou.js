// Needs you: everything Reem has got ready that is waiting on this person's tap, across all their
// chats (an email to approve, a reminder to send, a booking to create, a rule to learn...). Each is a
// card in the chat it came from; nothing else in the app lists them in one place. This only lists
// what is waiting and points at the chat: approving or cancelling is still done on the card, so
// nothing is decided from here. Every query is for the person asking, never for anyone else.
import { Router } from 'express';
import { db } from './db.js';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// [kind, what to call it, SQL for the person's own waiting rows]. Each row gives id,
// conversation_id (the chat the card is in), title and created_at.
const WAITING = [
  ['email', 'Email to approve',
    `SELECT id, conversation_id, COALESCE(NULLIF(subject, ''), '(no subject)') AS title, created_at FROM email_drafts WHERE user_id = ? AND status = 'pending'`],
  ['reminder', 'Reminder to send',
    `SELECT id, conversation_id, text AS title, created_at FROM team_reminders WHERE sender_id = ? AND status = 'pending'`],
  ['duty', 'Change to a responsibility',
    `SELECT id, conversation_id, '' AS title, created_at FROM responsibility_proposals WHERE master_id = ? AND status = 'pending'`],
  ['address', 'Company address to add',
    `SELECT id, conversation_id, email AS title, created_at FROM address_proposals WHERE master_id = ? AND status = 'pending'`],
  ['rule', 'Rule to learn',
    `SELECT id, conversation_id, rule AS title, created_at FROM lesson_proposals WHERE master_id = ? AND status = 'pending'`],
  ['stock', 'Stock to add',
    `SELECT id, conversation_id, '' AS title, created_at FROM inventory_proposals WHERE user_id = ? AND status = 'pending'`],
  ['booking', 'ARS booking to create',
    `SELECT id, conversation_id, '' AS title, created_at FROM ars_booking_requests WHERE user_id = ? AND status = 'pending'`],
  ['case', 'Case folder to save',
    `SELECT id, conversation_id, name AS title, created_at FROM case_proposals WHERE user_id = ? AND status = 'pending'`],
  ['site', 'Site update to confirm',
    `SELECT id, conversation_id, kind AS title, created_at FROM project_proposals WHERE user_id = ? AND status = 'pending'`],
];

/** What is waiting on this person, oldest first (the one left longest is the one to do first). */
export async function needsYou(user, limit = 30) {
  const rows = [];
  for (const [kind, label, sql] of WAITING) {
    for (const r of await db.prepare(sql).all(user.id)) {
      rows.push({ kind, label, id: r.id, conversation_id: r.conversation_id || null, title: String(r.title || ''), created_at: num(r.created_at) });
    }
  }
  rows.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const t = now();
  const items = rows.slice(0, limit).map((r) => ({ ...r, waiting_days: r.created_at ? Math.max(0, Math.floor((t - r.created_at) / DAY)) : 0 }));
  return { total: rows.length, items };
}

// ---------- route ----------

export const needsYouRoutes = Router();
needsYouRoutes.get('/', (req, res, next) => { needsYou(req.user).then((r) => res.json(r)).catch(next); });
