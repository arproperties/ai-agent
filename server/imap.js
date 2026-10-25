import { Router } from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveMx } from 'node:dns/promises';
import { db } from './db.js';
import { encrypt, decrypt } from './secrets.js';
import { smtpDefaults } from './smtp.js';
import { pickAttachment, attachmentText } from './emailAttachments.js';

// Any IMAP mailbox (Titan, Gmail, Zoho, Yahoo, cPanel hosting…). Read-only: folders are opened with EXAMINE,
// so reading never marks mail as read, and nothing is sent, moved or deleted.

export const imapAccount = (userId) => db.prepare('SELECT * FROM imap_accounts WHERE user_id = ?').get(userId);
// note: async (db.get returns a promise) — every caller must await it

// ---------- finding the server ----------
const KNOWN = [ // mail server (MX) of the domain -> its IMAP server
  [/titan\.email$/, 'imap.titan.email'],
  [/(google|googlemail)\.com$/, 'imap.gmail.com'],
  [/(outlook|office365)\.com$/, 'outlook.office365.com'],
  [/zoho\.(com|eu|in)$/, 'imap.zoho.com'],
  [/yahoodns\.net$/, 'imap.mail.yahoo.com'],
  [/icloud\.com$/, 'imap.mail.me.com'],
  [/secureserver\.net$/, 'imap.secureserver.net'],
];
export async function detectHost(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) throw new Error('Please enter a valid email address');
  const mx = await resolveMx(domain).catch(() => []);
  for (const { exchange } of mx.sort((a, b) => a.priority - b.priority)) {
    const hit = KNOWN.find(([re]) => re.test(exchange.toLowerCase()));
    if (hit) return hit[1];
  }
  return `imap.${domain}`;
}

export function client({ host, port, username, password }) {
  return new ImapFlow({
    host, port, secure: port === 993, auth: { user: username, pass: password },
    logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}
export function friendly(e, host) {
  if (e.authenticationFailed) return 'Wrong email or password, or IMAP access is turned off in your email settings.';
  if (/ENOTFOUND|EAI_AGAIN/.test(e.code || e.message)) return `Couldn't find the mail server ${host}. Check the server under Advanced.`;
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(e.code || e.message)) return `Couldn't reach ${host}. Check the server and port under Advanced.`;
  return e.responseText || e.message;
}

// connect, run fn, always log out
export async function withMailbox(acc, fn) {
  const c = client({ host: acc.host, port: acc.port, username: acc.username, password: decrypt(acc.password_enc) });
  c.on('error', () => {}); // socket errors after logout must not crash the server
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`Email: ${friendly(e, acc.host)}`);
  }
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

/**
 * The SMTP columns to store, from whatever the user typed plus the provider default.
 * Port 465 means implicit TLS and 587 means STARTTLS, so a port on its own is enough to
 * decide — but an explicit choice wins, because some hosts do run TLS on odd ports.
 */
export function applySmtp(body, imapHost) {
  const d = smtpDefaults(imapHost);
  const host = String(body.smtpHost || '').trim().toLowerCase().slice(0, 200) || d.host;
  if (host && !/^[a-z0-9.-]+$/.test(host)) throw Object.assign(new Error('The SMTP server name looks wrong'), { status: 400 });
  const port = Number(body.smtpPort) || d.port;
  const secure = 'smtpSecure' in body && body.smtpSecure !== null && body.smtpSecure !== ''
    ? !!body.smtpSecure
    : port === 465;
  return { smtp_host: host, smtp_port: port, smtp_secure: secure };
}

/**
 * Store the connection. Exported rather than inlined in the route because of what it does
 * NOT do: can_write is absent from the UPDATE list, so reconnecting a mailbox (new
 * password, moved server) neither re-grants sending nor revokes it. It is changed only by
 * PATCH, which is the switch the user sees — and that omission is now testable.
 */
