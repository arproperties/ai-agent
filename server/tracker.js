import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';
import { sendMail } from './mailer.js';
import { billAs } from './billing.js';
import { dubaiDate } from './saifsys/client.js';

// Activity tracker: Reem's side of the small tray app that sits on each employee PC
// (activity-tracker/, a separate program in this repo). The PC counts time per app all day
// and, at the end of it, sends one summary here through the door below; at 19:00 Dubai Reem
// emails HR one digest for everyone. There is no AI in any of this: counting minutes needs
// none, and Francis wanted it to cost no credits.
//
// The door works like the saifsys one (fromSaifsys.js): a public route guarded by a key.
// Each PC has its own key, made by the master in Settings → Activity reports and shown once;
// Reem keeps only its sha256, so a stolen database dump cannot pretend to be a PC.

/** A fresh device key: 32 random bytes, base64url, 43 characters. Shown once, never stored. */
export const newDeviceKey = () => randomBytes(32).toString('base64url');

/** What Reem stores and looks up: the key's sha256, hex. */
export const keyHash = (key) => createHash('sha256').update(String(key)).digest('hex');

/**
 * When the PC should send its day: half an hour before the digest goes out, so a normal day
 * is in the email and a PC that is slow or offline has a little time to catch up.
 */
export function dayEndOf(sendAt) {
  const [h, m] = String(sendAt).split(':').map(Number);
  const total = (((h * 60 + m) - 30) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The master's switches, one row, made on first use. Off to begin with: the digest goes to a real mailbox. */
export async function settings() {
  await db.prepare('INSERT INTO tracker_settings (id) VALUES (1) ON CONFLICT DO NOTHING').run();
  return db.prepare('SELECT "on", hr_email, send_at, titles_on, sent_on FROM tracker_settings WHERE id = 1').get();
}

const NOT_PAIRED = 'This PC is not paired with Reem';

/**
 * Mount in front of the PC's routes: checks the key, then makes the request that device's
 * and that person's. Looking the hash up is the comparison, as with a password hash, so there
 * is no plaintext to compare in constant time.
 */
export function fromTracker(req, res, next) {
  const key = String(req.get('X-Tracker-Key') || '').trim();
  if (!key) return res.status(401).json({ error: NOT_PAIRED });
  db.prepare(`SELECT d.id, d.user_id, d.name, u.disabled, row_to_json(u) AS person
                FROM tracker_devices d JOIN users u ON u.id = d.user_id WHERE d.key_hash = ?`).get(keyHash(key))
    .then(async (row) => {
      if (!row) return res.status(401).json({ error: NOT_PAIRED });
      if (row.disabled) return res.status(403).json({ error: 'This Reem account has been disabled' });
      await db.prepare('UPDATE tracker_devices SET last_seen_at = extract(epoch from now())::bigint WHERE id = ?').run(row.id);
      req.device = { id: row.id, user_id: row.user_id, name: row.name };
      req.user = row.person;
      next();
    }, next);
}

// ---------- the PC's routes (public, behind fromTracker) ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (message) => Object.assign(new Error(message), { status: 400 });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const count = (v) => Number.isInteger(v) && v >= 0;
const text = (v, max) => String(v ?? '').slice(0, max);

/**
 * The day as the contract has it, checked and tidied, or why not. Strings are cut to size
 * rather than refused: a long window title is normal, not an attack. Shape mistakes are
 * refused, because a half-read day would mislead HR.
 */
export function validDay(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'No day was sent' };
  const { date, first_seen, last_seen, active_seconds, idle_seconds, away_seconds, running, apps } = body;
  if (!DATE.test(String(date))) return { ok: false, error: 'date must be YYYY-MM-DD' };
  if (!TIME.test(String(first_seen)) || !TIME.test(String(last_seen))) return { ok: false, error: 'first_seen and last_seen must be HH:MM' };
  if (![active_seconds, idle_seconds, away_seconds].every(count)) return { ok: false, error: 'seconds must be whole numbers, 0 or more' };
  if (!Array.isArray(running) || !running.every((r) => Array.isArray(r) && r.length === 2 && r.every((t) => TIME.test(String(t))))) {
    return { ok: false, error: 'running must be a list of [HH:MM, HH:MM]' };
  }
  if (!Array.isArray(apps) || apps.length > 50) return { ok: false, error: 'apps must be a list of at most 50' };
  const cleanApps = [];
  for (const a of apps) {
    if (!a || typeof a !== 'object' || !count(a.seconds)) return { ok: false, error: 'each app needs a name and seconds' };
    if (!Array.isArray(a.titles) || a.titles.length > 5) return { ok: false, error: 'each app carries at most 5 titles' };
    if (!a.titles.every((t) => t && typeof t === 'object' && count(t.seconds))) return { ok: false, error: 'each title needs seconds' };
    cleanApps.push({ name: text(a.name, 120), seconds: a.seconds, titles: a.titles.map((t) => ({ title: text(t.title, 200), seconds: t.seconds })) });
  }
  return { ok: true, day: { date, first_seen, last_seen, active_seconds, idle_seconds, away_seconds, running, apps: cleanApps } };
}

export const fromTrackerRoutes = Router();

// The PC's first call after pairing, and its way of learning the day-end time the master set.
fromTrackerRoutes.post('/hello', wrap(async (req, res) => {
  const s = await settings();
  res.json({ name: req.user.name, device: req.device.name, day_end: dayEndOf(s.send_at) });
}));

// One day from one PC. A day sent again replaces the earlier row and is pending once more,
// so HR hears of the change; digested_at is left alone so the digest knows it is an update.
fromTrackerRoutes.post('/day', wrap(async (req, res) => {
  const v = validDay(req.body);
  if (!v.ok) throw bad(v.error);
  const d = v.day;
  await db.prepare(`INSERT INTO tracker_days (device_id, date, first_seen, last_seen, active_seconds, idle_seconds, away_seconds, running, apps)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
                    ON CONFLICT (device_id, date) DO UPDATE SET first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen,
                      active_seconds = EXCLUDED.active_seconds, idle_seconds = EXCLUDED.idle_seconds, away_seconds = EXCLUDED.away_seconds,
                      running = EXCLUDED.running, apps = EXCLUDED.apps, received_at = extract(epoch from now())::bigint, pending = true`)
    .run(req.device.id, d.date, d.first_seen, d.last_seen, d.active_seconds, d.idle_seconds, d.away_seconds, JSON.stringify(d.running), JSON.stringify(d.apps));
  const s = await settings();
  res.json({ ok: true, day_end: dayEndOf(s.send_at) });
}));

// ---------- the HR digest ----------

/** '6h 48m', '52m', '0m': the way the office reads a day. */
export function fmtSeconds(n) {
  const m = Math.round((n || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** 'Excel 3h 10m · Google Chrome 2h 05m': the biggest apps of a day in one line. */
export const topApps = (apps = [], n = 3) => [...apps].sort((a, b) => b.seconds - a.seconds).slice(0, n)
  .map((a) => `${a.name} ${fmtSeconds(a.seconds)}`).join(' · ');

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** 'Sun 15 Nov 2026' for a YYYY-MM-DD; the time zone is fixed so the server's UTC clock cannot shift the day. */
export function dayName(date, { year = true } = {}) {
  const d = new Date(`${date}T12:00:00Z`);
  const part = (o) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', ...o });
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}${year ? ` ${part({ year: 'numeric' })}` : ''}`;
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Stretches over ten minutes between first and last activity when the tracker was not running, as 'HH:MM–HH:MM'. */
function gaps(entry) {
  const segs = [...(entry.running || [])].sort((a, b) => toMin(a[0]) - toMin(b[0]));
  const out = [];
  for (let i = 1; i < segs.length; i++) {
    if (toMin(segs[i][0]) - toMin(segs[i - 1][1]) > 10) out.push(`${segs[i - 1][1]}–${segs[i][0]}`);
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const COLS = [['Name', 14], ['First', 8], ['Last', 8], ['Active', 9], ['Idle', 8], ['Away', 8]];

function textRows(entries) {
  const head = COLS.map(([h, w]) => pad(h, w)).join('') + 'Top apps';
  const lines = entries.map((e) => {
    if (e.missing) return `${pad(e.name, 14)}${pad('—', 8)}${pad('—', 8)}no report yet`;
    const cells = [e.name, e.first_seen, e.last_seen, fmtSeconds(e.active_seconds), fmtSeconds(e.idle_seconds), fmtSeconds(e.away_seconds)];
    const notes = gaps(e).map((g) => `tracker not running ${g}`);
    return cells.map((c, i) => pad(c, COLS[i][1])).join('') + topApps(e.apps) + (notes.length ? `\n${pad('', 14)}${notes.join(', ')}` : '');
  });
  return [head, ...lines].join('\n');
}

function htmlRows(entries) {
  const cell = (c, extra = '') => `<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap${extra}">${escape(c)}</td>`;
  const head = `<tr>${[...COLS.map(([h]) => h), 'Top apps'].map((h) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-weight:500">${h}</th>`).join('')}</tr>`;
  const rows = entries.map((e) => {
    if (e.missing) return `<tr>${cell(e.name)}${cell('—')}${cell('—')}<td colspan="4" style="padding:6px 10px;color:#888">no report yet</td></tr>`;
    const notes = gaps(e).map((g) => `tracker not running ${g}`).join(', ');
    return `<tr>${cell(e.name)}${cell(e.first_seen)}${cell(e.last_seen)}${cell(fmtSeconds(e.active_seconds))}${cell(fmtSeconds(e.idle_seconds))}${cell(fmtSeconds(e.away_seconds))}`
      + `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escape(topApps(e.apps))}${notes ? `<div style="color:#b45309;font-size:12px">${escape(notes)}</div>` : ''}</td></tr>`;
  });
  return `<table style="border-collapse:collapse;font-size:14px">${head}${rows.join('')}</table>`;
}

/**
 * The email HR gets: today's table, then the days that arrived late (never emailed before)
 * and the days that changed after HR saw them. Window titles go only into the CSV, and only
 * while the master's "include window titles" switch is on.
 */
export function renderDigest({ day, people = [], late = [], updated = [], titlesOn = true }) {
  const title = `Activity report — ${dayName(day)}`;
  const byDate = (list) => Object.entries(list.reduce((m, e) => ((m[e.date] ||= []).push(e), m), {})).sort(([a], [b]) => b.localeCompare(a));
  const sections = [['Late', late], ['Updated', updated]].flatMap(([label, list]) => byDate(list).map(([date, entries]) => ({ heading: `${label}: ${dayName(date, { year: false })}`, entries })));

  const text = [title, '', textRows(people), ...sections.flatMap((s) => ['', s.heading, textRows(s.entries).split('\n').slice(1).join('\n')]),
    '', `Attached: activity-${day}.csv (one row per person per app${titlesOn ? ', with top titles' : ''}).`].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:900px;margin:auto;padding:24px;color:#1d1b2e">
    <h2 style="font-weight:500">${escape(title)}</h2>${htmlRows(people)}
    ${sections.map((s) => `<h3 style="font-weight:500;margin-top:24px">${escape(s.heading)}</h3>${htmlRows(s.entries)}`).join('')}
    <p style="color:#777;font-size:13px;margin-top:24px">Away is a locked or sleeping PC; idle is no mouse or keyboard for over 3 minutes. The CSV attached has one row per person per app.</p></div>`;

  const csvLines = ['name,date,app,seconds,title,title_seconds'];
  for (const e of [...people, ...late, ...updated]) {
    if (e.missing) continue;
    for (const a of e.apps || []) {
      const titles = titlesOn ? a.titles || [] : [];
      if (!titles.length) csvLines.push([e.name, e.date, a.name, a.seconds, '', ''].map(csvCell).join(','));
      for (const t of titles) csvLines.push([e.name, e.date, a.name, a.seconds, t.title, t.seconds].map(csvCell).join(','));
    }
  }
  return { subject: title, text, html, csv: csvLines.join('\r\n') + '\r\n' };
}

