import { Router } from 'express';
import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, tx } from './db.js';
import { sendPasswordReset } from './mailer.js';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 60;
const COOKIE = 'jarvis_sid';

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [, salt, hex] = stored.split('$');
  const hash = await scryptAsync(password, salt, 64);
  return timingSafeEqual(hash, Buffer.from(hex, 'hex'));
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function startSession(req, res, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_DAYS * 86400 * 1000,
  });
}

// Simple in-memory brute-force guard: 10 failed attempts per IP+email per 15 minutes
const attempts = new Map();
const tooMany = (key) => {
  const a = attempts.get(key);
  return a && a.until > Date.now() && a.count >= 10;
};
const fail = (key) => {
  const a = attempts.get(key);
  attempts.set(key, a && a.until > Date.now() ? { ...a, count: a.count + 1 } : { count: 1, until: Date.now() + 15 * 60000 });
};

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  return await db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > extract(epoch from now())`).get(sha(token)) || null;
}

/**
 * When each account was last actually used. Written from here because this is the one
 * place every signed-in request passes through, and at most once every few minutes per
 * person: the People screen asks who is still using Jarvis, and a coarse answer serves
 * that as well as an exact one would while costing one write an hour instead of one a
 * request. Fire-and-forget - somebody's request must never fail over a statistic.
 */
const SEEN_EVERY = 5 * 60_000;
const lastWrote = new Map(); // user id -> when this process last recorded them
function recordSeen(userId) {
  const now = Date.now();
  if (now - (lastWrote.get(userId) || 0) < SEEN_EVERY) return;
  lastWrote.set(userId, now);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
    .run(Math.floor(now / 1000), userId)
    .catch((e) => console.error('[seen]', e.message));
}

export function requireUser(req, res, next) {
  currentUser(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    if (user.disabled) return res.status(403).json({ error: 'This account has been disabled' });
    req.user = user;
    recordSeen(user.id);
    next();
  }, next);
}

/**
 * The session this request arrives on, as the hash stored in `sessions`. Changing
 * someone's password clears their sessions; the master editing their own account can
 * pass this to spare the browser they are doing it from.
 */
export function sessionHash(req) {
  const token = readCookie(req, COOKIE);
  return token ? sha(token) : null;
}

/** Routes that only the master may call. Mount after requireUser, which sets req.user. */
export function requireMaster(req, res, next) {
  if (req.user?.role !== 'master') return res.status(403).json({ error: 'Not allowed' });
  next();
}

export const authRoutes = Router();

authRoutes.get('/me', async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json({ user: user && publicUser(user) });
  } catch (e) { next(e); }
});

// There is no public registration. Accounts are created by the master through
// /api/admin/users, or from the terminal; see scripts/make-master.js.

authRoutes.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${req.ip}|${email}`;
  if (tooMany(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await verifyPassword(String(req.body.password || ''), user.password_hash))) {
    fail(key);
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (user.disabled) return res.status(403).json({ error: 'This account has been disabled' });
  attempts.delete(key);
  await startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

// ---------- forgot / reset password ----------
authRoutes.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `forgot|${req.ip}|${email}`;
  if (tooMany(key)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  fail(key); // counts every request, successful or not
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const token = randomBytes(32).toString('base64url');
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id); // only the newest link works
    await db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), user.id, Math.floor(Date.now() / 1000) + 3600);
    const base = (process.env.APP_URL || req.get('origin') || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    // sent in the background so response time doesn't reveal whether the account exists
    sendPasswordReset(user, `${base}/?reset=${token}`).catch((e) => console.error('[mail]', e.message));
  }
  // same answer whether or not the account exists, so emails can't be probed
  res.json({ ok: true });
});

authRoutes.post('/reset', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > extract(epoch from now())').get(sha(token));
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  const hash = await hashPassword(password);
  await tx(async () => {
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // sign out everywhere else
  });
  await startSession(req, res, row.user_id);
  res.json({ user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });
});

authRoutes.post('/logout', async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// housekeeping: drop expired sessions once a day
setInterval(async () => {
  try {
    await db.exec('DELETE FROM sessions WHERE expires_at < extract(epoch from now())');
    await db.exec('DELETE FROM password_resets WHERE expires_at < extract(epoch from now())');
  } catch (e) { console.error('[db] housekeeping:', e.message); }
}, 86400000).unref();
