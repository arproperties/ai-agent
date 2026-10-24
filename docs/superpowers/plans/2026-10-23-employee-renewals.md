# Employee Renewals + Shelf Expiry Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employee and company documents live on the Reem Shelf. The Shelf alerts on every expiring document. An employee's contract nearing its end opens an **Employee Renewals** case, which runs Renew or Termination through approval and the PRO.

**Architecture:** The Shelf (`documents` table) stays the one store for files. Each file can belong to a **category** (Employee Documents, Company Documents, and any the master adds later, e.g. Vehicle Documents) and a **type** in it (Passport, Trade Licence...). Categories and types are rows in the database that the master manages from settings, not code, so a new kind of document needs no developer. A file in any category is seen and alerted to the master plus whoever has the one module **Document Renewals** (`document_renewals`) ticked. A category marked *private* (Employee Documents) is also hidden from `shared` and `file_access`. A daily job sends the alerts. The same module opens contract cases from files whose type is marked *opens a renewal case* (Labour Contract). saifsys still holds the employee profile, salary and payroll, which Reem reads through the Jarvis API. After approval, only salary or exit fields are written back to saifsys.

**Tech Stack:** Reem: Node/Express, Postgres (`server/db.js`), React (`client/src/components`), `node --test`. saifsys: PHP 8 + PDO/MariaDB, plain PHP tests in `saifsys/tests/`.

**Spec:** Francis's developer brief (pasted 2026-10-23) plus the decisions recorded below. There is no separate spec file.

## Decisions (Francis, 2026-10-23)

1. Long-term goal: staff use only Reem. saifsys is emptied module by module. Payroll/WPS moves last.
2. Employee documents are stored on the **Reem Shelf**, not saifsys. Profile, salary and payroll stay in saifsys for now.
3. Expiry alerts cover **every** Shelf document, not only employee ones.
4. Alerts go to **the master + the people with the matching module ticked**.
5. **One module, Document Renewals**, covers employee documents, company documents and the contract renewal cases (changed 23:48 from two modules). Whoever has it ticked also sees passports and visas.
6. Only an employee's Work Contract opens a renewal case. Every other document just gets reminders.
7. **Categories are a list, not code.** Francis may add another kind later (like Employee / Company Documents); the master adds it in settings with its types.

Decided by me where Francis was silent (change if he disagrees): a file with no category (personal paperwork) alerts **its owner only**.

## Facts found while planning

- The Shelf already reads `expires_on` with AI on upload (`server/files.js:84-85`, `classify()`), lets a person correct it (`PATCH /api/documents/:id`, `server/index.js:323`) and lists expiring files (`expiringDocuments`, `server/files.js:312`). **Nothing sends an alert yet.**
- Who may read a file today: `retrievalScope()` (`server/knowledge.js:359`): owner, `shared` (published by the master to everyone) and `file_access` viewers. The master reaches everything through `masterReach()`.
- saifsys (local copy, data to 2026-10-10): 194 employees, **0** visa dates, **0** Work Contract documents, 6 employee documents in total (4 passports, 2 Emirates IDs). Those 6 are imported once (Task 6); the rest HR uploads to the Shelf.

## Global Constraints

- One module: key `document_renewals`, label **Document Renewals**, `company: true`.
- Alert days: **60, 30, 14** before expiry, then on the day after expiry, then every **7** days until the file is replaced or marked "Not renewing". These are settings, not constants.
- Dubai dates throughout (`dubaiDate()` from `server/saifsys/client.js`).
- A push or to-do never carries document content: title, who or what it's for, days left and a link. Nothing else.
- An `employee` file is **never** visible through `shared` or `file_access`. It's visible only to its uploader, the master and `document_renewals` holders, and that applies to chat agents too (search_files, recall).
- A date AI read counts as **unconfirmed** until a person confirms it. An unconfirmed date sends a "Is <date> correct?" alert, and never opens a renewal case.
- "Terminate" means start a termination review. Nothing changes in saifsys until the approvals are recorded and HR has verified the documents.
- AI reads and flags. AI never decides renew vs terminate and never approves a change.
- Every decision, approval, file open and write-back lands in the case timeline (`employee_renewal_events`).
- Reem changes: branch `feat/employee-renewals` → PR → Francis merges. saifsys changes are committed in the saifsys repo. Nothing is deployed until Francis says so.
- Screens: show Francis two layout options before building each new screen. Use the themed `Select.jsx`, never a native `<select>`.

