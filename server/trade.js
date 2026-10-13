import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { DATA_DIR, MODELS } from './config.js';
import { isMaster } from './access.js';
import { claude, transcribe, audioExt } from './ai.js';
import { needsModule, userModules } from './modules.js';

// Sales & purchase: a book of what was sold and what was bought, kept by someone who is
// not at home with forms. They say which of the two it is, photograph the bill, and may
// say a few words in whatever language they speak. Reem reads the bill and the words and
// fills in who, how much and when; nothing is typed.
//
// A reading that goes wrong is put right the same way, by saying so (addVoice): the bill
// is read again with everything said so far, and what was said wins over the paper.
//
// An entry is never refused for being unreadable. It is kept with its photo and marked
// 'check', and the master looks at it.
//
// Kept in Reem only. Nothing here reads saifsys or writes to its accounts.

const DIR = `${DATA_DIR}/trade`;
const KINDS = ['sale', 'purchase'];
const MAX_PHOTOS = 5;
const REDO = 900; // for fifteen minutes an entry is still its writer's to take back
const NOW = 'extract(epoch from now())::bigint';
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const bare = (mime = '') => mime.split(';')[0].trim().toLowerCase(); // 'audio/webm;codecs=opus' is 'audio/webm'
// A phone's recorder may call a sound-only file video/webm or video/mp4.
const isVoice = (f) => !!f?.buffer?.length && /^(audio\/|video\/(webm|mp4)$)/.test(bare(f.mimetype));

// ---------- reading the bill ----------

const SYSTEM = `You keep the sales and purchase book of a small company in the UAE. A member of staff has photographed a bill, invoice or receipt, and may also have said something about it. Write down what it is by calling the record tool.

- The photo may be printed or handwritten, in any language. The spoken words may be in any language too.
- What the staff member said wins over the paper. Later lines of what they said correct earlier ones.
- party: for a purchase, who it was bought from; for a sale, who it was sold to. null if nothing says.
- amount: the final total to pay, including VAT. A number only. null if you cannot tell - never guess.
- currency: the three-letter code. AED unless something says otherwise.
- date: the date on the bill as YYYY-MM-DD. null if there is none.
- about: one short plain line in English saying what was sold or bought, with anything useful the staff member said.`;

const RECORD = {
  name: 'record',
  description: 'Write this sale or purchase into the book.',
  input_schema: {
    type: 'object',
    properties: {
      party: { type: ['string', 'null'] },
      amount: { type: ['number', 'null'] },
      currency: { type: 'string' },
      date: { type: ['string', 'null'] },
      about: { type: 'string' },
    },
    required: ['party', 'amount', 'currency', 'date', 'about'],
  },
};

/** What the bill and the spoken words say. photos: [{ mime, buffer }]. */
async function readBill({ kind, photos, said }) {
  const res = await claude.messages.create({
    model: MODELS[0].id, // not the fast one: a misread figure here is money
    max_tokens: 600,
    system: SYSTEM,
    tools: [RECORD],
    tool_choice: { type: 'tool', name: 'record' },
    messages: [{
      role: 'user',
      content: [
        ...photos.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.buffer.toString('base64') } })),
        { type: 'text', text: `This is a ${kind}.\n${photos.length ? '' : 'There is no photo.\n'}What the staff member said: ${said || '(nothing)'}` },
      ],
    }],
  });
  return res.content.find((b) => b.type === 'tool_use')?.input;
}

const clip = (s, max) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);

/** A reading made safe to keep: a real amount or none, a real date or none. */
export function tidy(r) {
  const { party, amount, currency, date, about } = r || {};
  const n = amount == null ? NaN : Number(String(amount).replace(/,/g, ''));
  // 30 February parses, as 2 March: a date only counts if it comes back as itself.
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? Date.parse(`${date}T00:00:00Z`) : NaN;
  const day = !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(date) ? date : null;
  return {
    party: clip(party, 200),
    amount: Number.isFinite(n) && n > 0 && n < 1e12 ? Math.round(n * 100) / 100 : null,
    currency: /^[a-z]{3}$/i.test(currency || '') ? currency.toUpperCase() : 'AED',
    bill_date: day,
    about: clip(about, 500),
  };
}

