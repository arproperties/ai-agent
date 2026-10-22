# Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every insert/update/delete in the lease app with who, when, via what and old → new values; show it to the master and Activity-module holders on a screen and through the AI chat.

**Architecture:** One PL/pgSQL trigger function writes to `activity_log`; a boot-time sweep attaches it to every table not on a skip-list (so new tables are covered). The acting person travels in `AsyncLocalStorage` and reaches Postgres as `set_config('app.actor'/'app.via', …, true)` on every write. A reader (`server/activity.js`) turns rows into readable entries for `/api/activity`, an `activity_search` chat tool and an Activity log screen.

**Tech Stack:** Node 22 ESM, Express 5, node-postgres, PostgreSQL 18, React (client/), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-22-activity-log-design.md`

## Global Constraints
- Branch `leasing-bookings` only; nothing pushed or deployed until Francis says so.
- Log never stores secrets: any column whose name matches `/pass|token|secret|key|_enc$|hash/i`, and vector/bytea columns → `"[hidden]"`.
- Text values longer than 500 characters are cut to 500 + `…`.
- Updates where only ignored columns changed (`updated_at`, `last_seen_at`) are not logged.
- `activity_log` rows cannot be UPDATEd or DELETEd (trigger raises); no app route writes it.
- `via` is one of `screen`, `chat`, `system`; no actor ⇒ `system`.
- Module key `activity`, label `Activity`.
- No native `<select>`; use `client/src/components/Select.jsx`.
- Existing screen panel `'activity'` is "My activity" (access log) — the new screen uses panel `'activitylog'`.

## Review Focus
1. A lease deleted with its payments (ON DELETE CASCADE) → each payment delete is logged with the deleter as actor. Test in Task 2.
2. `recordSeen` updating `users.last_seen_at` on every request → no log rows. Test in Task 1.
3. A write inside `tx()` and a write outside it both carry the actor. Test in Task 2.
4. A table created after boot (future feature) gets the trigger on the next sweep. Test in Task 1.
5. A non-holder calling `/api/activity` or the chat without the tool → 403 / tool absent. Test in Tasks 3 and 4.

---

### Task 1: Capture — table, trigger, boot sweep

**Files:**
- Create: `server/activityCapture.js`
- Modify: `server/index.js` (call sweep once at start, after all routers imported), `tests/helpers/db.js` (add `'activity_log'` to `TABLES`; call `attachActivityTriggers()` once after import)
- Test: `tests/activity-capture.test.js`

**Interfaces:**
- Produces: `export async function attachActivityTriggers(): Promise<string[]>` (returns table names newly attached); `export const SKIP_TABLES: Set<string>`; table `activity_log(id bigserial pk, at timestamptz default now(), actor_user_id int null, actor_name text null, via text not null, table_name text not null, row_id text null, action text not null check in ('insert','update','delete'), old jsonb, new jsonb, changed text[])` with indexes `(at desc)`, `(actor_user_id, at desc)`, `(table_name, row_id)`.

`SKIP_TABLES` = `activity_log, sessions, password_resets, chunks, error_log, push_subscriptions, reminders_sent, lease_alerts_sent, suggestion_scans, saifsys_runs, building_jobs_seen, chat_recaps, lease_import_reads`.

Trigger reads `current_setting('app.actor', true)` (int or empty) and `current_setting('app.via', true)`; `actor_name` from `users.name` at write time; `row_id` = `new.id`/`old.id` as text when an `id` column exists. Hiding/trimming done inside the trigger function (jsonb walk over top-level keys). Sweep: `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()` minus SKIP minus those having trigger `activity_capture`.

- [ ] **Step 1: Failing tests** — `activity-capture.test.js`:
  - `insert, update, delete of a todo are each logged with old/new` — after insert: one row action `insert`, `new.title` equals the title, `old` null; after update of title: `changed` deep-equals `['title']`, `old.title`/`new.title` right; after delete: action `delete`, `old.title` set.
  - `no actor means via system and null actor`.
  - `secrets are hidden and long text trimmed` — insert into `users` → `new.password_hash === '[hidden]'`; a 600-char todo title → `new.title.length === 501` ending `…`.
  - `last_seen_at alone is not logged` — `UPDATE users SET last_seen_at = 5` adds 0 rows.
  - `a table created later is picked up by the next sweep` — `CREATE TABLE zz_future (id serial primary key, x text)`, sweep returns `['zz_future']` among its result, insert logs one row; drop it after.
  - `the log cannot be changed` — `UPDATE activity_log SET via = 'x'` rejects; `DELETE FROM activity_log` rejects.
  - `skipped tables are not logged` — insert a session row → 0 rows for `sessions`.
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$DATABASE_URL_test" node --test --test-force-exit --test-concurrency=1 tests/activity-capture.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement `server/activityCapture.js` (DDL with `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, guard trigger on `activity_log` blocking UPDATE/DELETE, sweep). Header comment states the future-features rule.
- [ ] **Step 4:** Run → PASS. Run the whole suite → still green.
- [ ] **Step 5:** Commit `feat: Activity log: every change in every table is written down, old and new`.

