import { Router } from 'express';
import { simpleParser } from 'mailparser';
import { db, tx } from './db.js';
import { isMaster } from './access.js';
import { encrypt, decrypt } from './secrets.js';
import { client, detectHost, friendly, withMailbox, sentPath, applySmtp, replySubject, buildRefs } from './imap.js';
import { compose, sendRaw, friendlySmtp } from './smtp.js';
import { sendPush } from './push.js';
import { askSaifsys, saifsysConfigured } from './saifsys/client.js';

// Tenant care: the one inbox tenants write to, looked after by a few people together.
//
// Every few minutes Jarvis reads the new emails in it. When one does not say which
// building and unit it is about — and the sender is not a tenant saifsys already knows —
// Jarvis replies straight away asking for them, from the inbox itself, and files the reply in
// its Sent folder. That is the whole job: the tenant's next email is for the staff, who
// answer it from the shared email as they always have.
//
// Only when a reply could not go out (the mail server refused, the password changed) does it
// wait on the Tenant care page, where whoever looks after the inbox can tap Send or Skip —
// and their phones buzz to say so.
//
// No AI anywhere in it. Whether an email names a building and unit is a text search against
// saifsys's own list of buildings, units and tenants (module realestate, action directory),
// and the reply is a fixed text.

const EVERY = 3 * 60_000;
const PER_LOOK = 50;              // emails read per look at most; the rest wait for the next
const DIRECTORY_FOR = 30 * 60_000; // saifsys's list is asked for again after half an hour
const QUIET = 3 * 86400;          // one ask per sender in three days, however often they write
const NOW = 'extract(epoch from now())::bigint';
const now = () => Math.floor(Date.now() / 1000);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- the list of buildings, units and tenants ----------

let cached = { at: 0, dir: null };

/** saifsys's buildings (with unit numbers) and the tenants on active leases, kept for half an hour. */
export async function directory({ fresh = false } = {}) {
  if (!fresh && cached.dir && Date.now() - cached.at < DIRECTORY_FOR) return cached.dir;
  const body = await askSaifsys('realestate', 'directory');
  const dir = {
    buildings: (body.buildings || []).map((b) => ({ name: String(b.name || ''), units: (b.units || []).map(String) })).filter((b) => b.name),
    tenants: new Set((body.tenants || []).map((t) => String(t.email || '').trim().toLowerCase()).filter(Boolean)),
  };
  cached = { at: Date.now(), dir };
  return dir;
}

// ---------- does an email say where it is about ----------

