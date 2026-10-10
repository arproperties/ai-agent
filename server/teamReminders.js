import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { sendPush } from './push.js';
import { remindAt } from './todos.js';

// Reminders one person sends to others: "remind Rona and Tauqeer to send the report at 3".
//
// Said in chat, never typed into a form. Riley only ever PROPOSES one: the tool writes it
// down as pending and a card appears in the chat with Send and Cancel. Nothing reaches
// anybody until the sender taps Send — a misheard name or a wrong time is caught on the
// card, not on someone else's phone.
//
// Once sent, each person gets a buzz (if they have switched notifications on) and the
// reminder waits on their first screen until they tick it. The sender can see who has.
//
// Anyone may send one to anyone, or to everyone. "Everyone" is every active person except
// the sender, fixed at the moment it is proposed: someone added next week did not get it.
//
// A reminder can carry photos: ones the sender attached in the chat, named to the tool by
// file name. The bytes are copied here as the card is made, so what the others open is the
// picture the sender saw on the card — deleting it from the Shelf afterwards changes nothing.
// Only the sender, and the people it has actually been sent to, can open one.

const DIR = `${DATA_DIR}/reminder-files`;
const MAX_TEXT = 300;
const MAX_PHOTOS = 3;
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const CATCHUP = 6 * 3600; // later than this and it is shown, but no phone is woken for it
const NOW = 'extract(epoch from now())::bigint';
const now = () => Math.floor(Date.now() / 1000);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

const stamp = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** Everyone this person could send to: active, and not themselves. */
const others = (userId) =>
  db.prepare('SELECT id, name, email FROM users WHERE id <> ? AND NOT disabled ORDER BY lower(name)').all(userId);

/**
 * "Rona", "tauqeer", "rona@..." → people. Whole name first, then any one word of the name,
 * then the front of the email address. A name that fits nobody, or fits two people, is an
 * error that names the candidates, so Riley asks rather than picks.
 */
export async function findPeople(senderId, names) {
  const pool = await others(senderId);
  const found = new Map();
  for (const raw of names) {
    const want = String(raw || '').trim().toLowerCase();
    if (!want) continue;
    const tiers = [
      (u) => u.name.toLowerCase() === want,
      (u) => u.name.toLowerCase().split(/\s+/).includes(want),
      (u) => u.email.toLowerCase() === want || u.email.toLowerCase().split('@')[0] === want,
      (u) => u.name.toLowerCase().includes(want),
    ];
    let hits = [];
    for (const fits of tiers) { hits = pool.filter(fits); if (hits.length) break; }
    if (!hits.length) throw bad(`Nobody called "${raw}" uses Riley. The people are: ${pool.map((u) => u.name).join(', ') || 'nobody else yet'}.`);
    if (hits.length > 1) throw bad(`"${raw}" could be ${hits.map((u) => u.name).join(' or ')}. Ask which one.`);
    found.set(hits[0].id, hits[0]);
  }
  return [...found.values()];
}

/** One of the sender's own pictures — attached in the chat, or on their Shelf — by its file name. */
async function chatPhoto(userId, name) {
  const want = String(name || '').trim().toLowerCase();
  // The same file name twice means the newer upload: that is the one just attached.
  const doc = want && await db.prepare(`SELECT name, mime, path FROM documents
      WHERE user_id = ? AND path IS NOT NULL AND lower(name) = ? ORDER BY id DESC LIMIT 1`).get(userId, want);
  if (!doc) throw bad(`There is no picture called "${name}". Only a photo the user attached in this chat, or saved on their Shelf, can go on a reminder.`);
  if (!IMAGE.test(doc.mime || '')) throw bad(`${doc.name} is not a photo. A reminder can carry a JPG, PNG, GIF or WebP picture.`);
  try { return { name: doc.name, mime: doc.mime, buffer: readFileSync(doc.path) }; } catch { throw bad(`${doc.name} is listed on the Shelf but its file is missing.`); }
}

const photoOut = (p) => ({ id: p.id, name: p.name, url: `/api/team-reminders/photos/${p.id}` });

/** The photos on these reminders, as the app shows them: a lookup by reminder id. */
async function photosOf(reminderIds) {
  const rows = reminderIds.length
    ? await db.prepare('SELECT id, reminder_id, name FROM team_reminder_photos WHERE reminder_id = ANY(?::int[]) ORDER BY id').all(reminderIds)
    : [];
  return (id) => rows.filter((p) => p.reminder_id === id).map(photoOut);
}