/** Read the entry's bill again with everything said so far, and keep what comes of it. */
async function understand(id, read) {
  const e = await db.prepare('SELECT kind, said FROM trade_entries WHERE id = ?').get(id);
  let got = null;
  try {
    const files = await db.prepare(`SELECT mime, path FROM trade_entry_files WHERE entry_id = ? AND kind = 'photo' ORDER BY id`).all(id);
    const photos = await Promise.all(files.map(async (f) => ({ mime: f.mime, buffer: await readFile(f.path) })));
    got = tidy(await read({ kind: e.kind, photos, said: e.said }));
  } catch (err) {
    console.warn('[trade] could not read entry', id, err.message);
  }
  // A reading that failed leaves what was there: a correction must not wipe a good entry.
  if (!got) return db.prepare(`UPDATE trade_entries SET status = CASE WHEN amount IS NULL THEN 'check' ELSE status END WHERE id = ?`).run(id);
  await db.prepare('UPDATE trade_entries SET party = ?, amount = ?, currency = ?, bill_date = ?, about = ?, status = ? WHERE id = ?')
    .run(got.party, got.amount, got.currency, got.bill_date, got.about, got.amount == null ? 'check' : 'ok', id);
}

// ---------- reading ----------

const filesOf = (ids) => (ids.length
  ? db.prepare('SELECT id, entry_id, kind FROM trade_entry_files WHERE entry_id = ANY(?::int[]) ORDER BY id').all(ids)
  : []);

const out = (e, files, user, now) => {
  const mine = e.user_id === user.id;
  const ids = (kind) => files.filter((f) => f.entry_id === e.id && f.kind === kind).map((f) => f.id);
  return {
    id: e.id, kind: e.kind, party: e.party, amount: e.amount == null ? null : Number(e.amount), currency: e.currency,
    date: e.bill_date, about: e.about, said: e.said, status: e.status, createdAt: e.created_at, by: e.by_name || null, mine,
    photos: ids('photo'), voices: ids('voice'),
    canRemove: isMaster(user) || (mine && now - e.created_at < REDO),
  };
};

const DUBAI = 4 * 3600; // no summer time there
/** When today and this month began in Dubai, in epoch seconds. */
export function monthAndDay(now = Date.now() / 1000) {
  const d = new Date((now + DUBAI) * 1000);
  const at = (day) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day) / 1000 - DUBAI;
  return { day: at(d.getUTCDate()), month: at(1) };
}

const SELECT = 'SELECT e.*, u.name AS by_name FROM trade_entries e LEFT JOIN users u ON u.id = e.user_id';

// What a search looks through: the name, what it was for, the words spoken, the amount
// as it is written, and who recorded it.
const FOUND = `(e.party ILIKE ? OR e.about ILIKE ? OR e.said ILIKE ? OR e.amount::text ILIKE ? OR u.name ILIKE ?)`;
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** When a 'YYYY-MM-DD' day begins in Dubai, in epoch seconds; null for anything that is not a day. */
export function dayStart(s) {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isNaN(ms) || !new Date(ms).toISOString().startsWith(s) ? null : ms / 1000 - DUBAI;
}

/**
 * The latest entries and what they add up to: everybody's for the master, their own for
 * anyone else. q narrows the entries to the ones that mention it, and from and to (days in
 * Dubai, both counted) to the ones recorded then, reaching back through the whole book and
 * not only the latest. totals are always of everything; found is what the narrowed entries
 * add up to, all of them and not only the ones listed, and is null when nothing narrows.
 */
export async function listEntries(user, { q = '', from = '', to = '' } = {}) {
  const all = isMaster(user);
  const find = String(q ?? '').trim().slice(0, 100);
  const a = dayStart(from);
  const b = dayStart(to);
  const [since, until] = a != null && b != null && b < a ? [b, a] : [a, b]; // the wrong way round is still a stretch
  const narrow = [
    ...(find ? [[FOUND, Array(5).fill(like(find))]] : []),
    ...(since != null ? [['e.created_at >= ?', [since]]] : []),
    ...(until != null ? [['e.created_at < ?', [until + 86400]]] : []),
  ];
  const conds = [...(all ? [] : [['e.user_id = ?', [user.id]]]), ...narrow];
  const where = conds.length ? `WHERE ${conds.map((c) => c[0]).join(' AND ')}` : '';
  const args = conds.flatMap((c) => c[1]);
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY e.id DESC LIMIT ${all ? 200 : 100}`).all(...args);
  const found = narrow.length
    ? (await db.prepare(`SELECT e.kind, e.currency, count(*)::int AS entries, COALESCE(sum(e.amount), 0) AS total
        FROM trade_entries e LEFT JOIN users u ON u.id = e.user_id ${where} GROUP BY e.kind, e.currency ORDER BY e.kind, e.currency`).all(...args))
      .map((s) => ({ kind: s.kind, currency: s.currency, entries: s.entries, total: Number(s.total) }))
    : null;
  const files = await filesOf(rows.map((r) => r.id));
  const { day, month } = monthAndDay();
  const sums = await db.prepare(`SELECT kind, currency, COALESCE(sum(amount) FILTER (WHERE created_at >= ?), 0) AS today, sum(amount) AS month
    FROM trade_entries WHERE amount IS NOT NULL AND created_at >= ? ${all ? '' : 'AND user_id = ?'}
    GROUP BY kind, currency ORDER BY kind, currency`).all(...[day, month, ...(all ? [] : [user.id])]);
  const now = Date.now() / 1000;
  return {
    entries: rows.map((e) => out(e, files, user, now)),
    totals: sums.map((s) => ({ kind: s.kind, currency: s.currency, today: Number(s.today), month: Number(s.month) })),
    found,
  };
}

async function oneEntry(user, id) {
  const e = await db.prepare(`${SELECT} WHERE e.id = ?`).get(Number(id) || 0);
  if (!e || (!isMaster(user) && e.user_id !== user.id)) return null;
  return e;
}

const shown = async (user, id) => (await listEntries(user)).entries.find((e) => e.id === id);

// ---------- writing ----------

async function keep(entryId, kind, mime, ext, buffer) {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${randomUUID()}.${ext}`;
  await writeFile(path, buffer);
  await db.prepare('INSERT INTO trade_entry_files (entry_id, kind, mime, path) VALUES (?, ?, ?, ?)').run(entryId, kind, mime, path);
}
const keepVoice = (entryId, v) => keep(entryId, 'voice', bare(v.mimetype), audioExt(v.mimetype), v.buffer);