// ---------- the 19:00 timer ----------

/** Minutes since Dubai midnight, for comparing with the master's HH:MM. */
const dubaiMinutes = (at = Date.now()) => {
  const [h, m] = new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
  return h * 60 + m;
};

/** Two PCs of one person on one date become one line: totals added, apps and their titles merged. */
function mergeDays(userId, name, date, rows) {
  const apps = {};
  for (const r of rows) {
    for (const a of r.apps || []) {
      const app = (apps[a.name] ||= { name: a.name, seconds: 0, titles: {} });
      app.seconds += a.seconds;
      for (const t of a.titles || []) app.titles[t.title] = (app.titles[t.title] || 0) + t.seconds;
    }
  }
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    user_id: userId, name, date,
    first_seen: rows.map((r) => r.first_seen).sort()[0],
    last_seen: rows.map((r) => r.last_seen).sort().at(-1),
    active_seconds: sum('active_seconds'), idle_seconds: sum('idle_seconds'), away_seconds: sum('away_seconds'),
    running: rows.flatMap((r) => r.running || []),
    apps: Object.values(apps).sort((a, b) => b.seconds - a.seconds).map((a) => ({
      name: a.name, seconds: a.seconds,
      titles: Object.entries(a.titles).map(([title, seconds]) => ({ title, seconds })).sort((x, y) => y.seconds - x.seconds).slice(0, 5),
    })),
  };
}

