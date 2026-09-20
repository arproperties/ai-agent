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
  await db.prepare(`UPDATE email_drafts SET status = ?, decided_at = extract(epoch from now())::bigint WHERE id = ?`)
    .run(approved ? 'approved' : 'rejected', d.id);
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
