# Master role, assigned agents, and shared shelves

**Date:** 2026-09-20
**Status:** Design approved, not implemented
**Scope:** Server (`server/`), client (`client/src/`), one data migration

---

## 1. The problem

Today every account is identical. Anyone who registers gets a full team of agents
seeded automatically ([auth.js:89-90](../../../server/auth.js#L89-L90)), can create
unlimited new agents, can call the AI agent-generator, and can pick any model
including the most expensive one. There is no notion of an administrator.

That is wrong for the way this app is actually going to be used: one owner (the
"master") who defines the agents, and staff who use the agents they are given.
Staff creating their own agents is a misuse surface — free-text personas, uncapped
LLM spend on `/agents/draft`, and unrestricted model choice.

## 2. What we are building

**Master** defines agents, creates users, assigns agents to them, and curates the
shared knowledge those agents draw on. **Users** talk to the agents they have been
assigned and keep their own private workspace.

Three rules govern everything below:

> **Walls between people. No walls inside one person. Master above all.**

- A user's own files, notes, chats, memory and mailbox are visible only to them.
- Within one user, all of *their* agents can read all of *their* own material.
- Master can see every user's files, notes, chats, memory and mailbox.

"Master can see" means **browsing them in the admin screen**. It does not mean
master's own agents retrieve from them during chat — see §6 and §8.1.

## 3. Vocabulary

Two things in this design are easy to confuse, so they get distinct names.

| Term | Meaning |
|---|---|
| **Agent** | A role/persona the master authors — "Lawyer", "HR". Owned by master. |
| **Shelf** | The documents and notes filed against an agent. Master's shared items on a shelf reach every user who has that agent. |
| **User** | A person with an account. "The HR user" (Sara) is a person; "the HR agent" is a role. They are unrelated. |

The Lawyer agent reading "the HR shelf" means reading **master's HR documents**. It
never means reading Sara's workspace.

## 4. Roles and permissions

| | Master | User |
|---|---|---|
| Create / edit / delete agents | yes | no |
| `POST /api/agents/draft` (AI agent generation) | yes | no |
| Choose an agent's model | yes | no |
| See an assigned agent's config | all agents | own only, read-only |
| Create users, assign agents | yes | no |
| Upload files / write notes | yes, Private **or** Shared | yes, always private |
| Read own files, chats, memory, mail | yes | yes |
| Read **another user's** files, chats, memory, mail | yes, via admin screen | no |
| Read master's **shared** shelf items | yes | yes — this is the point |
| Read master's **private** items | yes | no |

**Role lives in the database, on the account — not in an env var.** `MASTER_EMAIL`
is explicitly rejected: the master can change their email address and must not lose
their role. Bootstrap is a one-off script (§9).

## 5. Data model

### 5.1 Users

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';       -- 'master' | 'user'
ALTER TABLE users ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
```

`disabled` exists because the only way to remove a user today is `DELETE`, and every
foreign key is `ON DELETE CASCADE` — deleting an account destroys all of their
documents, chunks, conversations and uploads irreversibly. Disabling is the safe
default action; deleting stays available and must warn.

Disabling a user must also `DELETE FROM sessions WHERE user_id = ?` — the pattern
already exists at [auth.js:141](../../../server/auth.js#L141).

### 5.2 Agent assignment

`agents.user_id` keeps its name and becomes "the owner", which is always the master.
Access is granted through a join table:

```sql
CREATE TABLE agent_assignments (
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  mode       TEXT    NOT NULL DEFAULT 'chat',   -- 'chat' | 'knowledge'
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT DEFAULT extract(epoch from now())::bigint,
  PRIMARY KEY (agent_id, user_id)
);
CREATE INDEX idx_assign_user ON agent_assignments(user_id);
```

**`mode` is the key idea.** It separates *who the user talks to* from *what that
conversation can draw on*:

- `chat` — the agent appears in the user's sidebar and the router may select it.
- `knowledge` — the agent does **not** appear; its shelf is readable in the
  background. This is how a Lawyer gets the HR handbook without getting HR.

`is_primary` matters only when a user has more than one `chat` agent; with exactly
one, [router.js:25](../../../server/router.js#L25) already short-circuits to it.

**Honest limitation, recorded deliberately:** `knowledge` mode hides the *agent*, not
the *content*. A user can extract anything on an attached shelf by asking for it, and
replies already render their sources. Attach shelves you are willing to have quoted
back. It is not a confidentiality boundary.

### 5.3 Sharing

```sql
ALTER TABLE documents ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks    ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false;  -- denormalised, like agent_id
```

`shared` is denormalised onto `chunks` for the same reason `agent_id` already is:
`recall()` must filter without a join.

**Default is `false`.** Master's account is simultaneously the company's shared root
*and* their personal workspace — the `FOLDERS` taxonomy in
[config.js:23-24](../../../server/config.js#L23-L24) includes `'IDs & Personal'` and
`'Financial & Tax'`, so passports and tax papers live here. Sharing must be a
deliberate click; forgetting the toggle must never publish anything.

Users never see the toggle. Their uploads are always private.

### 5.4 Notes and learned facts

Both reuse the `documents` pipeline rather than introducing a new table.
`documents.kind` already exists and currently holds `'doc'` or `'image'`; two values
are added:

- `'note'` — text typed directly into the Shelf screen (§7.3).
- `'fact'` — extracted automatically from a conversation (§7.4).

```sql
ALTER TABLE documents ADD COLUMN origin_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN origin_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;
```

Facts are stored with `user_id = <master>`, `shared = true`, `agent_id = <shelf>`,
and the two `origin_*` columns pointing at where they came from, so a wrong one can
be traced and deleted.

## 6. Retrieval

This is the one query that defines the whole security model.
[knowledge.js:140](../../../server/knowledge.js#L140) becomes:

```sql
   t.user_id = $me                                             -- everything of mine, any agent
OR (t.shared AND (t.agent_id IS NULL OR t.agent_id = ANY($myShelves)))
```

where `$myShelves` is every agent id assigned to me in **either** mode.

Two deliberate asymmetries:

- **My own material has no agent filter.** It is all mine; siloing my files per agent
  buys nothing and blocks the Lawyer agent from reading an invoice I uploaded.
- **Shared material keeps its agent filter.** This one *is* a real boundary — the
  Lawyer shelf must not pull from the HR shelf unless HR was attached.

[files.js:99-101](../../../server/files.js#L99-L101) `libraryCatalog()` takes the
same clause so "what files do I have?" stays consistent with what is retrievable.

**Unchanged and explicitly so:** `memories` stay `WHERE user_id = ?`
([knowledge.js:136-139](../../../server/knowledge.js#L136-L139)). `learn()` writes
things like *"User's name is Sara"* — facts about a **person**. Master's memories must
never flow down. Same for conversations and mailboxes.

## 7. Behaviours

### 7.1 Auto-filing uploads to the right shelf

`classify()` ([files.js:36-55](../../../server/files.js#L36-L55)) already reads every
upload and returns `{title, folder, summary, tags, date}`. It gains one field —
`agent` — chosen from the roster in the prompt. No new call, no extra cost.

The judgement it needs is already written, in
[router.js:8](../../../server/router.js#L8):

> *"Judge attached files by their type and purpose, not by words that merely appear in
> them (an offer letter for an accountant job is an HR matter; a tenancy contract is a
> property matter)."*

Reuse that wording.

**Two bugs this creates if not handled:**

1. **Ordering / split-brain.** `agent_id` is written at INSERT
   ([files.js:28](../../../server/files.js#L28)) but classification happens later, and
   [files.js:65](../../../server/files.js#L65) then indexes chunks from the *stale*
   doc object:
   ```js
   await indexChunks({ ...doc, title: c.title, folder: c.folder }, content);
   //                  ^^^^^ agent_id here is the pre-classification value
   ```
   `chunks` would land on the old shelf while `documents` shows the new one — the file
   is listed under Lawyer and is unretrievable by the Lawyer agent. Fix: carry
   `agent_id: c.agentId` into that spread, after the UPDATE.

2. **Dedup key.** [files.js:22](../../../server/files.js#L22) dedups on
   `(user_id, hash, agent_id)`. `agent_id` is unknown at that point once it is
   classifier-assigned, so re-uploading the same bytes would duplicate whenever the
   classifier chose differently. Drop the key to `(user_id, hash)`.

Unclassifiable items fall back to `agent_id = NULL`, which already means "all of that
user's agents" — a defined fallback, not an accident.

### 7.2 Private / Shared on master's uploads

Master's upload UI gets a two-state control, defaulting to **Private**. The
classifier's `folder` seeds the default: `IDs & Personal` and `Financial & Tax` stay
Private; `Company & Licenses` and `HR & Employees` suggest Shared. The suggestion is
a default, never an automatic decision.

### 7.3 Notes

The Shelf screen gets **Write a note** beside **Upload file**. A note skips text
extraction and runs the identical path — classify, file to a shelf, index.

`processDocument(doc, f, text)` already accepts pre-extracted text as its third
parameter ([files.js:58](../../../server/files.js#L58)), so this needs almost no new
code. Stored as `kind = 'note'`, with `mime`/`size`/`path` null.

Available to users too, for their own private notes.

### 7.4 Learning shareable facts from chat

`learn()` ([knowledge.js:145](../../../server/knowledge.js#L145)) already extracts
durable facts after every exchange and writes them to private memory. It gains a
second destination: facts that are **organisational** rather than **personal** are
written to a shelf as `kind = 'fact'`, `shared = true`.

- *"Sara prefers short answers"* → personal → private memory, as today.
- *"Notice period is 30 days for permanent staff"* → organisational → HR shelf.

There is **no review queue.** It was considered and cut: a weekly approval step does
not survive a real schedule, and a queue nobody empties is worse than none, because it
implies knowledge is being captured when it is not.

**Three guards replace the review step:**

1. **The prompt is biased hard toward "no".** Share only policy, process and general
   rules. Never a named person, a specific case, a salary, or an amount. The existing
   `learn()` system prompt is already written in this cautious style
   ([knowledge.js:151](../../../server/knowledge.js#L151)) — extend it, don't loosen it.
2. **A deterministic block before write** on anything containing a personal name, a
   currency amount, or an ID-like number. Catches what the model misses.
3. **Traceability.** `origin_user_id` and `origin_conversation_id` let master see
   where a fact came from and delete it in one click.

Plus a plain **Company knowledge** list in the admin screen — a list to prune if
master ever wants, never a queue that demands attention.

**Recorded risk:** with no review step, a misclassified fact reaches staff
immediately. The realistic bad case is a chat about one employee's salary or a
disciplinary matter read as general HR knowledge. This was raised, and the automatic
behaviour was chosen deliberately in exchange for zero maintenance.

## 8. Code changes

### 8.1 Server

| File | Change |
|---|---|
| [db.js:93](../../../server/db.js#L93) | schema per §5, plus `DO $$` migration block in the existing style |
| [auth.js:76](../../../server/auth.js#L76) | retire public `POST /register`; stop seeding `DEFAULT_AGENTS` |
| [auth.js:50](../../../server/auth.js#L50) | `publicUser()` exposes `role` so the client can branch |
| [auth.js:59](../../../server/auth.js#L59) | add `requireMaster`; `requireUser` rejects `disabled` accounts |
| [index.js:27](../../../server/index.js#L27) | `own('agents', …)` becomes an assignment check |
| [index.js:46](../../../server/index.js#L46) | `GET /api/agents` returns assigned `mode='chat'` agents; withholds `persona`/`model` from non-master |
| [index.js:49](../../../server/index.js#L49) | `/agents/draft` → master only |
| [index.js:71-92](../../../server/index.js#L71-L92) | agent create/update/delete → master only; drop the "at least one agent" guard |
| [index.js:156](../../../server/index.js#L156) | upload accepts the Private/Shared flag (master only) and the note path |
| [router.js:27](../../../server/router.js#L27) | **add the missing `user_id` filter** (see §10) |
| [chat.js:88](../../../server/chat.js#L88) | team query becomes assignment-based, `mode='chat'` only |
| [knowledge.js:140](../../../server/knowledge.js#L140) | the §6 clause |
| [knowledge.js:145](../../../server/knowledge.js#L145) | `learn()` gains the organisational branch and its guards |
| [files.js:22](../../../server/files.js#L22) | dedup key → `(user_id, hash)` |
| [files.js:36](../../../server/files.js#L36) | `classify()` returns `agent` |
| [files.js:65](../../../server/files.js#L65) | carry the classified `agent_id` into `indexChunks` |
| [files.js:99](../../../server/files.js#L99) | catalogue matches §6 |
| `server/admin.js` | **new** — `/api/admin/*` behind `requireMaster` |

**`/api/admin/*` is a separate router by design.** Every cross-user guard in this app
is `WHERE user_id = ?`. Putting `OR is_master` *inside* those expressions places the
bypass in the same line as the protection — one bad edit leaks for everyone, not just
master. A separate router leaves the normal path untouched and auditable.

Endpoints: list/create/disable users, assign and unassign agents (with `mode`), browse
a user's documents / conversations / mailbox, list and delete company knowledge.

### 8.2 Client

| File | Change |
|---|---|
| [Sidebar.jsx:71](../../../client/src/components/Sidebar.jsx#L71) | hide "New agent" for non-master |
| [Sidebar.jsx](../../../client/src/components/Sidebar.jsx) | **rename the "Files" label to "Shelf"** throughout |
| [AgentSheet.jsx](../../../client/src/components/AgentSheet.jsx) | read-only for non-master; hide Save / Delete / Draft / model picker |
| [Knowledge.jsx](../../../client/src/components/Knowledge.jsx) | "Shelf" heading; **Write a note**; Private/Shared toggle for master |
| [App.jsx:72](../../../client/src/App.jsx#L72) | empty state when a user has no agents yet (see §10) |
| `Admin.jsx` | **new** — master's screen for users, assignments, oversight, company knowledge |

Client-side hiding is cosmetic. **Every restriction is enforced server-side.**

## 9. Bootstrap and migration

**Bootstrap:** `scripts/make-master.js <email>`, matching the existing
`scripts/reset-password.js` pattern. Sets `role = 'master'` on that account. Master can
later grant the role to another account from the admin screen. No env var.

**Existing production data:** the live database already has real accounts, each seeded
with their own copy of `DEFAULT_AGENTS`. Migration:

1. Promote the chosen account to master; their agents remain theirs.
2. For every other user, create `agent_assignments` rows so they keep what they
   currently have, and leave the underlying rows in place.
3. Do **not** auto-delete the duplicated default agents — consolidating them onto
   master's copies is a manual follow-up, and cascading deletes here would destroy the
   documents attached to them.

Existing documents and chunks migrate with `shared = false`, matching the
private-by-default rule.

## 10. Bugs and gaps found while designing

These exist in the current code or appear as a direct consequence of the change.

1. **Cross-user document leak in the router.**
   [router.js:27](../../../server/router.js#L27) selects documents by `agent_id` with
   **no `user_id` filter**. Harmless today only because the ids come from the caller's
   own agents. The moment an agent is shared, one user's router prompt lists another
   user's filenames. Must be fixed as part of this work.

2. **Zero-agent users crash the app.**
   [router.js:20](../../../server/router.js#L20) does `fallback = agents[0]`; with an
   empty team that is `undefined` and `chat.js` dies on it. On the client,
   [App.jsx:72](../../../client/src/App.jsx#L72) gates the whole chat on
   `agents.length > 0`, so a freshly created user sees a blank screen. Needs a real
   empty state, and new users should be auto-assigned the general assistant.

3. **Deleting an agent destroys other users' files.** `documents.agent_id` and
   `chunks.agent_id` are `ON DELETE CASCADE`
   ([db.js:147](../../../server/db.js#L147), [db.js:170](../../../server/db.js#L170)).
   Deleting a shared agent wipes every assigned user's uploads for it. Unassigning must
   be a distinct operation, and deleting must warn with a count.

4. **Split-brain on classified uploads** — see §7.1, item 1.

5. **Dedup key** — see §7.1, item 2.

## 11. Out of scope

Considered and deliberately excluded:

- **Agent-to-agent consultation** (Lawyer agent queries HR agent mid-answer). It
  cancels out the access model: if any agent can request anything from another, master's
  assignments stop controlling anything. Access is granted by assignment, not through a
  side door. `mode='knowledge'` covers the real need.
- **Reading another user's chat history for retrieval.** Chats stay private. Facts
  reach shelves through §7.4, not by traversing transcripts.
- **Re-filing the library when agents change.** Adding an HR agent later leaves
  existing documents where they are. A "re-file" action is the answer and is YAGNI now.
- **Copy-on-assign agents.** Rejected in favour of share-by-reference so master's edits
  propagate.
- **A review queue for learned facts.** Cut — see §7.4.
- **Per-user API spend limits.** Real, but separate work.

## 12. Decision log

| Decision | Chosen |
|---|---|
| Agent assignment model | Share by reference, not copy |
| Master identity | `users.role` column; **not** `MASTER_EMAIL` |
| Master's uploads | Private/Shared toggle, **defaulting to Private** |
| Cross-role knowledge | `mode='knowledge'` shelves, not agent-to-agent calls |
| User's own files across their agents | Visible to all of their agents |
| Learned facts from chat | Automatic, no review queue, three guards |
| Master reads staff mailboxes | **Yes** |
| Master reads staff files and chats | Yes, via a separate admin router |
| "Files" label | Renamed **"Shelf"** |

---

## Next step

Implementation plan via the `writing-plans` skill. Suggested sequencing, since the
schema underpins everything:

1. Schema + `requireMaster` + bootstrap script
2. Assignments, and the retrieval clause in §6
3. Lock down the agent write routes; retire public registration
4. The four bugs in §10
5. Auto-filing, Private/Shared, notes, the "Shelf" rename
6. Admin screen
7. Learned facts and their guards
