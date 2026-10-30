import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { sendPush } from './push.js';
import { remindAt } from './todos.js';

// Reminders one person sends to others: "remind Rona and Tauqeer to send the report at 3".
//
// Said in chat, never typed into a form. Reem only ever PROPOSES one: the tool writes it
// down as pending and a card appears in the chat with Send and Cancel. Nothing reaches
// anybody until the sender taps Send — a misheard name or a wrong time is caught on the
// card, not on someone else's phone.
//
// Once sent, it becomes a to-do on each person's own list, marked as from the sender, and
// they get a buzz (if they have switched notifications on). Their list is the one place
// for what they have to do; ticking the to-do is what the sender sees on the card.
//
// Anyone may send one to anyone, or to everyone. "Everyone" is every active person except
// the sender, fixed at the moment it is proposed: someone added next week did not get it.
// Only people who have the To-do list can be sent one — it is where it lands.
//
// A reminder can carry photos or a video: ones the sender attached in the chat, named to
// the tool by file name. The bytes are copied here as the card is made, so what the others
// open is what the sender saw on the card — deleting it from the Shelf changes nothing.
// Only the sender, and the people it has actually been sent to, can open one.

const DIR = `${DATA_DIR}/reminder-files`;
const MAX_TEXT = 1000; // an instruction with its reasons; 300 cut them off mid-word
const MAX_PHOTOS = 3;
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const VIDEO = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;
const CATCHUP = 6 * 3600; // later than this and it is shown, but no phone is woken for it
const NOW = 'extract(epoch from now())::bigint';
const now = () => Math.floor(Date.now() / 1000);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

const stamp = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** Everyone this person could send to: active, and not themselves. has_list: they have the To-do list. */
const others = (userId) => db.prepare(`SELECT id, name, email,
      (role = 'master' OR EXISTS (SELECT 1 FROM module_access m WHERE m.user_id = users.id AND m.module = 'todos')) has_list
    FROM users WHERE id <> ? AND NOT disabled AND NOT external ORDER BY lower(name)`).all(userId);

