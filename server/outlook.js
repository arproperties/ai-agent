import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { db } from './db.js';

// Outlook via Microsoft Graph. Read-only: agents can search and read mail, never send, move or delete.
const { MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
const AUTH = `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0`; // common = personal + work accounts
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access User.Read Mail.Read';
export const outlookEnabled = !!(MS_CLIENT_ID && MS_CLIENT_SECRET);

export const outlookAccount = (userId) => db.prepare('SELECT * FROM outlook_accounts WHERE user_id = ?').get(userId);

async function tokenRequest(params) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: SCOPES, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error_description?.split(/\r?\n/)[0] || data.error || 'Microsoft sign-in failed'), { code: data.error });
  return data;
}

const expiry = (t) => Math.floor(Date.now() / 1000) + (Number(t.expires_in) || 3600);

// a valid access token, refreshed when it is about to expire
async function accessToken(userId) {
  const acc = outlookAccount(userId);
  if (!acc) throw new Error('Outlook is not connected');
  if (acc.access_token && acc.expires_at > Date.now() / 1000 + 60) return acc.access_token;
  let t;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: acc.refresh_token });
  } catch (e) {
    if (e.code === 'invalid_grant') { // revoked, password changed or expired: the user has to connect again
      db.prepare('DELETE FROM outlook_accounts WHERE user_id = ?').run(userId);
      throw new Error('The Outlook connection has expired. Reconnect it from the Email button in the menu.');
    }
    throw e;
  }
  db.prepare('UPDATE outlook_accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?')
    .run(t.access_token, t.refresh_token || acc.refresh_token, expiry(t), userId);
  return t.access_token;
}

async function graph(userId, path, headers = {}) {
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${await accessToken(userId)}`, ...headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Outlook: ${data.error?.message || `request failed (${res.status})`}`);
  return data;
}

// ---------- connect / disconnect ----------
const pending = new Map(); // sign-in state -> { userId, redirectUri, verifier, expires }
const b64url = (buf) => buf.toString('base64url');

