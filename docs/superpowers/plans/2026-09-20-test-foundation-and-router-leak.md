# Test Foundation and Router Leak Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a test harness for this codebase, then fix the two defects
recorded in §10 of the spec — a cross-user document leak in the agent router, and the
blank screen a user sees when they have no agents.

**Architecture:** Tests run on Node's built-in runner (`node --test`) against a real
throwaway Postgres database, because every defect here lives in SQL scoping and a
mock would prove nothing. `server/db.js` connects and runs its DDL at import time, so
the harness sets `DATABASE_URL` before importing it. `process.loadEnvFile` does not
override variables already present in the environment (verified on Node v24.15.0), so
`config.js` needs no changes.

**Tech Stack:** Node 22.13+ (`node:test`, `node:assert/strict`), Postgres 16 with
pgvector, Express 5, React 19 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-20-master-role-and-shelves-design.md](../specs/2026-09-20-master-role-and-shelves-design.md)

## Global Constraints

- Node `>=22.13` (`package.json` engines). Use built-ins; do not add test dependencies.
- The project is ESM (`"type": "module"`). No `require`.
- `db.prepare()` uses SQLite-style `?` placeholders, rewritten to `$1, $2…` by
  `compile()` in `server/db.js`. **Placeholders are numbered left to right across the
  whole statement** — adding one early shifts every later parameter.
- Timestamps are unix seconds via `extract(epoch from now())::bigint`, not `timestamptz`.
- The test database is **separate from development and production**. Every test
  truncates. Never point `TEST_DATABASE_URL` at a database with real data.
- This plan is scoped to Plan 1 of 3. It must not introduce roles, assignments or
  sharing — those are Plans 2 and 3.

---

### Task 1: Test harness

**Files:**
- Create: `tests/helpers/db.js`
- Modify: `package.json:5-12` (scripts)
- Modify: `README.md` (a "Running the tests" section)
- Test: `tests/helpers/harness.test.js`

**Interfaces:**
- Consumes: `server/db.js` — `db`, `tx`, `closeDb`
- Produces:
  - `reset(): Promise<void>` — truncates every table, restarts identities
  - `makeUser(name?: string): Promise<number>` — returns the new user id
  - `makeAgent(userId: number, name: string): Promise<number>` — returns the agent id
  - `makeDoc(userId: number, agentId: number|null, name: string): Promise<number>`
  - re-exports `db`, `closeDb`

**Why a real database:** the bug in Task 2 is a missing `WHERE` clause. A mocked
`db.prepare` would happily return whatever the test told it to and prove nothing.

- [ ] **Step 1: Create the test database**

Local Postgres:

```bash
createdb jarvis_test
psql -d jarvis_test -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

If `CREATE EXTENSION` fails with a permissions error, it needs a superuser — the same
situation `server/db.js:79` documents:

```bash
sudo -u postgres psql -d jarvis_test -c 'CREATE EXTENSION vector;'
```

The schema itself is created automatically: `server/db.js` runs `CREATE TABLE IF NOT
EXISTS` for everything at import time, so the first test run populates an empty
database.

- [ ] **Step 2: Write the harness helper**

Create `tests/helpers/db.js`:

```js
// Import this FIRST in every test file. server/db.js opens a pool and runs its DDL
// at import time, so DATABASE_URL has to be set before that module is loaded.
// process.loadEnvFile() in config.js does not override variables already in the
// environment, so this wins over the project's .env without touching config.js.
import { randomBytes } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Create a throwaway database and point at it:\n' +
    '  createdb jarvis_test && psql -d jarvis_test -c "CREATE EXTENSION vector;"\n' +
    '  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test'
  );
}

// reset() TRUNCATEs every table. Against the production database that is
// unrecoverable, so refuse to run unless the database is named like a test one.
// Checking the name rather than comparing against DATABASE_URL is deliberate: the
// project's .env has not been loaded at this point, so DATABASE_URL may still be
// unset here and a comparison would silently pass.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  throw new Error(
    `Refusing to run: the test database must be named with a "_test" suffix (got "${dbName}").\n` +
    'Every test truncates every table.'
  );
}
process.env.DATABASE_URL = url;

const { db, tx, closeDb } = await import('../../server/db.js');
export { db, tx, closeDb };

const TABLES = [
  'users', 'sessions', 'password_resets', 'agents', 'conversations', 'messages',
  'documents', 'chunks', 'memories', 'outlook_accounts', 'imap_accounts',
];