// Words that are in many building names and say nothing on their own: "Ayla Residence"
// is found by "ayla", but "residence" alone would find every building.
const GENERIC = new Set(['the', 'building', 'bldg', 'tower', 'towers', 'residence', 'residences', 'residency',
  'apartment', 'apartments', 'block', 'plaza', 'court', 'house', 'heights', 'complex']);

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim()} `;
const has = (text, phrase) => phrase.trim() && text.includes(` ${phrase.trim()} `);

/** The ways a tenant might write a building's name: in full, or without the generic words. */
export function buildingNames(name) {
  const full = norm(name).trim();
  const short = full.split(' ').filter((w) => !GENERIC.has(w)).join(' ');
  return [...new Set([full, short.length >= 3 ? short : ''].filter(Boolean))];
}

// "unit 507", "flat no. 12", "apt #A-304", "office 3" — a unit however saifsys spells it.
const UNIT_WORDS = /\b(unit|flat|apt|apartment|office|shop|villa|room|studio)\s*(no\.?|number|num|#)?\s*[a-z]?-?\d{1,5}[a-z]?\b/i;

/** Only what the tenant wrote: quoted replies and the old message underneath are cut off. */
export function ownWords(text) {
  const cut = String(text || '').split(/\n\s*(On .{0,200}wrote:|-{2,}\s*Original Message|From: .*\n(Sent|Date): )/i)[0];
  return cut.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

/**
 * What an email leaves out: 'building', 'unit', 'both', or null when it says both.
 * dir is directory()'s answer. A sender saifsys knows as a tenant is never asked.
 */
export function whatsMissing({ from, subject, text }, dir) {
  if (dir.tenants.has(String(from || '').toLowerCase())) return null;
  const said = norm(`${subject || ''}\n${ownWords(text)}`);
  const named = dir.buildings.filter((b) => buildingNames(b.name).some((n) => has(said, n)));
  const units = (named.length ? named : dir.buildings).flatMap((b) => b.units);
  const unit = UNIT_WORDS.test(`${subject || ''}\n${ownWords(text)}`) || units.some((u) => u.length >= 2 && has(said, norm(u)));
  if (named.length && unit) return null;
  if (named.length) return 'unit';
  if (unit) return 'building';
  return 'both';
}

// ---------- mail that is nobody to reply to ----------

const ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|alerts?|newsletter|info-?noreply)[@+.-]/i;

/** Newsletters, bank alerts, out-of-office and bounces: replying to them helps nobody. */
export function isAutomatic(from, headers) {
  if (ROBOT.test(String(from || ''))) return true;
  const h = (k) => String(headers?.get?.(k) ?? '').toLowerCase();
  const auto = h('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (/bulk|list|junk|auto_reply/.test(h('precedence'))) return true;
  return !!(headers?.has?.('list-id') || headers?.has?.('list-unsubscribe') || headers?.has?.('x-autoreply') || headers?.has?.('x-autorespond'));
}

// ---------- the reply ----------

function example(dir) {
  const b = dir?.buildings.find((x) => x.units.length);
  return b ? ` (for example: ${b.name}, unit ${b.units[0]})` : '';
}

export function replyText(missing, dir) {
  const ask = {
    both: `please reply with your building name and unit number${example(dir)}`,
    building: 'please reply with your building name',
    unit: 'please reply with your unit number',
  }[missing];
  return `Dear Tenant,\n\nThank you for your email.\n\nSo we can pass it to the right team, ${ask}.\n\nKind regards,\nTenant Care Team`;
}

// ---------- the inbox ----------

export const inbox = () => db.prepare('SELECT * FROM tenant_inbox WHERE id = 1').get();
const members = async () => (await db.prepare('SELECT user_id FROM tenant_inbox_members').all()).map((r) => r.user_id);

async function mayUse(user) {
  if (isMaster(user)) return true;
  return !!(await db.prepare('SELECT 1 FROM tenant_inbox_members WHERE user_id = ?').get(user.id));
}

/**
 * One look at the inbox: every email newer than the last one looked at, and a reply to
 * each that needs one, sent there and then. Returns how many replies it wrote. read, send
 * and file are injectable so the tests can run it without a mail server.
 */
export async function look({ read = readNew, dir: given, send, file } = {}) {
  const acc = await inbox();
  if (!acc) return 0;
  let dir;
  try {
    dir = given || await directory();
  } catch (e) {
    // Without the list nothing can be judged, so nothing is marked as looked at either:
    // the same emails are read again once saifsys answers.
    await db.prepare(`UPDATE tenant_inbox SET checked_at = ${NOW}, error = ? WHERE id = 1`).run(`saifsys: ${e.message}`.slice(0, 300));
    return 0;
  }

  const { mail, lastUid, uidValidity } = await read(acc);
  const mine = String(acc.email).toLowerCase();
  const domain = mine.split('@')[1];
  const made = [];
  for (const m of mail) {
    const from = String(m.from || '').toLowerCase();
    if (!from || from === mine || from.endsWith(`@${domain}`)) continue; // our own people
    if (isAutomatic(from, m.headers)) continue;
    const missing = whatsMissing({ from, subject: m.subject, text: m.text }, dir);
    if (!missing) continue;
    const recent = await db.prepare('SELECT 1 FROM tenant_asks WHERE from_addr = ? AND created_at > ? AND status <> ?')
      .get(from, now() - QUIET, 'skipped');
    if (recent) continue;
    const r = await db.prepare(`INSERT INTO tenant_asks (ref, message_id, refs, from_addr, from_name, subject, preview, received_at, missing, reply)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING RETURNING id`)
      .run(`${uidValidity}:${m.uid}`, m.messageId, m.refs, from, m.name || null, String(m.subject || '').slice(0, 300),
        ownWords(m.text).replace(/\s+/g, ' ').trim().slice(0, 400), m.at, missing, replyText(missing, dir));
    if (r.id) made.push({ id: r.id, from: m.name || from, subject: m.subject });
  }
  await db.prepare(`UPDATE tenant_inbox SET last_uid = ?, uid_validity = ?, checked_at = ${NOW}, error = NULL WHERE id = 1`).run(lastUid, uidValidity);

  // Sent one by one after last_uid has moved on, so a slow mail server can never make the
  // next look read (and answer) the same emails again.
  const stuck = [];
  for (const a of made) {
    const row = await db.prepare('SELECT reply FROM tenant_asks WHERE id = ?').get(a.id);
    await sendAsk(null, a.id, row.reply, { ...(send ? { send } : {}), ...(file ? { file } : {}) }).catch(() => stuck.push(a));
  }
  if (stuck.length) {
    const who = [...new Set([...(await members()), ...(await masters())])];
    const body = stuck.length === 1
      ? `The reply to ${stuck[0].from} could not be sent. Tap to send it.`
      : `${stuck.length} replies to tenants could not be sent. Tap to send them.`;
    sendPush(who, { title: 'Tenant care', body, url: '/?tenantcare=1', tag: 'tenant-care' }).catch(() => {});
  }
  return made.length;
}

const masters = async () => (await db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT disabled`).all()).map((r) => r.id);