/** Said to Reem, who says it to the sender: the master can switch the list on for them. */
function noList(people) {
  const names = people.map((u) => u.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} do` : `${names[0]} does`;
  return bad(`${who} not have the To-do list, which is where it would land. The master can tick To-do for them on their People profile.`);
}

/**
 * "Rona", "tauqeer", "rona@..." → people. Whole name first, then any one word of the name,
 * then the front of the email address. A name that fits nobody, or fits two people, is an
 * error that names the candidates, so Reem asks rather than picks.
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
    if (!hits.length) throw bad(`Nobody called "${raw}" uses Reem. The people are: ${pool.map((u) => u.name).join(', ') || 'nobody else yet'}.`);
    if (hits.length > 1) throw bad(`"${raw}" could be ${hits.map((u) => u.name).join(' or ')}. Ask which one.`);
    found.set(hits[0].id, hits[0]);
  }
  return [...found.values()];
}

/** One of the sender's own pictures or videos — attached in the chat, or on their Shelf — by its file name. */
async function chatPhoto(userId, name) {
  const want = String(name || '').trim().toLowerCase();
  // The same file name twice means the newer upload: that is the one just attached.
  const doc = want && await db.prepare(`SELECT name, mime, path FROM documents
      WHERE user_id = ? AND path IS NOT NULL AND lower(name) = ? ORDER BY id DESC LIMIT 1`).get(userId, want);
  if (!doc) throw bad(`There is no picture or video called "${name}". Only one the user attached in this chat, or saved on their Shelf, can go on a reminder.`);
  if (!IMAGE.test(doc.mime || '') && !VIDEO.test(doc.mime || '')) throw bad(`${doc.name} is not a photo or a video. A reminder can carry a JPG, PNG, GIF or WebP picture, or an MP4, MOV or WebM video.`);
  // Copied, not read in: a phone video can be a few hundred megabytes.
  if (!existsSync(doc.path)) throw bad(`${doc.name} is listed on the Shelf but its file is missing.`);
  return doc;
}

const photoOut = (p) => ({ id: p.id, name: p.name, mime: p.mime, url: `/api/team-reminders/photos/${p.id}` });

/** The photos on these reminders, as the app shows them: a lookup by reminder id. */
async function photosOf(reminderIds) {
  const rows = reminderIds.length
    ? await db.prepare('SELECT id, reminder_id, name, mime FROM team_reminder_photos WHERE reminder_id = ANY(?::int[]) ORDER BY id').all(reminderIds)
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
  // `|| 0`: phones still on the app from before To-dos ask for /team-reminders/inbox, which
  // lands here as id "inbox". That is "not found", not a database error.
  const r = await db.prepare('SELECT * FROM team_reminders WHERE id = ? AND sender_id = ?').get(Number(id) || 0, senderId);
  if (!r) return null;
  // The tick is on each person's to-do. A row without one is from before that, or not sent yet.
  const people = await db.prepare(`SELECT u.id, u.name, COALESCE(t.done, p.done) done,
        CASE WHEN t.id IS NULL THEN p.done_at ELSE t.done_at END done_at
      FROM team_reminder_people p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN todos t ON t.id = p.todo_id
      WHERE p.reminder_id = ? ORDER BY lower(u.name)`).all(r.id);
  const { sender_id, ...rest } = r;
  return { ...rest, people, photos: (await photosOf([r.id]))(r.id) };
}

/** Writes the reminder and its people and copies its files. Nothing is checked here. */
async function write(senderId, { body, to, at, everyone, conversationId, files, status = 'pending' }) {
  const { id } = await db.prepare(`INSERT INTO team_reminders (sender_id, conversation_id, text, remind_at, everyone, status)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).run(senderId, conversationId, body, at, !!everyone, status);
  await db.prepare(`INSERT INTO team_reminder_people (reminder_id, user_id)
      SELECT ?::int, * FROM UNNEST(?::int[])`).run(id, to.map((u) => u.id));
  if (files.length) mkdirSync(`${DIR}/${senderId}`, { recursive: true });
  for (const f of files) {
    const path = `${DIR}/${senderId}/${randomUUID()}${extname(f.name).toLowerCase().replace(/[^.\w]/g, '')}`;
    copyFileSync(f.path, path);
    await db.prepare('INSERT INTO team_reminder_photos (reminder_id, name, mime, path) VALUES (?, ?, ?, ?)').run(id, f.name, f.mime, path);
  }
  return id;
}

export async function proposeReminder(senderId, { text, people = [], everyone = false, remind_at, conversationId = null, photos = [] }) {
  const body = clean(text);
  if (!body) throw bad('A reminder needs something to say');
  let to;
  if (everyone) {
    to = (await others(senderId)).filter((u) => u.has_list);
  } else {
    to = await findPeople(senderId, people);
    const without = to.filter((u) => !u.has_list);
    if (without.length) throw noList(without);
  }
  if (!to.length) throw bad(everyone ? 'There is nobody else to send it to yet.' : 'Say who it is for.');
  const at = remindAt(remind_at);
  // Found before anything is written: a card that says "photo" with nothing on it is worse than no card.
  const names = Array.isArray(photos) ? photos : [];
  if (names.length > MAX_PHOTOS) throw bad(`Too many photos or videos (at most ${MAX_PHOTOS} on one reminder).`);
  const files = [];
  for (const name of names) files.push(await chatPhoto(senderId, name));
  const id = await write(senderId, { body, to, at, everyone, conversationId, files });
  return getReminder(senderId, id);
}

/**
 * A to-do typed on the To-do screen with someone picked to do it. There is no card to tap
 * there — picking the person and pressing Add is the decision — so it goes straight out.
 */
export async function assignTodo(senderId, { text, userId, remind_at }) {
  const body = clean(text);
  if (!body) throw bad('A to-do needs something to do');
  const person = (await others(senderId)).find((u) => u.id === Number(userId));
  if (!person) throw bad('Pick someone else to give it to, or leave it as your own.');
  if (!person.has_list) throw noList([person]);
  const at = remindAt(remind_at);
  const id = await write(senderId, { body, to: [person], at, everyone: false, conversationId: null, files: [], status: 'scheduled' });
  if (at == null || at <= now()) await deliver(id);
  return getReminder(senderId, id);
}

