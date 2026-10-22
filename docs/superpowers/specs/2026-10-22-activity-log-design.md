# Activity log — design (lease app, branch `leasing-bookings`)

Date: 2026-10-22. Target: the lease app on the USA server (52.205.130.59). Never `main`.

## Why

Francis wants to always be able to answer "who did what, and when" across the whole lease
app — for example, who changed or deleted a payment and nobody knew. He also wants it to
stay complete as the app grows: a feature added tomorrow must be recorded without anyone
remembering to wire it in. And he wants to ask the AI chat about it in plain words:
"how much did Jeff collect this week?", "who deleted a payment?", "what did Maria do today?".

## Goals

1. **Every change is recorded** — every insert, update and delete, in every table, with
   who did it, when, and **what changed (old value → new value)**.
2. **Automatic for future features.** New tables are covered with no extra code.
3. **Changes made through the AI chat are recorded too**, marked as made via chat
   ("Francis (via chat)").
4. **Who can see it:** the master, plus anyone the master ticks with a new **"Activity"**
   module on their People profile (Francis chose option A: one tick, sees the whole log —
   not per-module filtering).
5. **Searchable from the AI chat** by anyone who holds the Activity module, so
   questions about people, records, actions and dates are answered from the log.
6. **An Activity screen** in the left menu (for holders of the module) listing entries
   newest first, filterable by person, date range, kind of record, and action
   (added / changed / deleted), each entry showing the changed fields old → new.

## Scope (Francis's decisions)

- Whole app, **including personal things** — to-dos, routines, chats with the AI,
  messenger, email drafts — not just business records. He said: "yes log that also".
- **Activity holders see everything the master sees in the log, full text included** —
  other people's AI chats, messenger messages and email drafts (Francis confirmed twice,
  2026-10-22, knowing it exposes private content). No per-viewer filtering. Long text is
  still trimmed at ~500 characters per value.
- Viewing / opening screens is **not** logged; only changes.
- Detail level: **show what changed**, e.g. "amount $950 → $850".

## How it works (my calls, stated so they can be checked)

### Capture: database triggers
- A single PL/pgSQL trigger function writes one row per changed row into a new
  `activity_log` table: `id, at (timestamptz), actor_user_id, via ('screen'|'chat'|'system'),
  table_name, row_id, action ('insert'|'update'|'delete'), old (jsonb), new (jsonb),
  changed (text[] of column names, for updates)`.
- On every boot, the app attaches that trigger (AFTER INSERT/UPDATE/DELETE, FOR EACH ROW)
  to **every table in the schema that does not have it yet**, minus a short skip-list.
  That is what makes future features covered automatically: a new `CREATE TABLE` in
  `db.js` is picked up on the next start. (Event triggers need superuser, which the app's
  role is not — so the boot-time sweep is the mechanism.)
- **Skip-list (machine-only tables, no human action, would flood the log):** `activity_log`
  itself, `sessions`, `password_resets`, `chunks` (embeddings), `error_log`,
  `push_subscriptions`, `reminders_sent`, `lease_alerts_sent`, `suggestion_scans`,
  `saifsys_runs`, `building_jobs_seen`, `chat_recaps`, `lease_import_reads`. The list lives
  in one place in code with a comment; adding to it is a deliberate act.
- Updates where no column actually changed are not logged. `updated_at`-style timestamp
  columns alone do not count as a change.
- **Big values are trimmed** before storage: text longer than ~500 characters is cut with
  "…"; vector/bytea columns and password/token/secret columns (`password_hash`,
  `token_hash`, anything `*_enc`, `*secret*`, `*pass*`) are replaced with `"[hidden]"` —
  the log must never hold passwords or keys.
- Cascaded deletes (e.g. deleting a lease removes its payments) are each logged, all with
  the same actor — so "who deleted a payment" is answerable even when it went with a lease.

