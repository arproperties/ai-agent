# Roles, Assignments and Retrieval — Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the master the only account that can create and edit agents, give users
access through assignments rather than ownership, and replace the per-user retrieval
scope with one that also reaches the master's shared shelves.

**Architecture:** Role lives in `users.role`, never in an env var. Access to an agent
moves from `agents.user_id` (ownership) to a new `agent_assignments` table whose `mode`
column separates *the agents a user talks to* from *the shelves those conversations may
read*. All access questions route through one new module, `server/access.js`, so the
rules are testable in isolation and exist in exactly one place. Master's oversight is a
separate `/api/admin/*` router — never an `OR is_master` widening of existing queries.

**Tech Stack:** Node 22.13+ (`node:test`), Postgres 16 with pgvector, Express 5,
React 19 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-20-master-role-and-shelves-design.md](../specs/2026-09-20-master-role-and-shelves-design.md)

**Prerequisite:** Plan 1 is merged. `npm test` runs and passes.

## Global Constraints

- Node `>=22.13`. ESM only. No new dependencies.
- `npm test` is `node --test --test-force-exit` with **no path argument** — Node 22 on
  the droplet rejects the directory form.
- `db.prepare()` uses `?` placeholders rewritten to `$1, $2…` **left to right across
  the whole statement**. In `knowledge.js` the query vector is always the first
  placeholder; a scope's own params follow. Adding a placeholder shifts every later one.
- Tests require `TEST_DATABASE_URL` whose database name ends in `_test`. The harness
  refuses anything else because it truncates every table.
- Timestamps are unix seconds: `extract(epoch from now())::bigint`.
- **Every restriction is enforced server-side.** Hiding a button in React is cosmetic.
- This plan must not implement: the Private/Shared upload toggle UI, auto-filing to
  shelves, notes, the Files→Shelf rename, the admin *screen*, or learned facts. Those
  are Plan 3. This plan adds the `shared` **column** because retrieval reads it, but
  nothing in this plan ever sets it to true.

---

### Task 1: Schema

**Files:**
- Modify: `server/db.js:93-218` (the main `db.exec` block)
- Modify: `tests/helpers/db.js` (add `agent_assignments` to `TABLES`)
- Test: `tests/schema.test.js`

**Interfaces:**
- Produces: `users.role`, `users.disabled`, `users.created_by`, the
  `agent_assignments` table, `documents.shared`, `chunks.shared`

`CREATE TABLE IF NOT EXISTS` is safe to re-run, but `ALTER TABLE ADD COLUMN` is not, so
the additive columns go in a `DO $$` block in the same style as the pgvector migration
already at `server/db.js:225-244`.

- [ ] **Step 1: Write the failing test**

