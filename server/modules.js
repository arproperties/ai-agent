import { Router } from 'express';
import { db, tx } from './db.js';
import { isMaster, isExternal } from './access.js';

// Reem's own modules: a screen a person only gets once the master ticks it on their
// People profile (module_access). The master has them all. Nothing else is asked of the
// person - no HR link, no building to be put in charge of - a tick is the whole of it.
//
// Not the saifsys modules (server/saifsys/index.js), which decide what a person's agents
// may look up in saifsys. To add a module: a line here, its routes behind needsModule(key),
// and its row in the client's settings menu.
//
// everyone: a screen that was everybody's before it became a module. Whoever already had
// an account on the day it became one keeps it (giveToEveryoneOnce); the master unticks
// it from there. A person added afterwards starts with nothing, like any other module.
//
// A module is the screen and what only the screen does. What a chat needs of the same
// data - opening a file an agent quoted, approving an email an agent drafted - stays open
// to everyone, or taking Shelf or Email from a person would break their chats.
//
// In the order of the settings menu.

export const MODULES = [
  { key: 'shelf', label: 'Shelf', about: 'Their files and the ones shared with them: upload, sort, search and open.', everyone: true },
  { key: 'legal', label: 'Legal cases', about: 'Legal cases from the case type to the end: cooling periods, legal notice, settlement, proceedings, appeal and vouchers, with every document and step kept.', company: true },
  { key: 'todos', label: 'To-do', about: 'Their to-do list and the things that come back, with reminders.', everyone: true },
  { key: 'translate', label: 'Live Translator', about: 'Two people, two languages, one phone.', everyone: true },
  { key: 'meetings', label: 'Meetings', about: 'Record a meeting and get who said what, with a summary.', everyone: true },
  { key: 'transcribe', label: 'Transcribe', about: 'Turn a recording or an audio file into text.', everyone: true },
  // company: the company's own work, never given to an external person (access.js).
  { key: 'renewals', label: 'Lease renewals', about: 'See the leases ending in the next 120 days, live from saifsys, with a link to the DLD Rental Index.', company: true },
  { key: 'notices', label: 'Tenant notices', about: 'Report something at a unit in a chat with Reem, with a photo. Reem writes the notice; it is emailed to the tenant when they tap Send.', company: true },
  { key: 'duties', label: 'My responsibilities', about: 'See what they look after, as you have written it.', everyone: true, company: true },
  { key: 'checklists', label: 'Checklists', about: 'The points of a job, ticked each time it is done.', everyone: true, company: true },
  { key: 'memory', label: 'Memory', about: 'See and remove what Reem remembers about them.', everyone: true },
  { key: 'email', label: 'Email', about: 'Connect their own mailbox and see what Reem has sent from it.', everyone: true },
  // Not a screen: what a chat does with /explain, /breakdown and /explore (server/pictures.js).
  { key: 'pictures', label: 'Pictures', about: 'Start a chat message with /explain, /breakdown or /explore and Reem draws it as a picture. Each picture is paid for.' },
];
const KEYS = MODULES.map((m) => m.key);
export const COMPANY_MODULES = MODULES.filter((m) => m.company).map((m) => m.key);
const COMPANY = new Set(COMPANY_MODULES);
const bad = (message, status) => Object.assign(new Error(message), { status });

// ---------- who has which module ----------

/**
 * The module keys this user holds. A company tick left from before someone was made
 * external counts for nothing while they are external.
 */
export async function userModules(user) {
  if (isMaster(user)) return KEYS;
  const rows = await db.prepare('SELECT module FROM module_access WHERE user_id = ?').all(user.id);
  const have = new Set(rows.map((r) => r.module));
  return KEYS.filter((k) => have.has(k) && !(isExternal(user) && COMPANY.has(k)));
}

/** Every module, and whether this person has it: for their People profile. */
export async function listModuleAccess(userId) {
  const target = await db.prepare('SELECT id, role, external FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const have = new Set(await userModules(target));
  const external = isExternal(target);
  return {
    master: isMaster(target),
    external,
    modules: MODULES.filter((m) => !(external && m.company))
      .map((m) => ({ key: m.key, label: m.label, about: m.about, on: have.has(m.key) })),
  };
}

/** Replaces the person's whole set, so the caller sends the end state. Returns how many are kept. */
export async function setModuleAccess(userId, wanted) {
  const target = await db.prepare('SELECT id, role, external FROM users WHERE id = ?').get(Number(userId) || 0);
  if (!target) throw bad('User not found', 404);
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !KEYS.includes(k));
  if (unknown) throw bad(`Unknown module: ${unknown}`, 400);
  const refused = isExternal(target) && keys.find((k) => COMPANY.has(k));
  if (refused) throw bad(`${MODULES.find((m) => m.key === refused).label} is the company's own work, and this person is external`, 400);
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

/** The same, except for the requests open(req) lets through: the ones a chat makes too. */
export const needsModuleUnless = (key, open) => (req, res, next) => (open(req) ? next() : needsModule(key)(req, res, next));

/**
 * Run at start-up. A screen that has just become a module is given, once, to everyone who
 * has an account at that moment; module_rollouts remembers that it was done, so a tick the
 * master has since taken away is not put back by the next restart. Returns what it gave.
 */
export async function giveToEveryoneOnce() {
  const done = new Set((await db.prepare('SELECT module FROM module_rollouts').all()).map((r) => r.module));
  const due = MODULES.filter((m) => m.everyone && !done.has(m.key)).map((m) => m.key);
  await tx(async () => {
    for (const key of due) {
      await db.prepare('INSERT INTO module_access (user_id, module) SELECT id, ? FROM users ON CONFLICT DO NOTHING').run(key);
      await db.prepare('INSERT INTO module_rollouts (module) VALUES (?)').run(key);
    }
  });
  return due;
}

// ---------- routes ----------

export const moduleRoutes = Router();

// For the menu: which module screens to offer this person.
moduleRoutes.get('/me', (req, res, next) => {
  userModules(req.user).then((modules) => res.json({ modules }), next);
});