/** The new emails in the inbox, read without marking anything as read. */
async function readNew(acc) {
  return withMailbox(acc, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uidValidity = Number(c.mailbox.uidValidity);
      const top = Number(c.mailbox.uidNext) - 1;
      // First look, or the server renumbered the inbox: start from now, ask about nothing old.
      if (acc.last_uid == null || Number(acc.uid_validity) !== uidValidity) return { mail: [], lastUid: top, uidValidity };
      const last = Number(acc.last_uid);
      if (top <= last) return { mail: [], lastUid: last, uidValidity };
      // "n:*" always includes the newest email even when it is older than n, hence the filter.
      const uids = ((await c.search({ uid: `${last + 1}:*` }, { uid: true })) || []).filter((u) => u > last).sort((a, b) => a - b).slice(0, PER_LOOK);
      const mail = [];
      for await (const m of c.fetch(uids, { uid: true, internalDate: true, source: { maxLength: 60000 } }, { uid: true })) {
        const p = await simpleParser(m.source).catch(() => null);
        if (!p) continue;
        const sender = (p.replyTo?.value?.[0]) || p.from?.value?.[0] || {};
        mail.push({
          uid: m.uid, headers: p.headers, from: sender.address, name: p.from?.value?.[0]?.name || '',
          subject: p.subject || '', text: p.text || '', messageId: p.messageId || null,
          refs: buildRefs(Array.isArray(p.references) ? p.references.join(' ') : p.references, p.messageId),
          at: Math.floor(new Date(p.date || m.internalDate || Date.now()).getTime() / 1000),
        });
      }
      return { mail, lastUid: uids.length ? Math.max(...uids) : last, uidValidity };
    } finally { lock.release(); }
  });
}

let timer = null;
let busy = false;
export function startTenantCare() {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await look(); } catch (e) {
      console.warn('[tenant-care]', e.message);
      await db.prepare(`UPDATE tenant_inbox SET checked_at = ${NOW}, error = ? WHERE id = 1`).run(String(e.message).slice(0, 300)).catch(() => {});
    } finally { busy = false; }
  };
  timer = setInterval(tick, EVERY);
  setTimeout(tick, 20_000);
}

// ---------- sending ----------

/**
 * Send one ask's reply from the Tenant care inbox, threaded onto the tenant's email, and
 * file it in Sent. user is null when Jarvis sends it by itself, a person when they tapped Send.
 */
export async function sendAsk(user, id, body, { send = sendRaw, file = fileInSent } = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw bad('The reply is empty');
  if (text.length > 5000) throw bad('The reply is too long');
  const acc = await inbox();
  if (!acc) throw bad('The Tenant care inbox is not connected', 409);
  // Claimed first, so two people tapping Send at once send it once.
  const ask = await db.prepare(`UPDATE tenant_asks SET status = 'sending', reply = ?, error = NULL
    WHERE id = ? AND status IN ('pending', 'failed') RETURNING *`).get(text, Number(id));
  if (!ask) {
    const cur = await db.prepare('SELECT status FROM tenant_asks WHERE id = ?').get(Number(id));
    throw bad(cur ? `This reply was already ${cur.status}` : 'Reply not found', cur ? 409 : 404);
  }
  try {
    const mail = await compose({
      from: { name: 'Tenant Care', address: acc.email }, to: [ask.from_addr],
      subject: replySubject(ask.subject), text, inReplyTo: ask.message_id, references: ask.refs,
    });
    await send(acc, decrypt(acc.password_enc), mail);
    await db.prepare(`UPDATE tenant_asks SET status = 'sent', decided_by = ?, decided_at = ${NOW} WHERE id = ?`).run(user?.id ?? null, ask.id);
    await file(acc, mail.raw).catch((e) => console.warn('[tenant-care] could not file in Sent:', e.message));
  } catch (e) {
    const message = friendlySmtp(e, acc.smtp_host);
    await db.prepare('UPDATE tenant_asks SET status = ?, error = ? WHERE id = ?').run('failed', String(message).slice(0, 500), ask.id);
    throw bad(message, 502);
  }
  return askOut(await db.prepare('SELECT * FROM tenant_asks WHERE id = ?').get(ask.id));
}

async function fileInSent(acc, raw) {
  await withMailbox(acc, async (c) => {
    const path = await sentPath(c);
    if (path) await c.append(path, raw, ['\\Seen']);
  });
}

// ---------- routes ----------