/**
 * Each person's to-do, made with the reminder already marked as notified for its time, so
 * the to-do timer in reminders.js does not buzz again for what deliver() has just sent.
 * One statement, so the timer can never see the to-do without that mark.
 */
const giveTodos = (r) => db.prepare(`
  WITH made AS (
    INSERT INTO todos (user_id, text, remind_at, team_reminder_id)
    SELECT p.user_id, ?::text, ?::bigint, p.reminder_id FROM team_reminder_people p WHERE p.reminder_id = ?::int
    ON CONFLICT (team_reminder_id, user_id) WHERE team_reminder_id IS NOT NULL DO NOTHING
    RETURNING id, user_id, remind_at
  ), quiet AS (
    INSERT INTO reminders_sent (user_id, todo_id, due_at) SELECT user_id, id, remind_at FROM made
  )
  UPDATE team_reminder_people p SET todo_id = made.id FROM made WHERE p.reminder_id = ?::int AND p.user_id = made.user_id`)
  .run(r.text, r.remind_at ?? r.delivered_at, r.id, r.id);

/**
 * Hand it over, exactly once. The status change is the lock: whichever caller moves it
 * from scheduled to delivered is the one that sends, so the timer and a Send tap landing
 * in the same second cannot buzz anyone twice.
 */
async function deliver(id) {
  const r = await db.prepare(`UPDATE team_reminders SET status = 'delivered', delivered_at = ${NOW}
      WHERE id = ? AND status = 'scheduled' RETURNING *`).get(id);
  if (!r) return;
  await giveTodos(r); // on their list however late, even when it is too late to buzz
  if ((r.remind_at ?? now()) < now() - CATCHUP) return;
  const ids = (await db.prepare('SELECT user_id FROM team_reminder_people WHERE reminder_id = ?').all(r.id)).map((p) => p.user_id);
  const from = await db.prepare('SELECT name FROM users WHERE id = ?').get(r.sender_id);
  const media = (await db.prepare('SELECT mime FROM team_reminder_photos WHERE reminder_id = ?').all(r.id)).map((f) => f.mime);
  const mark = media.some((m) => VIDEO.test(m)) ? '🎬 ' : media.length ? '📷 ' : '';
  await sendPush(ids, { title: `To-do from ${from?.name || 'a colleague'}`, body: `${mark}${r.text}`, url: '/?todos=1', tag: `reem-team-${r.id}` })
    .catch((e) => console.error('[team-reminders]', e.message));
}

/**
 * Run at start-up: reminders delivered before they became to-dos are put on each person's
 * list, ticked or not as they were, and marked as notified so nobody is buzzed about them.
 * A person row that already has its to-do is left alone, so running it again does nothing.
 *
 * Whoever had them on their first screen without the To-do list is given the list along
 * with them — otherwise moving them would lose them. Only in the run that moves them, so a
 * list the master takes away later is not put back by the next restart.
 */
