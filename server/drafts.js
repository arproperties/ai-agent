import { db } from './db.js';

// An email an agent wrote, waiting for its owner. Nothing here sends anything — the whole
// point of this module is that writing an email and sending one are two separate acts with
// a human between them. server/outbox.js is the other half.

export const MAX_RECIPIENTS = Number(process.env.EMAIL_MAX_RECIPIENTS) || 10;

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });

/** A list of bare, lowercased, deduped addresses — or a 400 naming the one that is wrong. */
export function cleanAddresses(value, label) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  const list = raw
    .map((a) => String(a).trim().replace(/^.*<|>.*$/g, '').trim().toLowerCase())
    .filter(Boolean);
  for (const a of list) if (!ADDRESS.test(a)) throw fail(400, `${label} is not a valid email address: ${a}`);
  return [...new Set(list)];
}

export async function createDraft(userId, {
  agentId = null, conversationId = null, to, cc = [], subject = '', body = '',
  inReplyTo = null, refs = null, replyToId = null,
}) {
  const toList = cleanAddresses(to, 'To');
  const ccList = cleanAddresses(cc, 'Cc');
  if (!toList.length) throw fail(400, 'A draft needs at least one recipient');
  // Together, not each: ten recipients is ten people receiving it, wherever their address sits.
  if (toList.length + ccList.length > MAX_RECIPIENTS) throw fail(400, `Too many recipients (at most ${MAX_RECIPIENTS} across To and Cc)`);

  const { id } = await db.prepare(
    `INSERT INTO email_drafts (user_id, agent_id, conversation_id, to_addrs, cc_addrs, subject, body, in_reply_to, refs, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(
    userId, agentId, conversationId,
    JSON.stringify(toList), JSON.stringify(ccList),
    String(subject || '').slice(0, 200), String(body || '').slice(0, 20000),
    inReplyTo, refs, replyToId,
  );
  return getDraft(userId, id);
}

export const getDraft = (userId, id) =>
  db.prepare('SELECT * FROM email_drafts WHERE id = ? AND user_id = ?').get(Number(id), userId);

export function listDrafts(userId, { conversationId = null, status = null } = {}) {
  return db.prepare(`SELECT * FROM email_drafts
    WHERE user_id = ?
      AND (?::int IS NULL OR conversation_id = ?::int)
      AND (?::text IS NULL OR status = ?::text)
    ORDER BY id DESC LIMIT 100`)
    .all(userId, conversationId, conversationId, status, status);
}

/** The user's decision. Made once: a decided draft never goes back to pending. */
export async function decideDraft(userId, id, approved) {
  const d = await getDraft(userId, id);
  if (!d) throw fail(404, 'Draft not found');
  if (d.status !== 'pending') throw fail(409, `This draft is already ${d.status}`);
  // The read above is only for the message. The decision itself is this one statement:
  // two tabs tapping at once both pass the check, and only one of them changes a row.
  const { changes } = await db.prepare(
    `UPDATE email_drafts SET status = ?, decided_at = extract(epoch from now())::bigint WHERE id = ? AND status = 'pending'`
  ).run(approved ? 'approved' : 'rejected', d.id);
  if (changes !== 1) throw fail(409, 'This draft has already been decided');
  return getDraft(userId, id);
}

export const draftOut = (d) => d && {
  id: d.id,
  agentId: d.agent_id,
  conversationId: d.conversation_id,
  to: JSON.parse(d.to_addrs),
  cc: JSON.parse(d.cc_addrs),
  subject: d.subject,
  body: d.body,
  status: d.status,
  error: d.error,
  messageId: d.message_id,
  isReply: !!d.in_reply_to,
  createdAt: d.created_at,
  sentAt: d.sent_at,
};

// ---------- the record, and the limit ----------
// Titan caps outbound mail per mailbox per day. Going over does not bounce one message, it
// gets the mailbox throttled, so the limit lives here and is checked before every send.
// Over the limit is not an error: the draft stays approved and the outbox comes back to it.

export const PER_HOUR = Number(process.env.EMAIL_SEND_PER_HOUR) || 20;
export const PER_DAY = Number(process.env.EMAIL_SEND_PER_DAY) || 100;

export async function logAction(userId, { agentId = null, action, draftId = null, recipients = null, target = null, messageId = null, ok = true, error = null }) {
  await db.prepare(
    `INSERT INTO email_action_log (user_id, agent_id, action, draft_id, recipients, target, message_id, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, agentId, action, draftId,
    recipients == null ? null : typeof recipients === 'string' ? recipients : JSON.stringify(recipients),
    target, messageId, ok, error ? String(error).slice(0, 500) : null,
  );
}

export async function sendQuota(userId) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.prepare(
    `SELECT created_at FROM email_action_log
     WHERE user_id = ? AND action = 'send' AND ok AND created_at > ? ORDER BY created_at`
  ).all(userId, now - 86400);

  const hourly = rows.filter((r) => r.created_at > now - 3600);
  const hour = hourly.length;
  const day = rows.length;
  const allowed = hour < PER_HOUR && day < PER_DAY;

  // When the next slot frees: the oldest send still inside whichever window is full.
  let retryInSeconds = 0;
  if (!allowed) {
    const hourWait = hour >= PER_HOUR ? hourly[0].created_at + 3600 - now : 0;
    const dayWait = day >= PER_DAY ? rows[0].created_at + 86400 - now : 0;
    retryInSeconds = Math.max(1, hourWait, dayWait);
  }
  return { hour, day, perHour: PER_HOUR, perDay: PER_DAY, allowed, retryInSeconds };
}

export const actionLog = (userId, limit = 100) =>
  db.prepare('SELECT * FROM email_action_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Number(limit) || 100, 500));