Create `tests/schema.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';

test.after(() => closeDb());

const column = (table, name) => db.prepare(
  'SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = ? AND column_name = ?'
).get(table, name);

test('users gains role, disabled and created_by', async () => {
  assert.ok(await column('users', 'role'), 'users.role is missing');
  assert.ok(await column('users', 'disabled'), 'users.disabled is missing');
  assert.ok(await column('users', 'created_by'), 'users.created_by is missing');
});

test('a new user defaults to the user role and is not disabled', async () => {
  await reset();
  const id = await makeUser('Alice');
  const u = await db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id);
  assert.deepEqual(u, { role: 'user', disabled: false });
});

test('documents and chunks gain a shared flag defaulting to false', async () => {
  assert.ok(await column('documents', 'shared'), 'documents.shared is missing');
  assert.ok(await column('chunks', 'shared'), 'chunks.shared is missing');
});

test('agent_assignments links a user to an agent with a mode', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');

  await db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(hr, sara, 'chat');
  const row = await db.prepare('SELECT agent_id, user_id, mode, is_primary FROM agent_assignments WHERE user_id = ?').get(sara);
  assert.deepEqual(row, { agent_id: hr, user_id: sara, mode: 'chat', is_primary: false });
});

test('an agent can only be assigned to a user once', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');
  const ins = 'INSERT INTO agent_assignments (agent_id, user_id) VALUES (?, ?)';

  await db.prepare(ins).run(hr, sara);
  await assert.rejects(() => db.prepare(ins).run(hr, sara), /duplicate key/);
});

test('mode only accepts chat or knowledge', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');

  await assert.rejects(
    () => db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(hr, sara, 'admin'),
    /violates check constraint/
  );
});

test('deleting a user removes their assignments but not the agent', async () => {
  await reset();
  const master = await makeUser('Master');
  const sara = await makeUser('Sara');
  const hr = await makeAgent(master, 'HR');
  await db.prepare('INSERT INTO agent_assignments (agent_id, user_id) VALUES (?, ?)').run(hr, sara);

  await db.prepare('DELETE FROM users WHERE id = ?').run(sara);
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM agent_assignments').get();
  assert.equal(n, 0, 'the assignment should have been cascaded away');
  assert.ok(await db.prepare('SELECT 1 FROM agents WHERE id = ?').get(hr), 'the agent must survive');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

Expected: the schema tests fail — `users.role is missing` and
`relation "agent_assignments" does not exist`.

- [ ] **Step 3: Add the new table to the main schema block**

In `server/db.js`, inside the big `await db.exec(\`...\`)` that starts at line 93, add
after the `agents` table definition:

```sql
  -- Access to an agent comes from an assignment, not from ownership. agents.user_id is
  -- the owner (the master); these rows are who may use it.
  --   mode 'chat'      - appears in the user's sidebar, the router may select it
  --   mode 'knowledge' - hidden agent, its shelf is readable in the background
  CREATE TABLE IF NOT EXISTS agent_assignments (
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    mode       TEXT    NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'knowledge')),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT DEFAULT ${NOW},
    PRIMARY KEY (agent_id, user_id)
  );
```

and add to the index list at the end of the same block:

```sql
  CREATE INDEX IF NOT EXISTS idx_assign_user ON agent_assignments(user_id);
```

- [ ] **Step 4: Add the new columns**

Append a new `await db.exec()` block at the end of `server/db.js`, after the pgvector
migration:

```js
// Columns added for the master/assignment model. ADD COLUMN IF NOT EXISTS is safe to
// re-run, so this block is idempotent and runs on every boot like the rest of the schema.
await db.exec(`
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS role       TEXT    NOT NULL DEFAULT 'user';
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS disabled   BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE users     ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

  -- Sharing is per-item and opt-in. Denormalised onto chunks for the same reason
  -- agent_id already is: recall() must filter without joining documents.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE chunks    ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS idx_chunks_shared ON chunks(shared) WHERE shared;
`);
```

`users.role` deliberately has no CHECK constraint — Plan 3 may add roles, and a
constraint here would need a migration to change. The values are `'master'` and
`'user'`.

- [ ] **Step 5: Add the table to the test harness truncation list**

In `tests/helpers/db.js`, add `'agent_assignments'` to `TABLES`, after `'agents'`.

- [ ] **Step 6: Run the tests and verify they pass**

Expected: all schema tests pass, and Plan 1's tests still pass.

- [ ] **Step 7: Commit**

```bash
git add server/db.js tests/helpers/db.js tests/schema.test.js
git commit -m "feat: schema for roles, agent assignments and per-item sharing"
```

---

### Task 2: The access module

**Files:**
- Create: `server/access.js`
- Test: `tests/access.test.js`

**Interfaces:**
- Consumes: `server/db.js` — `db`
- Produces:
  - `isMaster(user): boolean`
  - `chatAgents(user): Promise<Agent[]>` — the agents this user converses with
  - `shelfIds(user): Promise<number[]>` — agent ids whose shelves they may read
  - `canUseAgent(user, agentId): Promise<boolean>`

Every access question in the app goes through this module. Putting them in one file is
the point: these four functions are the entire boundary between users.

**Master is deliberately not a special case inside a shared query.** Master owns their
agents, so `chatAgents` selects by ownership for them and by assignment for everyone
else — two separate statements, not one statement with an `OR`.

- [ ] **Step 1: Write the failing test**

Create `tests/access.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { isMaster, chatAgents, shelfIds, canUseAgent } from '../server/access.js';

test.after(() => closeDb());

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);

  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);

  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  const finance = await makeAgent(masterId, 'Finance');
  return { master, sara, lawyer, hr, finance };
}

test('isMaster reads the role column', async () => {
  const { master, sara } = await fixture();
  assert.equal(isMaster(master), true);
  assert.equal(isMaster(sara), false);
});

test('a user chats only with agents assigned in chat mode', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  const names = (await chatAgents(sara)).map((a) => a.name);
  assert.deepEqual(names, ['Lawyer'], 'a knowledge-mode agent must not appear');
});

test('a user with no assignments chats with nothing', async () => {
  const { sara } = await fixture();
  assert.deepEqual(await chatAgents(sara), []);
});

test('master chats with every agent they own, without assignments', async () => {
  const { master } = await fixture();
  const names = (await chatAgents(master)).map((a) => a.name);
  assert.deepEqual(names, ['Lawyer', 'HR', 'Finance']);
});

test('the primary agent sorts first', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(hr, sara.id, 'chat');
  await assign(lawyer, sara.id, 'chat');
  await db.prepare('UPDATE agent_assignments SET is_primary = true WHERE agent_id = ? AND user_id = ?').run(lawyer, sara.id);

  assert.equal((await chatAgents(sara))[0].name, 'Lawyer');
});

test('shelfIds covers both modes', async () => {
  const { sara, lawyer, hr, finance } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  const ids = (await shelfIds(sara)).sort();
  assert.deepEqual(ids, [lawyer, hr].sort(), 'a knowledge shelf is readable even though its agent is hidden');
  assert.ok(!ids.includes(finance), 'an unassigned shelf must not be readable');
});

test('canUseAgent follows assignment, in either mode', async () => {
  const { sara, lawyer, hr, finance } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');

  assert.equal(await canUseAgent(sara, lawyer), true);
  assert.equal(await canUseAgent(sara, hr), true);
  assert.equal(await canUseAgent(sara, finance), false);
});

test('master can use every agent they own and nothing they do not', async () => {
  const { master, sara, lawyer } = await fixture();
  const strayId = await makeAgent(sara.id, 'Stray');
  assert.equal(await canUseAgent(master, lawyer), true);
  assert.equal(await canUseAgent(master, strayId), false);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Expected: `Cannot find module '../server/access.js'`.

- [ ] **Step 3: Write the module**

Create `server/access.js`:

```js
import { db } from './db.js';

// Who may use which agent. Every cross-user boundary in the app is decided here, so
// the rules exist in one place and can be tested without an HTTP request.
//
// Master owns agents (agents.user_id); everyone else reaches them through
// agent_assignments. Those are two different questions, so they are two different
// statements rather than one query with an OR - a widening condition inside a shared
// query puts the bypass on the same line as the protection.

export const isMaster = (user) => user?.role === 'master';

/** The agents this user converses with: their sidebar, and what the router may pick. */
export async function chatAgents(user) {
  if (isMaster(user)) {
    return db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY id').all(user.id);
  }
  return db.prepare(`SELECT a.* FROM agents a
    JOIN agent_assignments aa ON aa.agent_id = a.id
    WHERE aa.user_id = ? AND aa.mode = 'chat'
    ORDER BY aa.is_primary DESC, a.id`).all(user.id);
}

/**
 * Agent ids whose shelves this user may read. Includes 'knowledge' assignments, whose
 * agent is hidden from the sidebar but whose documents are still retrievable - that is
 * the whole point of the mode.
 */
export async function shelfIds(user) {
  const rows = isMaster(user)
    ? await db.prepare('SELECT id AS agent_id FROM agents WHERE user_id = ?').all(user.id)
    : await db.prepare('SELECT agent_id FROM agent_assignments WHERE user_id = ?').all(user.id);
  return rows.map((r) => r.agent_id);
}

/** May this user attach files to, speak as, or otherwise act on this agent? */
export async function canUseAgent(user, agentId) {
  const id = Number(agentId);
  if (!id) return false;
  if (isMaster(user)) {
    return !!(await db.prepare('SELECT 1 FROM agents WHERE id = ? AND user_id = ?').get(id, user.id));
  }
  return !!(await db.prepare('SELECT 1 FROM agent_assignments WHERE agent_id = ? AND user_id = ?').get(id, user.id));
}
```

- [ ] **Step 4: Run the tests and verify they pass**

- [ ] **Step 5: Commit**

```bash
git add server/access.js tests/access.test.js
git commit -m "feat: add server/access.js as the single place access rules live"
```

---

### Task 3: Retrieval scope

**Files:**
- Modify: `server/knowledge.js:134-142` (`recall`)
- Modify: `server/files.js:99-103` (`libraryCatalog`)
- Modify: `server/chat.js:119-120` (call sites)
- Test: `tests/recall.test.js`

**Interfaces:**
- Consumes: `shelfIds` from `server/access.js`
- Produces:
  - `recall(user, agentId, query)` — **takes the user row, not a user id**
  - `libraryCatalog(user, agentId)` — same change

The spec's §6 clause:

```sql
   t.user_id = $me                                             -- everything of mine, any agent
OR (t.shared AND (t.agent_id IS NULL OR t.agent_id = ANY($myShelves)))
```

Two deliberate asymmetries: **my own material has no agent filter** (it is all mine —
siloing it per agent would stop the Lawyer agent reading an invoice I uploaded), while
**shared material keeps its agent filter** (that one is a real boundary).

`recall` and `libraryCatalog` now need the role, so they take the user row.

- [ ] **Step 1: Write the failing test**

Create `tests/recall.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { retrievalScope } from '../server/knowledge.js';

test.after(() => closeDb());

// Exercises the scope as SQL against real rows, which is the only way to know the
// clause is right. Uses chunks directly rather than going through embeddings.
async function chunkIds(user, agentId) {
  const { shelfIds } = await import('../server/access.js');
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT t.id, t.text FROM chunks t WHERE ${scope.sql} ORDER BY t.id`).all(...scope.params);
  return rows.map((r) => r.text);
}

const chunk = (userId, agentId, text, shared = false) =>
  db.prepare('INSERT INTO chunks (user_id, agent_id, text, shared) VALUES (?, ?, ?, ?)').run(userId, agentId, text, shared);

const assign = (agentId, userId, mode = 'chat') =>
  db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, ?)').run(agentId, userId, mode);

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const saraId = await makeUser('Sara');
  const sara = await db.prepare('SELECT * FROM users WHERE id = ?').get(saraId);
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  return { master, sara, lawyer, hr };
}

test('a user reads all of their own chunks regardless of agent', async () => {
  const { sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(sara.id, lawyer, 'sara lawyer note');
  await chunk(sara.id, hr, 'sara hr note');          // not assigned, but still hers
  await chunk(sara.id, null, 'sara library note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts.sort(), ['sara hr note', 'sara lawyer note', 'sara library note'].sort());
});

test("a user never reads another user's chunks", async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'master private note');   // shared = false
  await chunk(sara.id, lawyer, 'sara note');

  const texts = await chunkIds(sara, lawyer);
  assert.deepEqual(texts, ['sara note'], 'master\'s private chunk must not be visible');
});

test('a user reads shared chunks on shelves they were assigned', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, lawyer, 'legal shelf policy', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('legal shelf policy'));
});

test('a user does NOT read shared chunks on shelves they were not assigned', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, hr, 'hr payroll policy', true);

  assert.ok(!(await chunkIds(sara, lawyer)).includes('hr payroll policy'));
});

test('a knowledge-mode assignment grants shelf access without the agent', async () => {
  const { master, sara, lawyer, hr } = await fixture();
  await assign(lawyer, sara.id, 'chat');
  await assign(hr, sara.id, 'knowledge');
  await chunk(master.id, hr, 'hr handbook notice period', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('hr handbook notice period'));
});

test('a shared chunk with no agent reaches everyone', async () => {
  const { master, sara, lawyer } = await fixture();
  await assign(lawyer, sara.id);
  await chunk(master.id, null, 'company holiday calendar', true);

  assert.ok((await chunkIds(sara, lawyer)).includes('company holiday calendar'));
});

test('master reads all of their own chunks, shared or not', async () => {
  const { master, lawyer, hr } = await fixture();
  await chunk(master.id, lawyer, 'master private', false);
  await chunk(master.id, hr, 'master shared', true);

  const texts = await chunkIds(master, lawyer);
  assert.deepEqual(texts.sort(), ['master private', 'master shared'].sort());
});

test("master does not read a user's private chunks through recall", async () => {
  const { master, sara, lawyer } = await fixture();
  await chunk(sara.id, lawyer, 'sara private diary');

  assert.ok(!(await chunkIds(master, lawyer)).includes('sara private diary'),
    'master oversight is the admin router, not a widening of recall');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Expected: `does not provide an export named 'retrievalScope'`.

- [ ] **Step 3: Add the scope builder**

In `server/knowledge.js`, add above `recall`:

```js
/**
 * The scope every retrieval uses, as a condition on table alias `t`.
 *
 * Own material has no agent filter: it all belongs to this user, and siloing it per
 * agent would stop their Lawyer agent reading an invoice they uploaded. Shared material
 * keeps the agent filter - that one is a real boundary between roles.
 *
 * An empty shelf list is fine: `= ANY('{}'::int[])` is simply false.
 */
export function retrievalScope(userId, shelves) {
  return {
    sql: '(t.user_id = ? OR (t.shared AND (t.agent_id IS NULL OR t.agent_id = ANY(?::int[]))))',
    params: [userId, shelves],
  };
}
```

- [ ] **Step 4: Use it in `recall`**

Replace `recall` (`server/knowledge.js:134-142`):

```js
export async function recall(user, agentId, query) {
  const [qvec] = await embed([query]);
  const { n: memCount } = await db.prepare('SELECT COUNT(*)::int n FROM memories WHERE user_id = ?').get(user.id);
  // Memories are facts about a person, never about the company, so they are never
  // shared and never scoped by shelf.
  const memories = memCount <= 25 // small memory: include it all
    ? (await db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id').all(user.id)).map((r) => r.text)
    : await search('memories', { sql: 't.user_id = ?', params: [user.id] }, query, qvec, 12);
  const knowledge = await search('chunks', retrievalScope(user.id, await shelfIds(user)), query, qvec, 6);
  return { memories, knowledge };
}
```

and add the import at the top of `server/knowledge.js`:

```js
import { shelfIds } from './access.js';
```

> The `agentId` parameter is now unused by `recall` — the shelf list replaces it. Leave
> the parameter in place for this task so the call sites do not have to change twice;
> Task 7 removes it.

- [ ] **Step 5: Use it in `libraryCatalog`**

Replace `server/files.js:99-103`:

```js
// Compact catalogue of the files this user can see, so agents can answer
// "what files do I have?" or "find my lease". Same scope as recall().
export async function libraryCatalog(user, agentId) {
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT title, folder, name, doc_date FROM documents t
    WHERE ${scope.sql} AND status = 'ready' ORDER BY id DESC LIMIT 40`).all(...scope.params);
  return rows.map((d) => `- ${d.title} (${d.folder}${d.doc_date ? `, ${d.doc_date}` : ''}; file: ${d.name})`);
}
```

Note the added `t` alias on `documents` — `retrievalScope` writes conditions against
`t`. Update the imports at the top of `server/files.js`:

```js
import { IMAGE_TYPES, extractText, describeImage, indexChunks, retrievalScope } from './knowledge.js';
import { shelfIds } from './access.js';
```

- [ ] **Step 6: Update the call sites**

`server/chat.js:119-120`:

```js
  const { memories, knowledge } = await recall(user, agent.id, text || meta.map((f) => f.name).join(' '));
  const library = await libraryCatalog(user, agent.id); // same every turn, so read it once
```

Then check for any other caller:

```bash
grep -rn "recall(\|libraryCatalog(" server/ --include=*.js
```

Every hit must pass the user row, not `user.id`.

- [ ] **Step 7: Run the tests and verify they pass**

- [ ] **Step 8: Commit**

```bash
git add server/knowledge.js server/files.js server/chat.js tests/recall.test.js
git commit -m "feat: retrieval reads own material plus assigned shared shelves"
```

---

### Task 4: Agents come from assignments

**Files:**
- Modify: `server/index.js:45-47` (`GET /api/agents`)
- Modify: `server/index.js:27` (the `own` helper) and its agent call sites
- Modify: `server/chat.js:88`
- Test: `tests/agents-api.test.js`

**Interfaces:**
- Consumes: `chatAgents`, `canUseAgent`, `isMaster` from `server/access.js`
- Produces: `GET /api/agents` returns assigned agents; `persona` and `model` are
  withheld from non-master

- [ ] **Step 1: Write the failing test**

Create `tests/agents-api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { agentOut } from '../server/index.js';
```

> **Stop.** `server/index.js` calls `app.listen()` at import time, so importing it from a
> test starts a real server. Do not import it. Move the two pure helpers into a module
> that can be imported instead — that is Step 3.

Write the file as:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { agentOut } from '../server/agents.js';

test.after(() => closeDb());

const master = { id: 1, role: 'master' };
const plain = { id: 2, role: 'user' };

const row = {
  id: 7, user_id: 1, name: 'Lawyer', icon: 'scale', color: 'violet',
  persona: 'You are a lawyer. Internal routing rules follow…',
  model: 'claude-opus-5', voice: 'alloy', starters: '["Draft a notice"]',
};

test('master sees the full agent', () => {
  const out = agentOut(row, master);
  assert.equal(out.persona, row.persona);
  assert.equal(out.model, 'claude-opus-5');
  assert.deepEqual(out.starters, ['Draft a notice']);
});

test('a normal user does not receive persona or model', () => {
  const out = agentOut(row, plain);
  assert.equal(out.name, 'Lawyer');
  assert.deepEqual(out.starters, ['Draft a notice']);
  assert.ok(!('persona' in out), 'persona is master-authored and must not be exposed');
  assert.ok(!('model' in out), 'model choice is master-only');
});

test('agentOut tolerates a missing starters value', () => {
  assert.deepEqual(agentOut({ ...row, starters: null }, master).starters, []);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Expected: `Cannot find module '../server/agents.js'`.

- [ ] **Step 3: Extract the agent helpers**

Create `server/agents.js` and move `agentOut` and `agentIn` out of `server/index.js`
(currently lines 34-43), adding the role filter:

```js
import { MODELS, VOICES, COLORS } from './config.js';
import { isMaster } from './access.js';

/**
 * An agent as the API returns it. persona and model are master-authored configuration:
 * a normal user is shown the agent, not how it was built.
 */
export function agentOut(a, user) {
  if (!a) return a;
  const { persona, model, user_id, ...rest } = a;
  const base = { ...rest, starters: JSON.parse(a.starters || '[]') };
  return isMaster(user) ? { ...base, persona, model } : base;
}

export const agentIn = (b) => ({
  name: String(b.name || 'New agent').slice(0, 60),
  icon: /^[a-z-]{1,30}$/.test(b.icon) ? b.icon : 'bot',
  color: COLORS.includes(b.color) ? b.color : 'violet',
  persona: String(b.persona || '').slice(0, 8000),
  model: MODELS.some((m) => m.id === b.model) ? b.model : MODELS[0].id,
  voice: VOICES.includes(b.voice) ? b.voice : 'alloy',
  starters: JSON.stringify((Array.isArray(b.starters) ? b.starters : []).map(String).filter(Boolean).slice(0, 8)),
});
```

In `server/index.js`, delete lines 34-43 and import instead:

```js
import { agentOut, agentIn } from './agents.js';
import { chatAgents, canUseAgent, isMaster } from './access.js';
```

- [ ] **Step 4: Serve assigned agents**

Replace `GET /api/agents` (`server/index.js:45-47`):

```js
app.get('/api/agents', wrap(async (req, res) => {
  res.json((await chatAgents(req.user)).map((a) => agentOut(a, req.user)));
}));
```

- [ ] **Step 5: Make `own()` assignment-aware for agents**

`server/index.js:27` checks `user_id`, which is now ownership and wrong for users.
Agents need their own check. Replace the agent call sites:

- `server/index.js:78` (`PUT /api/agents/:id`) — master-only in Task 5; leave for now.
- `server/index.js:158` (`POST /api/documents`):
  ```js
  if (agentId && !await canUseAgent(req.user, agentId)) return notFound(res);
  ```
- `server/index.js:218` (`POST /api/voice/speak`):
  ```js
  const agent = (await canUseAgent(req.user, req.body.agentId))
    ? await db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(req.body.agentId))
    : null;
  ```

Leave `own()` itself in place — `documents` and `conversations` still use it correctly.

- [ ] **Step 6: Use assignments for the chat team**

`server/chat.js:88`:

```js
  const team = await chatAgents(user);
```

and add `import { chatAgents } from './access.js';` at the top.

- [ ] **Step 7: Run the tests and verify they pass**

- [ ] **Step 8: Commit**

```bash
git add server/agents.js server/index.js server/chat.js tests/agents-api.test.js
git commit -m "feat: agents come from assignments; persona and model are master-only"
```

---

### Task 5: Lock down the agent write routes

**Files:**
- Modify: `server/auth.js` (add `requireMaster`, expose `role`, reject disabled users)
- Modify: `server/index.js:49-92` (draft, create, update, delete)
- Test: `tests/auth-guards.test.js`

**Interfaces:**
- Produces: `requireMaster(req, res, next)` exported from `server/auth.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-guards.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from './helpers/db.js';
import { requireMaster } from '../server/auth.js';

test.after(() => closeDb());

// Minimal express double: requireMaster only touches req.user, res.status/json, next.
function runGuard(user) {
  return new Promise((resolve) => {
    const req = { user };
    const res = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, passed: false }); },
    };
    requireMaster(req, res, () => resolve({ status: null, body: null, passed: true }));
  });
}

test('requireMaster lets the master through', async () => {
  assert.deepEqual(await runGuard({ id: 1, role: 'master' }), { status: null, body: null, passed: true });
});

test('requireMaster rejects a normal user with 403', async () => {
  const r = await runGuard({ id: 2, role: 'user' });
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
});

test('requireMaster rejects a missing user', async () => {
  const r = await runGuard(undefined);
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Expected: `does not provide an export named 'requireMaster'`.

- [ ] **Step 3: Add the guard**

In `server/auth.js`, after `requireUser` (line 65):

```js
/** Routes that only the master may call. Mount after requireUser, which sets req.user. */
export function requireMaster(req, res, next) {
  if (req.user?.role !== 'master') return res.status(403).json({ error: 'Not allowed' });
  next();
}
```

- [ ] **Step 4: Expose the role and reject disabled accounts**

`server/auth.js:50`:

```js
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
```

`server/auth.js:59-65` — a disabled account must not be able to act:

```js
export function requireUser(req, res, next) {
  currentUser(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    if (user.disabled) return res.status(403).json({ error: 'This account has been disabled' });
    req.user = user;
    next();
  }, next);
}
```

Also reject a disabled account at login, after the password check at
`server/auth.js:102-105`:

```js
  if (user.disabled) return res.status(403).json({ error: 'This account has been disabled' });
```

- [ ] **Step 5: Gate the four agent write routes**

In `server/index.js`, add `requireMaster` to each. `wrap()` takes one handler, so the
guard goes before it as a second argument to the route:

```js
app.post('/api/agents/draft', requireMaster, wrap(async (req, res) => {
app.post('/api/agents', requireMaster, wrap(async (req, res) => {
app.put('/api/agents/:id', requireMaster, wrap(async (req, res) => {
app.delete('/api/agents/:id', requireMaster, wrap(async (req, res) => {
```

Import it: `import { authRoutes, requireUser, requireMaster } from './auth.js';`

In `PUT` and `DELETE`, the existing `own('agents', …)` check is now exactly right —
master owns their agents — so leave it.

- [ ] **Step 6: Drop the "at least one agent" guard**

`server/index.js:85-86` blocks deleting a user's last agent. Under assignment that is
the master's decision, not a rule. Delete those two lines.

> `DELETE /api/agents/:id` still cascades `documents` and `chunks` for **every**
> assigned user — spec §10 item 3. That is Plan 3. Do not attempt it here; note it and
> move on.

- [ ] **Step 7: Run the tests and verify they pass**

- [ ] **Step 8: Commit**

```bash
git add server/auth.js server/index.js tests/auth-guards.test.js
git commit -m "feat: only the master may create, edit or delete agents"
```

---

### Task 6: Retire public registration and add the bootstrap script

**Files:**
- Modify: `server/auth.js:76-95` (remove `POST /register`)
- Modify: `client/src/components/Auth.jsx` (remove the register tab)
- Create: `scripts/make-master.js`
- Modify: `package.json` (a `make-master` script)
- Test: manual — see steps

**Interfaces:**
- Produces: `node scripts/make-master.js <email>`

**Do this task last before the migration.** Once registration is gone, the only way to
create an account is the admin API in Task 7 or a script.

- [ ] **Step 1: Write the bootstrap script**

Create `scripts/make-master.js`, following the shape of `scripts/reset-password.js`:

```js
// Promote an existing account to master. Role lives on the account, not in an env var,
// so changing the email address never costs the role.
//   node scripts/make-master.js someone@example.com
import { db, closeDb } from '../server/db.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/make-master.js <email>');
  process.exit(1);
}

const user = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with the email ${email}.`);
  await closeDb();
  process.exit(1);
}

const existing = await db.prepare("SELECT email FROM users WHERE role = 'master' AND id <> ?").all(user.id);
if (existing.length) {
  console.log(`Note: already master - ${existing.map((u) => u.email).join(', ')}`);
}

await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(user.id);
console.log(`${user.name} <${user.email}> is now master.`);
await closeDb();
```

Add to `package.json` scripts:

```json
"make-master": "node scripts/make-master.js",
```

- [ ] **Step 2: Remove the registration route**

Delete `authRoutes.post('/register', …)` entirely — `server/auth.js:76-95`.

`GET /me` returns `inviteRequired` (line 72) purely for the register form; drop it:

```js
    res.json({ user: user && publicUser(user) });
```

`REGISTRATION_CODE` in `server/config.js:12` and its import in `auth.js:5` are now
unused. Remove both.

- [ ] **Step 3: Remove the register tab from the client**

In `client/src/components/Auth.jsx`, remove the `register` mode: the tab switcher at
line 59, the `register` entry in the copy map at line 9, and any branch that posts to
`/auth/register`. Sign in and forgot-password remain.

In `client/src/App.jsx`, `inviteRequired` state (line 17) and the prop at line 58 are
now dead. Remove them and the `setInviteRequired` call at line 27.

- [ ] **Step 4: Verify the client still builds**

```bash
npm run build
```

Expected: a clean build. A missing-import error here means a leftover reference to
`inviteRequired`.

- [ ] **Step 5: Verify registration is really gone**

Against the deployed server after Task 8, or locally if you run one:

```bash
curl -s -X POST https://jarvis.eloquentservice.com/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"probe@example.com","password":"hunter2hunter2"}'
```

Expected: `{"error":"Not found"}` — the catch-all at `server/index.js:231`.

- [ ] **Step 6: Commit**

```bash
git add server/auth.js server/config.js client/src/components/Auth.jsx client/src/App.jsx scripts/make-master.js package.json
git commit -m "feat: retire public registration; add the make-master bootstrap script"
```

---

### Task 7: Admin API

**Files:**
- Create: `server/admin.js`
- Modify: `server/index.js` (mount it)
- Modify: `server/knowledge.js` (drop the now-unused `agentId` from `recall`)
- Test: `tests/admin.test.js`

**Interfaces:**
- Consumes: `hashPassword` from `server/auth.js`, `requireMaster`
- Produces: `adminRoutes` — an Express router

**Why a separate router:** every cross-user guard in this app is `WHERE user_id = ?`.
An `OR is_master` inside those expressions would put the bypass on the same line as the
protection. A separate router leaves the normal path untouched and auditable.

This task ships the API only. The **screen** is Plan 3; until then master uses `curl`.

- [ ] **Step 1: Write the failing test**

Create `tests/admin.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { createUser, setAssignments, listUsers } from '../server/admin.js';

test.after(() => closeDb());

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const hr = await makeAgent(masterId, 'HR');
  return { master, lawyer, hr };
}

test('createUser makes a normal, enabled account recorded against its creator', async () => {
  const { master } = await fixture();
  const u = await createUser(master, { name: 'Sara', email: 'SARA@Example.com ', password: 'hunter2hunter2' });
  assert.equal(u.email, 'sara@example.com', 'email is normalised');
  assert.equal(u.role, 'user');

  const row = await db.prepare('SELECT role, disabled, created_by, password_hash FROM users WHERE id = ?').get(u.id);
  assert.equal(row.disabled, false);
  assert.equal(row.created_by, master.id);
  assert.match(row.password_hash, /^scrypt\$/, 'the password must be hashed');
});

test('createUser rejects a duplicate email', async () => {
  const { master } = await fixture();
  await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await assert.rejects(
    () => createUser(master, { name: 'Other', email: 'sara@example.com', password: 'hunter2hunter2' }),
    /already exists/
  );
});

test('createUser rejects a short password', async () => {
  const { master } = await fixture();
  await assert.rejects(
    () => createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'short' }),
    /at least 8/
  );
});

test('setAssignments replaces the whole set', async () => {
  const { master, lawyer, hr } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });

  await setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'chat', primary: true }]);
  await setAssignments(master, sara.id, [
    { agentId: lawyer, mode: 'chat' },
    { agentId: hr, mode: 'knowledge' },
  ]);

  const rows = await db.prepare('SELECT agent_id, mode FROM agent_assignments WHERE user_id = ? ORDER BY agent_id').all(sara.id);
  assert.deepEqual(rows, [{ agent_id: lawyer, mode: 'chat' }, { agent_id: hr, mode: 'knowledge' }].sort((a, b) => a.agent_id - b.agent_id));
});

test('setAssignments refuses an agent the master does not own', async () => {
  const { master } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  const strayOwner = await makeUser('Stray');
  const stray = await makeAgent(strayOwner, 'Stray');

  await assert.rejects(() => setAssignments(master, sara.id, [{ agentId: stray, mode: 'chat' }]), /not found/i);
});

test('setAssignments rejects an unknown mode', async () => {
  const { master, lawyer } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await assert.rejects(() => setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'root' }]), /mode/i);
});

test('listUsers reports each user with their assignment count and never a password', async () => {
  const { master, lawyer } = await fixture();
  const sara = await createUser(master, { name: 'Sara', email: 'sara@example.com', password: 'hunter2hunter2' });
  await setAssignments(master, sara.id, [{ agentId: lawyer, mode: 'chat' }]);

  const users = await listUsers();
  const row = users.find((u) => u.id === sara.id);
  assert.equal(row.agents, 1);
  assert.ok(!('password_hash' in row), 'never expose the hash');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Expected: `Cannot find module '../server/admin.js'`.

- [ ] **Step 3: Write the module**

Create `server/admin.js`:

```js
import { Router } from 'express';
import { db, tx } from './db.js';
import { hashPassword, requireMaster } from './auth.js';

// Master's oversight lives here, in its own router behind requireMaster, rather than
// as an "OR is_master" widening of the ordinary queries. Every cross-user guard in the
// app is `WHERE user_id = ?`; adding a bypass inside those expressions would put it on
// the same line as the protection.

const MODES = ['chat', 'knowledge'];
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function createUser(master, { name, email, password }) {
  const clean = {
    name: String(name || '').trim().slice(0, 60),
    email: String(email || '').trim().toLowerCase().slice(0, 200),
  };
  if (!clean.name) throw fail(400, 'Please enter a name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw fail(400, 'Please enter a valid email');
  if (String(password || '').length < 8) throw fail(400, 'Password must be at least 8 characters');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean.email)) {
    throw fail(409, 'An account with this email already exists');
  }

  const hash = await hashPassword(password);
  const { id } = await db.prepare(
    'INSERT INTO users (email, name, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id'
  ).run(clean.email, clean.name, hash, 'user', master.id);
  return { id, name: clean.name, email: clean.email, role: 'user' };
}

/** Replaces the user's entire assignment set, so the caller sends the desired end state. */
export async function setAssignments(master, userId, wanted) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw fail(404, 'User not found');

  const rows = (Array.isArray(wanted) ? wanted : []).map((a) => ({
    agentId: Number(a.agentId),
    mode: a.mode ?? 'chat',
    primary: !!a.primary,
  }));
  for (const r of rows) {
    if (!MODES.includes(r.mode)) throw fail(400, `Unknown mode: ${r.mode}`);
    const owned = await db.prepare('SELECT 1 FROM agents WHERE id = ? AND user_id = ?').get(r.agentId, master.id);
    if (!owned) throw fail(404, `Agent not found: ${r.agentId}`);
  }

  await tx(async () => {
    await db.prepare('DELETE FROM agent_assignments WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode, is_primary) VALUES (?, ?, ?, ?)');
    for (const r of rows) await ins.run(r.agentId, target.id, r.mode, r.primary);
  });
  return rows.length;
}

export function listUsers() {
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.disabled, u.created_at,
      (SELECT COUNT(*)::int FROM agent_assignments aa WHERE aa.user_id = u.id) agents
    FROM users u ORDER BY u.id`).all();
}

export const adminRoutes = Router();
adminRoutes.use(requireMaster);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

adminRoutes.get('/users', wrap(async (req, res) => res.json(await listUsers())));

adminRoutes.post('/users', wrap(async (req, res) => {
  res.json(await createUser(req.user, req.body));
}));

adminRoutes.put('/users/:id/agents', wrap(async (req, res) => {
  const n = await setAssignments(req.user, req.params.id, req.body.agents);
  res.json({ ok: true, assigned: n });
}));

// Disabling keeps the data and revokes every session. Deleting a user cascades away
// their documents, chunks and conversations irreversibly, so it is not offered here.
adminRoutes.put('/users/:id/disabled', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  const disabled = !!req.body.disabled;
  await db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled, id);
  if (disabled) await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true, disabled });
}));

adminRoutes.get('/users/:id/documents', wrap(async (req, res) => {
  res.json(await db.prepare(`SELECT id, name, title, folder, doc_date, shared, agent_id, created_at
    FROM documents WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(Number(req.params.id)));
}));

adminRoutes.get('/users/:id/conversations', wrap(async (req, res) => {
  res.json(await db.prepare('SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200')
    .all(Number(req.params.id)));
}));
```

The `fail()` helper sets `err.status`, which the error handler at `server/index.js:242`
already honours.

- [ ] **Step 4: Mount it**

In `server/index.js`, after the other routers (line 24):

```js
app.use('/api/admin', adminRoutes);
```

with `import { adminRoutes } from './admin.js';` at the top. It sits below
`app.use('/api', requireUser)` at line 22, so `req.user` is already set.

- [ ] **Step 5: Tidy the unused parameter**

`recall(user, agentId, query)` no longer uses `agentId`. Change the signature to
`recall(user, query)` and update `server/chat.js:119`:

```js
  const { memories, knowledge } = await recall(user, text || meta.map((f) => f.name).join(' '));
```

Do the same for `libraryCatalog(user, agentId)` → `libraryCatalog(user)` and
`server/chat.js:120`. Then confirm nothing else calls them:

```bash
grep -rn "recall(\|libraryCatalog(" server/ --include=*.js
```

- [ ] **Step 6: Run the tests and verify they pass**

- [ ] **Step 7: Commit**

```bash
git add server/admin.js server/index.js server/knowledge.js server/files.js server/chat.js tests/admin.test.js
git commit -m "feat: admin API for users and agent assignments, in its own router"
```

---

### Task 8: Migrate the live data and deploy

**Files:**
- Create: `scripts/migrate-to-assignments.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `node scripts/migrate-to-assignments.js`

The live database has real accounts (3 users, 21 agents at the time of writing), each
seeded with their own copy of `DEFAULT_AGENTS`. Without assignment rows, every existing
user's sidebar goes empty the moment Task 4 deploys.

**Run the migration in the same maintenance window as the deploy, immediately after.**

- [ ] **Step 1: Write the migration**

Create `scripts/migrate-to-assignments.js`:

```js
// One-off: give every existing user an assignment for the agents they already own, so
// nobody's sidebar empties when access moves from ownership to assignment.
//
// Agent ownership is deliberately NOT consolidated onto the master here. Each user's
// agents carry their own documents and chunks, and agents.id cascades to both - merging
// duplicate default agents would destroy files. That is a manual follow-up.
//
//   node scripts/migrate-to-assignments.js [--apply]
import { db, closeDb } from '../server/db.js';

const apply = process.argv.includes('--apply');

const pending = await db.prepare(`SELECT a.id agent_id, a.user_id, a.name, u.email
  FROM agents a JOIN users u ON u.id = a.user_id
  WHERE NOT EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.agent_id = a.id AND aa.user_id = a.user_id)
  ORDER BY a.user_id, a.id`).all();

if (!pending.length) {
  console.log('Nothing to do - every agent already has an assignment for its owner.');
} else {
  console.log(`${pending.length} agent(s) need an assignment:`);
  for (const p of pending) console.log(`  ${p.email.padEnd(32)} ${p.name}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these rows.');
  } else {
    const ins = db.prepare("INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, 'chat') ON CONFLICT DO NOTHING");
    for (const p of pending) await ins.run(p.agent_id, p.user_id);
    console.log(`\nWrote ${pending.length} assignment(s).`);
  }
}

const masters = await db.prepare("SELECT email FROM users WHERE role = 'master'").all();
console.log(masters.length
  ? `\nMaster: ${masters.map((m) => m.email).join(', ')}`
  : '\nNo master yet. Run: npm run make-master -- <email>');

await closeDb();
```

Add to `package.json`:

```json
"migrate-to-assignments": "node scripts/migrate-to-assignments.js",
```

- [ ] **Step 2: Run the full suite**

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

Expected: every test passes. Do not deploy on a red suite.

- [ ] **Step 3: Back up the live database first**

This migration is additive, but Task 1 altered tables on a database with real data.

```bash
ssh -i ~/.ssh/id_ed25519 root@64.227.153.90 \
  'sudo -u postgres pg_dump -Fc aiagent > /root/aiagent-$(date +%F-%H%M).dump && ls -lh /root/aiagent-*.dump | tail -3'
```

- [ ] **Step 4: Deploy**

```bash
./deploy.ps1
```

The schema changes in Task 1 apply themselves on boot — `server/db.js` runs its DDL at
import, and pm2 restarts the process.

- [ ] **Step 5: Dry-run the migration on the server**

```bash
ssh -i ~/.ssh/id_ed25519 root@64.227.153.90 'cd /var/www/jarvis && npm run migrate-to-assignments'
```

Read the list. Every existing user should appear with the agents they have today.

- [ ] **Step 6: Apply it, and make yourself master**

```bash
ssh -i ~/.ssh/id_ed25519 root@64.227.153.90 \
  'cd /var/www/jarvis && npm run migrate-to-assignments -- --apply && npm run make-master -- gilljennifer618@gmail.com'
```

- [ ] **Step 7: Verify against the live site**

```bash
# registration is gone
curl -s -X POST https://jarvis.eloquentservice.com/api/auth/register \
  -H 'Content-Type: application/json' -d '{"name":"T","email":"probe@example.com","password":"hunter2hunter2"}'
# expect: {"error":"Not found"}

# admin is refused without a master session
curl -s https://jarvis.eloquentservice.com/api/admin/users
# expect: {"error":"Please sign in"}
```

Then sign in as yourself and confirm: your agents are all still listed, a chat still
routes and answers, and your files still come back in a "what files do I have?" question.

- [ ] **Step 8: Verify a normal user is properly restricted**

Sign in as one of the other accounts (reset its password with
`npm run reset-password` if needed) and confirm:

1. The sidebar shows their agents (the migration preserved them).
2. There is no working way to create an agent — `POST /api/agents` returns 403.
3. `GET /api/agents` does **not** include `persona` or `model`.

```bash
curl -s -X POST https://jarvis.eloquentservice.com/api/agents \
  -H 'Content-Type: application/json' -b 'jarvis_sid=<their session cookie>' \
  -d '{"name":"Sneaky"}'
# expect: {"error":"Not allowed"}
```

- [ ] **Step 9: Commit**

```bash
git add scripts/migrate-to-assignments.js package.json
git commit -m "chore: migrate existing users to agent assignments"
```

---

## Self-review

**Spec coverage.** §4 permissions → Tasks 4, 5, 7. §5.1 users → Task 1. §5.2
assignments → Tasks 1, 2. §5.3 the `shared` column → Task 1 (the toggle that sets it is
Plan 3). §6 retrieval → Task 3. §8.1 server changes → Tasks 3-7. §9 bootstrap and
migration → Tasks 6, 8. §10 item 3 (cascade on agent delete) is explicitly deferred to
Plan 3 and called out in Task 5 Step 6.

**Deliberately not covered**, all Plan 3: §5.4 notes and learned facts, §7.1 auto-filing,
§7.2 the Private/Shared control, §7.3 notes, §7.4 learning, §8.2 all client changes
beyond removing the register tab.

**Placeholder scan.** None. Every step has runnable commands or complete code.

**Type consistency.** `isMaster`/`chatAgents`/`shelfIds`/`canUseAgent` are defined in
Task 2 Step 3 and consumed with matching signatures in Tasks 3 and 4.
`retrievalScope(userId, shelves)` returns `{sql, params}`, the shape `search()` in
`knowledge.js` already expects. `recall` and `libraryCatalog` change signature twice on
purpose — Task 3 swaps the user id for the user row, Task 7 drops the dead `agentId` —
and both call sites are updated in the same step as each change.

**Known risk.** Task 4 changes how agents are fetched, and Task 8 backfills the
assignment rows that keep existing users working. Between the deploy in Step 4 and the
migration in Step 6, existing users' sidebars are empty. Keep those steps together.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between
   tasks, fast iteration.
2. **Inline Execution** — tasks run in this session with checkpoints for review.
