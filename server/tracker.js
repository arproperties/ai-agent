import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';

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
