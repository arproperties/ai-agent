# Agent Lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the master corrects an agent in chat, Reem proposes a standing rule on a "Learn this?" card; once approved, the agent follows it in every chat, with everyone.

**Architecture:** A new `server/lessons.js` holds the tables' logic, a chat kit (`lessonKit`, same pattern as `addressKit` in `server/addressBook.js`) and master-only routes. `chat.js` adds the kit for the master and puts a `<lessons>` block into the cached part of the system prompt for every user. The client gets a `LessonCard` in the chat and a Lessons section in `AgentSheet`.

**Tech Stack:** Express 5 ESM, Postgres via `db.prepare(...)` with `?` placeholders, `node:test` against the real test DB, React 19 + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-lessons-design.md`

## Global Constraints

- **Francis doesn't want the word "Lessons" on screen.** Every user-facing text says **Rules** instead: the section in AgentSheet is "Rules", the empty text is "None yet. When you correct this agent in a chat, Reem offers to learn it as a rule.", the card collapses to "Rule added for …" or "Not added", and the AI's one-line reply says "the rule is waiting on the card". The card title stays "Learn this?". Code names (tables, files, `lessonKit`, `propose_lesson`) stay "lesson", so they don't clash with the `rule` text field.

- Only `user.role === 'master'` gets the tool, the cards and the routes. Staff and external chats never create lessons.
- Nothing applies without Approve. The tool only inserts a `pending` proposal.
- "All agents" (`agent_id IS NULL`) = every agent the master owns, including private and case agents. The block is read by the agent's owner (`agents.user_id`), so staff and external users talking to that agent get the same rules.
- Removed lessons and declined proposals count as "No": they are never proposed again for the same scope.
- Rules pass `tooSpecificToShare()` from `server/knowledge.js`, both on propose and on an edited approve.
- A rule is 1–300 characters after trimming.
- At most the newest 50 lessons go into the prompt, listed oldest first.
- Duplicate check: compare `lower(regexp_replace(trim(rule), '\s+', ' ', 'g'))`, same owner and same scope (same `agent_id`, or both NULL).
- New tables go in `server/db.js` (idempotent DDL) **and** in `TABLES` in `tests/helpers/db.js`.
- Comments explain *why*, in the plain style of the surrounding files.

## Review Focus

1. The master taps Approve twice, or on two devices: the lesson is added once and the second tap gets 409 "already approved".
2. The agent is deleted while a card is pending: the proposal goes with it (FK cascade), and approving returns 404 instead of crashing.
3. `replaces` points at a removed lesson, another owner's lesson, or nonsense: it is quietly dropped, so the new lesson is still proposed and nothing else is removed.
4. The same correction comes up in a second chat while the first card is still pending: the second proposal is refused, so there's no second card.
5. An Edit leaves the rule empty, makes it longer than 300 characters, or adds a tenant's name: the approve is refused with a clear message, and the card stays pending.

Each one has a test in Task 1.

---

### Task 1: Tables and lesson logic

**Files:**
- Modify: `server/db.js` (new DDL block near `address_proposals`, ~line 2123)
- Modify: `tests/helpers/db.js:47` (add `'lesson_proposals', 'agent_lessons'` to `TABLES`)
- Create: `server/lessons.js`
- Test: `tests/lessons.test.js`

**Interfaces:**
- Produces (all exported from `server/lessons.js`):
  - `proposeLesson(master, { agentId, rule, allAgents = false, replaces = null, conversationId = null }) -> Promise<Proposal>`. Throws `Error` with `.status` (400/403/409) using the local `bad(message, status)` helper, as in addressBook.js.
  - `decideLesson(master, id, { approve, rule?, agentId?, replace = true }) -> Promise<Proposal|null>`. Returns null when not found. `agentId: null` = All agents; `undefined` = keep the proposal's scope.
  - `removeLesson(master, lessonId) -> Promise<boolean>`
  - `lessonsFor(agent) -> Promise<{ owner: string, lessons: Array<{ id, rule, agent_id }> }>`. Reads `agent.user_id` and `agent.id`. `owner` is the owner's `users.name`. `lessons` are the current lessons for that agent plus the owner's All-agents ones, the newest 50, oldest first. (Tests below read `.lessons`.)
  - `lessonsBlock(ownerName, lessons) -> string` (`''` when empty)
  - `listLessons(master, agentId) -> Promise<{ own: Lesson[], all: Lesson[] }>`
  - `proposalsFor(master, conversationId) -> Promise<Proposal[]>`
  - `Proposal = { id, conversation_id, agent_id, agent_name (null = All agents), rule, replaces_lesson_id, replaces_rule, status: 'pending'|'approved'|'declined', decided_at, created_at }`
  - `Lesson = { id, agent_id, rule, created_at }`

- [ ] **Step 1: Add DDL to `server/db.js`**

```sql
CREATE TABLE IF NOT EXISTS lesson_proposals (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,   -- NULL = All agents
  rule TEXT NOT NULL,
  replaces_lesson_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  decided_at BIGINT,
  created_at BIGINT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS agent_lessons (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,   -- NULL = All agents
  rule TEXT NOT NULL,
  from_proposal_id INTEGER REFERENCES lesson_proposals(id) ON DELETE SET NULL,
  created_at BIGINT DEFAULT ${NOW},
  removed_at BIGINT
);
```

Precede it with a comment in the file's style saying what each table is for. Add both names to `TABLES`.

- [ ] **Step 2: Write the failing tests in `tests/lessons.test.js`**

Import `reset, makeUser, makeAgent, db, closeDb` from `./helpers/db.js` first, then the functions above. `const master = { id: await makeUser('Owner'), role: 'master', name: 'Owner' }`. Test names and assertions:

- `'a rule is proposed for the answering agent and applied only on Approve'`: propose `{ agentId: a, rule: 'Always show rent including VAT.' }` → `status === 'pending'`, `agent_name === 'PM'`, and `lessonsFor(agentRow)` is empty. Then `decideLesson(master, p.id, { approve: true })` → `status === 'approved'`, and `lessonsFor` gives one rule equal to the text.
- `'approving twice adds it once'`: the second `decideLesson` rejects with `/already approved/` and status 409. `agent_lessons` count is 1.
- `'only the master can propose'`: `proposeLesson({ id: staff, role: 'user' }, …)` rejects with status 403.
- `'an agent the master does not own is refused'`: an agent made under another user rejects with status 403.
- `'declined, removed, pending and current rules are not proposed again'`: the same text with different case and extra spaces rejects with `/already/` in each of the four states. The same text with `allAgents: true` (a different scope) is accepted.
- `'personal detail is refused, on propose and on an edited approve'`: `'Tell Rahul Sharma his rent is AED 60,000'` rejects with `/names, sums or ID numbers/`. An approve with `rule` set to that text rejects the same way, and the proposal stays `pending`.
- `'an edited rule must be 1-300 characters'`: `rule: '  '` rejects, and `'x'.repeat(301)` rejects.
- `'approve can move the scope to All agents, and checks duplicates again'`: approve with `agentId: null` → the lesson has `agent_id === null`. With an existing All-agents lesson of the same text, it rejects with `/already/`.
- `'replace removes the old lesson and adds the new one together'`: lesson L1, then propose with `replaces: L1.id` → `replaces_rule === L1.rule`. Approve with `replace: true` → L1 gets `removed_at` set and the new lesson is current. Approve with `replace: false` on another case → both stay.
- `'a replaces id that is not a current lesson of this owner is dropped'`: a removed lesson, another owner's lesson and `9999` each give `replaces_lesson_id === null`, and the proposal still succeeds.
- `'lessonsFor: own plus All-agents, newest 50, never removed or another owner\'s'`: insert 55 lessons and check length 50, oldest first, with the newest included. A removed lesson is absent. Another master's All-agents lesson is absent.
- `'a deleted agent takes its pending card with it'`: delete the agent, then `decideLesson` returns null.
- `'lessonsBlock is empty without lessons and lists them otherwise'`: `''` for `[]`. Otherwise the result contains `<lessons>`, `Owner` and each rule as a `- ` line.
- `'listLessons splits own from All agents'`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `TEST_DATABASE_URL=postgres://…/jarvis_test npm test -- tests/lessons.test.js`
Expected: FAIL with "Cannot find module" or "does not provide an export".

- [ ] **Step 4: Implement `server/lessons.js`**

Follow `addressBook.js`:
- `bad()`
- `isMaster` from `./access.js`
- `tooSpecificToShare` from `./knowledge.js`. The refusal message says: "Restate it as a general rule, without names, sums or ID numbers."
- The status-change lock uses `UPDATE … WHERE id = ? AND status = 'pending'`.

Run the approve and the replace inside `tx()` from `./db.js`. `agent_name` and `replaces_rule` come from a LEFT JOIN in one shared `SELECT`.

`lessonsBlock` text: `<lessons>\nStanding rules ${ownerName} has taught you about how to do your work. Follow them in every chat; where one clashes with a request in this chat, follow the request and mention the rule.\n- rule…\n</lessons>`.

- [ ] **Step 5: Run the tests to see them pass**

Run: the same command. Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/lessons.js tests/helpers/db.js tests/lessons.test.js
git commit -m "feat(lessons): tables and logic for lessons the master teaches agents"
```

### Task 2: Chat kit and the prompt block

**Files:**
- Modify: `server/lessons.js` (add the kit)
- Modify: `server/chat.js` (the kit list near line 579; `systemPrompt` at line 69 and its call at ~line 629)
- Test: `tests/lessons.test.js` (more tests)

**Interfaces:**
- Consumes: Task 1's `proposeLesson`, `lessonsFor`, `lessonsBlock`.
- Produces:
  - `lessonKit(user, { conversationId, agent, onCard }) -> Promise<{ definitions, status, run }>`. `definitions` is `[]` for non-masters.
  - The tool name is `propose_lesson`, with input `{ rule: string, all_agents?: boolean, replaces?: integer }`.
  - The SSE event `lesson` carries a `Proposal`.

- [ ] **Step 1: Write the failing tests**

- `'the kit is empty for staff and external users'`: `(await lessonKit({ id, role: 'user' }, { agent })).definitions.length === 0`.
- `'the tool description lists current lessons with ids, and recently declined or removed rules'`: after one current lesson and one declined proposal, the description includes `[<id>] <rule>` and the declined text.
- `'run proposes for the answering agent and sends the card'`: `run({ id: 't1', name: 'propose_lesson', input: { rule: 'R' } })` calls `onCard` once with `agent_id === agent.id`. The `tool_result` content includes `NOT applied` and is not an error.
- `'run returns the refusal as is_error'`: for a duplicate, `is_error === true` and the content matches `/already/`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement `lessonKit`**

The description has to tell the model these things:
- Call this only when the master corrects or redirects how the agent does its work, and only for a rule that will hold beyond this task.
- Never for facts about him (Memory has those), and never for one-off changes to the current draft.
- Write the rule as one plain sentence.
- Set `all_agents` only when it's clearly general.
- Set `replaces` to the id of a listed lesson it contradicts.
- After calling, say in one short line that the lesson is waiting on the card, and never say it is learned.

Append the current lessons with ids, and the last 20 declined or removed rules for this agent and for All agents. The status label is `'Noting that for next time…'`.

- [ ] **Step 4: Wire it into `chat.js`**

- In the kit list, next to `addressKit`, add `await lessonKit(user, { conversationId: convId, agent, onCard: (p) => send('lesson', p) })`.
- Load `const taught = await lessonsFor(agent)` before `systemPrompt`, and pass it as a new last parameter `taught = null`.
- Inside `systemPrompt`, when `taught?.lessons.length`, insert `lessonsBlock(taught.owner, taught.lessons)` into `parts` straight after the two persona lines. Lessons are stable, so they belong in the cached block.
- Add a chat-level test: `'a staff user talking to the agent gets the same lessons block'`. Call `lessonsFor(agentRow)` and check the block is identical whoever the chat user is. It depends only on the agent.

- [ ] **Step 5: Run `tests/lessons.test.js`, then the full suite**

Expected: the new tests pass. The full suite shows only the 4 failures that are already on main (`scripts\push-test.js` and 3 in `billing.test.js`).

- [ ] **Step 6: Commit** `feat(lessons): Reem proposes a lesson on a card when the master corrects an agent`

### Task 3: Routes

**Files:**
- Modify: `server/lessons.js` (`lessonRoutes`)
- Modify: `server/index.js` (import, and `app.use('/api/lessons', lessonRoutes)` next to the address-book line, ~line 113)

**Interfaces:**
- Produces (all master only via `requireMaster` from `./auth.js`, wrapped with a local `wrap()`):
  - `GET /api/lessons/proposals?conversation=<id>` → `Proposal[]`
  - `POST /api/lessons/proposals/:id/approve` body `{ rule?, agent_id?, replace? }` → `Proposal`. A missing `agent_id` key means keep the scope, and `null` means All agents.
  - `POST /api/lessons/proposals/:id/decline` → `Proposal`
  - `GET /api/lessons/agent/:agentId` → `{ own, all }`
  - `DELETE /api/lessons/:id` → `{ ok: true }`. A missing lesson gets 404.
- Errors use `.status` from `bad()`. Not found returns 404 `{ error: 'Not found' }`.

- [ ] **Step 1: Add the routes. The paths with literal segments go before `/:id`, as in `addressRoutes`.**
- [ ] **Step 2: Run `node --check server/index.js` and start `npm run dev`. `curl` `GET /api/lessons/agent/1` as a non-master should give 403.**
- [ ] **Step 3: Commit** `feat(lessons): master-only routes for the cards and the lessons list`

### Task 4: The card in the chat

**Files:**
- Create: `client/src/components/LessonCard.jsx` (styled like `AddressCard.jsx`)
- Modify: `client/src/components/Chat.jsx`:
  - state next to `addresses` (line 69)
  - load next to line 114 (master only)
  - an event branch next to line 214: `event === 'lesson'`
  - render next to line 487
- Modify: `client/src/lib/petChat.js:11` (add `'lesson'` to `CARDS`)

**Interfaces:**
- Consumes: the routes from Task 3. The master's agents come from `api.get('/agents')` for the For dropdown.
- Produces: `LessonCard({ proposal, onChanged })`.

- [ ] **Step 1: Build `LessonCard`**

What the card shows:
- The title "Learn this?".
- The rule in quotes.
- "For:" with a `<select>` of the master's agents plus "All agents" (value `''` means null), set to the proposal's scope.
- When `replaces_rule` is set, the line "Replaces: "<old rule>"" with a "Replace it" checkbox, ticked by default.
- The buttons **Approve**, **Edit** and **No**. Edit turns the rule into a textarea, and Approve then sends `rule`.

After a decision the card collapses to one line: "Learned for <agent | All agents>: <rule>" or "Not learned". Show an error from the API inline under the buttons, and keep the card open.

- [ ] **Step 2: Wire it into `Chat.jsx` and `petChat.js`.**
- [ ] **Step 3: Run `npm run build`. Expected: it builds with no errors.**
- [ ] **Step 4: Commit** `feat(lessons): Learn this? card in the chat`

### Task 5: Lessons list on the agent

**Files:**
- Modify: `client/src/components/AgentSheet.jsx` (a section shown when `me?.role === 'master' && agent.id`)

**Interfaces:**
- Consumes: `GET /api/lessons/agent/:id` and `DELETE /api/lessons/:id`.

- [ ] **Step 1: Add the "Lessons" section**

- Show each own rule with a remove button (an icon button, with a confirm).
- Then show the All-agents rules, labelled "From All agents", also removable.
- When there are none, show: "None yet. When you correct this agent in a chat, Reem offers to learn it."
- When there are 50 or more, add a note that only the newest 50 are used.

- [ ] **Step 2: Run `npm run build`.**
- [ ] **Step 3: Commit** `feat(lessons): Lessons list on each agent`

### Task 6: Live check and ship

- [ ] **Step 1: Run a live API check with a script in `server/.tmp-test/`, as was done for web fetch, using the local DB's key.**
  - Build the prompt as `chat.js` does, with the real `lessonKit` definitions, for `claude-sonnet-5-5` and for `claude-haiku-5-5` with the advisor.
  - Turn A: "No, that's wrong. Always show rent including VAT from now on." Expected: a `propose_lesson` tool_use with a sensible rule.
  - Turn B: "Thanks, that's great." Expected: no `propose_lesson`.
  - Delete the script afterwards.
- [ ] **Step 2: Run the full suite. Expected: only the 4 failures already on main.**
- [ ] **Step 3: Open a PR to `main` and merge it. Then deploy following the auto-merge-deploy memory:**
  1. Compare live with `origin/main` by md5 (strip CR first).
  2. Back up with `pg_dump` and a code tar in `~/backups/…before-lessons`.
  3. Run `npm run build`.
  4. Ship `server scripts package.json package-lock.json client/dist` with LF endings.
  5. Run `pm2 restart jarvis --update-env`.
  6. Check that the site returns 200 and the pm2 log shows no errors at boot.
