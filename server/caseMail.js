import { imapAccount, imapMatching } from './imap.js';
import { outlookAccount, outlookMatching } from './outlook.js';
import { searchTerm, mentionsCase } from './caseMatch.js';

// Finding a case's emails in the connected mailbox. Read-only, like the rest of the mail code.

const RECENT_CAP = 200; // discovery reads the newest 200 mails only, newest kept

/**
 * Every mail of one case. The mailbox search is only a net (it looks for the digits), so
 * each hit is checked again with mentionsCase; the same email can sit in Inbox and Sent
 * (or "All Mail"), so it is kept once, by Message-ID.
 */
export async function collectCase(box, caseNumber, { since } = {}) {
  const term = searchTerm(caseNumber);
  if (!term) return []; // no digits to look for: do not ask the mailbox for everything
  const found = await box.matching({ term, since });
  const seen = new Set();
  const out = [];
  for (const m of found) {
    if (!mentionsCase(m, caseNumber)) continue;
    const id = m.messageId || `key:${m.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The user's mailbox for case work (IMAP first, then Outlook, as connectedMailbox), or null. */
export async function caseMailbox(userId) {
  const imap = await imapAccount(userId);
  if (imap) {
    return {
      kind: 'imap',
      address: imap.email || 'connected mailbox',
      canSend: !!(imap.can_write && imap.smtp_host),
      matching: (opts) => imapMatching(userId, opts),
      recent: (since) => imapMatching(userId, { since, limit: RECENT_CAP }), // no term: everything since
    };
  }
  const out = await outlookAccount(userId);
  if (!out) return null;
  return {
    kind: 'outlook',
    address: out.email || 'connected mailbox',
    canSend: false, // Outlook stays read-only
    matching: (opts) => outlookMatching(userId, opts),
    recent: (since) => outlookMatching(userId, { since, limit: RECENT_CAP }),
  };
}
