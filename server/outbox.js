import { db } from './db.js';
import { decrypt } from './secrets.js';
import { imapAccount, imapActions } from './imap.js';
import { compose, sendRaw, friendlySmtp } from './smtp.js';
import { logAction, sendQuota } from './drafts.js';

// The only code in the app that sends mail on the user's behalf, and the only caller of
// SMTP. It is reached from exactly one place: a draft whose status is 'approved', which
// only the user can set. An agent has no path here.

async function markFailed(draft, message) {
  await db.prepare(`UPDATE email_drafts SET status = 'failed', error = ? WHERE id = ?`).run(String(message).slice(0, 500), draft.id);
}

// Putting a claimed draft back in the queue. Guarded on 'sending' so it can only ever undo
// a claim, never resurrect a draft that has already been decided one way or the other.
const unclaim = (id) => db.prepare(`UPDATE email_drafts SET status = 'approved' WHERE id = ? AND status = 'sending'`).run(id);

/**
 * Send one approved draft: compose, hand the exact bytes to SMTP, file the same bytes in
 * Sent. `send` and `append` are injectable so the tests can run without a mail server;
 * nothing in production passes them.
 */
export async function deliver(draft, { send = sendRaw, append = imapActions.appendToSent } = {}) {
  const acc = await imapAccount(draft.user_id);
  const log = (fields) => logAction(draft.user_id, { agentId: draft.agent_id, draftId: draft.id, ...fields });

  // Checked here and not only at the UI: between approving a draft and it reaching the
  // front of the queue, its owner may have turned sending off or disconnected the mailbox.
  // The last word on whether this mailbox may send is taken at the moment it would.
  if (!acc || !acc.can_write || !acc.smtp_host) {
    const why = 'Sending is turned off for this mailbox';
    await markFailed(draft, why);
    await log({ action: 'send', recipients: draft.to_addrs, target: draft.reply_to_id, ok: false, error: why });
    throw new Error(why);
  }

  // Outside the send, because a key the server cannot read is a fault in the deployment,
  // not an email that cannot be delivered. The draft goes back in the queue and sends once
  // the key is right; the user's card is never shown the name of an environment variable.
  let password;
  try {
    password = decrypt(acc.password_enc);
  } catch (e) {
    const why = 'This mailbox is not set up to send yet — whoever runs Jarvis needs to check its email settings.';
    console.error('[outbox] cannot decrypt the mailbox password:', e.message);
    await unclaim(draft.id);
    await log({ action: 'send', recipients: draft.to_addrs, target: draft.reply_to_id, ok: false, error: why });
    throw Object.assign(new Error(why), { cause: e });
  }

  let built;
  try {
    built = await compose({
      from: acc.email,
      to: JSON.parse(draft.to_addrs),
      cc: JSON.parse(draft.cc_addrs),
      subject: draft.subject,
      text: draft.body,
      inReplyTo: draft.in_reply_to,
      references: draft.refs,
    });
    await send(acc, password, built);
  } catch (e) {
    const why = friendlySmtp(e, acc.smtp_host);
    await markFailed(draft, why);
    await log({ action: 'send', recipients: draft.to_addrs, target: draft.reply_to_id, ok: false, error: why });
    throw Object.assign(new Error(why), { cause: e });
  }

  await db.prepare(`UPDATE email_drafts SET status = 'sent', message_id = ?, error = NULL,
      sent_at = extract(epoch from now())::bigint WHERE id = ?`).run(built.messageId, draft.id);
  await log({ action: 'send', recipients: draft.to_addrs, target: draft.reply_to_id, messageId: built.messageId });

  // The email has gone and cannot be recalled. A Sent copy that will not file is a filing
  // problem, so it is recorded on its own and never turns a delivered email into a failure.
  try {
    await append(draft.user_id, built.raw);
    await log({ action: 'sent_copy', messageId: built.messageId });
  } catch (e) {
    await log({ action: 'sent_copy', messageId: built.messageId, ok: false, error: e.message });
  }

  return { messageId: built.messageId };
}

/**
 * The queue is the set of approved drafts, so it survives a restart. One user over their
 * limit is skipped, not everybody behind them — and a draft over the limit stays approved,
 * because the user already said yes; it is the mail server that is not ready, not them.
 *
 * Nothing serialises the callers: approving kicks the queue, the agent's send_email tool
 * kicks it, the timer fires regardless, and two app instances would do all of that twice
 * over. So a draft is not sent because it was read as approved, it is sent because this
 * drain won the race to move it out of 'approved' — a row only one caller can claim. An
 * email that goes out twice cannot be taken back, so the claim is in the database, where
 * every instance can see it, rather than in a lock this process alone would respect.
 */
export async function drain({ deliverOne = deliver } = {}) {
  const rows = await db.prepare(`SELECT id, user_id FROM email_drafts WHERE status = 'approved' ORDER BY id LIMIT 50`).all();
  const throttled = new Set();
  let sent = 0;
  for (const { id, user_id: userId } of rows) {
    if (throttled.has(userId)) continue;
    if (!(await sendQuota(userId)).allowed) { throttled.add(userId); continue; }

    // Whoever this returns a row to owns the send. Another drain, or a reject landing in
    // between, leaves nothing to deliver and this one moves on.
    const claimed = await db.prepare(`UPDATE email_drafts SET status = 'sending' WHERE id = ? AND status = 'approved' RETURNING *`).get(id);
    if (!claimed) continue;

    try {
      await deliverOne(claimed);
      sent++;
    } catch (e) {
      // deliver() has already recorded it against the draft and the log. One bad draft
      // must not stop the queue behind it. The unclaim is for the paths that did not get
      // that far: a draft still holding the claim would otherwise never be sendable again.
      await unclaim(id).catch(() => {});
      console.error('[outbox]', id, e.message);
    }
  }
  return sent;
}

let timer = null;

/** Approving drains immediately; this is for drafts that were waiting on the rate limit. */
export async function startOutbox() {
  if (timer) return;

  // A process that died between claiming a draft and sending it leaves it 'sending'.
  // Nothing else can claim it, so put it back in the queue on the way up.
  // Honest caveat: a draft whose process died *after* SMTP accepted it but before the row
  // was written is indistinguishable from one that never left, and this sends it again.
  // That window is a few milliseconds wide; the alternative is a draft stuck forever.
  const back = await db.prepare(`UPDATE email_drafts SET status = 'approved' WHERE status = 'sending'`).run();
  if (back.changes) console.warn('[outbox]', back.changes, 'draft(s) left mid-send by a stopped process are back in the queue');

  timer = setInterval(() => drain().catch((e) => console.error('[outbox]', e.message)), 60000);
  timer.unref(); // never hold the process open for the sake of an empty queue
}

export const kick = () => drain().catch((e) => console.error('[outbox]', e.message));
