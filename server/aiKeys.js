import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';

// The AI keys, typed in by the master instead of living only in .env.
//
// Which key a call uses, first one that is there and working:
//   1. the person's own key (set on their profile in People)   - source 'own'
//   2. the company key (Settings → AI keys)                     - source 'company'
//   3. the key in .env, untouched and kept for good             - source 'server'
// Work nobody asked for in person (renewals, the shared inboxes) starts at 2.
//
// A key the provider turns down (wrong, revoked, out of credit) is skipped for a while and
// the next one is used, so people keep working; the screen shows the master what failed.
//
// The keys are stored encrypted, so a copy of the database alone does not give them away.
// The encryption secret is AI_KEYS_SECRET in .env if set, otherwise a file in data/ made on
// first use (data/ is never deployed over). A copy of the live database on another machine
// therefore cannot read live's keys: there they count as not set, and .env is used.

export const PROVIDERS = ['anthropic', 'openai'];
const COMPANY = 0;
const SKIP_FOR = 10 * 60 * 1000; // a key that just failed is not tried again for ten minutes

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- encryption ----------

let secret;
function cipherKey() {
  if (secret) return secret;
  if (process.env.AI_KEYS_SECRET) return (secret = createHash('sha256').update(process.env.AI_KEYS_SECRET).digest());
  const file = `${DATA_DIR}/ai-keys.secret`;
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return (secret = createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest());
}

export function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function unseal(sealed) {
  try {
    const [iv, tag, body] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = createDecipheriv('aes-256-gcm', cipherKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null; // sealed with another secret: a database copied from another server
  }
}

// ---------- the keys, held in memory ----------

// Calls start synchronously (a stream is returned at once), so the keys are kept in memory
// and read from the database only when they change. `${owner}:${provider}` → { key, last4 }
let stored = new Map();
const failing = new Map(); // key text → { until, at, reason } for keys turned down lately
const masters = new Set();

export async function loadKeys() {
  const rows = await db.prepare('SELECT owner_id, provider, secret, last4 FROM ai_keys').all();
  const next = new Map();
  for (const r of rows) {
    const key = unseal(r.secret);
    if (key) next.set(`${r.owner_id}:${r.provider}`, { key, last4: r.last4 });
  }
  stored = next;
  masters.clear();
  for (const { id } of await db.prepare("SELECT id FROM users WHERE role = 'master'").all()) masters.add(id);
}

await loadKeys().catch((e) => console.warn('[ai keys] could not load, using .env only:', e.message));

const ENV = {
  anthropic: () => process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  openai: () => process.env.OPENAI_API_KEY || '',
};

/**
 * The keys to try for this person, best first: [{ key, source, owner }]. The same key twice
 * (a person given the company's key) is tried once. Keys that failed lately go to the back,
 * still there in case they were the only ones.
 */
export function keysFor(provider, userId) {
  const chain = [];
  const add = (key, source, owner) => { if (key && !chain.some((k) => k.key === key)) chain.push({ key, source, owner, provider }); };
  if (userId && !masters.has(userId)) add(stored.get(`${userId}:${provider}`)?.key, 'own', userId);
  add(stored.get(`${COMPANY}:${provider}`)?.key, 'company', COMPANY);
  add(ENV[provider](), 'server', null);
  const now = Date.now();
  const ok = (k) => !(failing.get(k.key)?.until > now);
  return [...chain.filter(ok), ...chain.filter((k) => !ok(k))];
}

export const hasKey = (provider, userId) => keysFor(provider, userId).length > 0;

/** Did the provider turn the key itself down, as opposed to a busy moment or a bad request? */
export function isKeyError(e) {
  const s = e?.status;
  const text = `${e?.code || ''} ${e?.message || ''}`;
  return s === 401 || s === 402 || s === 403
    || (s === 400 && /credit balance/i.test(text))
    || (s === 429 && /insufficient_quota|exceeded your current quota/i.test(text));
}

/** A key was turned down: skip it for a while, and note it for the master's screen. */
export function keyFailed(k, e) {
  const reason = String(e?.message || 'Turned down').replace(/\s+/g, ' ').slice(0, 200);
  failing.set(k.key, { until: Date.now() + SKIP_FOR, at: Math.floor(Date.now() / 1000), reason });
  console.warn(`[ai keys] ${k.source} key …${k.key.slice(-4)} turned down, using the next one:`, reason);
  if (k.owner !== null) {
    db.prepare(`UPDATE ai_keys SET failed_at = extract(epoch from now())::bigint, failed_reason = ? WHERE owner_id = ? AND provider = ?`)
      .run(reason, k.owner, k.provider).catch(() => {});
  }
}

// ---------- setting them ----------

/** Ask the provider whether the key is real. Free: it only lists models. */
async function checkKey(provider, key) {
  try {
    if (provider === 'anthropic') await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 });
    else await new OpenAI({ apiKey: key, maxRetries: 0 }).models.list();
  } catch (e) {
    const who = provider === 'anthropic' ? 'Claude' : 'OpenAI';
    if (e?.status === 401 || e?.status === 403) throw bad(`${who} says this key is not valid`);
    throw bad(`Could not check the key with ${who}: ${e.message}`);
  }
}