### Task 2: Who did it — actor through db.js, middleware, chat

**Files:**
- Modify: `server/db.js` (actor store, `run`, `tx`), `server/index.js` (mount `actorContext` after `requireUser`), `server/chat.js:389` (tool runs with via `chat`)
- Create/extend: `server/activityCapture.js` export `actorContext`
- Test: `tests/activity-actor.test.js`

**Interfaces:**
- Produces in `server/db.js`: `export function withActor(actor: {userId:number, via:'screen'|'chat'}, fn: () => Promise<T>): Promise<T>`; `export const currentActor: () => actor|undefined`.
- Produces in `server/activityCapture.js`: `export function actorContext(req, res, next)` — `withActor({ userId: req.user.id, via: req.path === '/chat' ? 'chat' : 'screen' }, next)`.

`run`: when an actor is set and the SQL is a write (`/^\s*(insert|update|delete|with)\b/i`): inside a `tx` client → issue `SELECT set_config('app.actor',$1,true), set_config('app.via',$2,true)` once per transaction (track on the client); outside → take a pool client, BEGIN, set_config, query, COMMIT. `tx()` sets config right after BEGIN when an actor is present.

- [ ] **Step 1: Failing tests:**
  - `a write under withActor is logged with that person and via` — actor_user_id = sara, actor_name 'Sara', via 'screen'.
  - `a write inside tx under withActor carries the actor`.
  - `deleting a lease logs its payments' deletes with the same actor` — build tenant/unit/booking/installment/payment via existing helpers in `server/leasing.js` (as `leasing-money.test.js` does), delete the booking under `withActor`, assert a `lease_payments` delete row with actor sara.
  - `the middleware marks /chat as chat and others as screen` — tiny express app with fake `req.user`, POST `/chat` writes a todo → via `chat`; POST `/x` → `screen`.
  - `reads under an actor are untouched` — `SELECT 1` works and adds no rows.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `chat.js` wrap `kitFor(b.name)…run(b)` in `withActor({ userId: user.id, via: 'chat' }, …)`.
- [ ] **Step 4:** Run new + whole suite → PASS.
- [ ] **Step 5:** Commit `feat: Activity log: each change carries who made it, from the screens or the chat`.

### Task 3: Reading — readable entries, module, route

**Files:**
- Create: `server/activity.js`
- Modify: `server/modules.js` (`{ key: 'activity', label: 'Activity' }` appended to `MODULES`; RULE `[/^\/activity(\/|$)/, ['activity'], MASTER]` — nobody writes), `server/index.js` (`app.use('/api/activity', activityRoutes)`), `tests/modules.test.js` (`ALL` gains `'activity'`)
- Test: `tests/activity-read.test.js`

**Interfaces:**
- Produces: `export async function listActivity(f: { person?: string, userId?: number, kind?: string, action?: 'insert'|'update'|'delete', text?: string, from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', system?: boolean, limit?: number (default 100, max 500), before?: number }): Promise<Entry[]>`
- `Entry = { id, at (ISO), who: string ('System' when none), via, kind: string (label), table, row_id, action, about: string|null, changes: [{ field: label, from, to }] }` — for insert `from` null, delete `to` null; only `changed` columns for updates; id/created_at columns omitted from insert/delete lists.
- `export const LABELS: Record<table, { name: string, about?: (row) => string, fields?: Record<col,string> }>`; unknown table → name from `table_name` with prefix (`lease_`, `prop_`) dropped and `_` → space, capitalised; unknown column likewise.
- `export function kinds(): { key, label }[]` for the filter list (tables seen in the log).
- Routes: `GET /api/activity?person&kind&action&text&from&to&system&before` → `{ entries, kinds }`.