/**
 * What goes into the digest for `day`: everyone with a paired PC, summed per person for the
 * day (people whose PCs have not reported marked missing); then the pending rows of earlier
 * dates, split into days HR has never had (late) and days HR had already (updated).
 */
export async function collect(day = dubaiDate()) {
  const people = await db.prepare(`SELECT DISTINCT u.id, u.name FROM tracker_devices d JOIN users u ON u.id = d.user_id ORDER BY u.name, u.id`).all();
  const pending = await db.prepare(`SELECT t.*, u.id AS user_id, u.name FROM tracker_days t JOIN tracker_devices d ON d.id = t.device_id JOIN users u ON u.id = d.user_id
                                    WHERE t.pending AND t.date <= ? ORDER BY t.date, u.name`).all(day);
  const group = (rows) => Object.values(rows.reduce((m, r) => ((m[`${r.user_id}|${r.date}`] ||= []).push(r), m), {}))
    .map((rs) => mergeDays(rs[0].user_id, rs[0].name, rs[0].date, rs));
  const today = group(pending.filter((r) => r.date === day));
  const earlier = pending.filter((r) => r.date !== day);
  return {
    people: people.map((p) => today.find((t) => t.user_id === p.id) || { user_id: p.id, name: p.name, date: day, missing: true }),
    late: group(earlier.filter((r) => !r.digested_at)),
    updated: group(earlier.filter((r) => r.digested_at)),
    rowKeys: pending.map((r) => [r.device_id, r.date]),
  };
}