## Review Focus

1. **A passport filed under a private category must not leak.** Expected: someone with `file_access` to the uploader, or a file the master published, still can't open it or have an agent quote it. Test in Task 2 (`employee file ignores shared and file_access`).
2. **A renewed document uploaded next to the old one.** Expected: the old one stops alerting (`superseded_by`), with no alerts for both. Test in Task 5 (`newer file of same type stops the old alerts`).
3. **The same alert sent twice** (job restarts, or two servers). Expected: one alert per file per step, recorded in `document_alerts` with a unique key. Test in Task 5 (`restart does not resend`).
4. **AI files someone's visa against the wrong employee.** Expected: the employee link counts as unconfirmed like the date, and the renewal case waits for HR to confirm both. Test in Task 3 (`employee link is unconfirmed until a person confirms`) and Task 8.
5. **An external person or someone without the module.** Expected: an employee file is invisible to them, and they get no alerts even if they uploaded a company file. Test in Task 2 (`external person never sees categorised files`) and Task 5.
6. **The master adds a new category, or retires one that has files.** Expected: a new category works for upload, AI filing, alerts and the screen with no code change; a retired one can't be picked for new files, but its existing files keep their category and alerts. Test in Task 1 (`retired category keeps its files`) and Task 5 (`a category added later alerts like the seeded ones`).

---

## File Structure

**Reem** (`D:\Francis\projects\2026\Apps\Solutions\ai-agent`)
- Modify `server/db.js`: new columns on `documents`; tables `document_alerts`, `document_alert_settings`, `employee_renewals`, `employee_renewal_events`, `employee_renewal_tasks`.
- Modify `server/modules.js:23`: the `document_renewals` module.
- Create `server/docCategories.js`: categories and types (read, cache, master edits).
- Modify `server/knowledge.js:359` (`retrievalScope`) and `server/access.js` (`masterReach` stays as is): the category rule.
- Modify `server/files.js` (`classify`, `processDocument`, `expiringDocuments`).
- Modify `server/index.js:323` (PATCH document): category, type, employee/subject, confirm.
- Create `server/documentAlerts.js`: the daily alert job and its routes.
- Create `server/saifsys/hrRenewals.js`: the client for the new saifsys door.
- Create `server/employeeRenewals.js`, `server/employeeRenewalCompare.js`, `server/employeeRenewalAi.js`.
- Create `scripts/import-saifsys-employee-docs.js`: the one-time import.
- Client: Shelf file panel (category / type / employee or subject / confirm), `client/src/components/DocumentRenewals.jsx` (tabs Documents / Contract cases), `EmployeeRenewalCase.jsx`, `SettingsMenu.jsx` row.
- Tests: `tests/shelf-classes.test.js`, `tests/documentAlerts.test.js`, `tests/employeeRenewals.test.js`, `tests/employeeRenewalCompare.test.js`, `tests/employeeRenewalAi.test.js`.

**saifsys** (`D:\Francis\projects\2026\Apps\Solutions\saifsys`)
- Create `api/jarvis/v1/modules/hr_renewals.php` (read: `payroll`, `documents`, `document_file`); add it to `JARVIS_MODULES` in `api/jarvis/v1/index.php:28`.
- Create `api/jarvis/v1/modules/hr_renewal_act.php` (write: `renew`, `terminate`); add it to `JARVIS_ACT_MODULES` in `api/jarvis/v1/act.php:26`.
- Modify `hr/documents.php`: uploads locked, with a note "Employee documents are now kept in Reem".
- Tests: `tests/jarvis_hr_renewals_test.php`, `tests/jarvis_hr_renewal_act_test.php`.

---

## Phase A: Shelf categories (who sees what)

### Task 1: Categories, types, columns and the module

**Files:** `server/db.js`, create `server/docCategories.js`, `server/modules.js:23`; test `tests/shelf-classes.test.js`.

