import { createHash, randomBytes } from 'node:crypto';
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
