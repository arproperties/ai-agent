// Server health, the master's alone: is the server all right, and how fast is it filling up?
// Disk, memory, the database, the app itself and the backups, each with a green, amber or
// red light, plus a reading kept every hour so the screen can show growth over weeks. That
// growth is what tells the master when to act (a bigger server, files moved off it) before
// anyone notices it slowing down.
import { Router } from 'express';
import { statfs, readdir, stat, readFile } from 'node:fs/promises';
import { homedir, totalmem, freemem, loadavg, cpus } from 'node:os';
import { DATA_DIR } from './config.js';
import { db } from './db.js';

const HOUR = 3600e3;
const KEEP_DAYS = 400; // a little over a year of hourly readings is ~10k small rows
// The hand-made database backups taken before each deploy (pg_dump into ~/backups on live).
const BACKUP_DIR = process.env.BACKUP_DIR || `${homedir()}/backups`;

// Walking 2+ GB of uploads takes a moment, so folder sizes are counted with each hourly
// reading and the screen shows the last count rather than walking the disk per visit.
let folders = null; // { at, sizes: { uploads: bytes, … } }

async function dirSize(path) {
  let total = 0;
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = `${path}/${e.name}`;
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function countFolders() {
  const sizes = {};
  let names = [];
  try { names = (await readdir(DATA_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  for (const n of names) sizes[n] = await dirSize(`${DATA_DIR}/${n}`);
  folders = { at: Date.now(), sizes };
  return sizes;
}

// Linux says how much memory is really free to use (MemAvailable counts the cache it can
// drop); os.freemem() alone makes a healthy server look nearly full. Elsewhere (a Windows
// laptop running it locally) the plain numbers will do.
async function memory() {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = (k) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    return { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree') };
  } catch {
    return { total: totalmem(), available: freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

async function disk() {
  const s = await statfs(DATA_DIR);
  const total = s.blocks * s.bsize;
  return { total, free: s.bavail * s.bsize, used: total - s.bfree * s.bsize };
}

async function backups() {
  let files = [];
  try {
    const names = (await readdir(BACKUP_DIR)).filter((n) => /\.(dump|sql|sql\.gz)$/.test(n));
    files = await Promise.all(names.map(async (name) => ({ name, ...(await stat(`${BACKUP_DIR}/${name}`)) })));
  } catch {}
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    count: files.length,
    bytes: files.reduce((t, f) => t + f.size, 0),
    newest: files[0] ? { name: files[0].name, at: Math.round(files[0].mtimeMs / 1000), bytes: files[0].size } : null,
  };
}

async function database() {
  const { size } = await db.prepare('SELECT pg_database_size(current_database()) AS size').get();
  const tables = await db.prepare(`SELECT relname AS name, pg_total_relation_size(relid) AS bytes
    FROM pg_catalog.pg_statio_user_tables ORDER BY 2 DESC LIMIT 6`).all();
  return { bytes: Number(size), tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })) };
}

// What people did in the last day, so the numbers above have a reason next to them.
async function activity() {
  const day = Math.floor(Date.now() / 1000) - 86400;
  const r = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE last_seen_at >= ?) AS people,
      (SELECT COUNT(*) FROM messages WHERE created_at >= ?) AS messages,
      (SELECT COUNT(*) FROM documents WHERE created_at >= ?) AS uploads,
      (SELECT COUNT(*) FROM error_log WHERE created_at >= ? AND source = 'server') AS server_errors,
      (SELECT COUNT(*) FROM error_log WHERE created_at >= ? AND source = 'client') AS client_errors,
      (SELECT COALESCE(SUM(usd), 0) FROM ai_costs WHERE at >= ?) AS ai_usd`).get(day, day, day, day, day, day);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v) || 0]));
}

// The lights. Amber means "keep an eye on it", red means "act soon".
const light = (value, amber, red) => (value >= red ? 'red' : value >= amber ? 'amber' : 'green');

export async function readHealth() {
  const [d, m, dbase, b, act] = await Promise.all([disk(), memory(), database(), backups(), activity()]);
  const app = process.memoryUsage().rss;
  const backupAge = b.newest ? Date.now() / 1000 - b.newest.at : Infinity;
  return {
    at: Math.floor(Date.now() / 1000),
    disk: { ...d, light: light(d.used / d.total, 0.7, 0.85) },
    memory: {
      ...m, app,
      // Little left to use, or leaning hard on swap, both mean the server is short of memory.
      light: [light(1 - m.available / m.total, 0.75, 0.9), m.swapTotal ? light(m.swapUsed / m.swapTotal, 0.25, 0.6) : 'green']
        .sort((x, y) => ['green', 'amber', 'red'].indexOf(y) - ['green', 'amber', 'red'].indexOf(x))[0],
    },
    cpu: { cores: cpus().length, load: loadavg()[0], light: light(loadavg()[0] / (cpus().length || 1), 0.8, 1.5) },
    app: { uptime: Math.round(process.uptime()), node: process.version },
    database: dbase,
    folders: folders ? { at: Math.round(folders.at / 1000), sizes: folders.sizes } : null,
    backups: { ...b, dir: BACKUP_DIR, light: backupAge > 7 * 86400 ? 'red' : backupAge > 2 * 86400 ? 'amber' : 'green' },
    activity: act,
  };
}

// One reading an hour into server_health. Only the numbers that grow are kept: enough for
// the "how fast" charts, small enough to keep for a year.
export async function sample() {
  const sizes = await countFolders();
  const [d, m, dbase] = await Promise.all([disk(), memory(), database()]);
  await db.prepare(`INSERT INTO server_health (disk_used, disk_total, mem_used, mem_total, app_mem, db_bytes, uploads_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(d.used, d.total, m.total - m.available, m.total, process.memoryUsage().rss, dbase.bytes, sizes.uploads || 0);
  await db.prepare(`DELETE FROM server_health WHERE at < ${Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400}`).run();
}

// One point per Dubai day: that day's highest memory and its last disk/database size.
export async function history(days = 90) {
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await db.prepare(`SELECT to_char(to_timestamp(at) AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD') AS day,
      MAX(disk_used) AS disk_used, MAX(disk_total) AS disk_total, MAX(mem_used) AS mem_used, MAX(mem_total) AS mem_total,
      MAX(app_mem) AS app_mem, MAX(db_bytes) AS db_bytes, MAX(uploads_bytes) AS uploads_bytes
    FROM server_health WHERE at >= ? GROUP BY 1 ORDER BY 1`).all(from);
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'day' ? v : Number(v)])));
}

export function startServerHealth() {
  const tick = () => sample().catch((e) => console.error('[server-health]', e.message));
  // A restart (a deploy) should not leave a gap or take two readings in the same hour.
  db.prepare('SELECT MAX(at) AS at FROM server_health').get()
    .then((r) => {
      const since = Date.now() - Number(r?.at || 0) * 1000;
      setTimeout(() => { tick(); setInterval(tick, HOUR); }, Math.max(0, HOUR - since));
      if (since < HOUR) countFolders().catch(() => {}); // the screen still wants folder sizes now
    })
    .catch((e) => console.error('[server-health]', e.message));
}

export const serverHealthRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

serverHealthRoutes.get('/', wrap(async (req, res) => {
  res.json({ now: await readHealth(), history: await history(Number(req.query.days) || 90) });
}));
