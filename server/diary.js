import { Router } from 'express';
import { db } from './db.js';

// Diary: a person's own notebook. Each page is some writing, a pen drawing, or both,
// kept to read back later. Pages are private: only the person who wrote one can open it,
// the master included - it is a diary, not a report.
//
// The drawing is kept as the pen strokes themselves (JSON), so a page reopens with every
// stroke still there to undo, and stays sharp on any screen. The phone also sends a small
// picture of it (thumb) for the list, so the list never loads every stroke of every page.

const MAX_TITLE = 200;
const MAX_BODY = 100_000;
const MAX_DRAWING = 5_000_000; // characters of stroke JSON: a very busy page, far beyond a sketch
const MAX_THUMB = 300_000;
export const COLORS = ['plain', 'yellow', 'green', 'blue', 'pink', 'purple'];
const LIST_LIMIT = 500;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const secs = () => Math.floor(Date.now() / 1000);

function cleanDrawing(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  if (text.length > MAX_DRAWING) throw bad('This drawing is too big to keep. Start a new page for the rest.', 413);
  let d;
  try { d = JSON.parse(text); } catch { throw bad('The drawing could not be read'); }
  if (!d || !Array.isArray(d.strokes)) throw bad('The drawing could not be read');
  return d.strokes.length ? text : null; // an empty canvas is no drawing
}

function cleanThumb(v) {
  if (v === undefined) return undefined;
  if (!v) return null;
  const s = String(v);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > MAX_THUMB) throw bad('The drawing preview could not be read');
  return s;
}

/** Only the fields that were sent, cleaned; undefined means "leave as it is". */
function clean(input = {}) {
  const out = {};
  if (input.title !== undefined) out.title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (input.body !== undefined) {
    out.body = String(input.body ?? '');
    if (out.body.length > MAX_BODY) throw bad('This page is too long. Start a new page for the rest.', 413);
  }
  const drawing = cleanDrawing(input.drawing);
  if (drawing !== undefined) out.drawing = drawing;
  const thumb = cleanThumb(input.thumb);
  if (thumb !== undefined) out.thumb = thumb;
  if (input.color !== undefined) {
    if (!COLORS.includes(input.color)) throw bad('Unknown colour');
    out.color = input.color;
  }
  if (input.pinned !== undefined) out.pinned = !!input.pinned;
  return out;
}

const LIST_COLS = 'id, title, LEFT(body, 400) AS preview, thumb, color, pinned, created_at, updated_at, (drawing IS NOT NULL) AS has_drawing';
const FULL_COLS = 'id, title, body, drawing, thumb, color, pinned, created_at, updated_at';

/** Their pages, pinned first, then the latest written. q searches the title and the text. */
export async function listEntries(userId, { q } = {}) {
  const term = String(q ?? '').trim().slice(0, 100);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db.prepare(`SELECT ${LIST_COLS} FROM diary_entries WHERE user_id = ? AND (title ILIKE ? OR body ILIKE ?)
      ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ${LIST_LIMIT}`).all(userId, like, like);
  }
  return db.prepare(`SELECT ${LIST_COLS} FROM diary_entries WHERE user_id = ?
    ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ${LIST_LIMIT}`).all(userId);
}

export async function getEntry(userId, id) {
  const row = await db.prepare(`SELECT ${FULL_COLS} FROM diary_entries WHERE id = ? AND user_id = ?`).get(Number(id) || 0, userId);
  if (!row) throw bad('Page not found', 404);
  return row;
}

export async function createEntry(userId, input = {}) {
  const c = clean(input);
  const { id } = await db.prepare(`INSERT INTO diary_entries (user_id, title, body, drawing, thumb, color, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(userId, c.title ?? '', c.body ?? '', c.drawing ?? null, c.thumb ?? null, c.color ?? 'plain', c.pinned ?? false);
  return getEntry(userId, id);
}

/** Saves only what was sent, so the phone can save the writing without resending the drawing. */
export async function updateEntry(userId, id, input = {}, now = secs()) {
  await getEntry(userId, id); // someone else's page is "not found", never changed
  const c = clean(input);
  const keys = Object.keys(c);
  if (keys.length) {
    // Pinning is not an edit: the page keeps its place by when it was last written.
    const touched = keys.some((k) => k !== 'pinned');
    const sets = keys.map((k) => `${k} = ?`).concat(touched ? ['updated_at = ?'] : []);
    await db.prepare(`UPDATE diary_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...keys.map((k) => c[k]), ...(touched ? [now] : []), Number(id), userId);
  }
  return getEntry(userId, id);
}

export async function deleteEntry(userId, id) {
  const { changes } = await db.prepare('DELETE FROM diary_entries WHERE id = ? AND user_id = ?').run(Number(id) || 0, userId);
  if (!changes) throw bad('Page not found', 404);
  return { ok: true };
}

// ---------- routes (behind needsModule('diary') in index.js) ----------

export const diaryRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

diaryRoutes.get('/', wrap(async (req, res) => res.json(await listEntries(req.user.id, { q: req.query.q }))));
diaryRoutes.post('/', wrap(async (req, res) => res.json(await createEntry(req.user.id, req.body || {}))));
diaryRoutes.get('/:id', wrap(async (req, res) => res.json(await getEntry(req.user.id, req.params.id))));
diaryRoutes.put('/:id', wrap(async (req, res) => res.json(await updateEntry(req.user.id, req.params.id, req.body || {}))));
diaryRoutes.delete('/:id', wrap(async (req, res) => res.json(await deleteEntry(req.user.id, req.params.id))));