### Who did it: actor passed to the database
- The app already uses `AsyncLocalStorage` in `server/db.js`. Add a second store holding
  `{ userId, via }`, set by a middleware right after `requireUser` (via = 'screen') and by
  the chat when it runs a tool (via = 'chat', userId = the person chatting).
- Every write runs with `set_config('app.actor', …, true)` / `app.via` in its transaction
  so the trigger reads them via `current_setting(..., true)`. Writes outside a `tx()` are
  wrapped in a tiny transaction for this. Builder decides the exact mechanics; the
  requirement is that **every write made while handling a signed-in request or a chat turn
  carries that person**, and writes with no actor are recorded as `via = 'system'`
  (background jobs: email sync, scheduled reminders, alerts).

### Reading: readable entries
- A small labels map turns tables and columns into words ("lease_payments" → "Payment",
  "received_on" → "Received on"), plus a "what is this about" line per entry (tenant name,
  unit no., lease ref) where it can be found from the row. Unknown (future) tables still
  show, with a tidied table name — never hidden for lack of a label.
- Money is formatted with the region currency; ids pointing at people/units/tenants are
  shown by name where cheap.

### AI chat
- New chat tool `activity_search` (in its own kit, given only to Activity holders):
  filters for person (name, part ok), record kind, action, text match on the record,
  date range; returns entries with old → new values. Plus a `summary` mode that totals
  (e.g. sum of payment amounts **recorded by** a person in a range; count of deletes).
- "How much did Jeff collect" = payments added by Jeff in the range, minus ones later
  deleted, answered from the log (and cross-checkable with `lease_payments.recorded_by`).
- Someone without the module who asks gets told they don't have access to the activity log.
- The chat's own changes are logged as above.

### Access
- New module `{ key: 'activity', label: 'Activity' }` in `server/modules.js` `MODULES`;
  `/api/activity` route readable by holders, nobody can write.
- **The log cannot be edited or deleted from the app by anyone, master included.**
  (Anti-goal: a log someone can clean up.)

### Retention
- Kept indefinitely. Index on `(at DESC)`, `(actor_user_id, at DESC)`, `(table_name, row_id)`.

## Non-goals
- No logging of page views, reads, or logins (logins could be a later add).
- No undo/restore from the log.
- Not on `main` / Reem.

## Anti-goals (failure even if it "works")
- A change that is not in the log, because it came from a new feature, the chat, or a
  cascade.
- Passwords, tokens or keys stored in the log.
- Entries that only a developer can read (raw table/column names with no wording).
- A noticeable slowdown of normal saves.

## Future-features rule
Add to the repo's guidance (and Claude's memory) that the activity log is automatic: new
tables are covered by the boot sweep; a new table that is pure machine state must be added
to the skip-list on purpose; a new table should get a label in the labels map; any new chat
tool that writes must run inside the chat's actor context (it does, if it goes through the
existing kit runner).

## Calls made after the builder check (mine, for Francis to check)
- **Secrets:** hiding also covers any column named like `*token*`, `*key*`, `*_enc`,
  `*secret*`, `*pass*` (e.g. `outlook_accounts.access_token`). The app's database role
  may only INSERT into `activity_log` (no UPDATE/DELETE grant), so the app can never alter
  it; a superuser-only cleanup in psql stays possible for a secret that slips through.
- **Background writes** (`via = 'system'`) are logged in full like everything else, but
  the Activity screen and the chat hide them unless asked ("show system"). Bulk imports
  started by a person are that person's, not system.
- **"How much did X collect"** = sum of `lease_payments.amount` with `recorded_by = X`
  and `received_on` in the range, from the live table (so it matches the Leasing screens
  and covers history before the log existed), plus from the log: payments X added that
  were later deleted or changed, listed separately.
- Each entry stores the actor's name at write time, so it still reads right if the
  account is later removed.

## Left to the builder
Exact trigger SQL, how `set_config` is threaded through `db.js`, the Activity screen's
layout (follow existing screens and the themed `Select.jsx`, no native `<select>`), label
wording, tests (Postgres-backed, as the existing suite).
