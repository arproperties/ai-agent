import { Router } from 'express';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { transcribe } from './ai.js';

// Transcribe: any audio in, plain text out. A WhatsApp voice note, a phone recording,
// or something said straight into Reem. Audio attached in a chat comes through here
// too (readAudio), and is listed on the Transcribe page like any other.
//
// A feature of its own, apart from Meetings: no names, no summary, just the words. The
// file is kept on disk only until it has been read, then thrown away.
//
// Every file goes through ffmpeg first. That is what lets it take anything a phone makes
// (.opus from WhatsApp, .m4a, .amr, .caf…), and it is cut into ten-minute mp3 pieces so
// a long recording never runs into the speech API's size or length limits.

const DIR = `${DATA_DIR}/transcripts`;
const PIECE_SECONDS = 600;
export const MAX_MINUTES = 120;

const run = promisify(execFile);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// The call that costs money, swappable so the tests can run without it.
export const engine = { transcribe: (buffer) => transcribe(buffer, 'audio/mpeg') };

const out = ({ user_id, path, ...t }) => t;

// Phones are loose about audio types (WhatsApp's .opus often arrives as
// application/octet-stream), so the extension gets a say too.
export const AUDIO_EXT = ['opus', 'ogg', 'oga', 'm4a', 'aac', 'amr', 'caf', 'mp3', 'wav', 'flac', 'weba'];
export const isAudio = (f) => /^audio\//.test(f.mimetype || '')
  || AUDIO_EXT.includes(String(f.originalname || '').split('.').pop().toLowerCase());

// ---------- the rows ----------

export async function createTranscript(userId, { buffer, originalname, source = 'upload' }) {
  if (!buffer?.length) throw bad('No audio came through — try again');
  const kind = source === 'recording' ? 'recording' : 'upload';
  // Browsers send filenames as latin1; turn them back so Arabic names survive.
  const name = Buffer.from(String(originalname || ''), 'latin1').toString('utf8');
  const title = kind === 'upload' ? name.replace(/\.[^.]+$/, '').trim().slice(0, 120) : '';
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase();

  mkdirSync(DIR, { recursive: true });
  const { id } = await db.prepare(`INSERT INTO transcripts (user_id, title, source, path) VALUES (?, ?, ?, '') RETURNING id`)
    .run(userId, title, kind);
  const path = `${DIR}/${id}.${ext}`;
  await writeFile(path, buffer);
  await db.prepare('UPDATE transcripts SET path = ? WHERE id = ?').run(path, id);
  const t = await getTranscript(userId, id); // read before the work starts, so it always says "processing"
  kick(id);
  return t;
}