Labels to cover at least: lease_payments (Payment; about: amount + received_on), lease_bookings (Lease), lease_tenants (Tenant; about full_name), lease_installments (Charge), prop_units (Unit; unit_no), prop_buildings, prop_companies, lease_work_orders (Work order), prop_inspections, users (Person; name), module_access (Module access), todos (To-do; title), routines, messages (Chat message), dm_messages (Staff message), email_drafts, lease_settings, lease_sources, lease_services. Money fields shown with region currency (`cash()` from `server/leasingRegion.js`).

`text` filter: `old::text ILIKE` or `new::text ILIKE`; `person` matches `actor_name ILIKE`; dates in the region time zone; `system` false ⇒ `via <> 'system'`.

- [ ] **Step 1: Failing tests:** `an edited payment reads "Amount $950 → $850" with who and when`; `person, action, date and text filters narrow`; `system entries hidden unless asked`; `an unknown table still reads with a tidy name`; `route: master 200, holder 200, non-holder 403`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run new + suite → PASS.
- [ ] **Step 5:** Commit `feat: Activity log: readable entries and an Activity tick on the People profile`.

### Task 4: AI chat — `activity_search`

**Files:**
- Create: `server/activityKit.js`
- Modify: `server/chat.js` (add `activityKit(user)` to `kits` only when `modules.includes('activity')`)
- Test: `tests/activity-kit.test.js`

**Interfaces:**
- Consumes: `listActivity` (Task 3).
- Produces: `export const ACTIVITY_TOOLS` (one tool `activity_search`), `export function activityKit(user): Kit` (same `{definitions, status, run}` shape as `todoKit`).
- Tool input: `{ mode: 'entries'|'collected', person?, kind?, action?: 'added'|'changed'|'deleted', text?, from?, to?, include_system? }`. `entries` → up to 100 readable lines `"2026-10-22 10:14 · Jeff (via chat) · changed Payment (GSL 101, $950 on 2026-10-01): Amount $950 → $850"`. `collected` → requires `person`; sum of `lease_payments.amount` where `recorded_by` = that person and `received_on` in range (default this month), count, plus list of that person's payments later deleted or changed (from the log). Result states the currency.
- Description tells the model: use for any question about who did what, when, what changed, who deleted, how much someone collected.

- [ ] **Step 1: Failing tests:** `collected sums Jeff's payments in range and lists his deleted one`; `entries mode finds who deleted a payment`; `the kit is absent for a user without the module` (via a helper that builds the kit list or by testing `activityKit` guard).
- [ ] **Step 2–4:** fail → implement → pass (+ suite).
- [ ] **Step 5:** Commit `feat: Activity log: ask Riley who did what, and how much someone collected`.

### Task 5: Activity log screen

**Files:**
- Create: `client/src/components/ActivityLogPage.jsx`
- Modify: `client/src/components/Sidebar.jsx` (place `{ module: 'activity', Ico: History, label: 'Activity log', hint: 'Who changed what, and when', onClick: onActivityLog }`, after Sources), `client/src/App.jsx` (panel `'activitylog'`, render page, pass handler)

Page: back header like `SourcesPage`; filters row — person text box, kind (`Select.jsx`), action (`Select.jsx`: All / Added / Changed / Deleted), from/to dates, "Show system" toggle; list newest first: time, who (+ "via chat" chip), action word, kind, about; changes as `Field: from → to` lines (strike-through old). "Load more" uses `before`.

- [ ] **Step 1:** Build page and wiring. **Step 2:** `npm run build` → succeeds. **Step 3:** Start dev server, open the page as master, make a payment edit, see it listed.
- [ ] **Step 4:** Commit `feat: Activity log: a screen listing who changed what`.

### Task 6: Remember for future features
- Add memory note `activity-log-rule` (Claude memory) + MEMORY.md line: new tables auto-logged; machine-only tables go in `SKIP_TABLES`; add a `LABELS` entry; new chat tools run under the chat actor automatically.
- The same rule sits in the header comment of `server/activityCapture.js`.
