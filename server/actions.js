import { db, tx } from './db.js';
import { isMaster } from './access.js';

// What a person may change: Add, Edit, Delete, ticked once on their People profile and
// good for every module they hold. Modules decide what they see (server/modules.js);
// these decide what they may change in it. The master may do all three.

export const ACTIONS = [
  { key: 'add', label: 'Add' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];
const KEYS = ACTIONS.map((a) => a.key);
const bad = (message, status) => Object.assign(new Error(message), { status });

// ---------- who may do what ----------

/** The actions this user holds, in the tab's order. */
export async function userActions(user) {
  if (isMaster(user)) return KEYS;
  const rows = await db.prepare('SELECT action FROM action_access WHERE user_id = ?').all(user.id);
  const have = new Set(rows.map((r) => r.action));
  return KEYS.filter((k) => have.has(k));
}

/** All three, and whether this person has each: for their People profile. */
export async function listAppActions(userId) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const have = new Set(await userActions(target));
  return { master: isMaster(target), actions: ACTIONS.map((a) => ({ ...a, on: have.has(a.key) })) };
}

/** Replaces the person's whole set, so the caller sends the end state. Returns how many are kept. */
export async function setAppActions(userId, wanted) {
  const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !KEYS.includes(k));
  if (unknown) throw bad(`Unknown action: ${unknown}`, 400);
  if (isMaster(target)) return 0; // has them all already
  await tx(async () => {
    await db.prepare('DELETE FROM action_access WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO action_access (user_id, action) VALUES (?, ?)');
    for (const k of keys) await ins.run(target.id, k);
  });
  return keys.length;
}
