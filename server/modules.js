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
  { key: 'prospects', label: 'Prospects' }, // people interested in a unit, before they are tenants (server/prospects.js)
  { key: 'workorders', label: 'Work orders' },
  { key: 'reports', label: 'Reports' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'documents', label: 'Documents' },
  { key: 'properties', label: 'Properties' },
  { key: 'sources', label: 'Sources' },
  { key: 'activity', label: 'Activity' }, // the activity log: who changed what (server/activity.js)
  { key: 'accounts', label: 'Accounts' }, // expenses and repeating bills, sent to QuickBooks (server/expenses.js)
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

/** Everyone who holds a module, masters included, disabled accounts left out: who a push about it may go to. */
export async function holders(key) {
  const rows = await db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT disabled
    UNION SELECT m.user_id AS id FROM module_access m JOIN users u ON u.id = m.user_id
      WHERE m.module = ? AND NOT u.disabled`).all(key);
  return new Set(rows.map((r) => r.id));
}

// ---------- which module each route needs ----------

const ANYONE = '*'; // anyone signed in
const MASTER = []; // nobody's module: the master alone
// What follows /api, then who may read it (GET) and who may change it. The first line
// that matches decides. Screens share data (a lease form lists tenants, units and
// sources), so a route names every module whose screen reads it; changing belongs to the
// module that owns the thing, and to a screen that already adds one inline.
const RULES = [
  [/^\/activity(\/|$)/, ['activity'], MASTER], // read by its holders; nobody writes to the log
  [/^\/accounts(\/|$)/, ['accounts'], ['accounts']],
  [/^\/leasing\/region\/?$/, ANYONE, ANYONE], // money and dates are written with it everywhere; saving it is the master's, checked in its router
  [/^\/leasing\/alerts\/count$/, ANYONE, MASTER], // the sidebar's badges; trimmed to what they hold in the route
  [/^\/leasing\/alerts\/reminder(\/|$)/, ['alerts', 'overview', 'leasing'], ['alerts', 'leasing']], // the reminder is sent from a lease's Payments too
  [/^\/leasing\/alerts(\/|$)/, ['alerts', 'overview'], ['alerts']],
  [/^\/leasing\/reports\//, ['reports'], MASTER],
  [/^\/leasing\/overview$/, ['overview', 'leasing'], MASTER], // the 3D view is drawn from it too
  [/^\/leasing\/work-orders(\/|$)/, ['workorders', 'leasing'], ['workorders']], // the 3D view marks open repairs
  [/^\/leasing\/prospects(\/|$)/, ['prospects', 'leasing'], ['prospects']], // Make lease is the lease form's own route
  // an id is whatever sits between the slashes: Express decodes it and the routes read it as a number
  [/^\/leasing\/(tenants\/[^/]+\/(history|log)|log)(\/|$)/, ['tenants'], ['tenants']],
  [/^\/leasing\/tenants(\/|$)/, ['tenants', 'leasing', 'reports'], ['tenants', 'leasing']],
  [/^\/leasing\/services(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/leasing\/sources(\/|$)/, ['sources', 'leasing', 'prospects'], ['sources', 'leasing']], // a prospect picks where they came from
  [/^\/leasing\/(units\/[^/]+\/inspections|inspections|inspection-photos)(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/leasing\/(available|bookings|installments|payments|docs)(\/|$)/, ['leasing'], ['leasing']],
  [/^\/leasing(\/|$)/, MASTER, MASTER], // a leasing route with no line above is the master's until it is given one
  [/^\/properties\/renewals(\/|$)/, ['documents'], ['documents']],
  [/^\/properties\/places\/?$/, ['documents', 'properties', 'prospects'], ['documents', 'properties']], // the names only: a prospect picks the unit wanted
  [/^\/properties\/(documents|docs|places|companies\/[^/]+\/docs)(\/|$)/, ['documents', 'properties'], ['documents', 'properties']],
  [/^\/properties\/(plans|plan-readings|buildings\/[^/]+\/plan)(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/properties(\/|$)/, ['properties', 'leasing', 'reports'], ['properties']],
];

/** Who may make this request: module keys (any one is enough), '*' for anyone signed in, or null when it is not a module's route. */
export function needed(method, path) {
  // Express matches mounts whatever the case, so the gate must too.
  const lower = path.toLowerCase();
  const rule = RULES.find(([at]) => at.test(lower));
  if (!rule) return null;
  return method === 'GET' || method === 'HEAD' ? rule[1] : rule[2];
}

/** Refuses a request to a module the person does not hold. Mount at /api, after requireUser. */
export function moduleGate(req, res, next) {
  const need = needed(req.method, req.path);
  if (!need || need === ANYONE || isMaster(req.user)) return next();
  userModules(req.user).then((have) => (need.some((k) => have.includes(k)) ? next() : res.status(403).json({ error: 'Not allowed' })), next);
}
