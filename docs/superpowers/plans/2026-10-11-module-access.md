# Module Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The master ticks, on a person's People profile, which left-menu modules that person gets; the menu, the server, Riley and the pushes all follow those ticks, and everyone always has Chats.

**Architecture:** One new server module, `server/modules.js`, owns the list of modules, one table (`module_access`), and one table of rules saying which modules may read or change each `/api/leasing` and `/api/properties` route. A single middleware mounted at `/api` applies the rules. `/api/auth/me` carries the person's modules; the client keeps them in a small store (`client/src/lib/modules.js`) that the sidebar, the Tour, the cross-link buttons and a guard in `App.jsx` read.

**Tech Stack:** Node 22 (ES modules), Express 5, Postgres via the `db` / `tx` wrapper in `server/db.js`, `node --test`, React + Tailwind + lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-11-module-access-design.md`. Read it before starting.

## Global Constraints

- Branch `leasing-bookings` only. Never commit to, merge into or push to `main`. Do not push or deploy at all: Francis says when.
- **Before each task:** run `git status --short`. If a file the task modifies shows as already modified, stop and ask Francis; never commit or discard someone else's hunks. Line numbers here are from 2026-10-11: find the place by the code quoted, not the number.
- Each commit stages only the files its task names (`git add <paths>`), never `git add -A`.
- Module keys, exactly: `chats`, `tour`, `overview`, `leasing`, `tenants`, `workorders`, `reports`, `alerts`, `documents`, `properties`, `sources`. `chats` is always held and never stored.
- A module is on or off (spec D3). No view-only level, no roles (D2).
- The master holds every module and has no rows in `module_access` (D5).
- Nothing ticked means Chats only (D4). No migration seeds any row.
- Existing `requireMaster` checks stay exactly where they are. A tick never widens them.
- A refusal is `403 { error: 'Not allowed' }`, the same answer `requireMaster` gives.
- Never a native `<select>`: use `client/src/components/Select.jsx` (not needed here, but do not add one).
- Never use the connected company mailbox in a test; stubs only.
- Comments and messages follow the file they are in: short, plain, saying why.
- Tests need `TEST_DATABASE_URL` pointing at a database whose name ends in `_test`. One file: `npm test -- tests/modules.test.js`. Everything: `npm test`. `tests/drawing.test.js` crashes on Windows for an unrelated reason; that one failure is expected.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. A route under `/api/leasing` that nobody gave a rule (one added next month): a person who is not the master must be refused, not let through. (Test in Task 2.)
2. A person with Leasing only opens a new lease: every read the form makes (tenants, sources, services, companies, a building, free units) must answer 200. (Test in Task 2.)
3. A person whose module is unticked while they are signed in: their very next request to it is refused, with no sign-out needed. (Test in Task 2.)
4. `PUT /admin/users/:id/modules` sent `chats`, a duplicate, or a key that does not exist: `chats` and the duplicate are dropped without error, the unknown key is a 400 and nothing is saved. (Test in Task 1.)
5. A building's staff member with no Alerts tick: no leasing push reaches them, and the run does not fail for it. (Test in Task 5.)

## File Structure

| File | Responsibility |
|------|----------------|
| `server/modules.js` (create) | The modules, who holds which, the route rules, the gate. |
| `server/db.js` (modify) | The `module_access` table. |
| `server/index.js` (modify) | Mount the gate. |
| `server/auth.js` (modify) | `modules` on the signed-in user. |
| `server/admin.js` (modify) | The two People routes. |
| `server/leasingAlerts.js` (modify) | Trim `/count`; buzz only holders of Alerts. |
| `server/workOrders.js` (modify) | Buzz only holders of Work orders. |
| `server/leasingKit.js`, `server/chat.js` (modify) | Riley carries only the held modules' tools. |
| `tests/modules.test.js` (create) | Every rule above. |
| `tests/helpers/db.js`, `tests/work-orders.test.js`, `tests/document-alerts.test.js`, `tests/leasing-money.test.js`, `tests/leasing-reports.test.js` (modify) | The new table in the reset list; ticks for staff who expect a push. |
| `client/src/lib/modules.js` (create) | What the signed-in person holds: `setModules`, `can`, `moduleOf`. |
| `client/src/App.jsx`, `Sidebar.jsx`, `Tour3D.jsx` (modify) | The menu, the start screen, the guard, the Tour's stops. |
| `client/src/components/Leasing.jsx`, `Building3D.jsx`, `TenantHistory.jsx` (modify) | Buttons into a module not held are not shown. |
| `client/src/components/Admin.jsx` (modify) | The Modules tab on a person's profile. |

---

### Task 1: The modules and who holds them

**Files:**
- Create: `server/modules.js`
- Modify: `server/db.js` (after the `saifsys_action_access` block, near line 755)
- Modify: `tests/helpers/db.js` (the `TABLES` list, and a new helper at the end)
- Test: `tests/modules.test.js`

**Interfaces:**
- Produces:
  - `MODULES: { key: string, label: string, always?: true }[]`
  - `userModules(user: { id, role }): Promise<string[]>` in `MODULES` order
  - `listModuleAccess(userId): Promise<{ master: boolean, modules: { key, label, on, locked }[] }>`
  - `setModuleAccess(userId, keys: string[]): Promise<number>` (how many are stored)
  - `holders(key: string): Promise<Set<number>>` user ids, masters included
  - test helper `giveModules(userId, ...keys): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/modules.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser, giveModules } from './helpers/db.js';
import { MODULES, userModules, listModuleAccess, setModuleAccess, holders } from '../server/modules.js';

test.after(() => closeDb());

const ALL = ['tour', 'overview', 'chats', 'leasing', 'tenants', 'workorders', 'reports', 'alerts', 'documents', 'properties', 'sources'];

async function people() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const sara = await makeUser('Sara');
  return { master: { id: master, role: 'master' }, sara: { id: sara, role: 'user' } };
}

test('the modules are the menu, in its order', () => {
  assert.deepEqual(MODULES.map((m) => m.key), ALL);
});

test('nothing ticked is Chats only, and the master has every module', async () => {
  const { master, sara } = await people();
  assert.deepEqual(await userModules(sara), ['chats']);
  assert.deepEqual(await userModules(master), ALL);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM module_access').get()).n, 0, 'nobody is seeded');
});

test('ticking replaces the whole set, drops chats and duplicates, and refuses an unknown key', async () => {
  const { master, sara } = await people();
  assert.equal(await setModuleAccess(sara.id, ['workorders', 'chats', 'workorders', 'tenants']), 2);
  assert.deepEqual(await userModules(sara), ['chats', 'tenants', 'workorders']);

  assert.equal(await setModuleAccess(sara.id, ['reports']), 1);
  assert.deepEqual(await userModules(sara), ['chats', 'reports']);

  await assert.rejects(() => setModuleAccess(sara.id, ['reports', 'payroll']), (e) => e.status === 400 && /Unknown module: payroll/.test(e.message));
  assert.deepEqual(await userModules(sara), ['chats', 'reports'], 'a refused save changes nothing');

  await assert.rejects(() => setModuleAccess(9999, ['reports']), (e) => e.status === 404);
  assert.equal(await setModuleAccess(sara.id, 'not a list'), 0);
  assert.deepEqual(await userModules(sara), ['chats']);

  assert.equal(await setModuleAccess(master.id, ['reports']), 0, 'the master is never listed');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM module_access').get()).n, 0);
});