/**
 * One photo, for someone allowed to open it: the sender at any time, and the people it is
 * for once it has reached them. A card still waiting for Send has shown nobody anything.
 */
export async function photoFor(userId, photoId) {
  return await db.prepare(`SELECT f.name, f.mime, f.path FROM team_reminder_photos f
      JOIN team_reminders r ON r.id = f.reminder_id
      WHERE f.id = ? AND (r.sender_id = ? OR (r.status = 'delivered' AND EXISTS
        (SELECT 1 FROM team_reminder_people p WHERE p.reminder_id = r.id AND p.user_id = ?)))`)
    .get(Number(photoId) || 0, userId, userId) || null;
}

/** Remove a reminder's copies. Only ever inside our own folder, whatever the row says. */
async function dropPhotos(reminderId) {
  const gone = await db.prepare('DELETE FROM team_reminder_photos WHERE reminder_id = ? RETURNING path').all(reminderId);
  for (const { path } of gone) if (path.startsWith(`${DIR}/`)) rmSync(path, { force: true });
}

/** One reminder as the sender's card shows it: who it is for and who has done it. */
export async function getReminder(senderId, id) {
  const r = await db.prepare('SELECT * FROM team_reminders WHERE id = ? AND sender_id = ?').get(Number(id), senderId);
  if (!r) return null;
  const people = await db.prepare(`SELECT u.id, u.name, p.done, p.done_at FROM team_reminder_people p
      JOIN users u ON u.id = p.user_id WHERE p.reminder_id = ? ORDER BY lower(u.name)`).all(r.id);
  const { sender_id, ...rest } = r;
  return { ...rest, people, photos: (await photosOf([r.id]))(r.id) };
}

export async function proposeReminder(senderId, { text, people = [], everyone = false, remind_at, conversationId = null, photos = [] }) {
  const body = clean(text);
  if (!body) throw bad('A reminder needs something to say');
  const to = everyone ? await others(senderId) : await findPeople(senderId, people);
  if (!to.length) throw bad(everyone ? 'There is nobody else to send it to yet.' : 'Say who it is for.');
  const at = remindAt(remind_at);
  // Found before anything is written: a card that says "photo" with nothing on it is worse than no card.
  const names = Array.isArray(photos) ? photos : [];
  if (names.length > MAX_PHOTOS) throw bad(`Too many photos (at most ${MAX_PHOTOS} on one reminder).`);
  const files = [];
  for (const name of names) files.push(await chatPhoto(senderId, name));
  const { id } = await db.prepare(`INSERT INTO team_reminders (sender_id, conversation_id, text, remind_at, everyone)
      VALUES (?, ?, ?, ?, ?) RETURNING id`).run(senderId, conversationId, body, at, !!everyone);
  await db.prepare(`INSERT INTO team_reminder_people (reminder_id, user_id)
      SELECT ?::int, * FROM UNNEST(?::int[])`).run(id, to.map((u) => u.id));
  if (files.length) mkdirSync(`${DIR}/${senderId}`, { recursive: true });
  for (const f of files) {
    const path = `${DIR}/${senderId}/${randomUUID()}${extname(f.name).toLowerCase().replace(/[^.\w]/g, '')}`;
    writeFileSync(path, f.buffer);
    await db.prepare('INSERT INTO team_reminder_photos (reminder_id, name, mime, path) VALUES (?, ?, ?, ?)').run(id, f.name, f.mime, path);
  }
  return getReminder(senderId, id);
}

/**
 * Hand it over, exactly once. The status change is the lock: whichever caller moves it
 * from scheduled to delivered is the one that sends, so the timer and a Send tap landing
 * in the same second cannot buzz anyone twice.
 */
async function deliver(id) {
  const r = await db.prepare(`UPDATE team_reminders SET status = 'delivered', delivered_at = ${NOW}
      WHERE id = ? AND status = 'scheduled' RETURNING *`).get(id);
  if (!r) return;
  if ((r.remind_at ?? now()) < now() - CATCHUP) return;
  const ids = (await db.prepare('SELECT user_id FROM team_reminder_people WHERE reminder_id = ?').all(r.id)).map((p) => p.user_id);
  const from = await db.prepare('SELECT name FROM users WHERE id = ?').get(r.sender_id);
  const pictured = await db.prepare('SELECT 1 FROM team_reminder_photos WHERE reminder_id = ? LIMIT 1').get(r.id);
  await sendPush(ids, { title: `Reminder from ${from?.name || 'a colleague'}`, body: `${pictured ? '📷 ' : ''}${r.text}`, url: '/?reminders=1', tag: `jarvis-team-${r.id}` })
    .catch((e) => console.error('[team-reminders]', e.message));
}