export async function listTranscripts(userId, limit = 200) {
  const rows = await db.prepare(`SELECT id, title, source, status, error, duration_s, created_at, left(text, 200) AS preview
    FROM transcripts WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit);
  return rows;
}

export async function getTranscript(userId, id) {
  const t = await db.prepare('SELECT * FROM transcripts WHERE id = ? AND user_id = ?').get(Number(id), userId);
  return t ? out(t) : null;
}

export async function renameTranscript(userId, id, title) {
  await db.prepare('UPDATE transcripts SET title = ? WHERE id = ? AND user_id = ?')
    .run(String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), Number(id), userId);
  return getTranscript(userId, id);
}

export async function deleteTranscript(userId, id) {
  const t = await db.prepare('DELETE FROM transcripts WHERE id = ? AND user_id = ? RETURNING path').get(Number(id), userId);
  if (t?.path) rmSync(t.path, { force: true });
  return !!t;
}

// ---------- the work ----------

const jobs = new Map(); // id -> promise, so a test (or a second kick) can wait on the same one

export function kick(id) {
  if (!jobs.has(id)) jobs.set(id, work(id).finally(() => jobs.delete(id)));
  return jobs.get(id);
}

/** Wait until nothing is being written up (tests). */
export const settled = () => Promise.all([...jobs.values()]);

async function work(id) {
  const t = await db.prepare('SELECT id, path FROM transcripts WHERE id = ?').get(id);
  if (!t) return;
  try {
    const { text, seconds } = await audioToText(t.path);
    await db.prepare(`UPDATE transcripts SET status = 'ready', text = ?, error = ?, duration_s = ? WHERE id = ?`)
      .run(text, text ? null : NO_SPEECH, seconds, id);
  } catch (e) {
    console.warn('[transcripts]', id, e.message);
    await db.prepare(`UPDATE transcripts SET status = 'failed', error = ? WHERE id = ?`).run(e.message, id);
  } finally {
    rmSync(t.path, { force: true });
  }
}

const NO_SPEECH = 'No speech was heard in this recording.';

/** The words in an audio file on disk, as { text, seconds }. Errors come out in plain words. */
async function audioToText(path) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-transcribe-'));
  try {
    const pieces = await toPieces(path, dir);
    let seconds = 0;
    for (const p of pieces) seconds += await secondsOf(p);
    if (seconds > MAX_MINUTES * 60) throw bad(`This recording is ${Math.round(seconds / 60)} minutes long; the limit is ${MAX_MINUTES}`);
    // The pieces are independent: send them together rather than one after another.
    const texts = await Promise.all(pieces.map(async (p) => (await engine.transcribe(await readFile(p))).trim()));
    return { text: texts.filter(Boolean).join('\n\n'), seconds: Math.round(seconds) };
  } catch (e) {
    throw e.status ? e : bad(friendly(e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Audio attached in a chat: read now, while the chat waits, and kept on the Transcribe
 * page as well so it can be found again. name is the real (already decoded) filename.
 */
export async function readAudio(userId, buffer, name) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-chat-audio-'));
  try {
    const path = join(dir, `in.${(name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase()}`);
    await writeFile(path, buffer);
    const { text, seconds } = await audioToText(path);
    await db.prepare(`INSERT INTO transcripts (user_id, title, source, status, text, error, duration_s) VALUES (?, ?, 'chat', 'ready', ?, ?, ?)`)
      .run(userId, name.replace(/\.[^.]+$/, '').trim().slice(0, 120), text, text ? null : NO_SPEECH, seconds);
    return { text, seconds };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const friendly = (e) => (e.code === 'ENOENT' ? 'Reading audio needs ffmpeg on the server (sudo apt install -y ffmpeg)'
  : e.cmd?.includes('ffmpeg') ? 'Reem could not read this file as audio.'
  : 'Could not turn this into text. Try again in a minute.');

/** Any audio (or video) -> small mono mp3 pieces of at most ten minutes. */
async function toPieces(path, dir) {
  // 16 kHz mono at 32 kbps: speech survives it intact, and ten minutes is about 2.4 MB.
  await run('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(PIECE_SECONDS), '-reset_timestamps', '1', join(dir, 'piece%03d.mp3')]);
  const pieces = readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort().map((f) => join(dir, f));
  if (!pieces.length) throw bad('There is no sound in this file.');
  return pieces;
}

async function secondsOf(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  const secs = Number(String(stdout).trim());
  return Number.isFinite(secs) && secs > 0 ? secs : 0;
}

/** On boot: anything cut off by a restart is picked up again, if its file is still there. */
export async function startTranscripts() {
  const stuck = await db.prepare(`SELECT id, path FROM transcripts WHERE status = 'processing'`).all();
  for (const t of stuck) {
    if (t.path && existsSync(t.path)) kick(t.id);
    else await db.prepare(`UPDATE transcripts SET status = 'failed', error = 'The server restarted before this was finished. Upload it again.' WHERE id = ?`).run(t.id);
  }
}

// ---------- routes ----------

export const transcriptRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'Transcript not found' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

transcriptRoutes.get('/', wrap(async (req, res) => res.json(await listTranscripts(req.user.id))));
transcriptRoutes.post('/', upload.single('audio'), wrap(async (req, res) => {
  res.json(await createTranscript(req.user.id, { buffer: req.file?.buffer, originalname: req.file?.originalname, source: req.body.source }));
}));
transcriptRoutes.get('/:id', wrap(async (req, res) => {
  const t = await getTranscript(req.user.id, req.params.id);
  t ? res.json(t) : gone(res);
}));
transcriptRoutes.patch('/:id', wrap(async (req, res) => {
  const t = await renameTranscript(req.user.id, req.params.id, req.body.title);
  t ? res.json(t) : gone(res);
}));
transcriptRoutes.delete('/:id', wrap(async (req, res) => {
  (await deleteTranscript(req.user.id, req.params.id)) ? res.json({ ok: true }) : gone(res);
}));