test('the People screen is told every module, which are on, and that Chats is locked', async () => {
  const { master, sara } = await people();
  await giveModules(sara.id, 'leasing');
  const a = await listModuleAccess(sara.id);
  assert.equal(a.master, false);
  assert.deepEqual(a.modules.map((m) => m.key), ALL);
  assert.deepEqual(a.modules.filter((m) => m.on).map((m) => m.key), ['chats', 'leasing']);
  assert.deepEqual(a.modules.filter((m) => m.locked).map((m) => m.key), ['chats']);
  assert.equal(a.modules.find((m) => m.key === 'workorders').label, 'Work orders');

  const m = await listModuleAccess(master.id);
  assert.equal(m.master, true);
  assert.ok(m.modules.every((x) => x.on));
  await assert.rejects(() => listModuleAccess(9999), (e) => e.status === 404);
});

test('holders are the master and whoever is ticked', async () => {
  const { master, sara } = await people();
  const omar = await makeUser('Omar');
  await giveModules(sara.id, 'alerts');
  assert.deepEqual([...(await holders('alerts'))].sort(), [master.id, sara.id].sort());
  assert.deepEqual([...(await holders('reports'))], [master.id]);
  assert.equal((await holders('alerts')).has(omar), false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/modules.test.js`
Expected: FAIL, `Cannot find module '../server/modules.js'` (or `giveModules` is not exported).

- [ ] **Step 3: Add the table**

In `server/db.js`, straight after the `saifsys_action_access` block:

```js
// Which of the app's own modules each person has: one row per ticked place in the left
// menu (server/modules.js). The master has them all and is never listed; Chats is
// everyone's and is never listed either. It starts empty: nobody is given a screen
// they were not ticked for.
await db.exec(`
  CREATE TABLE IF NOT EXISTS module_access (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module TEXT NOT NULL,
    PRIMARY KEY (user_id, module)
  );
`);
```

- [ ] **Step 4: Add the table and the helper to the tests**

In `tests/helpers/db.js`, in `TABLES`, change `'saifsys_access', 'saifsys_action_access',` to `'saifsys_access', 'saifsys_action_access', 'module_access',`. At the end of the file add:

```js
/** Tick modules for someone, as the master would on their People profile. */
export async function giveModules(userId, ...keys) {
  for (const k of keys) {
    await db.prepare('INSERT INTO module_access (user_id, module) VALUES (?, ?) ON CONFLICT DO NOTHING').run(userId, k);
  }
}
```

- [ ] **Step 5: Write `server/modules.js`**

```js
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
```

- [ ] **Step 6: Run the test to see it pass**

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add server/modules.js server/db.js tests/helpers/db.js tests/modules.test.js
git commit -m "feat: Modules: which left-menu modules each person holds, kept per person; nothing ticked is Chats only"
```

---

### Task 2: The gate on the leasing and property routes

**Files:**
- Modify: `server/modules.js` (append)
- Modify: `server/index.js:65` (straight after `app.use('/api', requireUser);`)
- Modify: `server/leasingAlerts.js` (the `/count` route, near line 377)
- Test: `tests/modules.test.js` (append)

**Interfaces:**
- Consumes: `userModules(user)`, `giveModules(userId, ...keys)` from Task 1.
- Produces:
  - `needed(method: string, path: string): string[] | '*' | null`. `path` is what follows `/api`. `null`: not a module's route. `'*'`: anyone signed in. `[]`: the master only.
  - `moduleGate(req, res, next)`: Express middleware, mounted at `/api` after `requireUser`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/modules.test.js`. Change its first import lines to also bring in `express`, and the modules import to include `needed` and `moduleGate`:

```js
import express from 'express';
import { MODULES, userModules, listModuleAccess, setModuleAccess, holders, needed, moduleGate } from '../server/modules.js';
```

Then, at the end of the file:

```js
test('each route names the modules that may read it and the modules that may change it', () => {
  const rule = (path) => [needed('GET', path), needed('POST', path)];
  assert.deepEqual(rule('/leasing/overview'), [['overview', 'leasing'], []]);
  assert.deepEqual(rule('/leasing/bookings'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/bookings/7/payments'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/payments/7/receipt'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/available'), [['leasing'], ['leasing']]);
  assert.deepEqual(rule('/leasing/tenants'), [['tenants', 'leasing', 'reports'], ['tenants', 'leasing']]);
  assert.deepEqual(rule('/leasing/tenants/3'), [['tenants', 'leasing', 'reports'], ['tenants', 'leasing']]);
  assert.deepEqual(rule('/leasing/tenants/3/history'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/tenants/3/log'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/log/9/files'), [['tenants'], ['tenants']]);
  assert.deepEqual(rule('/leasing/services'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/sources/2'), [['sources', 'leasing'], ['sources', 'leasing']]);
  assert.deepEqual(rule('/leasing/work-orders'), [['workorders', 'leasing'], ['workorders']]);
  assert.deepEqual(rule('/leasing/work-orders/5/notes'), [['workorders', 'leasing'], ['workorders']]);
  assert.deepEqual(rule('/leasing/units/4/inspections'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/inspection-photos/4'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/leasing/reports/rent_roll'), [['reports'], []]);
  assert.deepEqual(rule('/leasing/alerts'), [['alerts', 'overview'], ['alerts']]);
  assert.deepEqual(rule('/leasing/alerts/reminder/8'), [['alerts', 'overview'], ['alerts']]);
  assert.deepEqual(rule('/leasing/alerts/count'), ['*', []]);
  assert.deepEqual(rule('/leasing/region'), ['*', '*']);
  assert.deepEqual(rule('/properties/renewals'), [['documents'], ['documents']]);
  assert.deepEqual(rule('/properties/documents'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/docs/3/file'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/companies/3/docs'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/places'), [['documents', 'properties'], ['documents', 'properties']]);
  assert.deepEqual(rule('/properties/plans'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/properties/buildings/2/plan'), [['leasing', 'properties'], ['leasing', 'properties']]);
  assert.deepEqual(rule('/properties/companies'), [['properties', 'leasing', 'reports'], ['properties']]);
  assert.deepEqual(rule('/properties/buildings/2'), [['properties', 'leasing', 'reports'], ['properties']]);
  assert.deepEqual(rule('/properties/unit-photos/2'), [['properties', 'leasing', 'reports'], ['properties']]);
  // A leasing route nobody has given a rule is the master's until somebody does.
  assert.deepEqual(rule('/leasing/something-new'), [[], []]);
  // Everything else in the app is not a module's and is left alone.
  for (const p of ['/todos', '/messenger/chats', '/admin/users', '/auth/me', '/buildings', '/leasingx']) assert.equal(needed('GET', p), null, p);
});

// The gate over real HTTP, mounted as index.js mounts it, in front of a stand-in for every route.
let caller = { id: 0, role: 'user' };
const app = express();
app.use('/api', (req, res, next) => { req.user = caller; next(); });
app.use('/api', moduleGate);
app.use('/api', (req, res) => res.json({ ok: true }));
const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
test.after(() => new Promise((ok) => server.close(ok)));
const hit = async (method, path) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method })).status;

test('a person reaches only the routes of the modules they hold', async () => {
  const { master, sara } = await people();
  caller = sara;
  assert.equal(await hit('GET', '/leasing/bookings'), 403);
  assert.equal(await hit('GET', '/properties/companies'), 403);
  assert.equal(await hit('GET', '/leasing/something-new'), 403, 'a route with no rule is refused, not let through');
  assert.equal(await hit('GET', '/todos'), 200, 'the rest of the app is untouched');
  assert.equal(await hit('GET', '/leasing/region'), 200);
  assert.equal(await hit('GET', '/leasing/alerts/count'), 200);
  const refused = await fetch(`http://127.0.0.1:${server.address().port}/api/leasing/bookings`);
  assert.deepEqual(await refused.json(), { error: 'Not allowed' });

  await giveModules(sara.id, 'workorders');
  assert.equal(await hit('GET', '/leasing/work-orders'), 200);
  assert.equal(await hit('POST', '/leasing/work-orders'), 200);
  assert.equal(await hit('GET', '/leasing/bookings'), 403);

  caller = master;
  for (const p of ['/leasing/bookings', '/leasing/something-new', '/properties/companies']) assert.equal(await hit('GET', p), 200, p);
  assert.equal(await hit('DELETE', '/leasing/reports/rent_roll'), 200, 'the master is never stopped here');
});

test('Leasing alone can make a lease: every read its form makes is allowed', async () => {
  const { sara } = await people();
  await giveModules(sara.id, 'leasing');
  caller = sara;
  for (const p of ['/properties/companies', '/properties/companies/1', '/properties/buildings/1', '/leasing/tenants', '/leasing/sources',
    '/leasing/services', '/leasing/available', '/leasing/bookings', '/leasing/overview', '/properties/plans', '/leasing/work-orders']) {
    assert.equal(await hit('GET', p), 200, p);
  }
  for (const p of ['/leasing/bookings', '/leasing/tenants', '/leasing/sources', '/leasing/services']) assert.equal(await hit('POST', p), 200, p);
  // What it reads from another module, it may not change there.
  assert.equal(await hit('POST', '/leasing/work-orders'), 403);
  assert.equal(await hit('POST', '/properties/companies'), 403);
  assert.equal(await hit('GET', '/leasing/tenants/1/history'), 403, 'a tenant’s history is the Tenants screen’s');
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 403);
});

test('unticking takes effect on the next request', async () => {
  const { sara } = await people();
  await giveModules(sara.id, 'reports');
  caller = sara;
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 200);
  await setModuleAccess(sara.id, []);
  assert.equal(await hit('GET', '/leasing/reports/rent_roll'), 403);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/modules.test.js`
Expected: FAIL, `The requested module '../server/modules.js' does not provide an export named 'needed'`.

- [ ] **Step 3: Append the rules and the gate to `server/modules.js`**

```js
// ---------- which module each route needs ----------

const ANYONE = '*'; // anyone signed in
const MASTER = []; // nobody's module: the master alone
// What follows /api, then who may read it (GET) and who may change it. The first line
// that matches decides. Screens share data (a lease form lists tenants, units and
// sources), so a route names every module whose screen reads it; changing belongs to the
// module that owns the thing, and to a screen that already adds one inline.
const RULES = [
  [/^\/leasing\/region\/?$/, ANYONE, ANYONE], // money and dates are written with it everywhere; saving it is the master's, checked in its router
  [/^\/leasing\/alerts\/count$/, ANYONE, MASTER], // the sidebar's badges; trimmed to what they hold in the route
  [/^\/leasing\/alerts(\/|$)/, ['alerts', 'overview'], ['alerts']],
  [/^\/leasing\/reports\//, ['reports'], MASTER],
  [/^\/leasing\/overview$/, ['overview', 'leasing'], MASTER], // the 3D view is drawn from it too
  [/^\/leasing\/work-orders(\/|$)/, ['workorders', 'leasing'], ['workorders']], // the 3D view marks open repairs
  [/^\/leasing\/(tenants\/\d+\/(history|log)|log)(\/|$)/, ['tenants'], ['tenants']],
  [/^\/leasing\/tenants(\/|$)/, ['tenants', 'leasing', 'reports'], ['tenants', 'leasing']],
  [/^\/leasing\/services(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/leasing\/sources(\/|$)/, ['sources', 'leasing'], ['sources', 'leasing']],
  [/^\/leasing\/(units\/\d+\/inspections|inspections|inspection-photos)(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/leasing\/(available|bookings|installments|payments|docs)(\/|$)/, ['leasing'], ['leasing']],
  [/^\/leasing(\/|$)/, MASTER, MASTER], // a leasing route with no line above is the master's until it is given one
  [/^\/properties\/renewals(\/|$)/, ['documents'], ['documents']],
  [/^\/properties\/(documents|docs|places|companies\/\d+\/docs)(\/|$)/, ['documents', 'properties'], ['documents', 'properties']],
  [/^\/properties\/(plans|plan-readings|buildings\/\d+\/plan)(\/|$)/, ['leasing', 'properties'], ['leasing', 'properties']],
  [/^\/properties(\/|$)/, ['properties', 'leasing', 'reports'], ['properties']],
];

/** Who may make this request: module keys (any one is enough), '*' for anyone signed in, or null when it is not a module's route. */
export function needed(method, path) {
  const rule = RULES.find(([at]) => at.test(path));
  if (!rule) return null;
  return method === 'GET' || method === 'HEAD' ? rule[1] : rule[2];
}

/** Refuses a request to a module the person does not hold. Mount at /api, after requireUser. */
export function moduleGate(req, res, next) {
  const need = needed(req.method, req.path);
  if (!need || need === ANYONE || isMaster(req.user)) return next();
  userModules(req.user).then((have) => (need.some((k) => have.includes(k)) ? next() : res.status(403).json({ error: 'Not allowed' })), next);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mount the gate**

In `server/index.js`, add the import beside the other server imports:

```js
import { moduleGate } from './modules.js';
```

and straight after `app.use('/api', requireUser); // everything below needs a signed-in user`:

```js
app.use('/api', moduleGate); // the leasing and property screens are modules, ticked per person (server/modules.js)
```

- [ ] **Step 6: Trim the sidebar's counts to what the person holds**

In `server/leasingAlerts.js`, add `import { userModules } from './modules.js';` beside the other imports, and replace the `/count` route with:

```js
// For the sidebar's badges: how many of each kind are open, and `count`, how many of them are pressing (not just coming up).
// Counted only for what the person can open: all of it with Alerts, the documents with Documents.
alertRoutes.get('/count', wrap(async (req, res) => {
  const has = await userModules(req.user);
  const all = has.includes('alerts') || has.includes('documents') ? await listAlerts() : [];
  const seen = (rule) => has.includes('alerts') || (rule === 'document' && has.includes('documents'));
  res.json({ count: has.includes('alerts') ? all.filter((a) => a.level !== 'info').length : 0,
    rules: Object.fromEntries(RULES.map((r) => [r, seen(r) ? all.filter((a) => a.rule === r).length : 0])) });
}));
```

- [ ] **Step 7: Add a test for the counts**

Append to `tests/modules.test.js` (add the imports at the top: `import { alertRoutes } from '../server/leasingAlerts.js';`, `import { create, addDocument } from '../server/properties.js';`):

```js
test('the sidebar counts only what the person can open', async () => {
  const { master, sara } = await people();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2020-01-01' }); // long expired: an alert today

  let who = sara;
  const counts = express();
  counts.use((req, res, next) => { req.user = who; next(); });
  counts.use('/api/leasing/alerts', alertRoutes);
  const s = await new Promise((ok) => { const x = counts.listen(0, '127.0.0.1', () => ok(x)); });
  const count = async () => (await fetch(`http://127.0.0.1:${s.address().port}/api/leasing/alerts/count`)).json();
  try {
    assert.deepEqual([(await count()).count, (await count()).rules.document], [0, 0], 'with neither module, nothing');
    await giveModules(sara.id, 'documents');
    assert.deepEqual([(await count()).count, (await count()).rules.document], [0, 1], 'Documents shows its own badge only');
    await giveModules(sara.id, 'alerts');
    assert.equal((await count()).rules.document, 1);
    assert.ok((await count()).count >= 1);
    who = master;
    assert.equal((await count()).rules.document, 1);
  } finally { await new Promise((ok) => s.close(ok)); }
});
```

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 10 tests. If `addDocument` refuses the past date, use a date 10 days after today's instead and keep the assertions.

- [ ] **Step 8: Run the route tests that mount routers themselves**

Run: `npm test -- tests/work-orders-routes.test.js tests/inspections-e2e.test.js tests/document-alerts.test.js`
Expected: PASS. These mount a router without the gate, so they are unchanged.

- [ ] **Step 9: Commit**

```bash
git add server/modules.js server/index.js server/leasingAlerts.js tests/modules.test.js
git commit -m "feat: Modules: the leasing and property routes answer only to people who hold a module that uses them"
```

---

### Task 3: The signed-in person's modules, and the People routes

**Files:**
- Modify: `server/auth.js:48` (`publicUser`) and its three callers
- Modify: `server/admin.js` (imports; two routes after the `saifsys-actions` route, near line 355)
- Test: `tests/modules.test.js` (append)

**Interfaces:**
- Consumes: `userModules`, `listModuleAccess`, `setModuleAccess` from Task 1.
- Produces:
  - `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/reset` → `{ user: { id, name, email, role, modules: string[] } }`
  - `GET /api/admin/users/:id/modules` → `{ master, modules: [{ key, label, on, locked }] }`
  - `PUT /api/admin/users/:id/modules` body `{ modules: string[] }` → `{ ok: true, modules: number }`

- [ ] **Step 1: Write the failing test**

Append to `tests/modules.test.js` (add `import { adminRoutes } from '../server/admin.js';` at the top):

```js
test('only the master ticks modules, over HTTP', async () => {
  const { master, sara } = await people();
  let who = sara;
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = who; next(); });
  a.use('/api/admin', adminRoutes);
  a.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const s = await new Promise((ok) => { const x = a.listen(0, '127.0.0.1', () => ok(x)); });
  const url = `http://127.0.0.1:${s.address().port}/api/admin/users/${sara.id}/modules`;
  const put = (modules) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modules }) });
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await put(['reports'])).status, 403);
    assert.deepEqual(await userModules(sara), ['chats'], 'she cannot tick her own');

    who = master;
    const saved = await put(['reports', 'chats']);
    assert.deepEqual([saved.status, await saved.json()], [200, { ok: true, modules: 1 }]);
    const read = await (await fetch(url)).json();
    assert.deepEqual(read.modules.filter((m) => m.on).map((m) => m.key), ['chats', 'reports']);

    const wrong = await put(['payroll']);
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /Unknown module: payroll/);
  } finally { await new Promise((ok) => s.close(ok)); }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/modules.test.js`
Expected: FAIL. The master's `PUT` answers 404, not 200.

- [ ] **Step 3: Add the routes**

In `server/admin.js` add `import { listModuleAccess, setModuleAccess } from './modules.js';` beside the other imports, and after the `saifsys-actions` route:

```js
// Which of the app's own modules (the left menu) a person has. Chats is everyone's; the master has them all.
adminRoutes.get('/users/:id/modules', wrap(async (req, res) => {
  res.json(await listModuleAccess(req.params.id));
}));

adminRoutes.put('/users/:id/modules', wrap(async (req, res) => {
  res.json({ ok: true, modules: await setModuleAccess(req.params.id, req.body.modules) });
}));
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Carry the modules on the signed-in user**

In `server/auth.js` add `import { userModules } from './modules.js';` and replace `publicUser`:

```js
// `modules` is what the menu is drawn from (server/modules.js); the server checks each request again.
const publicUser = async (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, modules: await userModules(u) });
```

Then await it at its three callers:

- in `/me`: `res.json({ user: user && await publicUser(user) });`
- in `/login`: `res.json({ user: await publicUser(user) });`
- in `/reset`: `res.json({ user: await publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });`

Run: `grep -n "publicUser(" server/auth.js`
Expected: four lines: the definition and three calls, each call preceded by `await`.

- [ ] **Step 6: Run the auth tests**

Run: `npm test -- tests/auth-guards.test.js tests/schema.test.js tests/admin.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/auth.js server/admin.js tests/modules.test.js
git commit -m "feat: Modules: the master ticks a person's modules from People, and the signed-in person is told theirs"
```

---

### Task 4: Riley carries only the held modules' tools

**Files:**
- Modify: `server/leasingKit.js` (above `leasingKit`, near line 669, and the function itself)
- Modify: `server/chat.js:321`
- Test: `tests/modules.test.js` (append)

**Interfaces:**
- Consumes: `userModules(user)` from Task 1.
- Produces: `leasingKit(user, { onChanged, renewals, modules })`. `modules` is the person's module keys; **left out, the kit carries every tool**, which is how the existing tests call it.

- [ ] **Step 1: Write the failing test**

Append to `tests/modules.test.js` (add `import { leasingKit, LEASING_TOOLS } from '../server/leasingKit.js';` and `import { RENEWAL_TOOLS } from '../server/renewals.js';` at the top):

```js
test('Riley carries only the tools of the modules a person holds', async () => {
  const { sara } = await people();
  const names = (modules) => leasingKit(sara, { modules }).definitions.map((d) => d.name).sort();

  assert.deepEqual(names(['chats']), [], 'Chats alone looks nothing up in leasing');
  assert.deepEqual(names(['chats', 'workorders']), ['leasing_add_work_order', 'leasing_update_work_order', 'leasing_work_orders']);
  assert.deepEqual(names(['chats', 'reports']), ['leasing_report', 'leasing_tenant_statement']);
  assert.deepEqual(names(['chats', 'documents']), RENEWAL_TOOLS.map((t) => t.name).sort());
  assert.ok(names(['chats', 'tenants']).includes('leasing_tenant_history'));
  assert.ok(!names(['chats', 'leasing']).includes('leasing_tenant_history'));
  assert.equal(leasingKit(sara).definitions.length, LEASING_TOOLS.length + RENEWAL_TOOLS.length, 'no modules given: everything, as before');
  // Every tool belongs to some module: none is left that nobody could be given.
  const every = names(MODULES.map((m) => m.key));
  assert.equal(every.length, LEASING_TOOLS.length + RENEWAL_TOOLS.length);

  // A tool it does not carry is refused if asked for anyway.
  const kit = leasingKit(sara, { modules: ['chats', 'tenants'] });
  const report = await kit.run({ id: 't', name: 'leasing_report', input: { report: 'rent_roll' } });
  assert.equal(report.is_error, true);
  assert.match(report.content, /does not have that part of the app/);
  // The list tool is shared: it answers for what they hold and refuses the rest.
  const tenants = await kit.run({ id: 't', name: 'leasing_list', input: { what: 'tenants' } });
  assert.notEqual(tenants.is_error, true);
  const leases = await kit.run({ id: 't', name: 'leasing_list', input: { what: 'bookings' } });
  assert.equal(leases.is_error, true);
  assert.match(leases.content, /does not have that part of the app/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/modules.test.js`
Expected: FAIL. `names(['chats'])` is every tool, not `[]`.

- [ ] **Step 3: Give each tool its module**

In `server/leasingKit.js`, above the comment that begins `The leasing tools, in the shape chat.js keeps its toolkits in`, add:

```js
// Which modules a tool belongs to (server/modules.js): holding any one of them is enough.
// It follows the screens: a tool is carried by whoever could do the same thing by hand.
const TOOL_MODULES = {
  leasing_report: ['reports'], leasing_tenant_statement: ['reports'],
  leasing_free_units: ['leasing'], leasing_tenant_history: ['tenants'], leasing_unit_inspections: ['leasing', 'properties'],
  leasing_work_orders: ['workorders'], leasing_list: ['leasing', 'properties', 'tenants', 'sources'],
  leasing_add_company: ['properties'], leasing_add_building: ['properties'], leasing_add_units: ['properties'],
  leasing_add_service: ['leasing', 'properties'], leasing_add_tenant: ['tenants', 'leasing'],
  leasing_add_booking: ['leasing'], leasing_change_booking: ['leasing'], leasing_confirm_booking: ['leasing'], leasing_record_inspection: ['leasing', 'properties'],
  leasing_add_work_order: ['workorders'], leasing_update_work_order: ['workorders'],
  renewal_status: ['documents'], renewal_start: ['documents'], renewal_check_replies: ['documents'], renewal_compare: ['documents'],
};
// leasing_list reads several screens' lists: each kind is whose it is on the screens.
const LIST_MODULES = { companies: ['properties', 'leasing'], buildings: ['properties', 'leasing'], units: ['properties', 'leasing'],
  services: ['leasing', 'properties'], tenants: ['tenants', 'leasing'], sources: ['sources', 'leasing'], bookings: ['leasing'] };
const NOT_THEIRS = 'This person does not have that part of the app. Tell them to ask the master.';
```

- [ ] **Step 4: Filter the kit**

Replace the `leasingKit` function and its comment with:

```js
/**
 * The leasing tools, in the shape chat.js keeps its toolkits in. `user` is who is asking;
 * `onChanged` is told when something was added, so an open screen can show it. `modules`
 * is what they hold: only those tools are carried. Left out, every tool is.
 */
export function leasingKit(user, { onChanged, renewals, modules } = {}) {
  const change = writes(user);
  const renew = renewalTools(user, renewals); // getting a document renewed: server/renewals.js
  const may = (keys = []) => !modules || keys.some((k) => modules.includes(k));
  return {
    definitions: [...LEASING_TOOLS, ...RENEWAL_TOOLS].filter((d) => may(TOOL_MODULES[d.name])),
    status: (name) => STATUS[name] || RENEWAL_STATUS[name] || 'Looking at the leasing records…',
    run: async (block) => {
      try {
        const fn = reads[block.name] || change[block.name] || renew[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        if (!may(TOOL_MODULES[block.name])) throw new Error(NOT_THEIRS);
        if (block.name === 'leasing_list' && LIST_MODULES[block.input?.what] && !may(LIST_MODULES[block.input.what])) throw new Error(NOT_THEIRS);
        const content = await fn(block.input || {});
        if (change[block.name]) onChanged?.();
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 6: Pass the person's modules from the chat**

In `server/chat.js` add `import { userModules } from './modules.js';` beside the other imports. On the line that builds `kits` (it contains `leasingKit(user, { onChanged: () => send('changed', { what: 'leasing' }) })`), add this line just above it:

```js
  const modules = await userModules(user); // Riley looks up only what this person's menu shows
```

and change the call to:

```js
leasingKit(user, { modules, onChanged: () => send('changed', { what: 'leasing' }) })
```

Run: `grep -rn "leasingKit(" server/`
Expected: two lines: the definition in `leasingKit.js` and this one call, which passes `modules`.

- [ ] **Step 7: Run every test that uses the kit**

Run: `npm test -- tests/leasing-extras.test.js tests/leasing-tax.test.js tests/leasing-history.test.js tests/work-orders.test.js tests/renewals.test.js tests/chat-cache.test.js`
Expected: PASS. They call `leasingKit` without `modules`, so they carry everything as before.

- [ ] **Step 8: Commit**

```bash
git add server/leasingKit.js server/chat.js tests/modules.test.js
git commit -m "feat: Modules: Riley looks up and changes only what is in a person's modules"
```

---

### Task 5: Pushes go only to people who hold the module

**Files:**
- Modify: `server/leasingAlerts.js` (`runAlerts`, near line 204)
- Modify: `server/workOrders.js` (`tellUrgent`, near line 92)
- Modify: `tests/work-orders.test.js`, `tests/document-alerts.test.js`, `tests/leasing-money.test.js`, `tests/leasing-reports.test.js`
- Test: `tests/modules.test.js` (append)

**Interfaces:**
- Consumes: `holders(key)` from Task 1; `giveModules` from Task 1.
- Produces: no new names. `runAlerts` returns, and pushes to, only holders of `alerts`; an urgent work order pushes only to holders of `workorders`.

- [ ] **Step 1: Write the failing test**

Append to `tests/modules.test.js` (add at the top: `import { runAlerts } from '../server/leasingAlerts.js';`, `import { createWorkOrder } from '../server/workOrders.js';`, and widen the properties import to `import { create, addDocument, setBuildingStaff } from '../server/properties.js';`):

```js
test('a building’s staff are buzzed only about modules they hold', async () => {
  const { master, sara } = await people();
  const omar = await makeUser('Omar');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await setBuildingStaff(b.id, [sara.id, omar]);
  await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2027-01-08' }); // its window opens on 2026-10-10

  // Neither has Alerts: only the master hears, and nothing breaks for the two who do not.
  assert.deepEqual((await runAlerts('2026-10-10', 9)).map((n) => n.user_id), [master.id]);
  // Ticked later, she is told of what she has never been told.
  await giveModules(sara.id, 'alerts');
  assert.deepEqual((await runAlerts('2026-10-10', 10)).map((n) => n.user_id), [sara.id]);

  const sent = [];
  const push = async (to) => { sent.push([...to].sort((x, y) => x - y)); };
  await createWorkOrder({ unit_id: u.id, detail: 'Water through the ceiling', priority: 'urgent' }, master.id, '2026-10-10', { push });
  assert.deepEqual(sent, [], 'neither has Work orders, and the master raised it');
  await giveModules(omar, 'workorders');
  await createWorkOrder({ unit_id: u.id, detail: 'Sparks from a socket', priority: 'urgent' }, master.id, '2026-10-10', { push });
  assert.deepEqual(sent, [[omar]]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/modules.test.js`
Expected: FAIL. The first `runAlerts` also returns Sara and Omar.

- [ ] **Step 3: Leasing alerts**

In `server/leasingAlerts.js` widen the import to `import { userModules, holders } from './modules.js';`. In `runAlerts`, straight after the line `const masters = (await db.prepare("SELECT id FROM users WHERE role = 'master'").all()).map((u) => u.id);` add:

```js
  const may = await holders('alerts'); // a notice opens the Alerts screen, so it goes only to people who have it
```

and change the loop's recipients from

```js
    for (const userId of new Set([a.owner, ...a.staff, ...masters].filter(Boolean))) {
```

to

```js
    for (const userId of new Set([a.owner, ...a.staff, ...masters].filter((id) => id && may.has(id)))) {
```

- [ ] **Step 4: Urgent work orders**

In `server/workOrders.js` add `import { holders } from './modules.js';` beside the other imports. In `tellUrgent`, replace

```js
  const to = people.map((p) => p.id).filter((id) => id !== by);
```

with

```js
  const may = await holders('workorders'); // it opens Work orders, so it goes only to people who have it
  const to = people.map((p) => p.id).filter((id) => id !== by && may.has(id));
```

- [ ] **Step 5: Run the new test to see it pass**

Run: `npm test -- tests/modules.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 6: Tick the modules for staff in the older tests**

These tests were written when a building's staff were buzzed with no tick. Give the staff the module, so each still tests what it was written to test.

`tests/document-alerts.test.js`: add `giveModules` to the `./helpers/db.js` import, and in `tower()` after `await setBuildingStaff(b.id, [staff]);` add:

```js
  await giveModules(staff, 'alerts');
```

`tests/work-orders.test.js`: add `giveModules` to the `./helpers/db.js` import. In the test `a new urgent work order buzzes the building’s staff and the master, not the one who raised it`, after `await setBuildingStaff(building.id, [keeper, staff]);` add:

```js
  await giveModules(keeper, 'workorders');
  await giveModules(staff, 'workorders');
```

In the test `a work order past its scheduled day is an alert, once a day, until it is done`, after `await setBuildingStaff(building.id, [keeper]);` add:

```js
  await giveModules(keeper, 'alerts');
  await giveModules(staff, 'alerts');
```

- [ ] **Step 7: Find and fix the rest**

Run: `npm test -- tests/work-orders.test.js tests/document-alerts.test.js tests/leasing-money.test.js tests/leasing-reports.test.js`

For each test that still fails because a person who is not the master is missing from what `runAlerts` returned: in that test's fixture, straight after that person is made with `makeUser`, add `await giveModules(<their id>, 'alerts');` and add `giveModules` to the file's `./helpers/db.js` import. Change no assertion. If a failure is anything other than a missing non-master recipient, stop and report it.

Run the four files again.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/leasingAlerts.js server/workOrders.js tests/modules.test.js tests/work-orders.test.js tests/document-alerts.test.js tests/leasing-money.test.js tests/leasing-reports.test.js
git commit -m "feat: Modules: a leasing alert or an urgent work order buzzes only people who can open it"
```

---

### Task 6: The menu, the start screen and the Tour follow the modules

**Files:**
- Create: `client/src/lib/modules.js`
- Modify: `client/src/App.jsx` (imports; after the `loadRegion` effect near line 91)
- Modify: `client/src/components/Sidebar.jsx:49-66` (`places`)
- Modify: `client/src/components/Tour3D.jsx:79` and `:97-102`

**Interfaces:**
- Consumes: `me.modules: string[]` from Task 3.
- Produces (from `client/src/lib/modules.js`):
  - `setModules(list: string[] | undefined): void`
  - `can(key: string): boolean`
  - `moduleOf(panel: string | null, leasingTab: string): string | null`

- [ ] **Step 1: Write the store**

Create `client/src/lib/modules.js`:

```js
// The modules the signed-in person holds (server/modules.js): one per place in the left
// menu. Set once from /auth/me and read wherever a screen, or a button into one, is
// offered. The server checks every request again; this only keeps what would be refused
// from being offered.
let held = new Set();

export const setModules = (list) => { held = new Set(list || []); };
export const can = (key) => held.has(key);

// Which module each section of the Leasing page belongs to. Its three ways in are one module.
const TAB = { overview: 'overview', bookings: 'leasing', '3d': 'leasing', calendar: 'leasing', tenants: 'tenants',
  workorders: 'workorders', reports: 'reports', alerts: 'alerts', documents: 'documents' };

/** The module the open screen belongs to, or null when it is one everybody has. */
export const moduleOf = (panel, leasingTab) => (panel === 'leasing' ? TAB[leasingTab] || 'overview'
  : panel === 'properties' || panel === 'sources' ? panel : null);
```

- [ ] **Step 2: Keep it in step with who is signed in, start staff on the chat, and guard every screen**

In `client/src/App.jsx` add the import after the `region` import:

```js
import { setModules, can, moduleOf } from './lib/modules';
```

Inside `App`, on the line straight above `if (me === undefined) return null;`, add:

```js
  setModules(me?.modules); // before anything below is drawn, so every `can` in this render is today's
```

Straight after the effect that calls `loadRegion()`, add:

```js
  // Staff start on the chat, the one screen everyone has; the master starts on the Overview.
  // A notification that asked for a screen is still followed.
  useEffect(() => { if (me && me.role !== 'master') setPanel((p) => (p === 'leasing' && !notifiedLeasing ? null : p)); }, [me?.id]);
  // Whatever asked for a screen (a link, a notification, a button, a voice command): one
  // the person does not hold is not opened, and they are left on the chat.
  useEffect(() => {
    if (!me) return;
    const need = moduleOf(panel, leasingTab);
    if (need && !me.modules?.includes(need)) setPanel(null);
    if (tour && !me.modules?.includes('tour')) setTour(false);
  }, [me, panel, leasingTab, tour]);
```

- [ ] **Step 3: Draw the menu from the modules**

In `client/src/components/Sidebar.jsx` add the import after the other `lib` imports:

```js
import { can } from '../lib/modules';
```

Give each entry of `places` its module and filter by it. Add `module: '<key>'` as the first property of each object, with these keys in order: `tour` (3D Navigation), `overview`, `chats`, `leasing`, `tenants`, `workorders`, `reports`, `alerts`, `documents`, `properties`, `sources`. Leave the Region entry without one. For example the first two become:

```js
    { module: 'tour', Ico: Compass, color: 'from-fuchsia-400 to-violet-600 shadow-fuchsia-500/30', label: '3D Navigation', hint: 'Walk the whole app in 3D', here: tourOpen, onClick: onTour },
    { module: 'overview', Ico: LayoutDashboard, color: 'amber', label: 'Overview', hint: 'Occupancy, rent and what needs attention', here: leasingOpen && leasingTab === 'overview', onClick: () => onLeasing('overview') },
```

and change the closing `].filter(Boolean);` to:

```js
    // A place is shown to whoever holds its module (ticked on their People profile). Region has none: it is the master's.
  ].filter((p) => p && (!p.module || can(p.module)));
```

Run: `grep -c "module: '" client/src/components/Sidebar.jsx`
Expected: `11`.

- [ ] **Step 4: The Tour shows only held stops, and asks only for their figures**

In `client/src/components/Tour3D.jsx` add `import { can } from '../lib/modules';` beside the other `lib` imports. Replace

```js
  const stops = useMemo(() => STOPS.filter((s) => !s.master || user.role === 'master'), [user.role]);
```

with

```js
  // The master's stops, and for everyone else the stops of the modules they hold: a stop's id is its module.
  const stops = useMemo(() => STOPS.filter((s) => (s.master ? user.role === 'master' : can(s.id))), [user.role, user.modules]);
```

and replace the three reads inside the `useEffect` that begins `if (inside) return;` with:

```js
    // Each figure is asked for only by someone the server would answer.
    if (can('overview') || can('leasing')) api.get('/leasing/overview?company_id=&building_id=&months=1').then(setD).catch(() => {});
    if (can('alerts') || can('documents')) api.get('/leasing/alerts/count').then(setAlerts).catch(() => {});
    if (can('workorders') || can('leasing')) api.get('/leasing/work-orders?status=active').then((r) => setRepairs(r.work_orders.filter((w) => LIVE.includes(w.status)))).catch(() => {});
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: the build finishes with no error.

- [ ] **Step 6: Check it by hand**

Run the app (`npm run dev`), and with the test database:

1. Signed in as the master: the menu is unchanged, and the app opens on the Overview.
2. Create a person on People. Sign in as them in a private window: the app opens on the chat, and the menu shows Chats and nothing else of the eleven places.
3. As the master, run in the database: `INSERT INTO module_access (user_id, module) VALUES (<their id>, 'workorders'), (<their id>, 'tour');` Reload their window: Work orders and 3D Navigation appear; the Tour shows the Chats and Work orders stops only.

Expected: all three as described. Report exactly what was seen if any differs.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/modules.js client/src/App.jsx client/src/components/Sidebar.jsx client/src/components/Tour3D.jsx
git commit -m "feat: Modules: the left menu and the Tour show a person only their modules, and staff start on the chat"
```

---

### Task 7: Buttons into a module not held are not shown

**Files:**
- Modify: `client/src/components/Leasing.jsx` (`BookingCard` near line 572; `LeasingPage` near lines 1011-1019 and 1072-1097)
- Modify: `client/src/components/Building3D.jsx:327`
- Modify: `client/src/components/TenantHistory.jsx:190-191` and `:230`

**Interfaces:**
- Consumes: `can(key)` from `client/src/lib/modules.js` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: The Leasing page**

In `client/src/components/Leasing.jsx` add `import { can } from '../lib/modules';` beside the other `lib` imports.

In `BookingCard`, change

```js
    b.status === 'confirmed' && [Wrench, 'Work orders', onWork, 'Repairs raised for this tenant during the lease'],
```

to

```js
    b.status === 'confirmed' && can('workorders') && [Wrench, 'Work orders', onWork, 'Repairs raised for this tenant during the lease'],
```

In `LeasingPage`, replace `openBooking`, `pay` and `openAlert` with:

```js
  // A lease is opened only by someone who has Leasing; from the other screens the way in is simply not offered.
  const openBooking = (id, as) => api.get(`/leasing/bookings/${id}`).then((b) => setForm(as ? { [as]: b } : b)).catch(() => {});
  const pay = can('leasing') ? (id) => openBooking(id, 'payOf') : undefined;
  // An alert opens the screen that deals with it, when the person has that screen.
  const openAlert = (a) => {
    if (!can({ documents: 'documents', tenants: 'tenants', workorder: 'workorders' }[a.open] || 'leasing')) return;
    if (a.open === 'documents') { setDocOpen(a.document_id); setRenewalOpen(a.renewal_id || null); setTab('documents'); return; }
    if (a.open === 'tenants') { setTab('tenants'); return; }
    if (a.open === 'workorder') { setForm({ workOf: { openId: a.work_order_id } }); return; }
    openBooking(a.booking_id, { pay: 'payOf', docs: 'docsOf' }[a.open]);
  };
```

Change the `add` button's line to:

```js
  const add = can('leasing') && <button onClick={() => setForm({ preset: null })} className={PRIMARY}><Plus size={16} /> New lease</button>;
```

and the last line of the function to:

```js
  return <Page title="Overview" onBack={onBack} action={add}><LeasingOverview key={key} onPay={pay} onAlerts={(k) => { if (!can('alerts')) return; onAlert(k); setTab('alerts'); }} /></Page>;
```

`LeasingReports`, `LeasingOverview` and `TenantHistory` are already passed `pay`; `LeasingReports` and `LeasingOverview` already draw no link when `onPay` is missing. Check `Page` draws nothing for `action={false}`:

Run: `grep -n "action" client/src/components/Leasing.jsx | head -5`
Expected: `Page` renders `{action}`, which draws nothing for `false`. If it wraps it in an element unconditionally, change that to `{action && …}`.

Also in `LeasingPage`, the `Building3D` line already passes `onPay={pay}`; with `pay` now possibly undefined it is reached only by someone holding Leasing, where it is defined. No change.

- [ ] **Step 2: The 3D view**

In `client/src/components/Building3D.jsx` add `import { can } from '../lib/modules';` and change

```js
            <button onClick={() => onWork(unit)} className={toggle(false)}><Wrench size={14} /> Work orders</button>
```

to

```js
            {can('workorders') && <button onClick={() => onWork(unit)} className={toggle(false)}><Wrench size={14} /> Work orders</button>}
```

- [ ] **Step 3: A tenant's history**

In `client/src/components/TenantHistory.jsx` add `import { can } from '../lib/modules';`. In `Item`, change

```js
          {late ? open && <button onClick={() => onPay(i.booking_id)} className={GHOST}><Banknote size={14} /> Payments</button>
            : order ? <button onClick={() => onWork(i)} className={GHOST}>Open <ChevronRight size={14} /></button> : (
```

to

```js
          {late ? open && onPay && <button onClick={() => onPay(i.booking_id)} className={GHOST}><Banknote size={14} /> Payments</button>
            : order ? can('workorders') && <button onClick={() => onWork(i)} className={GHOST}>Open <ChevronRight size={14} /></button> : (
```

and wrap the "Add maintenance" button (the one whose `onClick` is `() => onWorkOrder({ ...mine, startNew: true })`) so it reads:

```js
        {can('workorders') && <button onClick={() => onWorkOrder({ ...mine, startNew: true })} className={OUTLINE} title={h?.current ? `A work order for unit ${h.current.unit_no}, ${h.current.building}` : 'A work order'}><Plus size={16} /> <span className="hidden sm:inline">Add </span>maintenance</button>}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: the build finishes with no error.

- [ ] **Step 5: Check it by hand**

With a person who holds Tenants only (`INSERT INTO module_access … 'tenants'`): open a tenant's history. Expected: no "Add maintenance", no "Open" on a maintenance line, no "Payments" on a late-rent line; the history itself reads normally. With a person who holds Leasing only: a confirmed lease's card has no "Work orders" action; the 3D view opens and a unit's card has no "Work orders" button.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Leasing.jsx client/src/components/Building3D.jsx client/src/components/TenantHistory.jsx
git commit -m "feat: Modules: a button that leads into a module the person does not hold is not shown"
```

---

### Task 8: The Modules tab on a person's profile

**Files:**
- Modify: `client/src/components/Admin.jsx` (`PersonDetail`'s `TABS` near line 218, its body near line 275; a new `AppModules` component above `SaifsysModules`, near line 349)

**Interfaces:**
- Consumes: `GET` / `PUT /api/admin/users/:id/modules` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Add the tab**

In `PersonDetail`, change `TABS` to:

```js
  const TABS = [['agents', 'Agents'], ['modules', 'Modules'], ['duties', 'Responsibilities'], ['documents', 'Shelf'], ['conversations', 'AI chats'],
    ['messages', 'Team chat'], ['memory', 'Memory'], ['saifsys', 'saifsys']];
```

and under the line `{tab === 'memory' && <Memories person={person} />}` add:

```js
        {tab === 'modules' && <AppModules key={person.id} person={person} />}
```

- [ ] **Step 2: Add the component**

Above the comment block that introduces `SaifsysModules`, add:

```js
/**
 * Which places in the left menu this person has. A tap saves straight away, as the
 * saifsys modules do: it is one switch per place, with nothing to review first. Chats is
 * everyone's, so it is shown ticked and cannot be tapped.
 */
function AppModules({ person }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/admin/users/${person.id}/modules`).then(setData).catch((e) => { setError(e.message); setData({ modules: [] }); });
  }, [person.id]);

  const toggle = async (key) => {
    const modules = data.modules.map((m) => (m.key === key ? { ...m, on: !m.on } : m));
    setData({ ...data, modules });
    setError('');
    try {
      await api.put(`/admin/users/${person.id}/modules`, { modules: modules.filter((m) => m.on).map((m) => m.key) });
    } catch (e) {
      setError(e.message);
      setData(data); // put the switch back
    }
  };

  if (!data) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <>
      <p className="text-sm leading-relaxed text-mute">
        {data.master
          ? 'The master has every module.'
          : `Tick what ${person.name} sees in the left menu. Anything not ticked is hidden from them, and Riley cannot look it up for them. Everyone has Chats.`}
      </p>
      <div className="grid items-start gap-2 @md:grid-cols-2">
        {data.modules.map((m) => {
          const fixed = data.master || m.locked;
          return (
            <button key={m.key} onClick={() => !fixed && toggle(m.key)} disabled={fixed} aria-pressed={m.on}
              className={`flex w-full items-center gap-3 rounded-[1.25rem] border p-3 text-left transition ${
                m.on ? 'border-p1/50 bg-gradient-to-r from-p1/20 via-p1/[0.07] to-transparent' : 'border-stroke bg-white/[0.035] hover:bg-white/[0.07]'}`}>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm font-medium ${m.on ? 'text-txt' : 'text-mute'}`}>{m.label}</span>
                {m.locked && <span className="block truncate text-xs text-mute">Everyone has this</span>}
              </span>
              <span className={`grid size-[18px] shrink-0 place-items-center rounded-full ${
                m.on ? 'bg-gradient-to-br from-p1 to-p2 text-white' : 'border border-white/15 bg-white/[0.04]'}`}>
                {m.on && <Check size={11} strokeWidth={3.5} />}
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
    </>
  );
}
```

`Loader2`, `Check`, `useState`, `useEffect` and `api` are already imported in this file.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: the build finishes with no error.

- [ ] **Step 4: Check it by hand**

As the master: People → a person → Modules. Expected: eleven cards in the menu's order, Chats ticked with "Everyone has this" and not tappable. Tick Work orders and Reports; reload the page: both are still ticked. Open the master's own profile → Modules: every card ticked, none tappable, and the line reads "The master has every module." In the person's own window, reload: Work orders and Reports are in their menu.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Admin.jsx
git commit -m "feat: People: a Modules tab on each person's profile, where the master ticks which places in the left menu they get"
```

---

### Task 9: The whole thing together

**Files:** none changed unless something fails.

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: every file passes except `tests/drawing.test.js` on Windows.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no error.

- [ ] **Step 3: Walk through it as a new member of staff**

With the test database and `npm run dev`:

1. As the master, create "Reception" on People. Tick nothing.
2. As Reception: the app opens on the chat. The menu shows Chats only. Ask Riley "what is the rent roll?": Riley has no tool for it and says it cannot look that up.
3. In Reception's browser console run `fetch('/api/leasing/bookings').then(r => r.status).then(console.log)`: prints `403`.
4. As the master, tick Work orders for Reception. As Reception, reload: Work orders is in the menu and opens; raise a work order. Ask Riley "what work orders are open?": it answers.
5. Turn Voice control on as Reception and say "open reports": nothing opens, because Reports is not on the screen to be pressed.
6. As the master, untick Work orders. As Reception, without reloading, tap a work order: it is refused. Reload: the menu shows Chats only again.

Expected: all six as described. Report any that differ, with what was seen.

- [ ] **Step 4: Stop**

Do not push and do not deploy. Tell Francis it is ready on `leasing-bookings`, with the result of Step 3.