/** The sender's decision on the card. */
export async function decideReminder(senderId, id, send) {
  const r = await getReminder(senderId, id);
  if (!r) return null;
  if (r.status !== 'pending') throw bad(`This reminder has already been ${r.status === 'cancelled' ? 'cancelled' : 'sent'}.`, 409);
  await db.prepare('UPDATE team_reminders SET status = ? WHERE id = ?').run(send ? 'scheduled' : 'cancelled', r.id);
  if (!send) await dropPhotos(r.id);
  if (send && (r.remind_at == null || r.remind_at <= now())) await deliver(r.id);
  return getReminder(senderId, id);
}

/** Called every minute by server/reminders.js: the ones whose time has come. */
export async function deliverDue() {
  const due = await db.prepare(`SELECT id FROM team_reminders WHERE status = 'scheduled' AND remind_at <= ?`).all(now());
  for (const { id } of due) await deliver(id);
}

/** What others have sent this person and they have not ticked yet — their first screen. */
export async function inbox(userId, { done = false, limit = 50 } = {}) {
  const rows = await db.prepare(`
    SELECT r.id, r.text, r.remind_at, r.delivered_at, u.name sender_name, p.done, p.done_at
    FROM team_reminder_people p
    JOIN team_reminders r ON r.id = p.reminder_id
    JOIN users u ON u.id = r.sender_id
    WHERE p.user_id = ? AND r.status = 'delivered' AND p.done = ?
    ORDER BY r.delivered_at DESC LIMIT ?`).all(userId, done, limit);
  const photos = await photosOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, photos: photos(r.id) }));
}

export async function markDone(userId, id, done = true) {
  const { changes } = await db.prepare(`UPDATE team_reminder_people SET done = ?, done_at = CASE WHEN ? THEN ${NOW} ELSE NULL END
      WHERE reminder_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM team_reminders r WHERE r.id = reminder_id AND r.status = 'delivered')`)
    .run(!!done, !!done, Number(id), userId);
  return changes > 0;
}

/** The sender's own, newest first — "did Rona do it?" */
async function sentBy(senderId, limit = 15) {
  const rows = await db.prepare(`SELECT id FROM team_reminders WHERE sender_id = ? AND status <> 'cancelled'
      ORDER BY id DESC LIMIT ?`).all(senderId, limit);
  return Promise.all(rows.map((r) => getReminder(senderId, r.id)));
}

// ---------- chat tools ----------

const when = (r) => (r.remind_at ? stamp(r.remind_at) : 'as soon as it is sent');

function sentLine(r) {
  const state = { pending: 'waiting for the sender to tap Send', scheduled: `will go out ${stamp(r.remind_at)}`, delivered: `delivered ${stamp(r.delivered_at)}` }[r.status];
  const who = r.people.map((p) => `${p.name} ${p.done ? '✓ done' : '— not done'}`).join('; ');
  return `- #${r.id} "${r.text}" (${state}). ${r.everyone ? 'Everyone: ' : ''}${who}`;
}