/** What was spoken, in the language it was spoken in. No language is named, so the model works it out. */
const heard = async (hear, v) => String(await hear(v.buffer, bare(v.mimetype)) ?? '').trim().slice(0, 4000);

/** A new entry: saved with its photos and voice note, then read. photos and voice are multer's. */
export async function createEntry(user, { kind, photos = [], voice = null }, { read = readBill, hear = transcribe } = {}) {
  if (!KINDS.includes(kind)) throw bad('Please choose Sale or Purchase');
  if (photos.length > MAX_PHOTOS) throw bad(`At most ${MAX_PHOTOS} photos on one entry`);
  if (photos.some((f) => !PHOTO_TYPES[f.mimetype] || !f.buffer?.length)) throw bad('A photo must be a JPG or PNG picture');
  if (voice && !isVoice(voice)) throw bad('That voice note could not be used. Please record it again.');
  if (!photos.length && !voice) throw bad('Please take a photo of the bill or say what it was');

  const { id } = await db.prepare('INSERT INTO trade_entries (user_id, kind) VALUES (?, ?) RETURNING id').run(user.id, kind);
  for (const f of photos) await keep(id, 'photo', f.mimetype, PHOTO_TYPES[f.mimetype], f.buffer);
  if (voice) {
    await keepVoice(id, voice);
    // Words that could not be made out are not a reason to lose the entry: the recording is kept.
    const said = await heard(hear, voice).catch((e) => { console.warn('[trade] could not hear entry', id, e.message); return ''; });
    if (said) await db.prepare('UPDATE trade_entries SET said = ? WHERE id = ?').run(said, id);
  }
  await understand(id, read);
  return shown(user, id);
}

/** Put an entry right by saying what is wrong with it. */
export async function addVoice(user, id, voice, { read = readBill, hear = transcribe } = {}) {
  const e = await oneEntry(user, id);
  if (!e) throw bad('Entry not found', 404);
  if (!isVoice(voice)) throw bad('That voice note could not be used. Please record it again.');
  const said = await heard(hear, voice).catch(() => '');
  if (!said) throw bad('Reem could not hear that. Please say it again.');
  await keepVoice(e.id, voice);
  await db.prepare('UPDATE trade_entries SET said = ? WHERE id = ?').run([e.said, said].filter(Boolean).join('\n').slice(0, 8000), e.id);
  await understand(e.id, read);
  return shown(user, e.id);
}

/** Take an entry away, with its pictures and recordings. */
export async function deleteEntry(user, id) {
  const e = await oneEntry(user, id);
  if (!e) throw bad('Entry not found', 404);
  if (!isMaster(user) && Date.now() / 1000 - e.created_at >= REDO) throw bad('Only the master can delete this entry now', 403);
  const files = await db.prepare('SELECT path FROM trade_entry_files WHERE entry_id = ?').all(e.id);
  await db.prepare('DELETE FROM trade_entries WHERE id = ?').run(e.id);
  // Only ever inside our own folder, whatever the row says.
  for (const f of files) if (f.path.startsWith(`${DIR}/`)) rmSync(f.path, { force: true });
}

// ---------- Reem in chat ----------

