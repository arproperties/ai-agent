import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { isMaster } from './access.js';
import { decrypt } from './secrets.js';
import { compose, sendRaw, friendlySmtp } from './smtp.js';
import { directory, inbox, fileInSent } from './tenantCare.js';
import { needsModule } from './modules.js';

// Tenant notices: what a watchman used to post in the WhatsApp group. He picks the
// building and the unit, takes a photo, writes what he saw, and Reem emails it to that
// unit's tenant there and then, from the Tenant care inbox, and files it in Sent.
//
// The buildings, the units and the tenant emails are saifsys's (module realestate, action
// directory - the same list Tenant care reads). Nothing is kept here but the notices
// themselves, and saifsys is only ever read.
//
// Open on purpose: anyone with the module (server/modules.js) may report on any building
// and any unit. The tenant's email address is never shown to them; only the master sees
// where a notice went.
//
// No AI anywhere in it: the email is a fixed text around the watchman's own words.

const DIR = `${DATA_DIR}/notices`;
const MAX_PHOTOS = 5;
const MAX_TEXT = 2000;
const STUCK = 300; // a notice still "sending" after five minutes was cut off, and may be tried again
const NOW = 'extract(epoch from now())::bigint';
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ---------- the buildings and units ----------

/** Every building with its units, and whether saifsys has a tenant email for each. Never the email itself. */
export function places(dir) {
  return dir.buildings.map((b) => ({
    name: b.name,
    units: b.units.map((u) => ({ number: u, tenant: tenantsOf(dir, b.name, u).length > 0 })),
  }));
}

/** The emails of the tenants on an active lease of this unit. */
export function tenantsOf(dir, building, unit) {
  return [...new Set((dir.leases || []).filter((t) => same(t.building, building) && same(t.unit, unit)).map((t) => t.email))];
}

// ---------- the email ----------

