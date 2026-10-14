import { Router } from 'express';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { isMaster } from './access.js';
import { decrypt } from './secrets.js';
import { compose, sendRaw, friendlySmtp } from './smtp.js';
import { directory, inbox, fileInSent } from './tenantCare.js';
import { needsModule, userModules } from './modules.js';

// Tenant notices: what a watchman used to post in the WhatsApp group. He tells Reem in a
// chat, with a photo, what he saw at a unit; Reem gets the notice ready on a card, and it is
// emailed to that unit's tenant when he taps Send, from the Tenant care inbox, and filed in
// Sent. The screen of its own was taken out on 2026-10-14: chat is the one way in.
//
// The buildings, the units and the tenant emails are saifsys's (module realestate, action
// directory - the same list Tenant care reads). Nothing is kept here but the notices
// themselves, and saifsys is only ever read.
//
// Open on purpose: anyone with the module (server/modules.js) may report on any building
// and any unit. The card shows them the tenant's email, so they see who it goes to.
//
// Reem writes the words; the email is a fixed letter around them.

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
const LISTED = "n.status NOT IN ('draft', 'cancelled')"; // a chat's card that was never sent is not a notice

/** The latest notices: everybody's for the master, their own for anyone else. */
export async function listNotices(user) {
  const rows = isMaster(user)
    ? await db.prepare(`${SELECT} WHERE ${LISTED} ORDER BY n.id DESC LIMIT 100`).all()
    : await db.prepare(`${SELECT} WHERE ${LISTED} AND n.user_id = ? ORDER BY n.id DESC LIMIT 50`).all(user.id);
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

// ---------- Reem in chat ----------

// The same notice, got ready from what was said or typed in a chat, with the photos sent
// there: a card with the building, the unit, the words and the tenant's email, and nothing
// goes out until Send is tapped on it. The email is shown on the card on purpose - the
// master asked for the one sending it to see who it goes to.

const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const unitOnly = (s) => String(s || '').trim().replace(/^(unit|flat|apartment|apt|shop|office|room)\s*(no\.?|number|#)?\s*/i, '').trim();

/** The building meant: the exact name, else the only one whose name holds every word said. */
export function findBuilding(dir, said) {
  const exact = dir.buildings.filter((b) => same(b.name, said || ''));
  if (exact.length === 1) return exact[0];
  const asked = words(said).trim().split(' ').filter(Boolean);
  const hits = asked.length ? dir.buildings.filter((b) => asked.every((w) => words(b.name).includes(` ${w} `) || words(b.name).replace(/ /g, '').includes(w))) : [];
  if (hits.length === 1) return hits[0];
  const names = (list) => list.map((b) => b.name).slice(0, 30).join(', ');
  throw bad(hits.length > 1
    ? `Which building? "${said}" could be ${names(hits)}. Ask which one.`
    : `No building matches "${said || ''}". The buildings are: ${names(dir.buildings)}. Ask which one.`);
}

const noticeRow = (userId, id) => db.prepare('SELECT * FROM tenant_notices WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);

async function noticeCard(n) {
  const photos = await photosOf([n.id]);
  return {
    id: n.id, conversation_id: n.conversation_id, status: n.status, error: n.error, building: n.building, unit: n.unit,
    description: n.description, to: n.to_addrs ? n.to_addrs.split(',') : [], photos: photos.map((p) => p.id), sentAt: n.sent_at,
  };
}

export const getNoticeCard = async (user, id) => { const n = await noticeRow(user.id, id); return n ? noticeCard(n) : null; };

/** A picture sent in this chat, by the name Reem saw it under - as one of the user's documents. */
async function chatPicture(userId, conversationId, name) {
  const doc = await db.prepare(`SELECT id, name, mime, path FROM documents WHERE user_id = ? AND path IS NOT NULL AND lower(name) = lower(?)
    ORDER BY (conversation_id IS NOT DISTINCT FROM ?) DESC, id DESC LIMIT 1`).get(userId, String(name || '').trim(), conversationId);
  if (!doc) throw bad(`There is no picture called "${name}" in this chat. Use the name from its <image name="…" /> tag.`);
  if (!PHOTO_TYPES[doc.mime]) throw bad(`${doc.name} cannot go on a notice: it must be a JPG or PNG picture. Leave it out and say so.`);
  return doc;
}

/** Get a card ready. Nothing is sent. */
export async function proposeNotice(user, input, { conversationId = null } = {}, { dir: given } = {}) {
  const text = String(input.description ?? '').trim();
  if (!text) throw bad('Say what was seen at the unit.');
  if (text.length > MAX_TEXT) throw bad('That is too long for a notice. Make it shorter.');
  const names = [...new Set(Array.isArray(input.photos) ? input.photos : [])];
  if (names.length > MAX_PHOTOS) throw bad(`At most ${MAX_PHOTOS} photos on one notice.`);
  const pictures = [];
  for (const name of names) pictures.push(await chatPicture(user.id, conversationId, name));

  const dir = given || await directory();
  const b = findBuilding(dir, input.building);
  const u = b.units.find((x) => same(x, unitOnly(input.unit)));
  if (!u) throw bad(`${b.name} has no unit "${input.unit}". Ask which unit.`);

  const to = tenantsOf(dir, b.name, u);
  const { id } = await db.prepare(`INSERT INTO tenant_notices (user_id, conversation_id, building, unit, description, to_addrs, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft') RETURNING id`).run(user.id, conversationId, b.name, u, text, to.join(',') || null);
  // The notice's own copies, so clearing the Shelf later does not take them off it.
  if (pictures.length) mkdirSync(DIR, { recursive: true });
  for (const p of pictures) {
    const path = `${DIR}/${randomUUID()}.${PHOTO_TYPES[p.mime]}`;
    await writeFile(path, await readFile(p.path));
    await db.prepare('INSERT INTO tenant_notice_photos (notice_id, mime, path) VALUES (?, ?, ?)').run(id, p.mime, path);
  }
  return getNoticeCard(user, id);
}

/** Send or Cancel on the card. The status change is the lock, so a double tap sends once. */
export async function decideNotice(user, id, sending, { dir: given, ...mail } = {}) {
  const n = await noticeRow(user.id, id);
  if (!n) return null;
  if (n.status !== 'draft') throw bad(n.status === 'cancelled' ? 'This notice was cancelled.' : 'This notice was already sent.', 409);
  // Reported when it is sent, not when the card was made.
  const claimed = await db.prepare(`UPDATE tenant_notices SET status = ?, created_at = ${NOW} WHERE id = ? AND status = 'draft' RETURNING id`)
    .get(sending ? 'sending' : 'cancelled', n.id);
  if (!claimed) throw bad('This notice was already decided.', 409);
  if (sending) {
    let dir;
    try { dir = given || await directory({ fresh: true }); } catch (e) {
      await db.prepare(`UPDATE tenant_notices SET status = 'failed', error = ? WHERE id = ?`).run(e.message.slice(0, 500), n.id);
      return getNoticeCard(user, n.id);
    }
    await deliver(n.id, dir, mail);
  }
  return getNoticeCard(user, n.id);
}

const NOTICE = {
  name: 'tenant_notice',
  description: 'Get a notice to a tenant ready: something seen at a unit that its tenant must be told about - water leaking, rubbish or shoes left outside the door, ' +
    'a car parked in the wrong place, damage, noise. Use it when the user reports such a thing about a unit, ' +
    'usually with a photo, in any language - what a watchman used to post in the WhatsApp group. ' +
    'Write description in English for the tenant: short, polite and plain, only what was reported - no greeting or sign-off, the letter around it adds those. ' +
    'Pass the photos sent with it by their names. This only shows a card with the building, the unit, the words and the tenant\'s email: ' +
    'nothing is sent until the user taps Send on it, so never say it was sent. When a building or unit was not said, ask for it rather than guess.',
  input_schema: {
    type: 'object',
    properties: {
      building: { type: 'string', description: 'The building name, or part of it, as said.' },
      unit: { type: 'string', description: 'The unit number, e.g. "204".' },
      description: { type: 'string', description: 'The notice, in English, for the tenant.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'Names of pictures attached in this chat (from their <image name="…" /> tags) to send with it.' },
    },
    required: ['building', 'unit', 'description'],
  },
};

/** The notice tool, same shape as inventoryKit(). Only for someone with the Tenant notices module. */
export async function noticeKit(user, ctx = {}, opts = {}) {
  const has = (await userModules(user)).includes('notices');
  return {
    definitions: has ? [NOTICE] : [],
    status: () => 'Getting the notice ready…',
    run: async (block) => {
      try {
        if (!has || block.name !== NOTICE.name) throw new Error(`Unknown tool ${block.name}`);
        const c = await proposeNotice(user, block.input || {}, ctx, opts);
        ctx.onCard?.(c);
        const who = c.to.length ? `it goes to ${c.to.join(', ')}` : 'saifsys has no tenant email for this unit, so it would be saved but not emailed - say so';
        return { type: 'tool_result', tool_use_id: block.id, content: `Ready as card #${c.id} for ${c.building}, Unit ${c.unit}${c.photos.length ? ` with ${c.photos.length} photo(s)` : ''}; ${who}. ` +
          'NOT sent yet - tell the user in one short line to check the card and tap Send. Never say it is sent.' };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const noticeRoutes = Router();
noticeRoutes.use(needsModule('notices'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Cards from chat: this person's own, in one conversation.
noticeRoutes.get('/chat', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM tenant_notices WHERE user_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(await Promise.all(rows.map((r) => getNoticeCard(req.user, r.id))));
}));
for (const [path, sending] of [['send', true], ['cancel', false]]) {
  noticeRoutes.post(`/chat/:id/${path}`, wrap(async (req, res) => {
    const c = await decideNotice(req.user, req.params.id, sending);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  }));
}

noticeRoutes.post('/:id/send', wrap(async (req, res) => {
  res.json(await resendNotice(req.user, req.params.id));
}));

noticeRoutes.get('/:id/photos/:photo', wrap(async (req, res) => {
  const n = await oneNotice(req.user, req.params.id);
  const p = n && await db.prepare('SELECT mime, path FROM tenant_notice_photos WHERE id = ? AND notice_id = ?').get(Number(req.params.photo) || 0, n.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(p.mime).sendFile(p.path);
}));