export async function bringOldRemindersIntoTodos() {
  const { changes } = await db.prepare(`
    WITH made AS (
      INSERT INTO todos (user_id, text, remind_at, done, done_at, created_at, updated_at, team_reminder_id)
      SELECT p.user_id, r.text, COALESCE(r.remind_at, r.delivered_at, r.created_at), p.done, p.done_at,
             COALESCE(r.delivered_at, r.created_at), COALESCE(p.done_at, r.delivered_at, r.created_at), r.id
      FROM team_reminder_people p JOIN team_reminders r ON r.id = p.reminder_id
      WHERE r.status = 'delivered' AND p.todo_id IS NULL
      ON CONFLICT (team_reminder_id, user_id) WHERE team_reminder_id IS NOT NULL DO NOTHING
      RETURNING id, user_id, remind_at, team_reminder_id
    ), quiet AS (
      INSERT INTO reminders_sent (user_id, todo_id, due_at) SELECT user_id, id, remind_at FROM made
    ), list AS (
      INSERT INTO module_access (user_id, module) SELECT DISTINCT user_id, 'todos' FROM made
      ON CONFLICT DO NOTHING
    )
    UPDATE team_reminder_people p SET todo_id = made.id FROM made
    WHERE p.reminder_id = made.team_reminder_id AND p.user_id = made.user_id`).run();
  return changes;
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

// What others have sent this person is on their to-do list (server/todos.js), read and
// ticked there like any other to-do, so there is no inbox of its own here.

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
      description: 'Give a task or reminder to OTHER people who use Reem — "tell Hayley to send progress videos", ' +
        '"remind Rona and Tauqeer to send the report at 3pm", "tell everyone the office closes early tomorrow". ' +
        'Once sent it lands as a to-do on each person\'s own list, marked as from the user. For the user\'s own to-dos use add_todo instead. ' +
        'This does NOT send it: a card with Send and Cancel appears in the chat and nothing goes out until the user taps Send. ' +
        'Say in one short line that it is ready for them to send. If a name is unclear the tool says so — ask, do not guess. ' +
        'It can carry photos or a video the user attached in this chat: pass their file names in photos, and only when the user wants them sent along ' +
        '(an instruction that says "see attached" means they do). ' +
        `The people who can be given one: ${names.join(', ') || 'nobody else yet'}.`,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The to-do as they will read it, in full — what to do and anything they need to know to do it.' },
          people: { type: 'array', items: { type: 'string' }, description: 'Names of the people it is for. Leave empty when everyone is true.' },
          everyone: { type: 'boolean', description: 'True to send it to everyone (except the user).' },
          photos: {
            type: 'array', items: { type: 'string' },
            description: `Optional. File names of photos or videos to send with it, exactly as given in <image name="…" /> or <file_library>. At most ${MAX_PHOTOS}.`,
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
  ];
}

const STATUS = {
  remind_people: 'Getting the to-do ready…',
  list_sent_reminders: 'Checking who has done it…',
};

/**
 * The toolkit for chat.js. The list of names is read once per turn and put in the tool's
 * description, so Reem spells people the way the app does.
 * ctx: { conversationId, onCard } — onCard puts the Send/Cancel card in front of the user.
 */
export async function teamReminderKit(userId, ctx = {}) {
  const names = (await others(userId)).filter((u) => u.has_list).slice(0, 200).map((u) => u.name);
  const handlers = {
    remind_people: async (input) => {
      const r = await proposeReminder(userId, {
        text: input.text, people: input.people || [], everyone: !!input.everyone,
        remind_at: input.remind_at, conversationId: ctx.conversationId, photos: input.photos || [],
      });
      ctx.onCard?.(r);
      const pics = r.photos.length ? ` with ${r.photos.length} attachment${r.photos.length === 1 ? '' : 's'}` : '';
      return `Ready as #${r.id}: "${r.text}"${pics} for ${r.everyone ? `everyone (${r.people.length} people)` : r.people.map((p) => p.name).join(', ')}, ${when(r)}. ` +
        'It is NOT sent yet — the card in the chat has Send and Cancel. Tell the user to tap Send; it then goes on their to-do lists. Never say it has been sent.';
    },
    list_sent_reminders: async () => {
      const rows = await sentBy(userId);
      return rows.length ? rows.map(sentLine).join('\n') : 'They have not sent anyone a reminder yet.';
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

// The people a to-do can be given to, for the To-do screen's "For" picker.
teamReminderRoutes.get('/people', wrap(async (req, res) => {
  res.json((await others(req.user.id)).filter((u) => u.has_list).map(({ id, name }) => ({ id, name })));
}));
// A to-do typed on the To-do screen with someone picked: it goes straight out.
teamReminderRoutes.post('/assign', wrap(async (req, res) => {
  res.json(await assignTodo(req.user.id, { text: req.body?.text, userId: req.body?.user_id, remind_at: req.body?.remind_at }));
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
