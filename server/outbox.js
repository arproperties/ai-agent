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

/**
 * Send one approved draft: compose, hand the exact bytes to SMTP, file the same bytes in
 * Sent. `send` and `append` are injectable so the tests can run without a mail server;
 * nothing in production passes them.
 */
export async function deliver(draft, { send = sendRaw, append = imapActions.appendToSent } = {}) {
  const acc = await imapAccount(draft.user_id);

  // Checked here and not only at the UI: between approving a draft and it reaching the
  // front of the queue, its owner may have turned sending off or disconnected the mailbox.
  // The last word on whether this mailbox may send is taken at the moment it would.
  if (!acc || !acc.can_write || !acc.smtp_host) {
    await markFailed(draft, 'Sending is turned off for this mailbox');
    throw new Error('Sending is turned off for this mailbox');
  }

  const log = (fields) => logAction(draft.user_id, { agentId: draft.agent_id, draftId: draft.id, ...fields });

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
    await send(acc, decrypt(acc.password_enc), built);
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
 */
export async function drain({ deliverOne = deliver } = {}) {
  const rows = await db.prepare(`SELECT * FROM email_drafts WHERE status = 'approved' ORDER BY id LIMIT 50`).all();
  const throttled = new Set();
  let sent = 0;
  for (const d of rows) {
    if (throttled.has(d.user_id)) continue;
    if (!(await sendQuota(d.user_id)).allowed) { throttled.add(d.user_id); continue; }
    try {
      await deliverOne(d);
      sent++;
    } catch (e) {
      // deliver() has already recorded it against the draft and the log. One bad draft
      // must not stop the queue behind it.
      console.error('[outbox]', d.id, e.message);
    }
  }
  return sent;
}

let timer = null;

/** Approving drains immediately; this is for drafts that were waiting on the rate limit. */
export function startOutbox() {
  if (timer) return;
  timer = setInterval(() => drain().catch((e) => console.error('[outbox]', e.message)), 60000);
  timer.unref(); // never hold the process open for the sake of an empty queue
}

export const kick = () => drain().catch((e) => console.error('[outbox]', e.message));