function definitions(names) {
  return [
    {
      name: 'remind_people',
      description: 'Send a reminder to OTHER people who use Riley — "remind Rona and Tauqeer to send the report at 3pm", ' +
        '"tell everyone the office closes early tomorrow". For the user\'s own reminders use add_todo instead. ' +
        'This does NOT send it: a card with Send and Cancel appears in the chat and nothing goes out until the user taps Send. ' +
        'Say in one short line that it is ready for them to send. If a name is unclear the tool says so — ask, do not guess. ' +
        'It can carry photos the user attached in this chat: pass their file names in photos, and only when the user wants the picture sent along. ' +
        `The people who can be reminded: ${names.join(', ') || 'nobody else yet'}.`,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The reminder as they will read it, short, e.g. "Send the monthly report".' },
          people: { type: 'array', items: { type: 'string' }, description: 'Names of the people it is for. Leave empty when everyone is true.' },
          everyone: { type: 'boolean', description: 'True to send it to everyone (except the user).' },
          photos: {
            type: 'array', items: { type: 'string' },
            description: `Optional. File names of photos to send with it, exactly as given in <image name="…" /> or <file_library>. At most ${MAX_PHOTOS}.`,
          },
          remind_at: {
            type: 'string',
            description: 'Optional. When it should reach them, ISO 8601 WITH the UAE offset, e.g. "2026-10-05T15:00:00+04:00". Omit to send it straight away.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'list_sent_reminders',
      description: 'The reminders the user has sent to others, with who has marked each one done. Use for "did Rona do it?".',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_received_reminders',
      description: 'Reminders other people have sent to the user, with their ids. Use for "what have I been asked to do?".',
      input_schema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
    },
    {
      name: 'complete_received_reminder',
      description: 'Mark a reminder someone else sent the user as done, by id. Only when the user says it is done. The sender will see it.',
      input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  ];
}

const STATUS = {
  remind_people: 'Getting the reminder ready…',
  list_sent_reminders: 'Checking who has done it…',
  list_received_reminders: 'Checking what you have been sent…',
  complete_received_reminder: 'Ticking that off…',
};

/**
 * The toolkit for chat.js. The list of names is read once per turn and put in the tool's
 * description, so Riley spells people the way the app does.
 * ctx: { conversationId, onCard } — onCard puts the Send/Cancel card in front of the user.
 */
export async function teamReminderKit(userId, ctx = {}) {
  const names = (await others(userId)).slice(0, 200).map((u) => u.name);
  const handlers = {
    remind_people: async (input) => {
      const r = await proposeReminder(userId, {
        text: input.text, people: input.people || [], everyone: !!input.everyone,
        remind_at: input.remind_at, conversationId: ctx.conversationId, photos: input.photos || [],
      });
      ctx.onCard?.(r);
      const pics = r.photos.length ? ` with ${r.photos.length} photo${r.photos.length === 1 ? '' : 's'}` : '';
      return `Ready as #${r.id}: "${r.text}"${pics} for ${r.everyone ? `everyone (${r.people.length} people)` : r.people.map((p) => p.name).join(', ')}, ${when(r)}. ` +
        'It is NOT sent yet — the card in the chat has Send and Cancel. Tell the user to tap Send. Never say it has been sent.';
    },
    list_sent_reminders: async () => {
      const rows = await sentBy(userId);
      return rows.length ? rows.map(sentLine).join('\n') : 'They have not sent anyone a reminder yet.';
    },
    list_received_reminders: async (input) => {
      const open = await inbox(userId);
      const done = input.include_done ? await inbox(userId, { done: true, limit: 15 }) : [];
      const line = (r) => `- #${r.id} from ${r.sender_name}: "${r.text}"${r.done ? ' ✓ done' : ''}`;
      if (!open.length && !done.length) return 'Nobody has sent them a reminder that is still open.';
      return [open.length ? `Open:\n${open.map(line).join('\n')}` : 'Nothing open.', done.length ? `Done:\n${done.map(line).join('\n')}` : ''].filter(Boolean).join('\n\n');
    },
    complete_received_reminder: async (input) => {
      if (!await markDone(userId, input.id)) throw new Error(`No reminder #${input.id} was sent to them. Call list_received_reminders for the ids.`);
      return `Marked #${input.id} done. The sender can see it.`;
    },
  };
  return {
    definitions: definitions(names),
    status: (name) => STATUS[name] || null,
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const teamReminderRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'Reminder not found' });

// Sent to me, not yet ticked: the first screen.
teamReminderRoutes.get('/inbox', wrap(async (req, res) => res.json(await inbox(req.user.id))));
teamReminderRoutes.post('/inbox/:id/done', wrap(async (req, res) => {
  (await markDone(req.user.id, req.params.id, req.body?.done !== false)) ? res.json({ ok: true }) : gone(res);
}));
// The cards in one chat, oldest first, whatever became of them.
teamReminderRoutes.get('/', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM team_reminders WHERE sender_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(await Promise.all(rows.map((r) => getReminder(req.user.id, r.id))));
}));
teamReminderRoutes.get('/photos/:id', wrap(async (req, res) => {
  const f = await photoFor(req.user.id, req.params.id);
  if (!f) return gone(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(f.mime).sendFile(f.path);
}));
teamReminderRoutes.get('/:id', wrap(async (req, res) => {
  const r = await getReminder(req.user.id, req.params.id);
  r ? res.json(r) : gone(res);
}));
teamReminderRoutes.post('/:id/send', wrap(async (req, res) => {
  const r = await decideReminder(req.user.id, req.params.id, true);
  r ? res.json(r) : gone(res);
}));
teamReminderRoutes.post('/:id/cancel', wrap(async (req, res) => {
  const r = await decideReminder(req.user.id, req.params.id, false);
  r ? res.json(r) : gone(res);
}));
