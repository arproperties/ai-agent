import { Router } from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveMx } from 'node:dns/promises';
import { db } from './db.js';
import { encrypt, decrypt } from './secrets.js';

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
async function detectHost(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) throw new Error('Please enter a valid email address');
  const mx = await resolveMx(domain).catch(() => []);
  for (const { exchange } of mx.sort((a, b) => a.priority - b.priority)) {
    const hit = KNOWN.find(([re]) => re.test(exchange.toLowerCase()));
    if (hit) return hit[1];
  }
  return `imap.${domain}`;
}

function client({ host, port, username, password }) {
  return new ImapFlow({
    host, port, secure: port === 993, auth: { user: username, pass: password },
    logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}
function friendly(e, host) {
  if (e.authenticationFailed) return 'Wrong email or password, or IMAP access is turned off in your email settings.';
  if (/ENOTFOUND|EAI_AGAIN/.test(e.code || e.message)) return `Couldn't find the mail server ${host}. Check the server under Advanced.`;
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(e.code || e.message)) return `Couldn't reach ${host}. Check the server and port under Advanced.`;
  return e.responseText || e.message;
}

// connect, run fn, always log out
async function withMailbox(acc, fn) {
  const c = client({ host: acc.host, port: acc.port, username: acc.username, password: decrypt(acc.password_enc) });
  c.on('error', () => {}); // socket errors after logout must not crash the server
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`Email: ${friendly(e, acc.host)}`);
  }
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

// ---------- routes (signed-in user) ----------
export const imapRoutes = Router();
const accountOut = (a) => a && { email: a.email, host: a.host, port: a.port, connectedAt: a.created_at };

imapRoutes.get('/', async (req, res) => res.json({ account: accountOut(await imapAccount(req.user.id)) }));

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

  const c = client({ host, port, username, password });
  c.on('error', () => {});
  try {
    await c.connect(); // test the login before saving anything
    await c.logout().catch(() => c.close());
  } catch (e) {
    return res.status(400).json({ error: friendly(e, host), host, port });
  }
  await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, port, username, password_enc) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, host = excluded.host, port = excluded.port,
      username = excluded.username, password_enc = excluded.password_enc, created_at = extract(epoch from now())::bigint`)
    .run(req.user.id, email, host, port, username, enc);
  res.json({ account: accountOut(await imapAccount(req.user.id)) });
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

async function searchEmail(userId, { query = '', folder, unread_only, since, limit = 10 }) {
  const top = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const q = String(query).trim().slice(0, 200);
  const criteria = {
    ...(q ? { text: q } : { all: true }),
    ...(unread_only ? { seen: false } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(since || '') ? { since: new Date(`${since}T00:00:00Z`) } : {}),
  };
  const found = await withMailbox(await imapAccount(userId), async (c) => {
    const out = [];
    for (const path of await folders(c, folder || (q ? 'all' : 'inbox'))) {
      const lock = await c.getMailboxLock(path, { readOnly: true });
      try {
        const uids = ((await c.search(criteria, { uid: true })) || []).slice(-top); // highest UIDs = newest
        if (!uids.length) continue;
        const query = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, source: { maxLength: 20000 } };
        for await (const m of c.fetch(uids, query, { uid: true })) {
          const preview = await simpleParser(m.source).then((p) => p.text || '').catch(() => '');
          out.push({ id: `${path}:${m.uid}`, m, preview });
        }
      } finally { lock.release(); }
    }
    return out;
  });
  if (!found.length) return 'No emails found.';
  const date = (m) => new Date(m.envelope?.date || m.internalDate || 0);
  return found.sort((a, b) => date(b.m) - date(a.m)).slice(0, top).map(({ id, m, preview }) => [
    `[id: ${id}] ${stamp(date(m))} · From: ${person(m.envelope?.from)} · Subject: ${m.envelope?.subject || '(no subject)'}` +
      `${m.flags?.has('\\Seen') ? '' : ' · UNREAD'}${hasAttachment(m.bodyStructure) ? ' · has attachments' : ''}`,
    `  ${preview.replace(/\s+/g, ' ').slice(0, 220)}`,
  ].join('\n')).join('\n\n');
}

async function readEmail(userId, { id }) {
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
  const files = (p.attachments || []).filter((a) => a.contentDisposition !== 'inline').map((a) => a.filename || 'unnamed');
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

export const imapTools = { search_email: searchEmail, read_email: readEmail };
