import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { isExternal } from './access.js';
import { userModules } from './modules.js';
import { imapAccount } from './imap.js';
import { decrypt } from './secrets.js';
import { fromLoopback } from './apps.js';

// Email in Claude.ai: each person connects their own work mailbox (Titan) to their own
// Claude.ai as a custom connector, so Claude can read, search and send their mail.
//
// The mailbox is the one they already connected under Email (imap_accounts), so nobody
// types their password twice; this only adds a private link to it. The connector itself
// is a separate small program on the same machine (business-mail-connector/, pm2
// business-mail-connector, port 3003): nginx sends https://<site>/mail-mcp/<token> to it,
// and it asks Reem here, over loopback, which mailbox that token opens.
//
// The link is the key, so a link only works while all of these still hold: the person
// still has the module (the master can untick it), is not switched off or external, and
// still has a mailbox under Email. Sending is offered only when their own "Allow sending
// and actions" switch under Email is on, the same switch Reem's agents obey.

export const LINK_PATH = '/mail-mcp/';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const newToken = () => randomBytes(24).toString('base64url');

/** What the person's screen shows: their mailbox (from Email) and their link, never the password. */
export async function myConnector(userId) {
  const acc = await imapAccount(userId);
  const row = await db.prepare('SELECT token, created_at FROM mail_connectors WHERE user_id = ?').get(userId);
  return {
    mailbox: acc ? { email: acc.email, canSend: !!(acc.can_write && acc.smtp_host) } : null,
    link: row ? `${LINK_PATH}${row.token}` : null, // the browser puts its own origin in front
    madeAt: row ? Number(row.created_at) : null,
  };
}

/** Make the link, or a new one: the old one stops working at once. */
export async function makeLink(userId) {
  if (!(await imapAccount(userId))) throw bad('Connect your mailbox under Email first');
  await db.prepare(`INSERT INTO mail_connectors (user_id, token) VALUES (?, ?)
    ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, created_at = extract(epoch from now())::bigint`)
    .run(userId, newToken());
  return myConnector(userId);
}

export async function removeLink(userId) {
  await db.prepare('DELETE FROM mail_connectors WHERE user_id = ?').run(userId);
}

/** For the master: who has a link, so one can be switched off. */
export async function listConnected() {
  return db.prepare(`SELECT m.user_id AS "userId", u.name, a.email, m.created_at AS "madeAt"
    FROM mail_connectors m JOIN users u ON u.id = m.user_id LEFT JOIN imap_accounts a ON a.user_id = m.user_id
    ORDER BY lower(u.name)`).all();
}

/**
 * The mailbox behind a link, for the connector. Null when the link is wrong or old, or
 * when its owner has since lost the right to it.
 */
export async function loginFor(token) {
  if (!token) return null;
  const r = await db.prepare(`SELECT u.id, u.role, u.external, u.disabled FROM mail_connectors m
    JOIN users u ON u.id = m.user_id WHERE m.token = ?`).get(String(token));
  if (!r || r.disabled || isExternal(r)) return null;
  if (!(await userModules(r)).includes('claude_mail')) return null;
  const acc = await imapAccount(r.id);
  if (!acc) return null;
  let password;
  try { password = decrypt(acc.password_enc); } catch { return null; } // saved under another EMAIL_KEY
  return {
    email: acc.email,
    password,
    imap: { host: acc.host, port: acc.port, username: acc.username },
    smtp: acc.can_write && acc.smtp_host ? { host: acc.smtp_host, port: acc.smtp_port, secure: acc.smtp_secure } : null,
  };
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The person's own screen (mounted behind needsModule('claude_mail')).
export const mailConnectorRoutes = Router();
mailConnectorRoutes.get('/', wrap(async (req, res) => res.json(await myConnector(req.user.id))));
mailConnectorRoutes.post('/link', wrap(async (req, res) => res.json(await makeLink(req.user.id))));
mailConnectorRoutes.delete('/', wrap(async (req, res) => {
  await removeLink(req.user.id);
  res.json(await myConnector(req.user.id));
}));

// The master's list in Settings → Apps.
export const mailConnectorPeopleRoutes = Router();
mailConnectorPeopleRoutes.use(requireMaster);
mailConnectorPeopleRoutes.get('/', wrap(async (req, res) => res.json(await listConnected())));
mailConnectorPeopleRoutes.delete('/:userId', wrap(async (req, res) => {
  await removeLink(Number(req.params.userId) || 0);
  res.json(await listConnected());
}));

// The connector's door: this machine only, never through nginx (see apps.js).
export const mailConnectorDoor = Router();
mailConnectorDoor.get('/:token', wrap(async (req, res) => {
  if (!fromLoopback(req)) return res.status(404).json({ error: 'Not found' });
  const login = await loginFor(req.params.token);
  if (!login) return res.status(404).json({ error: 'Not found' });
  res.json(login);
}));