const dubai = (secs) => new Date(secs * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

export function noticeSubject(n) {
  return `Notice: ${n.building}, Unit ${n.unit}`;
}

export function noticeText(n, photos) {
  return ['Dear Tenant,', '',
    `This is a notice from the building management about ${n.building}, Unit ${n.unit}.`, '',
    n.description, '',
    `Reported on ${dubai(n.created_at)}.`,
    ...(photos ? [photos === 1 ? 'A photo is attached.' : `${photos} photos are attached.`] : []), '',
    'If you have any questions, please reply to this email.', '',
    'Kind regards,', 'Tenant Care Team'].join('\n');
}

// ---------- reading ----------

const photosOf = (ids) => (ids.length
  ? db.prepare('SELECT id, notice_id, mime, path FROM tenant_notice_photos WHERE notice_id = ANY(?::int[]) ORDER BY id').all(ids)
  : []);

const out = (n, photos, user) => ({
  id: n.id, building: n.building, unit: n.unit, description: n.description, status: n.status, error: n.error,
  createdAt: n.created_at, sentAt: n.sent_at, by: n.by_name || null, mine: n.user_id === user.id,
  photos: photos.filter((p) => p.notice_id === n.id).map((p) => p.id),
  // Where it went is the master's to see; the watchman only needs to know that it did.
  ...(isMaster(user) ? { to: n.to_addrs ? n.to_addrs.split(',') : [] } : {}),
});

const SELECT = 'SELECT n.*, u.name AS by_name FROM tenant_notices n LEFT JOIN users u ON u.id = n.user_id';

/** The latest notices: everybody's for the master, their own for anyone else. */
export async function listNotices(user) {
  const rows = isMaster(user)
    ? await db.prepare(`${SELECT} ORDER BY n.id DESC LIMIT 100`).all()
    : await db.prepare(`${SELECT} WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`).all(user.id);
  const photos = await photosOf(rows.map((r) => r.id));
  return rows.map((n) => out(n, photos, user));
}

async function oneNotice(user, id) {
  const n = await db.prepare(`${SELECT} WHERE n.id = ?`).get(Number(id) || 0);
  if (!n || (!isMaster(user) && n.user_id !== user.id)) return null;
  return n;
}

// ---------- writing and sending ----------

/**
 * Email one notice to the unit's tenants, as saifsys has them now. Returns the row as it
 * ends up: sent, failed, or no_email. send and file are injectable for the tests.
 */
async function deliver(id, dir, { send = sendRaw, file = fileInSent } = {}) {
  const n = await db.prepare('SELECT * FROM tenant_notices WHERE id = ?').get(id);
  const to = tenantsOf(dir, n.building, n.unit);
  const done = (status, error = null) => db.prepare(`UPDATE tenant_notices SET status = ?, error = ?, to_addrs = ?, sent_at = ${status === 'sent' ? NOW : 'NULL'} WHERE id = ?`)
    .run(status, error && String(error).slice(0, 500), to.join(',') || null, id);
  if (!to.length) return done('no_email');
  const acc = await inbox();
  if (!acc) return done('failed', 'The Tenant care inbox is not connected, so there is no mailbox to send from.');
  try {
    const photos = await photosOf([id]);
    const attachments = await Promise.all(photos.map(async (p, i) => ({
      filename: `photo-${i + 1}.${PHOTO_TYPES[p.mime]}`, contentType: p.mime, content: (await readFile(p.path)).toString('base64'),
    })));
    const mail = await compose({
      from: { name: 'Tenant Care', address: acc.email }, to,
      subject: noticeSubject(n), text: noticeText(n, photos.length), attachments,
    });
    await send(acc, decrypt(acc.password_enc), mail);
    await done('sent');
    await file(acc, mail.raw).catch((e) => console.warn('[notices] could not file in Sent:', e.message));
  } catch (e) {
    await done('failed', friendlySmtp(e, acc.smtp_host));
  }
}

/** A new notice: saved with its photos, then emailed straight away. files are multer's. */
export async function createNotice(user, { building, unit, description, files = [] }, { dir: given, ...mail } = {}) {
  const text = String(description ?? '').trim();
  if (!text) throw bad('Please write what you saw');
  if (text.length > MAX_TEXT) throw bad('That is too long. Please keep it shorter.');
  if (files.length > MAX_PHOTOS) throw bad(`At most ${MAX_PHOTOS} photos on one notice`);
  if (files.some((f) => !PHOTO_TYPES[f.mimetype] || !f.buffer?.length)) throw bad('A photo must be a JPG or PNG picture');

  const dir = given || await directory();
  const b = dir.buildings.find((x) => same(x.name, building));
  if (!b) throw bad('Please pick a building');
  const u = b.units.find((x) => same(x, unit));
  if (!u) throw bad('Please pick a unit');

  const { id } = await db.prepare('INSERT INTO tenant_notices (user_id, building, unit, description) VALUES (?, ?, ?, ?) RETURNING id')
    .run(user.id, b.name, u, text);
  if (files.length) mkdirSync(DIR, { recursive: true });
  for (const f of files) {
    const path = `${DIR}/${randomUUID()}.${PHOTO_TYPES[f.mimetype]}`;
    await writeFile(path, f.buffer);
    await db.prepare('INSERT INTO tenant_notice_photos (notice_id, mime, path) VALUES (?, ?, ?)').run(id, f.mimetype, path);
  }
  await deliver(id, dir, mail);
  return (await listNotices(user)).find((n) => n.id === id);
}

/** Try again: a notice that could not go out, or whose unit had no tenant email when it was written. */
export async function resendNotice(user, id, { dir: given, ...mail } = {}) {
  const n = await oneNotice(user, id);
  if (!n) throw bad('Notice not found', 404);
  // Claimed first, so two taps send it once.
  const claimed = await db.prepare(`UPDATE tenant_notices SET status = 'sending', error = NULL
    WHERE id = ? AND (status IN ('failed', 'no_email') OR (status = 'sending' AND created_at < ${NOW} - ${STUCK})) RETURNING id`).get(n.id);
  if (!claimed) throw bad(n.status === 'sent' ? 'This notice was already sent' : 'This notice is being sent', 409);
  let dir;
  try { dir = given || await directory({ fresh: true }); } catch (e) {
    await db.prepare(`UPDATE tenant_notices SET status = 'failed', error = ? WHERE id = ?`).run(e.message.slice(0, 500), n.id);
    throw e;
  }
  await deliver(n.id, dir, mail);
  return (await listNotices(user)).find((x) => x.id === n.id);
}

/** Take a notice away, with its pictures. Sending is not undone: the tenant keeps the email. */
export async function deleteNotice(user, id) {
  if (!isMaster(user)) throw bad('Only the master can delete a notice', 403);
  const photos = await photosOf([Number(id) || 0]);
  const { changes } = await db.prepare('DELETE FROM tenant_notices WHERE id = ?').run(Number(id) || 0);
  if (!changes) throw bad('Notice not found', 404);
  // Only ever inside our own folder, whatever the row says.
  for (const p of photos) if (p.path.startsWith(`${DIR}/`)) rmSync(p.path, { force: true });
}

// ---------- routes ----------

export const noticeRoutes = Router();
noticeRoutes.use(needsModule('notices'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: MAX_PHOTOS } });

// The buildings and units to pick from, as saifsys has them.
noticeRoutes.get('/places', wrap(async (req, res) => {
  res.json(places(await directory()));
}));

noticeRoutes.get('/', wrap(async (req, res) => {
  res.json({ notices: await listNotices(req.user), inbox: !!(await inbox()) });
}));

noticeRoutes.post('/', upload.array('photos', MAX_PHOTOS), wrap(async (req, res) => {
  res.json(await createNotice(req.user, { building: req.body.building, unit: req.body.unit, description: req.body.description, files: req.files || [] }));
}));

noticeRoutes.post('/:id/send', wrap(async (req, res) => {
  res.json(await resendNotice(req.user, req.params.id));
}));

noticeRoutes.delete('/:id', wrap(async (req, res) => {
  await deleteNotice(req.user, req.params.id);
  res.json({ ok: true });
}));

noticeRoutes.get('/:id/photos/:photo', wrap(async (req, res) => {
  const n = await oneNotice(req.user, req.params.id);
  const p = n && await db.prepare('SELECT mime, path FROM tenant_notice_photos WHERE id = ? AND notice_id = ?').get(Number(req.params.photo) || 0, n.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(p.mime).sendFile(p.path);
}));