const askOut = (a) => a && {
  id: a.id, from: a.from_addr, name: a.from_name, subject: a.subject, preview: a.preview,
  receivedAt: a.received_at, missing: a.missing, reply: a.reply, status: a.status, error: a.error, decidedAt: a.decided_at,
};
const inboxOut = (a) => a && { email: a.email, checkedAt: a.checked_at, error: a.error, connectedAt: a.created_at };

export const tenantCareRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const guard = wrap(async (req, res, next) => ((await mayUse(req.user)) ? next() : res.status(403).json({ error: 'You do not look after the Tenant care inbox' })));
const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master can change this' }));

// For the menu: whether to show Tenant care at all, and how many replies are waiting.
tenantCareRoutes.get('/me', wrap(async (req, res) => {
  if (!(await mayUse(req.user))) return res.json({ member: false, waiting: 0 });
  const { n } = await db.prepare(`SELECT count(*)::int AS n FROM tenant_asks WHERE status IN ('pending', 'failed')`).get();
  res.json({ member: true, waiting: n });
}));

tenantCareRoutes.get('/', guard, wrap(async (req, res) => {
  const open = await db.prepare(`SELECT * FROM tenant_asks WHERE status IN ('pending', 'failed', 'sending') ORDER BY id DESC LIMIT 100`).all();
  const done = await db.prepare(`SELECT a.*, u.name AS by_name FROM tenant_asks a LEFT JOIN users u ON u.id = a.decided_by
    WHERE a.status IN ('sent', 'skipped') ORDER BY a.decided_at DESC NULLS LAST LIMIT 20`).all();
  const out = { inbox: inboxOut(await inbox()), saifsys: saifsysConfigured(), open: open.map(askOut), done: done.map((a) => ({ ...askOut(a), by: a.by_name })) };
  if (isMaster(req.user)) {
    const have = new Set(await members());
    out.people = (await db.prepare(`SELECT id, name, email FROM users WHERE NOT disabled AND role IS DISTINCT FROM 'master' ORDER BY lower(name)`).all())
      .map((u) => ({ ...u, member: have.has(u.id) }));
  }
  res.json(out);
}));

tenantCareRoutes.post('/asks/:id/send', guard, wrap(async (req, res) => {
  res.json(await sendAsk(req.user, req.params.id, req.body.reply));
}));

tenantCareRoutes.post('/asks/:id/skip', guard, wrap(async (req, res) => {
  const a = await db.prepare(`UPDATE tenant_asks SET status = 'skipped', decided_by = ?, decided_at = ${NOW}
    WHERE id = ? AND status IN ('pending', 'failed') RETURNING *`).get(req.user.id, Number(req.params.id));
  if (!a) return res.status(409).json({ error: 'This reply was already dealt with' });
  res.json(askOut(a));
}));

// Connecting the inbox: the login is tested before anything is saved, like the personal Email card.
tenantCareRoutes.post('/inbox', masterOnly, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!password) return res.status(400).json({ error: 'Please enter the email password' });
  const host = await detectHost(email);
  const port = 993;
  const enc = encrypt(password);
  const smtp = applySmtp({}, host);
  const c = client({ host, port, username: email, password });
  c.on('error', () => {});
  try {
    await c.connect();
    await c.logout().catch(() => c.close());
  } catch (e) {
    return res.status(400).json({ error: friendly(e, host) });
  }
  // A new login starts looking from now: last_uid goes back to empty.
  await db.prepare(`INSERT INTO tenant_inbox (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, created_by)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET email = excluded.email, host = excluded.host, port = excluded.port, username = excluded.username,
      password_enc = excluded.password_enc, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure,
      created_by = excluded.created_by, last_uid = NULL, uid_validity = NULL, error = NULL, created_at = ${NOW}`)
    .run(email, host, port, email, enc, smtp.smtp_host, smtp.smtp_port, smtp.smtp_secure, req.user.id);
  look().catch((e) => console.warn('[tenant-care]', e.message)); // sets the starting point straight away
  res.json({ inbox: inboxOut(await inbox()) });
}));

tenantCareRoutes.delete('/inbox', masterOnly, wrap(async (req, res) => {
  await db.prepare('DELETE FROM tenant_inbox WHERE id = 1').run();
  res.json({ ok: true });
}));

tenantCareRoutes.put('/members', masterOnly, wrap(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Number.isInteger))];
  await tx(async () => {
    await db.prepare('DELETE FROM tenant_inbox_members').run();
    if (ids.length) await db.prepare('INSERT INTO tenant_inbox_members (user_id) SELECT id FROM users WHERE id = ANY(?::int[]) ON CONFLICT DO NOTHING').run(ids);
  });
  res.json({ members: await members() });
}));