// the address the browser used (Vite dev server, tunnel or real domain); Microsoft checks it against the registered list
function appBase(req) {
  try { if (req.get('referer')) return new URL(req.get('referer')).origin; } catch { /* fall through */ }
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
const backToApp = (res, status, message) =>
  res.redirect(`/?${new URLSearchParams({ outlook: status, ...(message ? { message: message.slice(0, 200) } : {}) })}`);

// needs a signed-in user
export const outlookRoutes = Router();

outlookRoutes.get('/', (req, res) => {
  const acc = outlookAccount(req.user.id);
  res.json({ enabled: outlookEnabled, account: acc && { email: acc.email, connectedAt: acc.created_at } });
});

outlookRoutes.get('/connect', (req, res) => {
  if (!outlookEnabled) return backToApp(res, 'error', 'Outlook is not set up on the server yet (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
  for (const [k, p] of pending) if (p.expires < Date.now()) pending.delete(k);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const redirectUri = `${appBase(req)}/api/outlook/callback`;
  pending.set(state, { userId: req.user.id, redirectUri, verifier, expires: Date.now() + 10 * 60000 });
  res.redirect(`${AUTH}/authorize?${new URLSearchParams({
    client_id: MS_CLIENT_ID, response_type: 'code', response_mode: 'query', redirect_uri: redirectUri, scope: SCOPES, state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
  })}`);
});

outlookRoutes.delete('/', (req, res) => {
  db.prepare('DELETE FROM outlook_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Microsoft sends the browser back here. Public route: the one-time state identifies the user
// (an installed iPhone app may finish sign-in in a browser window without the app's cookie).
export const outlookCallback = Router();

outlookCallback.get('/callback', async (req, res) => {
  const p = pending.get(String(req.query.state || ''));
  pending.delete(String(req.query.state || ''));
  if (!p || p.expires < Date.now()) return backToApp(res, 'error', 'The sign-in took too long or was already used. Please try again.');
  if (req.query.error) return backToApp(res, 'error', String(req.query.error_description || req.query.error).split(/\r?\n/)[0]);
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: p.redirectUri, code_verifier: p.verifier });
    const me = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json());
    db.prepare(`INSERT INTO outlook_accounts (user_id, email, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, access_token = excluded.access_token,
        refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, created_at = unixepoch()`)
      .run(p.userId, me.mail || me.userPrincipalName || null, t.access_token, t.refresh_token, expiry(t));
    backToApp(res, 'connected');
  } catch (e) {
    console.error('[outlook]', e.message);
    backToApp(res, 'error', e.message);
  }
});

// ---------- tools for the agents ----------
export const EMAIL_TOOLS = [
  {
    name: 'search_email',
    description: "Search or list emails in the user's Outlook mailbox. Returns up to `limit` messages with id, date, sender, subject and a short preview. " +
      'Leave query empty to list the latest emails. Use read_email with an id to read the full message.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, a person, company or email address. Empty = latest emails.' },
        folder: { type: 'string', enum: ['inbox', 'sent', 'all'], description: 'Default: all folders when searching, inbox when listing.' },
        unread_only: { type: 'boolean' },
        since: { type: 'string', description: 'Only emails received on or after this date (YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 10.' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read one email in full (recipients, body text, attachment names and a link to open it in Outlook) by the id from search_email.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const person = (r) => (r?.emailAddress ? `${r.emailAddress.name || ''} <${r.emailAddress.address || ''}>`.trim() : 'unknown');
const stamp = (iso) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const SUMMARY = 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments';

async function searchEmail(userId, { query = '', folder, unread_only, since, limit = 10 }) {
  const top = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(since || '') ? since : null;
  const q = String(query).trim().slice(0, 200);
  const box = folder || (q ? 'all' : 'inbox');
  const base = box === 'inbox' ? '/me/mailFolders/inbox/messages' : box === 'sent' ? '/me/mailFolders/sentitems/messages' : '/me/messages';
  let params;
  if (q) {
    // Graph can't combine $search with $filter: dates go into the search text, unread is filtered here
    const kql = `${q.replace(/"/g, '')}${day ? ` received>=${day}` : ''}`;
    params = { $search: `"${kql}"`, $select: SUMMARY, $top: String(unread_only ? 50 : top) };
  } else {
    const filter = [`receivedDateTime ge ${day || '1900-01-01'}T00:00:00Z`, ...(unread_only ? ['isRead eq false'] : [])].join(' and ');
    params = { $filter: filter, $orderby: 'receivedDateTime desc', $select: SUMMARY, $top: String(top) };
  }
  const { value = [] } = await graph(userId, `${base}?${new URLSearchParams(params)}`);
  const found = value.filter((m) => !unread_only || !m.isRead).slice(0, top);
  if (!found.length) return 'No emails found.';
  return found.map((m) => [
    `[id: ${m.id}] ${stamp(m.receivedDateTime)} · From: ${person(m.from)} · Subject: ${m.subject || '(no subject)'}` +
      `${m.isRead ? '' : ' · UNREAD'}${m.hasAttachments ? ' · has attachments' : ''}`,
    `  ${String(m.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 220)}`,
  ].join('\n')).join('\n\n');
}

async function readEmail(userId, { id }) {
  const path = `/me/messages/${encodeURIComponent(String(id || ''))}`;
  const m = await graph(userId, `${path}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink`,
    { Prefer: 'outlook.body-content-type="text"' });
  const files = m.hasAttachments
    ? (await graph(userId, `${path}/attachments?$select=name,size,isInline`)).value.filter((a) => !a.isInline).map((a) => a.name)
    : [];
  const body = String(m.body?.content || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return [
    `Subject: ${m.subject || '(no subject)'}`,
    `From: ${person(m.from)}`,
    `To: ${(m.toRecipients || []).map(person).join(', ')}`,
    ...(m.ccRecipients?.length ? [`Cc: ${m.ccRecipients.map(person).join(', ')}`] : []),
    `Date: ${stamp(m.receivedDateTime)}`,
    ...(files.length ? [`Attachments: ${files.join(', ')}`] : []),
    `Open in Outlook: ${m.webLink}`,
    '',
    body.length > 15000 ? `${body.slice(0, 15000)}\n…(truncated)` : body,
  ].join('\n');
}

// runs one tool_use block and returns its tool_result
export async function runEmailTool(userId, block) {
  try {
    const run = { search_email: searchEmail, read_email: readEmail }[block.name];
    if (!run) throw new Error(`Unknown tool ${block.name}`);
    return { type: 'tool_result', tool_use_id: block.id, content: await run(userId, block.input || {}) };
  } catch (e) {
    return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
  }
}