/** Empty every table and restart the id sequences, so ids are predictable per test. */
export async function reset() {
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function makeUser(name = 'Test') {
  const email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const { id } = await db
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
    .run(email, name, 'not-a-real-hash');
  return id;
}

export async function makeAgent(userId, name) {
  const { id } = await db
    .prepare('INSERT INTO agents (user_id, name, persona) VALUES (?, ?, ?) RETURNING id')
    .run(userId, name, `You are ${name}.`);
  return id;
}

/** agentId null = the shared library. */
export async function makeDoc(userId, agentId, name) {
  const { id } = await db
    .prepare(`INSERT INTO documents (user_id, agent_id, name, title, status)
              VALUES (?, ?, ?, ?, 'ready') RETURNING id`)
    .run(userId, agentId, name, name);
  return id;
}
```

- [ ] **Step 3: Write a test that proves the harness works**

Create `tests/helpers/harness.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, makeDoc, closeDb } from './db.js';

test.after(() => closeDb());

test('reset() empties the database and restarts ids', async () => {
  await reset();
  const first = await makeUser('Alice');
  await reset();
  const second = await makeUser('Bob');
  assert.equal(first, second, 'ids should restart from 1 after a reset');

  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM users').get();
  assert.equal(n, 1, 'only the user created after the reset should remain');
});

test('the factories link rows together', async () => {
  await reset();
  const userId = await makeUser('Alice');
  const agentId = await makeAgent(userId, 'Lawyer');
  const docId = await makeDoc(userId, agentId, 'tenancy.pdf');

  const doc = await db.prepare('SELECT user_id, agent_id, name FROM documents WHERE id = ?').get(docId);
  assert.deepEqual(doc, { user_id: userId, agent_id: agentId, name: 'tenancy.pdf' });
});
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `"scripts"` after `"start"`:

```json
"test": "node --test --test-force-exit",
```

No path argument: Node 22 (which the droplet runs) rejects `node --test tests/` with
`Cannot find module '/var/www/jarvis/tests'`, while Node 24 accepts it. With no path
the runner auto-discovers from the working directory, which works on both and skips
`node_modules` by default.

The runner only treats files matching `*.test.js` (and similar) as tests, so
`tests/helpers/db.js` is loaded as a plain module, not executed as a suite.

`--test-force-exit` is needed because of a side effect in `server/ai.js:60`: it calls
`embedder()` at import time to warm the local embedding model. `tests/router.test.js`
imports `server/router.js`, which imports `ai.js`, so that warm-up starts on every
test run. It is wrapped in `.catch()` so it cannot fail the suite, but a pending model
load is an open handle and the runner would otherwise sit waiting for it after the
last assertion.

- [ ] **Step 5: Run the tests**

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

Expected: `# pass 2`, `# fail 0`.

If it fails with `The "vector" extension is required…`, go back to Step 1 and install
the extension as a superuser.

- [ ] **Step 6: Document it in the README**

Add a section after the existing setup instructions:

````markdown
## Running the tests

Tests run against a real throwaway Postgres database — the things they check are SQL
scoping rules, which a mock cannot verify.

```bash
createdb jarvis_test
psql -d jarvis_test -c 'CREATE EXTENSION vector;'   # may need: sudo -u postgres psql -d jarvis_test -c 'CREATE EXTENSION vector;'

TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

The schema is created automatically on the first run. Every test truncates the
database, so never point `TEST_DATABASE_URL` at development or production data.
````

- [ ] **Step 7: Commit**

```bash
git add tests/ package.json README.md
git commit -m "test: add a test harness backed by a throwaway Postgres database"
```

---

### Task 2: Fix the cross-user document leak in the router

**Files:**
- Modify: `server/router.js:18-32`
- Modify: `server/chat.js:112`
- Test: `tests/router.test.js`

**Interfaces:**
- Consumes: `tests/helpers/db.js` — `reset`, `makeUser`, `makeAgent`, `makeDoc`, `closeDb`
- Produces:
  - `teamDocuments(userId: number, agentIds: number[]): Promise<{agent_id: number, name: string}[]>`
    — newly exported from `server/router.js`
  - `pickAgent({ agents, userId, text, attachments, recent, currentAgentId })` — gains
    a required `userId`

**The defect.** `server/router.js:27`:

```js
const docs = await db.prepare('SELECT agent_id, name FROM documents WHERE agent_id IN (' + agents.map(() => '?').join(',') + ')')
  .all(...agents.map((a) => a.id));
```

There is no `user_id` filter. Today the agent ids always come from the caller's own
agents, so nothing leaks. The moment an agent is shared between users — Plan 2 — every
document filed against that agent by *any* user is pulled in, and its filename is
written into the router prompt at `router.js:31`. Fixing it before sharing exists
means the leak never ships.

**Why extract a function.** `pickAgent` calls `ask()`, which hits the Anthropic API.
Pulling the query into `teamDocuments` makes the security-critical part testable with
no network and no API key. It also short-circuits at `router.js:25` when there is only
one agent, so a test must use two agents to reach the query at all.

- [ ] **Step 1: Write the failing test**

Create `tests/router.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, makeAgent, makeDoc, closeDb } from './helpers/db.js';
import { teamDocuments } from '../server/router.js';