export async function saveAccount(userId, { email, host, port, username, passwordEnc, smtp }) {
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, host = excluded.host, port = excluded.port,
      username = excluded.username, password_enc = excluded.password_enc,
      smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure,
      created_at = extract(epoch from now())::bigint`)
    .run(userId, email, host, port, username, passwordEnc, smtp.smtp_host, smtp.smtp_port, smtp.smtp_secure);
}

// ---------- routes (signed-in user) ----------
export const imapRoutes = Router();
const accountOut = (a) => a && {
  email: a.email, host: a.host, port: a.port,
  smtpHost: a.smtp_host, smtpPort: a.smtp_port, smtpSecure: a.smtp_secure,
  canWrite: a.can_write,
  connectedAt: a.created_at,
};

imapRoutes.get('/', async (req, res) => res.json({ account: accountOut(await imapAccount(req.user.id)) }));

// What we would use for this address, so the Advanced fields can show it before connecting.
// Reads nothing and stores nothing — it is one MX lookup.
imapRoutes.get('/suggest', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const host = await detectHost(email).catch(() => '');
  const smtp = smtpDefaults(host);
  res.json({ host, port: 993, smtpHost: smtp.host, smtpPort: smtp.port, smtpSecure: smtp.secure });
});

imapRoutes.post('/', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!password) return res.status(400).json({ error: 'Please enter your email password' });
  const host = String(req.body.host || '').trim().toLowerCase().slice(0, 200) || await detectHost(email);
  if (!/^[a-z0-9.-]+$/.test(host)) return res.status(400).json({ error: 'The server name looks wrong' });
  const port = Number(req.body.port) || 993;
  const username = String(req.body.username || '').trim().slice(0, 200) || email;
  const enc = encrypt(password); // before connecting: a missing EMAIL_KEY should fail fast
  const smtp = applySmtp(req.body, host);

  const c = client({ host, port, username, password });
  c.on('error', () => {});
  try {
    await c.connect(); // test the login before saving anything
    await c.logout().catch(() => c.close());
  } catch (e) {
    return res.status(400).json({ error: friendly(e, host), host, port });
  }
  await saveAccount(req.user.id, { email, host, port, username, passwordEnc: enc, smtp });
  res.json({ account: accountOut(await imapAccount(req.user.id)) });
});

// Turning sending on, or correcting the SMTP server after the fact. Its own route because
// it is its own decision: it never takes a password and never touches the IMAP side.
imapRoutes.patch('/', async (req, res, next) => {
  try {
    const acc = await imapAccount(req.user.id);
    if (!acc) return res.status(404).json({ error: 'No email account is connected' });
    const smtp = applySmtp({
      smtpHost: req.body.smtpHost ?? acc.smtp_host,
      smtpPort: req.body.smtpPort ?? acc.smtp_port,
      smtpSecure: req.body.smtpSecure ?? acc.smtp_secure,
    }, acc.host);
    const canWrite = 'canWrite' in req.body ? !!req.body.canWrite : acc.can_write;
    if (canWrite && !smtp.smtp_host) return res.status(400).json({ error: 'Set an SMTP server under Advanced before turning sending on' });
    await db.prepare('UPDATE imap_accounts SET smtp_host = ?, smtp_port = ?, smtp_secure = ?, can_write = ? WHERE user_id = ?')
      .run(smtp.smtp_host, smtp.smtp_port, smtp.smtp_secure, canWrite, req.user.id);
    res.json({ account: accountOut(await imapAccount(req.user.id)) });
  } catch (e) { next(e); }
});

imapRoutes.delete('/', async (req, res) => {
  await db.prepare('DELETE FROM imap_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- tools for the agents (same inputs/outputs as the Outlook ones) ----------
const person = (list) => (list || []).map((a) => `${a.name || ''} <${a.address || ''}>`.trim()).join(', ') || 'unknown';
const stamp = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown date');
const hasAttachment = (node) => !!node && (node.disposition === 'attachment' || (node.childNodes || []).some(hasAttachment));

async function folders(c, box) {
  if (box === 'inbox') return ['INBOX'];
  const sent = (await c.list()).find((f) => f.specialUse === '\\Sent')?.path;
  if (box === 'sent') return sent ? [sent] : [];
  return ['INBOX', ...(sent ? [sent] : [])];
}

// ---------- has the user already answered it? ----------
const addr = (list) => (list || []).map((a) => String(a.address || '').toLowerCase()).filter(Boolean);
const bareSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd|aw|tr)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const msgIds = (s) => String(s || '').match(/<[^>]+>/g) || [];

/**
 * Which inbox messages the user has already answered, and when. Pure, so it is testable.
 * inbox: [{ key, messageId, subject, from: [address], at: Date, answeredFlag }]
 * sent:  [{ inReplyTo, references: [messageId], subject, to: [address], at: Date }]
 * A reply counts when the mail program marked it answered, when a sent email points at it
 * (In-Reply-To / References), or — for programs that drop those headers — when a later
 * sent email in the same subject went to the person who wrote it.
 */
export function answered(inbox, sent) {
  const byId = new Map();
  for (const s of sent) {
    for (const id of [s.inReplyTo, ...(s.references || [])].filter(Boolean)) {
      if (!byId.has(id) || byId.get(id) > s.at) byId.set(id, s.at);
    }
  }
  const out = new Map(); // key -> Date | null (null = answered, date unknown)
  for (const m of inbox) {
    let when = m.messageId ? byId.get(m.messageId) : undefined;
    if (!when) {
      const subj = bareSubject(m.subject);
      if (subj.length >= 4) {
        const hit = sent.filter((s) => s.at > m.at && bareSubject(s.subject) === subj && s.to.some((a) => m.from.includes(a)))
          .sort((a, b) => a.at - b.at)[0];
        when = hit?.at;
      }
    }
    if (when) out.set(m.key, when);
    else if (m.answeredFlag) out.set(m.key, null);
  }
  return out;
}

// The sent mail since `since`, as answered() reads it. At most the newest 400.
async function sentSince(c, since) {
  const path = await sentPath(c);
  if (!path) return [];
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    const day = new Date(since.getTime() - 86400000);
    const uids = ((await c.search({ since: day }, { uid: true })) || []).slice(-400);
    const out = [];
    if (!uids.length) return out;
    for await (const m of c.fetch(uids, { uid: true, envelope: true, internalDate: true, headers: ['references'] }, { uid: true })) {
      out.push({
        inReplyTo: msgIds(m.envelope?.inReplyTo)[0],
        references: msgIds(m.headers?.toString()),
        subject: m.envelope?.subject,
        to: [...addr(m.envelope?.to), ...addr(m.envelope?.cc)],
        at: new Date(m.envelope?.date || m.internalDate || 0),
      });
    }
    return out;
  } finally { lock.release(); }
}

async function searchEmail(userId, { query = '', folder, unread_only, since, limit = 10, include_replied }) {
  const top = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const q = String(query).trim().slice(0, 200);
  // A plain "what's in my inbox" leaves out what the user has already answered;
  // a search for something specific shows it, marked as answered.
  const hideReplied = !q && !include_replied;
  const criteria = {
    ...(q ? { text: q } : { all: true }),
    ...(unread_only ? { seen: false } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(since || '') ? { since: new Date(`${since}T00:00:00Z`) } : {}),
  };
  const date = (m) => new Date(m.envelope?.date || m.internalDate || 0);
  let skipped = 0;
  const found = await withMailbox(await imapAccount(userId), async (c) => {
    const out = [];
    for (const path of await folders(c, folder || (q ? 'all' : 'inbox'))) {
      const inbox = path === 'INBOX';
      let heads = [];
      let lock = await c.getMailboxLock(path, { readOnly: true });
      try {
        // Look further back in the inbox, so dropping answered mail still leaves a full page.
        const uids = ((await c.search(criteria, { uid: true })) || []).slice(inbox ? -top * 4 : -top); // highest UIDs = newest
        if (!uids.length) continue;
        for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true }, { uid: true })) heads.push(m);
      } finally { lock.release(); }

      let replied = new Map();
      if (inbox && heads.length) {
        const oldest = new Date(Math.min(...heads.map((m) => date(m).getTime())));
        const sent = await sentSince(c, oldest).catch(() => []);
        replied = answered(heads.map((m) => ({
          key: m.uid, messageId: m.envelope?.messageId, subject: m.envelope?.subject,
          from: addr(m.envelope?.from), at: date(m), answeredFlag: m.flags?.has('\\Answered'),
        })), sent);
      }
      heads.sort((a, b) => date(b) - date(a));
      if (hideReplied && inbox) {
        const kept = heads.filter((m) => !replied.has(m.uid)).slice(0, top);
        const cutoff = kept.length === top ? date(kept[top - 1]) : new Date(0);
        skipped += heads.filter((m) => replied.has(m.uid) && date(m) >= cutoff).length; // only the ones that would have shown
        heads = kept;
      }
      heads = heads.slice(0, top);
      if (!heads.length) continue;

      const previews = new Map();
      lock = await c.getMailboxLock(path, { readOnly: true });
      try {
        for await (const m of c.fetch(heads.map((m) => m.uid), { uid: true, source: { maxLength: 20000 } }, { uid: true })) {
          previews.set(m.uid, await simpleParser(m.source).then((p) => p.text || '').catch(() => ''));
        }
      } finally { lock.release(); }
      for (const m of heads) out.push({ id: `${path}:${m.uid}`, m, preview: previews.get(m.uid) || '', replied: replied.has(m.uid) ? replied.get(m.uid) || true : false });
    }
    return out;
  });
  const note = skipped ? `\n\n(${skipped} email${skipped === 1 ? '' : 's'} the user already replied to ${skipped === 1 ? 'was' : 'were'} left out. ` +
    'Do not mention them unless asked; search with include_replied to see them.)' : '';
  if (!found.length) return `No emails found.${note}`;
  return found.sort((a, b) => date(b.m) - date(a.m)).slice(0, top).map(({ id, m, preview, replied }) => [
    `[id: ${id}] ${stamp(date(m))} · From: ${person(m.envelope?.from)} · Subject: ${m.envelope?.subject || '(no subject)'}` +
      `${m.flags?.has('\\Seen') ? '' : ' · UNREAD'}${hasAttachment(m.bodyStructure) ? ' · has attachments' : ''}` +
      `${replied ? ` · ALREADY REPLIED${replied instanceof Date ? ` ${stamp(replied)}` : ''}` : ''}`,
    `  ${preview.replace(/\s+/g, ' ').slice(0, 220)}`,
  ].join('\n')).join('\n\n') + note;
}

// One whole message, parsed. `path` rides along because read_email reports the folder.
async function fetchParsed(userId, id) {
  const i = String(id || '').lastIndexOf(':');
  const path = String(id).slice(0, i);
  const uid = Number(String(id).slice(i + 1));
  if (i < 1 || !uid) throw new Error('Unknown email id: use an id from search_email');
  const p = await withMailbox(await imapAccount(userId), async (c) => {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m?.source) throw new Error('That email no longer exists');
      return simpleParser(m.source);
    } finally { lock.release(); }
  });
  return { p, path };
}

const attached = (p) => (p.attachments || []).filter((a) => a.contentDisposition !== 'inline')
  .map((a) => ({ name: a.filename || 'unnamed', mimetype: a.contentType, buffer: a.content }));

/** One attachment's bytes: { name, mimetype, buffer }. For reading it, or for sending it on. */
export async function emailFile(userId, { id, name }) {
  const { p } = await fetchParsed(userId, id);
  return pickAttachment(attached(p), name);
}

const readAttachment = async (userId, input) => attachmentText(await emailFile(userId, input));

async function readEmail(userId, { id }) {
  const { p, path } = await fetchParsed(userId, id);
  const files = attached(p).map((a) => a.name);
  const body = String(p.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return [
    `Subject: ${p.subject || '(no subject)'}`,
    `From: ${p.from?.text || 'unknown'}`,
    `To: ${p.to?.text || ''}`,
    ...(p.cc?.text ? [`Cc: ${p.cc.text}`] : []),
    `Date: ${stamp(p.date)}`,
    `Folder: ${path}`,
    ...(files.length ? [`Attachments: ${files.join(', ')}`] : []),
    '',
    body.length > 15000 ? `${body.slice(0, 15000)}\n…(truncated)` : body,
  ].join('\n');
}

export const imapTools = { search_email: searchEmail, read_email: readEmail, read_attachment: readAttachment };

/**
 * The newest inbox mail since a moment, as plain records rather than a tool's text — for
 * server/suggestions.js, which reads it to spot deadlines. Read-only like everything above.
 * No mailbox connected is an empty list, not an error.
 */
export async function recentInbox(userId, { since, limit = 20 } = {}) {
  const acc = await imapAccount(userId);
  if (!acc) return [];
  return withMailbox(acc, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = ((await c.search({ since }, { uid: true })) || []).slice(-limit);
      const out = [];
      if (!uids.length) return out;
      for await (const m of c.fetch(uids, { uid: true, envelope: true, internalDate: true, source: { maxLength: 20000 } }, { uid: true })) {
        const at = new Date(m.envelope?.date || m.internalDate || 0);
        if (at < since) continue; // IMAP "since" is by day; the hours are ours to check
        const text = await simpleParser(m.source).then((p) => p.text || '').catch(() => '');
        out.push({ id: `INBOX:${m.uid}`, from: person(m.envelope?.from), subject: m.envelope?.subject || '(no subject)', at, text: text.replace(/\s+/g, ' ').slice(0, 600) });
      }
      return out;
    } finally { lock.release(); }
  });
}

/**
 * Every mail in the inbox and sent folder that has `term` in it (no term: every mail), as
 * full records, for case folders. Read-only. `since` is by day on the server, so the hours
 * are checked here. Newest `limit` kept, no 25 cap like the agent tool.
 * Mail = { key, messageId, at, from, to, subject, text, attachments: [{ name, mimetype, buffer }] }
 */
export async function imapMatching(userId, { term = '', since, limit = 500 } = {}) {
  const acc = await imapAccount(userId);
  if (!acc) return [];
  const criteria = { ...(term ? { text: term } : { all: true }), ...(since ? { since } : {}) };
  return withMailbox(acc, async (c) => {
    const sent = await sentPath(c);
    const out = [];
    for (const path of ['INBOX', ...(sent ? [sent] : [])]) {
      const lock = await c.getMailboxLock(path, { readOnly: true });
      try {
        const uids = ((await c.search(criteria, { uid: true })) || []).slice(-limit); // highest UIDs = newest
        if (!uids.length) continue;
        for await (const m of c.fetch(uids, { uid: true, internalDate: true, source: true }, { uid: true })) {
          const p = await simpleParser(m.source).catch(() => null);
          if (!p) continue;
          const at = new Date(p.date || m.internalDate || 0);
          if (since && at < since) continue;
          out.push({
            key: `${path}:${m.uid}`, messageId: p.messageId || null, at,
            from: p.from?.text || 'unknown', to: p.to?.text || '', subject: p.subject || '(no subject)',
            text: String(p.text || ''), attachments: attached(p),
          });
        }
      } finally { lock.release(); }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  });
}

// ---------- acting on the mailbox ----------
// Everything below opens a writable lock, unlike the read tools above. All of it is
// reversible and all of it stays inside the mailbox: nothing here sends, and nothing here
// deletes. Sending lives in server/outbox.js, behind the user's approval.

export function parseId(id) {
  const s = String(id || '');
  const i = s.lastIndexOf(':');
  const path = s.slice(0, i);
  const uid = Number(s.slice(i + 1));
  if (i < 1 || !Number.isInteger(uid) || uid < 1) throw new Error('Unknown email id: use an id from search_email');
  return { path, uid };
}

/** Folders are addressed by what the user calls them, not by their IMAP path. */
export const resolveFolder = (boxes, wanted) => {
  const want = String(wanted || '').trim().toLowerCase();
  return boxes.find((f) => f.path.toLowerCase() === want || f.name.toLowerCase() === want);
};

export const replySubject = (s) => (/^re\s*:/i.test(String(s || '').trim()) ? String(s).trim() : `Re: ${String(s || '').trim() || '(no subject)'}`);

/** The thread so far, plus the message being answered. Folded header lines unfold to one. */
export function buildRefs(existing, messageId) {
  const ids = String(existing || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (messageId && !ids.includes(messageId)) ids.push(messageId);
  return ids.length ? ids.join(' ') : null;
}

export const sentPath = async (c) => {
  const boxes = await c.list();
  return boxes.find((f) => f.specialUse === '\\Sent')?.path || boxes.find((f) => /^sent/i.test(f.name))?.path || null;
};

async function markSeen(userId, id, seen) {
  const { path, uid } = parseId(id);
  await withMailbox(await imapAccount(userId), async (c) => {
    const lock = await c.getMailboxLock(path); // writable, unlike the read tools above: marking seen is a write
    try {
      const fn = seen ? c.messageFlagsAdd.bind(c) : c.messageFlagsRemove.bind(c);
      if (!(await fn(String(uid), ['\\Seen'], { uid: true }))) throw new Error('That email no longer exists');
    } finally { lock.release(); }
  });
  return seen ? 'Marked as read.' : 'Marked as unread.';
}

async function moveMessage(userId, id, folder) {
  const { path, uid } = parseId(id);
  return withMailbox(await imapAccount(userId), async (c) => {
    const boxes = await c.list();
    const target = resolveFolder(boxes, folder);
    if (!target) throw new Error(`There is no folder called "${folder}". The mailbox has: ${boxes.map((f) => f.name).join(', ')}`);
    if (target.path === path) return `That email is already in ${target.name}.`;
    const lock = await c.getMailboxLock(path);
    try {
      if (!(await c.messageMove(String(uid), target.path, { uid: true }))) throw new Error('That email no longer exists');
    } finally { lock.release(); }
    return `Moved to ${target.name}.`;
  });
}

/** What a reply needs from the email it answers: who to write to, and how to thread onto it. */
async function original(userId, id) {
  const { path, uid } = parseId(id);
  return withMailbox(await imapAccount(userId), async (c) => {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const m = await c.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
      if (!m?.envelope) throw new Error('That email no longer exists');
      const e = m.envelope;
      const existing = String(m.headers || '').replace(/^references:/i, '').trim();
      const addrs = (list) => (list || []).map((a) => a.address).filter(Boolean);
      return {
        messageId: e.messageId || null,
        refs: buildRefs(existing, e.messageId),
        subject: e.subject || '',
        from: addrs(e.replyTo?.length ? e.replyTo : e.from),
        to: addrs(e.to),
        cc: addrs(e.cc),
      };
    } finally { lock.release(); }
  });
}

/** The copy in Sent. Byte-identical to what went out, so the reply threads onto it. */
async function appendToSent(userId, raw) {
  await withMailbox(await imapAccount(userId), async (c) => {
    const path = await sentPath(c);
    if (!path) throw new Error('This mailbox has no Sent folder');
    await c.append(path, raw, ['\\Seen']);
  });
}

export const imapActions = { markSeen, moveMessage, original, appendToSent };