let sending = false;

/**
 * Every five minutes: once the switch is on and the set time has come, send today's digest
 * to HR, once a day. When mail fails or HR has no address, nothing is marked: the rows stay
 * pending and the next tick tries again.
 */
export async function tick({ now = Date.now(), send = sendMail } = {}) {
  if (sending) return;
  const s = await settings();
  const day = dubaiDate(now);
  if (!s.on || s.sent_on === day || dubaiMinutes(now) < toMin(s.send_at)) return;
  if (!s.hr_email.trim()) { console.log('[tracker] digest due but HR has no email address in Settings → Activity reports'); return; }
  sending = true;
  try {
    const { people, late, updated, rowKeys } = await collect(day);
    const d = renderDigest({ day, people, late, updated, titlesOn: s.titles_on });
    await send({ to: s.hr_email, subject: d.subject, text: d.text, html: d.html, attachments: [{ filename: `activity-${day}.csv`, content: d.csv, contentType: 'text/csv' }] });
    for (const [deviceId, date] of rowKeys) await db.prepare('UPDATE tracker_days SET pending = false, digested_at = ? WHERE device_id = ? AND date = ?').run(day, deviceId, date);
    await db.prepare('UPDATE tracker_settings SET sent_on = ? WHERE id = 1').run(day);
  } catch (e) {
    console.error('[tracker] digest not sent:', e.message);
  } finally {
    sending = false;
  }
}

let timer;
export function startTracker() {
  if (timer) return;
  const run = () => billAs({ userId: null, job: 'other' }, () => tick()).catch((e) => console.error('[tracker]', e.message));
  timer = setInterval(run, 5 * 60_000);
  timer.unref();
  run();
}