// Asking only. An entry is still made on the screen, from a photo of the bill; nothing a
// chat says can add one, change one or take one away.

const MAX_CHAT_ENTRIES = 40;
const DAY = { type: 'string', description: 'YYYY-MM-DD, a day in Dubai. Work it out from the current date given to you.' };
const BOOK = {
  name: 'sales_purchases',
  description: 'The Sales & purchase book: what staff recorded as sold or bought from a photo of the bill - who it was sold to or bought from, ' +
    'how much, the date on the bill, what it was for, when it was recorded and by whom. ' +
    'Use for "how much did we sell today?", "total purchases this month?", "what did Ahmed record this week?", "any bill from Al Noor?", "what did we buy on 5 October?". ' +
    'It always gives the totals for today and for this month. With search, from or to it also gives "found": what the matching entries add up to - ' +
    'all of them, even when the list of entries is cut short - so take a total from there and never add the listed entries up yourself. ' +
    'from and to are the days an entry was recorded, both counted. Totals are per currency and leave out an entry whose amount could not be read (needs_checking). ' +
    'The master is shown everyone\'s entries; anyone else only their own - "whose" says which. ' +
    'View only: an entry is added on the Sales & purchase screen, not here - say so only if asked to put something in the book. ' +
    'A bill or receipt sent in the chat is not a request for the book: it is saved on the Shelf like any file, and this tool is not needed for it. ' +
    'This is not the Shelf: contracts and other documents are found with the Shelf tools.',
  input_schema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Optional. Part of the name, what it was for, the amount, or the name of who recorded it.' },
      from: DAY,
      to: DAY,
      kind: { type: 'string', enum: KINDS, description: 'Optional. Only sales, or only purchases.' },
    },
  },
};

async function bookForChat(user, input) {
  for (const d of [input.from, input.to]) if (d && dayStart(d) == null) throw new Error('Dates look like 2026-10-13');
  const of = (list) => (KINDS.includes(input.kind) ? list.filter((x) => x.kind === input.kind) : list);
  const { entries, totals, found } = await listEntries(user, { q: input.search, from: input.from, to: input.to });
  const list = of(entries);
  const day = (secs) => new Date((secs + DUBAI) * 1000).toISOString().slice(0, 10);
  return JSON.stringify({
    whose: isMaster(user) ? 'everyone\'s entries' : 'this user\'s own entries only',
    totals: of(totals),
    ...(found ? { found: of(found) } : {}),
    entries: list.slice(0, MAX_CHAT_ENTRIES).map((e) => ({
      id: e.id, kind: e.kind, party: e.party, amount: e.amount, currency: e.currency, bill_date: e.date, about: e.about,
      recorded: day(e.createdAt), by: e.by, ...(e.status === 'check' ? { needs_checking: true } : {}),
    })),
    ...(list.length > MAX_CHAT_ENTRIES ? { more: `Only the latest ${MAX_CHAT_ENTRIES} entries are listed. Narrow it with search or dates to see others.` } : {}),
  });
}

/** The book's one tool, same shape as buildingKit(). Only for someone who has the module. */
export async function tradeKit(user) {
  const has = (await userModules(user)).includes('trade');
  return {
    definitions: has ? [BOOK] : [],
    status: () => 'Looking at the sales and purchases…',
    run: async (block) => {
      try {
        if (!has || block.name !== BOOK.name) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await bookForChat(user, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const tradeRoutes = Router();
tradeRoutes.use(needsModule('trade'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: MAX_PHOTOS + 1 } });

tradeRoutes.get('/', wrap(async (req, res) => {
  res.json(await listEntries(req.user, { q: req.query.q, from: req.query.from, to: req.query.to }));
}));

tradeRoutes.post('/', upload.fields([{ name: 'photos', maxCount: MAX_PHOTOS }, { name: 'voice', maxCount: 1 }]), wrap(async (req, res) => {
  res.json(await createEntry(req.user, { kind: req.body.kind, photos: req.files?.photos || [], voice: req.files?.voice?.[0] || null }));
}));

tradeRoutes.post('/:id/say', upload.single('voice'), wrap(async (req, res) => {
  res.json(await addVoice(req.user, req.params.id, req.file));
}));

tradeRoutes.delete('/:id', wrap(async (req, res) => {
  await deleteEntry(req.user, req.params.id);
  res.json({ ok: true });
}));

tradeRoutes.get('/:id/files/:file', wrap(async (req, res) => {
  const e = await oneEntry(req.user, req.params.id);
  const f = e && await db.prepare('SELECT mime, path FROM trade_entry_files WHERE id = ? AND entry_id = ?').get(Number(req.params.file) || 0, e.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(f.mime).sendFile(f.path);
}));