const ownerOf = async (owner) => {
  if (owner === 'company') return COMPANY;
  const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(owner));
  if (!user) throw bad('User not found', 404);
  if (user.role === 'master') throw bad("The master's keys are the company keys: set them in Settings → AI keys");
  return user.id;
};
const providerParam = (p) => {
  if (!PROVIDERS.includes(p)) throw bad('Unknown provider');
  return p;
};

export async function setKey(master, owner, provider, key, { check = true } = {}) {
  const ownerId = await ownerOf(owner);
  providerParam(provider);
  const clean = String(key || '').trim();
  if (clean.length < 20 || /\s/.test(clean)) throw bad('That does not look like an API key');
  if (provider === 'anthropic' && !clean.startsWith('sk-ant-')) throw bad('A Claude key starts with sk-ant-');
  if (provider === 'openai' && (!clean.startsWith('sk-') || clean.startsWith('sk-ant-'))) throw bad('An OpenAI key starts with sk-');
  if (check) await checkKey(provider, clean);
  await db.prepare(`INSERT INTO ai_keys (owner_id, provider, secret, last4, set_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, provider) DO UPDATE SET secret = EXCLUDED.secret, last4 = EXCLUDED.last4, set_by = EXCLUDED.set_by,
      set_at = extract(epoch from now())::bigint, failed_at = NULL, failed_reason = NULL`)
    .run(ownerId, provider, seal(clean), clean.slice(-4), master.id);
  failing.delete(clean);
  await loadKeys();
  return keysOf(owner);
}

export async function removeKey(owner, provider) {
  const ownerId = await ownerOf(owner);
  await db.prepare('DELETE FROM ai_keys WHERE owner_id = ? AND provider = ?').run(ownerId, providerParam(provider));
  await loadKeys();
  return keysOf(owner);
}

/** Check a stored key again (the Test button); a pass clears the failure note. */
export async function testKey(owner, provider) {
  const ownerId = await ownerOf(owner);
  const k = stored.get(`${ownerId}:${providerParam(provider)}`);
  if (!k) throw bad('No key is set here');
  await checkKey(provider, k.key);
  failing.delete(k.key);
  await db.prepare('UPDATE ai_keys SET failed_at = NULL, failed_reason = NULL WHERE owner_id = ? AND provider = ?').run(ownerId, provider);
  return keysOf(owner);
}

/**
 * What the screen shows: per provider the masked key and its last failure, never the key.
 * `server` says whether .env has one, as the last fallback.
 */
export async function keysOf(owner) {
  const ownerId = await ownerOf(owner);
  const rows = await db.prepare('SELECT provider, secret, last4, set_at, failed_at, failed_reason FROM ai_keys WHERE owner_id = ?').all(ownerId);
  const out = {};
  for (const p of PROVIDERS) {
    const r = rows.find((x) => x.provider === p);
    const company = stored.get(`${COMPANY}:${p}`);
    const env = ENV[p]();
    out[p] = {
      key: r ? {
        last4: r.last4, setAt: Number(r.set_at),
        unreadable: !unseal(r.secret), // sealed on another server: set it again here
        failedAt: r.failed_at ? Number(r.failed_at) : null, failedReason: r.failed_reason || null,
      } : null,
      // What is used when this one is not set (or fails)
      fallback: ownerId !== COMPANY && company ? { source: 'company', last4: company.last4 } : env ? { source: 'server', last4: env.slice(-4) } : null,
      serverFailed: env && failing.get(env)?.until > Date.now() ? failing.get(env).reason : null,
    };
  }
  return out;
}

// ---------- routes (master only) ----------

export const aiKeyRoutes = Router();
aiKeyRoutes.use(requireMaster);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// :owner is 'company' or a person's id
aiKeyRoutes.get('/:owner', wrap(async (req, res) => res.json(await keysOf(req.params.owner))));
aiKeyRoutes.put('/:owner/:provider', wrap(async (req, res) => res.json(await setKey(req.user, req.params.owner, req.params.provider, req.body?.key))));
aiKeyRoutes.delete('/:owner/:provider', wrap(async (req, res) => res.json(await removeKey(req.params.owner, req.params.provider))));
aiKeyRoutes.post('/:owner/:provider/test', wrap(async (req, res) => res.json(await testKey(req.params.owner, req.params.provider))));
