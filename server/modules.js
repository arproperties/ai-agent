import { db, tx } from './db.js';
import { isMaster } from './access.js';

// The app's modules: one for each place in the left menu (client Sidebar.jsx `places`),
// in the menu's order. The master has them all. Everyone else has Chats, and whatever is
// ticked for them on their People profile (module_access). A module is on or off: what
// only the master may do inside a screen is still checked where it always was.

export const MODULES = [
  { key: 'tour', label: '3D Navigation' },
  { key: 'overview', label: 'Overview' },
  { key: 'chats', label: 'Chats', always: true },
  { key: 'leasing', label: 'Leasing' },
  { key: 'tenants', label: 'Tenants' },
  { key: 'workorders', label: 'Work orders' },
  { key: 'reports', label: 'Reports' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'documents', label: 'Documents' },
  { key: 'properties', label: 'Properties' },
  { key: 'sources', label: 'Sources' },
];
const KEYS = MODULES.map((m) => m.key);
const ALWAYS = MODULES.filter((m) => m.always).map((m) => m.key);
const bad = (message, status) => Object.assign(new Error(message), { status });

// ---------- who has which module ----------

/** The module keys this user holds, in the menu's order. */
export async function userModules(user) {
  if (isMaster(user)) return KEYS;
  const rows = await db.prepare('SELECT module FROM module_access WHERE user_id = ?').all(user.id);
  const have = new Set(rows.map((r) => r.module));
  return KEYS.filter((k) => ALWAYS.includes(k) || have.has(k));
}

/** Every module, and whether this person has it: for their People profile. */
export async function listModuleAccess(userId) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const have = new Set(await userModules(target));
  return {
    master: isMaster(target),
    modules: MODULES.map((m) => ({ key: m.key, label: m.label, on: have.has(m.key), locked: !!m.always })),
  };
}

/** Replaces the person's whole set, so the caller sends the end state. Returns how many are kept. */
export async function setModuleAccess(userId, wanted) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !KEYS.includes(k));
  if (unknown) throw bad(`Unknown module: ${unknown}`, 400);
  if (isMaster(target)) return 0; // has them all already
  const keep = keys.filter((k) => !ALWAYS.includes(k));
  await tx(async () => {
    await db.prepare('DELETE FROM module_access WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO module_access (user_id, module) VALUES (?, ?)');
    for (const k of keep) await ins.run(target.id, k);
  });
  return keep.length;
}

/** Everyone who holds a module, masters included: who a push about it may go to. */
export async function holders(key) {
  const rows = await db.prepare(`SELECT id FROM users WHERE role = 'master'
    UNION SELECT user_id AS id FROM module_access WHERE module = ?`).all(key);
  return new Set(rows.map((r) => r.id));
}