test.after(() => closeDb());

test('teamDocuments returns the caller\'s own documents', async () => {
  await reset();
  const alice = await makeUser('Alice');
  const lawyer = await makeAgent(alice, 'Lawyer');
  const hr = await makeAgent(alice, 'HR');
  await makeDoc(alice, lawyer, 'alice-tenancy.pdf');

  const docs = await teamDocuments(alice, [lawyer, hr]);
  assert.deepEqual(docs.map((d) => d.name), ['alice-tenancy.pdf']);
});

test('teamDocuments never returns another user\'s documents on a shared agent', async () => {
  await reset();
  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');
  const shared = await makeAgent(alice, 'Lawyer'); // Plan 2 lets Bob use this same agent
  const other = await makeAgent(alice, 'HR');

  await makeDoc(alice, shared, 'alice-tenancy.pdf');
  await makeDoc(bob, shared, 'bob-divorce-papers.pdf');

  const docs = await teamDocuments(alice, [shared, other]);
  const names = docs.map((d) => d.name);
  assert.ok(!names.includes('bob-divorce-papers.pdf'), `leaked another user's file: ${names.join(', ')}`);
  assert.deepEqual(names, ['alice-tenancy.pdf']);
});

test('teamDocuments handles an empty agent list without building invalid SQL', async () => {
  await reset();
  const alice = await makeUser('Alice');
  assert.deepEqual(await teamDocuments(alice, []), []);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

Expected: all three fail with `SyntaxError: The requested module '../server/router.js'
does not provide an export named 'teamDocuments'`.

- [ ] **Step 3: Extract and fix the query**

In `server/router.js`, add above `pickAgent`:

```js
/**
 * Filenames for the router prompt, so it can tell what each agent already holds.
 * Scoped to the calling user: an agent may be shared between users, but one user's
 * documents must never appear in another user's routing prompt.
 */
export async function teamDocuments(userId, agentIds) {
  if (!agentIds.length) return [];
  return db.prepare(`SELECT agent_id, name FROM documents
    WHERE user_id = ? AND agent_id IN (${agentIds.map(() => '?').join(',')})`)
    .all(userId, ...agentIds);
}
```

The `userId` placeholder comes first because `compile()` in `server/db.js` numbers
`?` left to right — `userId` must be the first argument to `.all()` to match.

- [ ] **Step 4: Use it from `pickAgent`**

Change the signature at `server/router.js:18` to accept `userId`:

```js
export async function pickAgent({ agents, userId, text, attachments = [], recent, currentAgentId }) {
```

and replace lines 27-28 with:

```js
  const docs = await teamDocuments(userId, agents.map((a) => a.id));
```

- [ ] **Step 5: Pass `userId` from the caller**

`server/chat.js:112` — `pickAgent` has exactly one caller:

```js
  const { agent, why } = await pickAgent({ agents: team, userId: user.id, text, attachments: meta, recent: prior, currentAgentId });
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 7: Verify the running app still routes**

```bash
npm run dev
```

Sign in, make sure you have at least two agents, and send a message that should reach a
specific one. Confirm the "Choosing the best agent…" status resolves and the reply is
attributed to a sensible agent. This exercises the `ask()` path the unit tests skip.

- [ ] **Step 8: Commit**

```bash
git add server/router.js server/chat.js tests/router.test.js
git commit -m "fix: scope the router's document lookup to the calling user

The query behind the routing prompt filtered on agent_id alone. Agents are
per-user today so nothing leaked, but once an agent is shared between users
every document filed against it would be listed in every assigned user's
routing prompt. Extracted as teamDocuments() so the scoping is testable
without calling the model."
```

---

### Task 3: Empty state for a user with no agents

**Files:**
- Modify: `client/src/App.jsx:71-77`
- Modify: `server/chat.js:89`

**Interfaces:**
- Consumes: `agents` from `App.jsx:19`, `onEditAgent` already wired at `App.jsx:66`
- Produces: nothing other tasks depend on

**The defect.** `client/src/App.jsx:72` gates the whole chat pane on `agents.length >
0`. A user with no agents sees an empty dark panel with no text and no way forward.

**Correcting the record:** this is *not* a crash. `server/chat.js:89` returns a 400
before `pickAgent` runs, and that is `pickAgent`'s only caller, so `agents[0]` is never
`undefined`. The spec's §10 item 2 has been corrected to say so.

**On testing:** the client has no test runner and no jsdom — adding a React testing
stack to cover one conditional branch is disproportionate to the change. This task is
verified manually with the exact steps below. Task 2 carries the automated coverage.

- [ ] **Step 1: Add the empty state**

In `client/src/App.jsx`, replace lines 72-75:

```jsx
        {agents.length > 0 ? (
          <Chat key={chat.key} user={me} agents={agents} folders={config.folders} conversationId={chat.id} voiceEnabled={config.voice}
            onConversation={onConversation} onMenu={() => setDrawer(true)} onNewChat={() => openChat(null)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-lg font-medium">No agents yet</p>
            <p className="max-w-sm text-sm text-mute">
              You need at least one agent before you can start a conversation.
            </p>
            <button onClick={() => setEditing({})}
              className="mt-2 rounded-full bg-violet-600 px-5 py-2 text-sm font-medium hover:bg-violet-500">
              Create an agent
            </button>
          </div>
        )}
```

`setEditing({})` opens `AgentSheet` in create mode — the same call the sidebar's "New
agent" button makes at `Sidebar.jsx:71`.

> **Plan 2 will change this copy.** Once agent creation is master-only, a normal user
> cannot follow this advice; the button is replaced with "Your administrator hasn't
> assigned you an agent yet." Leave it as written for now — it is correct for the app
> as it currently behaves.

- [ ] **Step 2: Check the class names exist**

`text-mute` is used throughout (e.g. `Chat.jsx:143`). Confirm `violet-600` resolves in
this Tailwind 4 setup:

```bash
grep -rn "violet-6\|violet-5" client/src/ | head
```

If it does not appear anywhere, substitute a colour that is already in use rather than
inventing one.

- [ ] **Step 3: Verify manually**

```bash
npm run dev
```

1. Sign in.
2. In `psql` against your **development** database, hide your agents:
   ```sql
   UPDATE agents SET user_id = -1 WHERE user_id = <your id>;
   ```
3. Reload. Expect "No agents yet" with a working **Create an agent** button, not a
   blank panel.
4. Click it, create an agent, confirm the chat pane appears.
5. Restore:
   ```sql
   UPDATE agents SET user_id = <your id> WHERE user_id = -1;
   ```

- [ ] **Step 4: Fix the server's message**

`server/chat.js:89` currently answers `'Create an agent first'`. That stays accurate
for now, but the message should not assert a capability the user may not have. Change
it to state the condition rather than the remedy:

```js
  if (!team.length) return res.status(400).json({ error: 'You have no agents yet' });
```

- [ ] **Step 5: Commit**

```bash
git add client/src/App.jsx server/chat.js
git commit -m "fix: show an empty state when a user has no agents

The chat pane was gated on agents.length > 0 with no else branch, so a user
with no agents saw a blank panel. Not a crash - chat.js already rejects the
request - but there was nothing on screen explaining it."
```

---

## Self-review

**Spec coverage.** This plan implements §10 items 1 and 2 only, plus the test
foundation every later plan depends on. Items 3 (cascade on agent delete), 4
(split-brain on classified uploads) and 5 (dedup key) belong to Plan 3, where the code
that triggers them is written. Everything in §4-§9 is Plan 2 and Plan 3.

**Placeholders.** None. Every step has runnable commands or complete code.

**Type consistency.** `teamDocuments(userId, agentIds)` is defined in Task 2 Step 3
and consumed in Step 4 with the same argument order. `reset`/`makeUser`/`makeAgent`/
`makeDoc` are defined in Task 1 Step 2 and used with matching signatures in Task 1
Step 3 and Task 2 Step 1. `makeDoc` returns an id that Task 1 Step 3 uses in a lookup.

**Known gap, stated rather than hidden.** Task 3 has no automated test. The client has
no test runner, and standing up React Testing Library plus jsdom to assert one
conditional branch is out of proportion to the change. Manual steps are given instead.

---

## The remaining plans

This spec is too large for one plan. Suggested split, each producing working software:

**Plan 2 — Roles, assignments and retrieval.** `users.role`, `requireMaster`, the
bootstrap script, `agent_assignments` with its `mode` column, the §6 retrieval clause,
locking down the agent write routes, retiring public registration, and the data
migration in §9. This is the security core and should not be split further — a
half-applied permission model is worse than none.

**Plan 3 — Shelf features and admin.** Auto-filing to shelves, Private/Shared, notes,
the Files → Shelf rename, the admin screen, learned facts and their guards, plus §10
items 3-5.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between
   tasks, fast iteration.
2. **Inline Execution** — tasks run in this session with checkpoints for review.