**Tables:**
- `document_categories`: `id`, `label TEXT UNIQUE`, `private BOOLEAN` (hidden from `shared` / `file_access`), `links_to TEXT` (`'employee'` = the file is for a saifsys employee; `'subject'` = for a free-text company / plate / policy), `active BOOLEAN DEFAULT true`, `sort INT`.
- `document_types`: `id`, `category_id`, `label`, `opens_case BOOLEAN DEFAULT false`, `active BOOLEAN DEFAULT true`, `sort INT`. `UNIQUE (category_id, label)`.
- Seeded once (insert only if the table is empty):
  - **Employee Documents** (`private true`, `links_to 'employee'`): Passport, Residence Visa, Emirates ID, Labour Contract (`opens_case true`), Labour Card, Health Card, Driving Licence, Other employee document.
  - **Company Documents** (`private false`, `links_to 'subject'`): Trade Licence, Establishment Card, Insurance Policy, Vehicle Registration (Mulkiya), Tenancy Contract (Ejari), Other company document.
- No code may test a category by its label or id. Behaviour comes only from `private`, `links_to` and `opens_case`.

**Schema (on `documents`):**
- `category_id INTEGER REFERENCES document_categories(id)`, `type_id INTEGER REFERENCES document_types(id)` (NULL = personal file)
- `employee_code TEXT`, `employee_name TEXT` (when `links_to 'employee'`, from saifsys HR)
- `subject TEXT` (when `links_to 'subject'`: the company, vehicle plate or policy it's for)
- `expiry_confirmed_by INTEGER REFERENCES users(id)`, `expiry_confirmed_at BIGINT`
- `link_confirmed_by INTEGER`, `link_confirmed_at BIGINT` (the employee link)
- `superseded_by INTEGER REFERENCES documents(id) ON DELETE SET NULL`
- `not_renewing_at BIGINT`, `not_renewing_note TEXT`
- Index `idx_docs_category ON documents(category_id, expires_on) WHERE category_id IS NOT NULL`.

**`server/docCategories.js`:**
- `listCategories({ includeRetired = false }) -> [{ id, label, private, links_to, active, types: [{ id, label, opens_case, active }] }]`, cached in memory and cleared on every edit.
- `typeById(id) -> { id, label, opens_case, category: {...} } | null`.
- Routes (master only for writes): `GET /api/doc-categories`, `POST /api/doc-categories` `{ label, private, links_to }`, `PATCH /api/doc-categories/:id` `{ label, active, sort }`, `POST /api/doc-categories/:id/types` `{ label, opens_case }`, `PATCH /api/doc-types/:id` `{ label, active, opens_case }`. There's no delete: retiring (`active false`) keeps old files intact. `private` and `links_to` can't change once a category has files.

**Module:**
- `{ key: 'document_renewals', label: 'Document Renewals', about: 'Employee and company documents (visas, contracts, trade licences, insurance): see them, get their expiry alerts, and renew or end employee contracts with approvals and the PRO.', company: true }`

- [ ] **Step 1:** Failing tests: `modules list document_renewals`, `seed creates the two categories once`, `only the master adds a category or type`, `retired category keeps its files` (retire → `listCategories()` hides it, old file still has it), `private cannot change once files exist`.
- [ ] **Step 2–4:** fail → implement → pass (`npm test -- tests/shelf-classes.test.js`).
- [ ] **Step 5: Commit** `feat(shelf): document categories and types the master manages; Document Renewals module`.

### Task 2: The visibility rule

**Files:** `server/knowledge.js:359`, `server/shelf.js:103`, `server/files.js` (`readableDocuments`, `readableDocument`); test `tests/shelf-classes.test.js`.

**Interfaces:**
- `retrievalScope(userId, t)` keeps its signature (sync, `{ sql, params }`). New SQL:
  ```
  ( t.user_id = ?
    OR (NOT EXISTS (SELECT 1 FROM document_categories dc WHERE dc.id = t.category_id AND dc.private)
        AND (t.shared OR t.user_id IN (SELECT owner_id FROM file_access WHERE viewer_id = ?)))
    OR (t.category_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM module_access ma JOIN users u ON u.id = ma.user_id
          WHERE ma.user_id = ? AND NOT u.external
            AND ma.module = 'document_renewals')) )
  ```
  with params `[userId, userId, userId]`. The master keeps `masterReach()`. Check every caller of `agentScope`/`retrievalScope` for the extra param (`grep -rn "retrievalScope\|agentScope" server`).
- `ownFilesOnly` (private agents) is unchanged: own files only.

- [ ] **Step 1: Failing tests:**
  - `module holder sees employee files of others`.
  - `employee file ignores shared and file_access` (viewer with `file_access` to the uploader and the file `shared = true` → not readable, not in `readableDocuments`, not returned by `search_files`).
  - `company file still follows shared and file_access`.
  - `external person never sees categorised files` (external user with a stale `document_renewals` row in `module_access` → nothing).
  - `master sees all`.
- [ ] **Step 2–4:** fail → implement → pass. Then run the whole suite: nothing new failing beyond the known unrelated failures.
- [ ] **Step 5: Commit** `feat(shelf): employee files are seen only by the master and Employee Renewals`.

### Task 3: AI fills category, type and employee on upload

**Files:** `server/files.js` (`classify`, `processDocument`); test `tests/shelf-classes.test.js`.

**Interfaces:**
- Consumes: `askSaifsys('hr', 'employees', { status: 'current' })`, cached for 1 hour in memory, as the roster `[{ code, name, nickname }]`.
- `classify()` is given the active types from `listCategories()` as `id · Category › Type` lines and asks for `"type_id": <one of those ids or null>`, `"employee_code": "<a code from the roster or null>"` and `"subject": "<company / plate / policy or null>"`. A category added later is in the prompt automatically. Add the roster to the prompt only for users with `document_renewals` (or the master). `category_id` comes from the type, never from the model directly. Keep only the field the category's `links_to` asks for.
- `pickEmployee(raw, roster) -> { code, name } | null`: an exact code match only (as `pickCompany` does).
- Nothing is confirmed by AI: `expiry_confirmed_*` and `link_confirmed_*` stay NULL.
- If saifsys is down, file without the roster (`employee_code` null). The upload never fails because of saifsys.

- [ ] **Step 1:** Failing tests (fake `ask`): `visa photo gets Residence Visa and the employee code`, `unknown code is dropped`, `unknown or retired type_id is dropped`, `category follows the type`, `a type added later is offered to the model`, `employee link is unconfirmed until a person confirms`, `saifsys down still files the document`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(shelf): AI suggests document type and employee`.

### Task 4: Correct and confirm on the Shelf

**Files:** `server/index.js:323`, Shelf file panel in the client; test `tests/shelf-classes.test.js`.

**PATCH `/api/documents/:id`** also accepts `type_id` (sets `category_id` with it; `null` clears both), `employee_code` (checked with `lookupCode()` from `server/hrLinks.js`), `subject`, `confirm_expiry: true`, `confirm_link: true`, `not_renewing: { note }`. Who may change these fields: the owner, the master, or a `document_renewals` holder for a categorised file (the rule from Task 2, as write permission for these fields only, not rename/delete). Changing `expires_on` or `employee_code` clears the matching confirmation.

- [ ] **Step 1:** Failing tests: `module holder confirms a date on someone else's file`, `changing the date clears the confirmation`, `a wrong employee code is refused with HR's message`, `person without the module cannot change category fields`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Client: the panel shows Type, For (employee or subject), Expires, with a **Confirm** button beside each unconfirmed value. Options shown to Francis first. Browser check.
- [ ] **Step 6: Commit** `feat(shelf): correct and confirm a document's type, employee and expiry`.

## Phase B: Expiry alerts

### Task 5: The daily alert job

**Files:** Create `server/documentAlerts.js`; modify `server/db.js`, `server/index.js`; test `tests/documentAlerts.test.js`.

**Tables:**
- `document_alert_settings` (one row): `days int[] DEFAULT '{60,30,14}'`, `overdue_every_days int DEFAULT 7`, `hour int DEFAULT 8`.
- `document_alerts`: `id`, `document_id`, `step TEXT` (`'d60' | 'd30' | 'd14' | 'expired' | 'overdue:<yyyy-mm-dd>' | 'confirm'`), `sent_to int[]`, `sent_at`. `UNIQUE (document_id, step)`.

**Interfaces:**
- `recipientsFor(doc) -> int[]`: any category → the master(s) + active, non-external `document_renewals` holders. No category → `[doc.user_id]`.
- `dueSteps(doc, today, settings) -> string[]`: the steps due today that haven't been sent. Skip files with `superseded_by`, `not_renewing_at`, `status <> 'ready'` or `kind = 'fact'`.
- `alertOnce({ today })`: for each due step, `INSERT … ON CONFLICT DO NOTHING RETURNING id` first, then `sendPush(recipients, { title, body, url: '/shelf?doc=<id>', tag: 'expiry-<id>' })` and a to-do for each recipient at `d14`.
- `startDocumentAlerts()`: hourly tick, acts once a day at `hour` Dubai time.
- Supersede: when a file is confirmed with a type + employee/subject + a later expiry than an older file of the same type for the same employee/subject, set the old one's `superseded_by`.
- Routes (behind auth): `GET /api/document-alerts/settings`, `PUT` (master only).

- [ ] **Step 1: Failing tests:**
  - `sends at 60, 30 and 14 days` (expiry today+60 → `d60`, and so on).
  - `restart does not resend` (run `alertOnce` twice → one push).
  - `unconfirmed date sends a confirm alert, not a countdown`.
  - `categorised files go to master and Document Renewals holders only`.
  - `a category added later alerts like the seeded ones`.
  - `personal file goes to its owner only`.
  - `external holder gets nothing`.
  - `expired then every 7 days`.
  - `newer file of same type stops the old alerts`.
  - `not renewing stops the alerts`.
  - `push has no document text` (body = title, for whom, days left).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: expiry alerts for every Shelf document`.

### Task 6: Fill the gaps: old files and the 6 saifsys documents

**Files:** Create `scripts/import-saifsys-employee-docs.js`; saifsys `api/jarvis/v1/modules/hr_renewals.php` (`documents`, `document_file` actions); saifsys `hr/documents.php`.

- [ ] **Step 1:** Backfill: a one-off run over files with no `expires_on` and a folder of `HR & Employees` / `Contracts & Agreements` / `Legal`, calling the existing `findExpiry()`. Dry-run first (it prints what it would set), then a real run. Dates set this way are unconfirmed.
- [ ] **Step 2:** saifsys read actions (`GET`, `X-Jarvis-Key`):
  - `?module=hr_renewals&action=documents&id=<employee id>` → `{ documents: [{ id, type, number, issued_at, expires_at, has_file }] }`
  - `?action=document_file&id=<doc id>` → the file, refused (404) if its path escapes `uploads/docs/`.
  - PHP tests: `documents lists one employee's rows`, `document_file refuses a path outside uploads/docs`, `hr door still hides visa and passport` (`module=hr&action=employee` has no `visa`/`passport` keys).
- [ ] **Step 3:** Import script: for each saifsys document with a file, save it to the Shelf as the master's file with the Employee Documents type matching its saifsys type by label (unmatched → "Other employee document"), `employee_code`, `expires_on` (confirmed, since a person typed it in saifsys), and a note `Imported from saifsys document #<id>`. Idempotent on that id. Dry-run, then a real run on the local copy.
- [ ] **Step 4:** saifsys `hr/documents.php`: hide the upload form, keep viewing, add the line "Employee documents are now kept in Reem." Browser check.
- [ ] **Step 5: Commit** both repos: `feat: bring old files and saifsys employee documents under expiry alerts`.

### Task 7: Document Renewals screen (Documents tab)

**Files:** `client/src/components/DocumentRenewals.jsx`, `SettingsMenu.jsx`; route `GET /api/document-renewals/documents?category=<id>` behind `needsModule('document_renewals')` (categorised files, soonest expiry first, with alert state; grouped by employee or subject per the category's `links_to`). A filter chip per active category, built from `listCategories()`. A **Categories** panel (master only) to add a category and its types, rename, or retire, using the Task 1 routes. Task 9 adds the Contract cases tab to this screen.

- [ ] **Step 1:** Failing route tests: `module is required`, `lists categorised files only`, `filters by category`, `shows the next alert step`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Screen grouped Expired / ≤14 / ≤30 / ≤60 / Later / No date, each row with "Upload renewed" and "Not renewing". Options shown to Francis first. Browser check.
- [ ] **Step 6: Commit** `feat: Document Renewals screen`.

## Phase C: Employee Renewals

### Task 8: saifsys payroll read, and cases from contracts

**Files:** saifsys `hr_renewals.php` (`payroll` action) + test; create `server/saifsys/hrRenewals.js`, `server/employeeRenewals.js`; modify `server/db.js`, `server/index.js`; test `tests/employeeRenewals.test.js`.

**saifsys:** `?module=hr_renewals&action=payroll&id=&months=6` → `{ items: [{ run_id, period, payroll_type, base_pay, allowance, bonus, overtime, deductions, net_pay }] }`, newest first. Test: `payroll is newest first and capped at months`.

**Reem client** (`server/saifsys/hrRenewals.js`, not added to agents' tools): `employeeDetail(code, ask = askSaifsys)` (wraps `hr/employee`), `payrollHistory(employeeId, months = 6, ask)`.

**Tables:**
- `employee_renewal_settings` (one row): `open_days 60`, `approver_ids int[]` (empty = the master), `pro_ids int[]`.
- `employee_renewals`: `id`, `document_id` (the contract on the Shelf), `employee_code`, `employee_name`, `contract_end date`, `status`, `path` (`'renew' | 'terminate'`), `owner_id`, `proposal jsonb`, `paused_reason`, `closed_at`, `closed_note`, timestamps. Unique partial index on `(employee_code) WHERE closed_at IS NULL`.
- `employee_renewal_events`: `id`, `renewal_id`, `at`, `user_id`, `kind`, `detail jsonb`.
- `employee_renewal_tasks`: `id`, `renewal_id`, `assignee_id`, `kind`, `instructions`, `due_date`, `status` (`'open' | 'done' | 'blocked'`), `evidence jsonb`, timestamps.

**Statuses** (exported `STATUSES`): `open` → `renew_review | terminate_review | needs_review` → `awaiting_approval` → `with_pro` → `checking_documents` → `writing_back` → `closed`; any open status ↔ `paused`.

**`scanCases({ today, ask })`**, run inside the alert job's daily tick: a case opens for each Shelf file whose type has `opens_case` (and whose category `links_to 'employee'`), **both confirmations set**, not superseded, expiring within `open_days`. If a newer confirmed contract supersedes the case's file, the case moves to it (no second case). If saifsys says the employee left, the case closes with `Left in saifsys on <exit_date>`.

- [ ] **Step 1:** Failing tests: `opens one case for a confirmed contract at 60 days`, `unconfirmed contract opens nothing`, `does not open twice`, `newer contract moves the open case`, `employee who left closes the case`, `saifsys error leaves cases untouched`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: Employee Renewals cases open from confirmed contracts`.

### Task 9: Employee Renewals screens

**Routes** (behind `needsModule('document_renewals')`): `GET /api/employee-renewals` → `{ cases }`; `GET /:id` → case + `employeeDetail` + that employee's Shelf files + events; `POST /:id/decision` `{ choice: 'renew' | 'terminate' | 'needs_review', note }`; `POST /:id/pause` `{ reason }`, `/resume`, `/out-of-scope` `{ reason }`.

- [ ] **Step 1:** Failing tests: `module is required`, `external user is refused`, `decision terminate sets terminate_review and calls nothing in saifsys`, `every decision is an event with who`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Screens: two tabs, **Cases** and **Documents**. The case page shows the employee (from saifsys), contract and visa dates (from the Shelf), the files (open inline), the timeline and the three buttons. Options shown to Francis first. Browser check.
- [ ] **Step 6: Commit** `feat: Employee Renewals screens`.

### Task 10: Compare terms with payroll

**Files:** create `server/employeeRenewalCompare.js`; test `tests/employeeRenewalCompare.test.js`.

**Interface:** `compareTerms(detail, payrollItems) -> { rows: [{ field, contract, payroll, period, source, flag }], flags }`. Fields `basic`, `allowance`, `bonus`, `total`, `paid_by`; `flag` ∈ `null | 'missing' | 'differs' | 'outdated' | 'total_mismatch'`. Pure, no I/O.

- [ ] **Step 1:** Failing tests: `same numbers, no flags`, `differs flags the component with the run's period`, `no payroll in 3 months is outdated`, `missing contract value is missing`, `total that is not the sum is flagged`, `cash vs WPS mismatch is flagged`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: compare an employee's terms with their payroll`.

### Task 11: Proposal and approval

**Routes:** `POST /:id/proposal` `{ mode: 'keep' | 'update' | 'resolve_first', terms: { basic, allowance, bonus, position, location, hours, benefits, new_start, new_end, effective_date }, note }` (`resolve_first` pauses with the flags as the reason); `POST /:id/submit` → `awaiting_approval` + push to approvers; `POST /:id/approve`, `POST /:id/reject` `{ note }`.

- [ ] **Step 1:** Failing tests: `keep copies current terms`, `update requires new_end and effective_date`, `proposer cannot approve their own proposal`, `only approvers or the master approve`, `rejected goes back to renew_review with the note`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Case page: the comparison table, the three choices, structured fields, the approval box. Browser check.
- [ ] **Step 6: Commit** `feat: renewal proposals need approval`.

### Task 12: PRO task

The PRO is a Reem user listed in `pro_ids`. While their task is open they can open that case's employee files, and nothing else. Their email only says a task is waiting, with a link.

**Routes:** `POST /:id/tasks` (after approval only) `{ assignee_id, kind, instructions, due_date }`; `GET /api/employee-renewals/tasks/mine`; `POST /tasks/:taskId/done` `{ note }`; `POST /tasks/:taskId/blocked` `{ reason }` (pauses the case, tells the owner); `POST /tasks/:taskId/files` (the PRO uploads the signed or issued papers **to the Shelf** as Employee Documents files linked to the case, unconfirmed).

- [ ] **Step 1:** Failing tests: `task before approval is refused`, `PRO sees only their own task's case`, `PRO loses file access when the task is done`, `email has no attachment and no document text`, `overdue task reminds the PRO, then the owner`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: PRO tasks for approved renewals`.

### Task 13: Read and check the returned papers

**Files:** create `server/employeeRenewalAi.js`; test `tests/employeeRenewalAi.test.js`.

**Interfaces:** `readContractDoc(doc) -> { name, employee_code, passport_no, start, end, basic, allowance, total, signed, confidence: 'high' | 'low' }` (Claude vision, as the payment-slip reader does); `checkAgainstCase(read, caseRow, detail) -> { ok, problems: string[] }`.

- [ ] **Step 1:** Failing tests (fake model): `matching document passes`, `document for another employee is held`, `end date not the approved one is held`, `unsigned is held`, `low confidence always goes to HR`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Case page: what was read beside what was approved, and a **Verified** tick, required even when `ok` (it also confirms the new contract's date and employee link on the Shelf). Commit `feat: read returned contracts and hold any mismatch`.

### Task 14: Write back to saifsys, then close

**saifsys** `hr_renewal_act.php` (POST, `X-Jarvis-Action-Key`, the acting person's `email` as in `act.php`):
- `action=renew` `{ email, employee_id, case_ref, terms }` → updates salary fields only where they changed and writes the employee activity log. Answers `{ changed: [...] }`. Idempotent on `case_ref`.
- `action=terminate` `{ email, employee_id, case_ref, last_working_day, exit_type, exit_reason, final_settlement_status }` → sets those fields with `status 'notice_period'` (never `terminated` before the last working day).
- PHP tests: `renew changes only what changed`, `same case_ref twice does nothing the second time`, `unknown employee is 404`, `terminate sets notice_period`.

**Reem:** `POST /:id/write-back`, allowed only in `checking_documents` with Verified ticked. It calls `actSaifsys`, logs the answer, re-reads `employeeDetail` to confirm, then closes. Tests: `write-back before verify is refused`, `saifsys error keeps the case open with the message`, `keep-terms renewal closes without calling saifsys`.

- [ ] Steps: failing tests (both repos) → implement → pass → commit `feat: verified renewals are written back to saifsys`.

### Task 15: Termination review

`POST /:id/termination` `{ last_working_day, reason, notice_days, notice_given_on }` builds a checklist: open loans and advances (saifsys payroll), leave balance, unpaid payroll, vehicle, Reem/saifsys login. HR ticks each row with a note. Then the Task 11 approval, a Task 12 PRO task (visa and labour card cancellation), the Task 14 `terminate` write-back, and the case closes only when HR confirms immigration is done and the cancellation papers are on the Shelf.

- [ ] **Step 1:** Failing tests: `checklist lists open loans from saifsys`, `cannot submit with unticked rows unless each has a note`, `approval required before PRO task`, `write-back sets notice_period`, `case stays open until HR confirms immigration done`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat: termination review with checklist, approval and PRO`.

### Task 16: Settings, review, PR

- [ ] Settings (master only): alert days, overdue repeat, Employee Renewals approvers and PRO. Tests: `only the master changes settings`.
- [ ] `npm test` (Reem) and every `php tests/*_test.php` (saifsys) green, apart from the known unrelated failures (list them unchanged).
- [ ] Code review of the branch. Push `feat/employee-renewals`, open the PR for Francis to merge. No deploy until he says.

---

## Start here tomorrow

1. `git checkout main && git pull`, then `git checkout -b feat/employee-renewals`.
2. Task 1, then Task 2: the visibility rule has to be in place **before** any passport is given a category, so nothing leaks while the rest is being built.
3. Task 5 (alerts) is the first thing worth showing the boss. Employee Renewals (Phase C) builds on it.
