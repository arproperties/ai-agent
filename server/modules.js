import { Router } from 'express';
import { db, tx } from './db.js';
import { isMaster } from './access.js';

// Reem's own modules: a screen a person only gets once the master ticks it on their
// People profile (module_access). The master has them all. Nothing else is asked of the
// person - no HR link, no building to be put in charge of - a tick is the whole of it.
//
// Not the saifsys modules (server/saifsys/index.js), which decide what a person's agents
// may look up in saifsys. To add a module: a line here, its routes behind needsModule(key),
// and its row in the client's settings menu.

export const MODULES = [
  { key: 'notices', label: 'Tenant notices', about: 'Report something at a unit with a photo. Reem emails the notice to the tenant.' },
];
const KEYS = MODULES.map((m) => m.key);
const bad = (message, status) => Object.assign(new Error(message), { status });

// ---------- who has which module ----------

/** The module keys this user holds. */
export async function userModules(user) {
  if (isMaster(user)) return KEYS;
  const rows = await db.prepare('SELECT module FROM module_access WHERE user_id = ?').all(user.id);
  const have = new Set(rows.map((r) => r.module));
  return KEYS.filter((k) => have.has(k));
}

/** Every module, and whether this person has it: for their People profile. */
export async function listModuleAccess(userId) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const have = new Set(await userModules(target));
  return {
    master: isMaster(target),
    modules: MODULES.map((m) => ({ key: m.key, label: m.label, about: m.about, on: have.has(m.key) })),
  };
}

/** Replaces the person's whole set, so the caller sends the end state. Returns how many are kept. */
export async function setModuleAccess(userId, wanted) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !KEYS.includes(k));
  if (unknown) throw bad(`Unknown module: ${unknown}`, 400);
  await tx(async () => {
    await db.prepare('DELETE FROM module_access WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO module_access (user_id, module) VALUES (?, ?)');
    for (const k of keys) await ins.run(target.id, k);
  });
  return keys.length;
}

/** Refuses anyone who does not hold this module. Put it in front of the module's routes. */
export const needsModule = (key) => (req, res, next) => {
  userModules(req.user).then((have) => (have.includes(key) ? next() : res.status(403).json({ error: 'You do not have this module' })), next);
};

// ---------- routes ----------

export const moduleRoutes = Router();

// For the menu: which module screens to offer this person.
moduleRoutes.get('/me', (req, res, next) => {
  userModules(req.user).then((modules) => res.json({ modules }), next);
});
