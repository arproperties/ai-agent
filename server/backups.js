// Backups, the master's alone: the whole database and every uploaded file, downloaded from
// Settings → Backups. The password is asked again first, so a borrowed phone that is still
// signed in cannot take everything with one tap. Nothing is kept on the server: each
// download is made as it streams, so a 2.5 GB zip never sits in the 2 GB of memory.
//
// It is only a backup when someone taps it, so the master gets a buzz when either kind has
// not been downloaded for a week.

import { Router } from 'express';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import archiver from 'archiver';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { checkPassword } from './auth.js';
import { sendPush } from './push.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

const UNLOCKED_FOR = 10 * 60_000; // one password, both downloads, for ten minutes
const WEEK = 7 * 86400;
const secs = () => Math.floor(Date.now() / 1000);

// Unlocks live in memory: a restart only means typing the password again.
const unlocks = new Map(); // token -> { userId, until }
const wrong = new Map(); // userId -> { count, until }

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

async function state() {
  await db.prepare('INSERT INTO backup_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING').run();
  return db.prepare('SELECT * FROM backup_state WHERE id = 1').get();
}
const done = async (kind) => {
  await state(); // the row, should this be the first thing ever done here
  await db.prepare(`UPDATE backup_state SET ${kind === 'database' ? 'database_at' : 'files_at'} = ? WHERE id = 1`).run(secs());
};

function unlocked(req) {
  const u = unlocks.get(String(req.query.t || ''));
  if (!u || u.until < Date.now() || u.userId !== req.user.id) throw bad('Type your password again to download.', 403);
}

// pg_dump gets the connection from the environment, never its arguments, so the database
// password does not show in the server's process list.
function dumpEnv() {
  const url = new URL(process.env.DATABASE_URL);
  return {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

export const backupRoutes = Router();

backupRoutes.get('/', wrap(async (req, res) => {
  const s = await state();
  res.json({ database_at: s.database_at, files_at: s.files_at });
}));

backupRoutes.post('/unlock', wrap(async (req, res) => {
  const w = wrong.get(req.user.id);
  if (w && w.until > Date.now() && w.count >= 5) throw bad('Too many wrong passwords. Try again in 15 minutes.', 429);
  if (!(await checkPassword(req.user.id, req.body?.password))) {
    wrong.set(req.user.id, w && w.until > Date.now() ? { ...w, count: w.count + 1 } : { count: 1, until: Date.now() + 15 * 60_000 });
    throw bad('Wrong password', 401);
  }
  wrong.delete(req.user.id);
  for (const [t, u] of unlocks) if (u.until < Date.now()) unlocks.delete(t);
  const token = randomBytes(24).toString('base64url');
  unlocks.set(token, { userId: req.user.id, until: Date.now() + UNLOCKED_FOR });
  res.json({ token, minutes: UNLOCKED_FOR / 60_000 });
}));

// The database, in pg_dump's own format: what `pg_restore` takes back. A dump that stops
// half way cuts the download off, so a broken file never looks like a whole one.
backupRoutes.get('/database', wrap(async (req, res) => {
  unlocked(req);
  const dump = spawn('pg_dump', ['-Fc', '--no-owner'], { env: dumpEnv() });
  let err = '';
  dump.stderr.on('data', (d) => { err += d; });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="reem-database-${dubaiDate()}.dump"`);
  dump.stdout.pipe(res);
  res.on('close', () => { if (dump.exitCode === null) dump.kill(); });
  dump.on('error', (e) => { console.error('[backups] pg_dump:', e.message); res.destroy(); });
  dump.on('close', (code) => {
    if (code === 0) done('database').catch((e) => console.error('[backups]', e.message));
    else { console.error('[backups] pg_dump failed:', err.slice(0, 500)); res.destroy(); }
  });
}));

// Every uploaded file, as one zip. Stored, not squeezed: they are mostly PDFs and photos that
// are already compressed, and squeezing 2.5 GB would only tie up the processor.
backupRoutes.get('/files', wrap(async (req, res) => {
  unlocked(req);
  const dir = `${DATA_DIR}/uploads`;
  const zip = archiver('zip', { store: true });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="reem-files-${dubaiDate()}.zip"`);
  zip.on('warning', (e) => console.warn('[backups] zip:', e.message));
  zip.on('error', (e) => { console.error('[backups] zip:', e.message); res.destroy(); });
  res.on('close', () => { if (!res.writableFinished) zip.abort(); });
  // Counted only when the whole zip has gone out, not when the browser gave up half way.
  res.on('finish', () => done('files').catch((e) => console.error('[backups]', e.message)));
  zip.pipe(res);
  if (existsSync(dir)) zip.directory(dir, 'uploads');
  await zip.finalize();
}));

/** The weekly buzz: either kind not downloaded for 7 days (counted from the day this began). */
export async function remindIfDue(now = secs()) {
  const s = await state();
  const last = (at) => at || s.started_at;
  const stale = [];
  if (now - last(s.database_at) >= WEEK) stale.push('the database');
  if (now - last(s.files_at) >= WEEK) stale.push('the files');
  if (!stale.length || (s.reminded_at && now - s.reminded_at < WEEK)) return false;
  const masters = (await db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT disabled`).all()).map((u) => u.id);
  if (!masters.length) return false;
  await db.prepare('UPDATE backup_state SET reminded_at = ? WHERE id = 1').run(now);
  await sendPush(masters, {
    title: 'Time for a backup',
    body: `Nobody has downloaded ${stale.join(' or ')} for 7 days. Settings → Backups.`,
    tag: 'backups',
  });
  return true;
}

let timer = null;
export function startBackupReminder() {
  if (timer) return;
  // Checked every hour, sent at 10 in the morning Dubai time.
  timer = setInterval(() => {
    if (dubaiHour() === 10) remindIfDue().catch((e) => console.error('[backups]', e.message));
  }, 3600_000);
  timer.unref();
}
