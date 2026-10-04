import { Router } from 'express';
import { db, tx } from '../db.js';
import { isMaster } from '../access.js';
import { saifsysConfigured } from './client.js';
import * as ars from './ars.js';
import * as hr from './hr.js';
import { ACTIONS, actionKeys, setActions, bookingKit, bookingRoutes } from './booking.js';

// saifsys, module by module — the same workspaces as its launcher. Each module that has
// something connected is a file in this folder (tools, handlers, status) matching a file
// in saifsys's api/jarvis/v1/modules/. The rest are listed so the master can already
// decide who gets them; they carry no tools until something is connected.
//
// Who sees what: the master sees every module. Everyone else sees only the modules
// ticked for them on the admin screen (saifsys_access). An agent only carries the tools
// of the modules its user has, so a question about a module you do not have is simply
// one Riley cannot look up.

export { saifsysConfigured } from './client.js';

export const MODULES = [
  { key: 'operations', label: 'Operations' },
  { key: 'cleaning', label: 'Cleaning' },
  { key: 'realestate', label: 'Real Estate' },
  { key: 'construction', label: 'Construction' },
  { key: 'ars', label: 'ARS Home Rentals', ...ars },
  { key: 'grocery', label: 'Grocery' },
  { key: 'barber', label: 'Barber shop' },
  { key: 'hr', label: 'HR', ...hr },
  { key: 'finance', label: 'Finance' },
];
const KEYS = MODULES.map((m) => m.key);
const connected = (m) => !!m.tools?.length;

// ---------- who has which module ----------

/** The module keys this user may use. */
export async function userModules(user) {
  if (isMaster(user)) return KEYS;
  const rows = await db.prepare('SELECT module FROM saifsys_access WHERE user_id = ?').all(user.id);
  const have = new Set(rows.map((r) => r.module));
  return KEYS.filter((k) => have.has(k));
}

/** Every module, and whether this person has it — for the admin screen. */
export async function listAccess(userId) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw Object.assign(new Error('User not found'), { status: 404 });
  const have = new Set(await userModules(target));
  const may = new Set(isMaster(target) ? ACTIONS.map((a) => a.key) : await actionKeys(target.id));
  return {
    master: isMaster(target),
    modules: MODULES.map((m) => ({ key: m.key, label: m.label, connected: connected(m), on: have.has(m.key) })),
    // What they may DO, apart from what they may see. An action only works with its module ticked too.
    actions: ACTIONS.map((a) => ({ key: a.key, module: a.module, label: a.label, on: may.has(a.key) })),
  };
}

/** Replaces the person's set of saifsys actions. */
export async function setActionAccess(userId, wanted) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw Object.assign(new Error('User not found'), { status: 404 });
  await setActions(target.id, wanted);
  return (await actionKeys(target.id)).length;
}

/** Replaces the person's whole set, so the caller sends the end state. */
export async function setAccess(userId, wanted) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw Object.assign(new Error('User not found'), { status: 404 });
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !KEYS.includes(k));
  if (unknown) throw Object.assign(new Error(`Unknown module: ${unknown}`), { status: 400 });
  await tx(async () => {
    await db.prepare('DELETE FROM saifsys_access WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO saifsys_access (user_id, module) VALUES (?, ?)');
    for (const k of keys) await ins.run(target.id, k);
  });
  return keys.length;
}

// ---------- the tools an agent carries ----------

/**
 * This user's saifsys tools, same shape as todoKit() so chat.js routes calls by name.
 * null when saifsys is not connected or the user has no connected module.
 */
export async function saifsysKit(user) {
  if (!saifsysConfigured()) return null;
  const have = new Set(await userModules(user));
  const mods = MODULES.filter((m) => connected(m) && have.has(m.key));
  if (!mods.length) return null;
  const handlers = Object.assign({}, ...mods.map((m) => m.handlers));
  const status = Object.assign({}, ...mods.map((m) => m.status));
  return {
    definitions: mods.flatMap((m) => m.tools),
    status: (name) => status[name] ?? null,
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

/**
 * The tools that DO things in saifsys, for chat.js — kept apart from saifsysKit, which
 * only reads. Creating a booking needs the ARS module (its lookups find the unit and the
 * guest) as well as the action itself.
 */
export async function saifsysActionKit(user, ctx) {
  if (!(await userModules(user)).includes('ars')) return null;
  return bookingKit(user, ctx);
}

// ---------- routes ----------

// The same live answers the agents see, for anyone who has that module.
export const saifsysRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const needs = (key) => wrap(async (req, res, next) => {
  if (!(await userModules(req.user)).includes(key)) return res.status(403).json({ error: 'You do not have this saifsys module' });
  next();
});

// Booking cards: each is the person's own, so the ARS module is not checked to read or
// cancel one; creating checks everything again in decideBooking.
saifsysRoutes.use('/ars/bookings', bookingRoutes);

saifsysRoutes.get('/ars/checkouts', needs('ars'), wrap(async (req, res) => {
  res.json(await ars.checkouts(req.query.date ? String(req.query.date) : undefined));
}));
