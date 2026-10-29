import { db, tx } from './db.js';
import { isMaster } from './access.js';

// What a person may change: Add, Edit, Delete, ticked once on their People profile and
// good for every module they hold. Modules decide what they see (server/modules.js);
// these decide what they may change in it. The master may do all three.
//
// A new feature joins without anyone remembering a list: every route under COVERED is
// checked by its method. Only three things need a thought, and a test fails until each is
// done (tests/actions.test.js): a POST that changes something already there goes in
// OVERRIDES; a new Riley tool that changes something goes in TOOL_ACTIONS
// (server/leasingKit.js); a new button that adds, edits or deletes is shown with canDo
// (client/src/lib/actions.js).

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

// ---------- which action each request is ----------

// The shared records: what follows /api for every screen of the business. A person's own
// things (chats, to-dos, meetings, mail, their Riley imports) are theirs, whatever is ticked.
export const COVERED = /^\/(leasing|properties|accounts|inventory|recurring-payments)(\/|$)/;
// The method says the action: POST adds, PUT and PATCH edit, DELETE deletes. A POST that
// does something else is listed here; the first line that matches decides, and null is
// a POST that changes nothing (Riley reading a file before anything is saved). A new
// POST is an add until it is given a line (tests/actions.test.js keeps the list honest).
const OVERRIDES = [
  [/^\/leasing\/bookings\/[^/]+\/(contract|confirm|end|cancel|deposit|deposit\/pass)$/, 'edit'], // the state of a lease that is there
  [/^\/leasing\/payments\/[^/]+\/file$/, 'edit'], // the slip of a payment already recorded
  [/^\/leasing\/alerts\/reminder\/[^/]+$/, 'edit'], // sending a reminder about a lease
  [/^\/properties\/(companies|buildings|units)\/[^/]+\/photo$/, 'edit'], // the one picture of a place, replaced
  [/^\/properties\/renewals\/[^/]+\/(find|requests\/[^/]+\/sent|check|chase|compare|lookup|decide|close)$/, 'edit'], // a renewal moving along
  [/^\/recurring-payments\/entries\/[^/]+\/active$/, 'edit'], // paused or running again
  [/^\/recurring-payments\/dues\/[^/]+\/(paid|pending)$/, 'edit'],
  [/^\/recurring-payments\/(dues|transfers)\/[^/]+\/attachment$/, 'edit'], // the file of a line, replaced
  [/^\/inventory\/proposals\/[^/]+\/(add|cancel)$/, 'edit'], // deciding what Riley proposed
  [/^\/inventory\/[^/]+\/items\/[^/]+\/(take|photo)$/, 'edit'],
  [/^\/(leasing\/slips|properties\/documents|accounts\/receipts|leasing\/(tenants|bookings)\/import)\/read$/, null], // Riley reads; the save is its own request
  [/^\/properties\/buildings\/[^/]+\/plan\/read$/, null],
];
const BY_METHOD = { POST: 'add', PUT: 'edit', PATCH: 'edit', DELETE: 'delete' };

/** 'add', 'edit' or 'delete' for a request that changes shared records; null for a read, or for the person's own things. */
export function actionFor(method, path) {
  const action = BY_METHOD[method];
  const lower = path.toLowerCase().replace(/\/$/, '');
  if (!action || !COVERED.test(lower)) return null;
  const line = method === 'POST' && OVERRIDES.find(([at]) => at.test(lower));
  return line ? line[1] : action;
}

/** Refuses a change the person has not been ticked for. Mount at /api, after moduleGate. */
export function actionGate(req, res, next) {
  const action = actionFor(req.method, req.path);
  if (!action || isMaster(req.user)) return next();
  userActions(req.user).then((have) => (have.includes(action) ? next()
    : res.status(403).json({ error: `You are not allowed to ${action} here. Ask the master.` })), next);
}
