import { Router } from 'express';
import webpush from 'web-push';
import { db } from './db.js';
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from './config.js';

// A buzz on the phone when Jarvis is closed.
//
// The live stream in messenger.js only exists while the app is open. This is the other
// half: when a message lands for someone whose app is shut, the server hands a short
// notice to the push service their browser already trusts — Apple's on an iPhone,
// Google's on Android and Chrome — and that service wakes the phone.
//
// Nothing here costs money and nothing new was signed up for. The keys below (VAPID) are
// generated once by `node scripts/vapid-keys.js` and live in .env; they are how the push
// service knows a notice really came from this server. Without them the whole feature is
// simply off, and everything else in the app carries on working.
//
// One row per device, not per person: the same user has a separate subscription for their
// phone, their iPad and their laptop, and each is switched on by tapping Allow on that
// device. Deleting the row is how notifications are switched off — there is no on/off
// column anywhere, because a row that exists IS the permission.

const ready = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (ready) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
else console.warn('[push] VAPID keys are not set — notifications are off. Run: node scripts/vapid-keys.js');

export const pushReady = () => ready;

const NOW = 'extract(epoch from now())::bigint';
const MAX_BODY = 120; // a phone truncates a long one anyway, and the words go over the wire

/**
 * Remember this device, so it can be woken later.
 *
 * The endpoint is unique across the whole table, not per user: it identifies one browser
 * install. If someone signs in as a different person on the same phone, the row moves to
 * them rather than sitting there quietly sending that phone the wrong person's messages.
 */
export async function saveSubscription(userId, sub, device) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint.startsWith('https://') || !p256dh || !auth) throw Object.assign(new Error('That is not a usable push subscription'), { status: 400 });
  await db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device)
      VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth, device = EXCLUDED.device, created_at = ${NOW}`)
    .run(userId, endpoint, p256dh, auth, String(device || '').slice(0, 200) || null);
}

/** Switching notifications off on one device. Missing is fine — the end state is the same. */
export const removeSubscription = (userId, endpoint) =>
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));

export const subscriptionsFor = (userId) =>
  db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);

const asSubscription = (r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });

/**
 * Send one notice to every device these users have switched on.
 *
 * One device failing never stops the others, and a push service having a bad morning is
 * logged rather than raised: callers send this off and do not wait for it, because the
 * message it is about has already been saved and already delivered to whoever is looking.
 * A device that answers 404 or 410 is gone for good — the app was deleted or the
 * permission revoked — so its row is dropped rather than retried forever.
 */
export async function sendPush(userIds, { title, body, url = '/', tag }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ready || !ids.length) return 0;
  const rows = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ANY(?::int[])').all(ids);
  if (!rows.length) return 0;

  const payload = JSON.stringify({ title, body: String(body || '').slice(0, MAX_BODY), url, tag });
  const dead = [];
  const sent = [];
  const results = await Promise.allSettled(rows.map((r) => webpush.sendNotification(asSubscription(r), payload, { TTL: 3600 })));
  results.forEach((out, i) => {
    if (out.status === 'fulfilled') { sent.push(rows[i].endpoint); return; }
    const code = out.reason?.statusCode;
    if (code === 404 || code === 410) dead.push(rows[i].endpoint);
    else console.warn('[push]', code || '', out.reason?.message);
  });
  if (dead.length) await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ANY(?::text[])').run(dead);
  if (sent.length) await db.prepare(`UPDATE push_subscriptions SET last_used_at = ${NOW} WHERE endpoint = ANY(?::text[])`).run(sent);
  return sent.length;
}

// ---------- routes ----------

export const pushRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The app asks for this before offering the toggle at all: no key, no offer, so nobody is
// shown a switch that cannot do anything.
pushRoutes.get('/key', (req, res) => res.json({ enabled: ready, key: ready ? VAPID_PUBLIC_KEY : null }));

pushRoutes.post('/subscribe', wrap(async (req, res) => {
  if (!ready) throw Object.assign(new Error('Notifications are not set up on this server'), { status: 503 });
  await saveSubscription(req.user.id, req.body.subscription, req.body.device);
  res.json({ ok: true });
}));

pushRoutes.delete('/subscribe', wrap(async (req, res) => {
  await removeSubscription(req.user.id, req.body?.endpoint || req.query.endpoint);
  res.json({ ok: true });
}));

// Sends one to this user's own devices, so they can see it working rather than having to
// ask someone to message them.
pushRoutes.post('/test', wrap(async (req, res) => {
  const sent = await sendPush([req.user.id], { title: 'Jarvis', body: 'Notifications are on. This is what they look like.', url: '/', tag: 'push-test' });
  res.json({ sent });
}));
