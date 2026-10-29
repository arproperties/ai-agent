# Prospects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Prospects tab in the lease app where staff keep people interested in a unit (as Rent Manager's Prospects did), follow them up, and turn one into a draft lease with one button.

**Architecture:** One new table `lease_prospects` and one new server file `server/prospects.js` (functions + an Express router mounted under `/api/leasing`). A prospect is a lead, not a tenant: no tenant row is made until **Make lease** opens the existing lease form pre-filled and the lease is saved. The lease remembers nothing new; the prospect points at the lease (`booking_id`). A new `prospects` module gates the screen; the Actions gate (server/actions.js) covers its add/edit/delete with no new code. A follow-up date raises an alert through the existing alerts machinery.

**Tech Stack:** Node/Express, Postgres (`db.prepare(...).get/all/run`), node:test, React + Tailwind client.

**Spec:** this conversation, 2026-10-29. Agreed fields: name, phone, email; unit or building wanted and move-in date; source (the existing Sources list); status New → Viewing booked → Applied → Leased, or Lost with a reason; notes; a follow-up date that reminds. One button, **Make lease**, makes the draft lease with the prospect's details filled in; documents are asked for then, not before.

## Global Constraints

- Branch `leasing-bookings`. Before Task 1, `git status` must show the Actions work (server/actions.js etc.) committed by Francis's other session; if it is not, stop and ask. Never touch `main`.
- Tests run against the throwaway test DB (`tests/helpers/db.js`), never `lease_live`. Command: `npm test -- tests/<file>`. Ignore the ~22 known saifsys/inventory/push failures in a full run.
- Nothing is deployed or pushed. Commit locally only.
- No browser `<select>`: every pick list uses the themed searchable `client/src/components/Select.jsx`.
- Nothing in this feature sends an email or a push except the existing alert push (Task 4), which obeys the alert settings and quiet hours like every other rule.
- Status keys and labels, exactly: `new` "New", `viewing` "Viewing booked", `applied` "Applied", `lost` "Lost". "Leased" is never stored: it is shown when the prospect's lease exists and is not cancelled.
- Error copy, exactly: `Give the prospect's name.` · `Give a phone number or an email.` · `Say why the prospect was lost.` · `That unit is not in that building.` · `Unknown status: <x>` · `Prospect not found` (404) · `<Name> already has lease <ref>.` (409)

## Review Focus

1. **The draft lease made from a prospect is deleted or cancelled** — the prospect must stop showing Leased and go back to its stored status (Applied), so **Make lease** can be pressed again. Test in Task 2.
2. **Make lease pressed twice** (two tabs, or a double click) — the second save is refused with `<Name> already has lease <ref>.`, and no second tenant is created (the refusal is inside the lease's transaction). Test in Task 2.
3. **A prospect with only a building, or nothing, wanted** — Make lease still opens the form with name/phone/email/source/date filled and the unit left to pick. Test in Task 3 (preset built from a row with `unit_id: null`).
4. **The wanted unit or building is deleted later** — the prospect stays, its unit/building just goes blank (`ON DELETE SET NULL`); listing does not crash. Test in Task 1.
5. **Staff without the Leasing module** — they can keep prospects but are not offered Make lease (the lease routes would refuse them). Test in Task 3 (`can('leasing')` false hides the button) and the route test in Task 1 (a `prospects`-only user may add a prospect, gets 403 on `/leasing/bookings`).

---

### Task 1: Prospects table, functions and routes

**Files:**
- Modify: `server/db.js` (after the `lease_sources` block, ~line 1470)
- Create: `server/prospects.js`
- Modify: `server/index.js:109` (mount the router beside `workOrderRoutes`, before `leasingRoutes`)
- Modify: `server/modules.js:14` and `:93` (module + route rule)
- Modify: `server/activity.js` `LABELS`
- Test: `tests/prospects.test.js` (create)

**Interfaces:**
- Produces (server/prospects.js):
  - `STATUSES = [['new','New'],['viewing','Viewing booked'],['applied','Applied'],['lost','Lost']]`
  - `listProspects({ q, status } = {}, today = <business today>) → Promise<Prospect[]>`
  - `addProspect(body, by) → Promise<Prospect>`
  - `updateProspect(id, body) → Promise<Prospect>` (partial: only the fields sent change)
  - `removeProspect(id) → Promise<{ ok: true }>`
  - `prospectRoutes` (Express Router): `GET /prospects?q=&status=`, `POST /prospects`, `PUT /prospects/:id`, `DELETE /prospects/:id`
  - `Prospect` = `{ id, full_name, phone, email, building_id, building, company_id, unit_id, unit_no, move_in_date, source, status, lost_reason, notes, follow_up, booking_id, lease_ref, leased, due, created_at }` — dates as `'YYYY-MM-DD'`; `leased` = booking exists and is not cancelled; `due` = not leased, status ≠ lost, `follow_up <= today`; `lease_ref` via the existing `bookingRef`.

- [ ] **Step 1: Write the failing tests** in `tests/prospects.test.js` (same setup as `tests/leasing.test.js`: `reset()`, a company, building "Tower", units 101/102):
  - `adds a prospect with only a name and a phone; status starts New` → `status === 'new'`, `leased === false`, `due === false`.
  - `refuses a prospect without a name, or without any way to reach them` → rejects `/Give the prospect's name\./`, then `/Give a phone number or an email\./`.
  - `a unit wanted fills in its building; a unit from another building is refused` → add with `unit_id: u1.id` only → `building === 'Tower'`; add with `unit_id` of a unit in a second building and `building_id: tower.id` → rejects `/That unit is not in that building\./`.
  - `lost needs a reason; an unknown status is refused` → `updateProspect(id, { status: 'lost' })` rejects `/Say why the prospect was lost\./`; with `lost_reason: 'Found cheaper'` passes; `{ status: 'leased' }` rejects `/Unknown status: leased/`.
  - `due when the follow-up day has come, not when lost` → `follow_up: '2026-10-29'`, list at `'2026-10-29'` → `due === true`; at `'2026-10-28'` → false; set lost → false.
  - `search and the status filter` → `listProspects({ q: '0501' })` finds by phone; `{ status: 'viewing' }` returns only those.
  - `the wanted unit deleted later leaves the prospect, without a unit` → delete u1 via `remove('unit', ...)` from properties.js, `listProspects()` still has the row with `unit_id === null`.
  - Route test (pattern of `tests/work-orders-routes.test.js`, mounting `moduleGate` too): a staff user with only the `prospects` module and the `add` action can `POST /api/leasing/prospects` (200); the same user gets 403 on `POST /api/leasing/bookings`; a user with `prospects` but no `delete` action gets 403 on `DELETE /api/leasing/prospects/:id`.

- [ ] **Step 2: Run to verify they fail**
  Run: `npm test -- tests/prospects.test.js`
  Expected: FAIL, `Cannot find module '../server/prospects.js'`.

- [ ] **Step 3: Add the table in `server/db.js`**, with a comment in the file's style:
  `lease_prospects (id SERIAL PK, full_name TEXT NOT NULL, phone TEXT, email TEXT, building_id INTEGER REFERENCES prop_buildings(id) ON DELETE SET NULL, unit_id INTEGER REFERENCES prop_units(id) ON DELETE SET NULL, move_in_date DATE, source TEXT, status TEXT NOT NULL DEFAULT 'new', lost_reason TEXT, notes TEXT, follow_up DATE, booking_id INTEGER REFERENCES lease_bookings(id) ON DELETE SET NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at BIGINT DEFAULT ${NOW})`, plus `CREATE INDEX IF NOT EXISTS idx_lease_prospects_booking ON lease_prospects(booking_id)`. Add `lease_prospects` to whatever `tests/helpers/db.js` `reset()` truncates.

- [ ] **Step 4: Write `server/prospects.js`.** `source` is stored as the name (as `lease_bookings.source` is). When `unit_id` is given, `building_id` is taken from the unit; if a different `building_id` was also sent, refuse. `q` matches name, phone, email, notes (ILIKE). Order: due first, then `follow_up` ascending (nulls last), then newest. `today` defaults to `todayHere()` from leasing.js; `lease_ref` uses `bookingRef` from leasing.js.

- [ ] **Step 5: Wire it up.** `server/modules.js`: `{ key: 'prospects', label: 'Prospects' }` after `tenants`; rule `[/^\/leasing\/prospects(\/|$)/, ['prospects', 'leasing'], ['prospects']]` above the tenants rules. `server/index.js`: `app.use('/api/leasing', prospectRoutes); // people interested in a unit, before they are tenants`. `server/activity.js` LABELS: `lease_prospects: { name: 'Prospect', about: (r) => [r.full_name, r.status].filter(Boolean).join(', '), fields: { follow_up: 'Follow up on', move_in_date: 'Move-in wanted', lost_reason: 'Why lost' } }`.

- [ ] **Step 6: Run to verify they pass**
  Run: `npm test -- tests/prospects.test.js tests/actions.test.js tests/modules.test.js`
  Expected: PASS (if `tests/actions.test.js` lists every POST route, the prospects POST is an `add` — no OVERRIDES line needed).

- [ ] **Step 7: Commit**
  `git add server/db.js server/prospects.js server/index.js server/modules.js server/activity.js tests/prospects.test.js tests/helpers/db.js`
  `git commit -m "feat(leasing): prospects: people interested in a unit, before they are tenants"`

---

### Task 2: A lease made from a prospect

**Files:**
- Modify: `server/leasing.js` (add `linkProspect` beside `makeBooking`, ~line 353 — it lives here, not in prospects.js, because prospects.js already imports `bookingRef` and `todayHere` from leasing.js; the other way round would be a circular import)
- Test: `tests/prospects.test.js`

**Interfaces:**
- Consumes: `listProspects`, `addProspect` (Task 1); `createBooking(body, by)` (leasing.js).
- Produces: `linkProspect(prospectId, bookingId) → Promise<void>` — throws 404 `Prospect not found`, or 409 `<Name> already has lease <ref>.` when the prospect's current `booking_id` points at a lease that is not cancelled. `createBooking` accepts optional `body.prospect_id`.

- [ ] **Step 1: Write the failing tests**
  - `a lease saved from a prospect marks it leased` → `createBooking(stay(u1.id, '2026-12-01', '2027-11-30', { prospect_id: p.id }))` → prospect has `leased === true`, `booking_id === bk.id`, `lease_ref === bk.ref`, stored `status` unchanged.
  - `the same prospect cannot make two leases` → second `createBooking(... { prospect_id: p.id })` rejects `/Sara already has lease .+\./`, and `listTenants()` length is unchanged (rolled back with the lease).
  - `the lease deleted or cancelled, the prospect is open again` → `removeBooking(bk.id)` → `leased === false`, `booking_id === null`, `status` back to what it was; a confirmed lease then `cancelBooking` → `leased === false`, and a new lease from it is accepted.

- [ ] **Step 2: Run to verify they fail**
  Run: `npm test -- tests/prospects.test.js`
  Expected: FAIL (`leased` is false after the lease is made).

- [ ] **Step 3: Implement.** In `makeBooking`, after the lease row is inserted and inside the same transaction, `if (body.prospect_id) await linkProspect(body.prospect_id, id)`. `linkProspect` locks the prospect row (`SELECT ... FOR UPDATE`) before checking, so two saves cannot both pass.

- [ ] **Step 4: Run to verify they pass**
  Run: `npm test -- tests/prospects.test.js tests/leasing.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -am "feat(leasing): a lease made from a prospect marks it leased; only one at a time"` (plus `git add` of the test file if new hunks).

---

### Task 3: The Prospects screen and Make lease

**Files:**
- Create: `client/src/components/Prospects.jsx`
- Modify: `client/src/components/Leasing.jsx` (tab render ~line 1408; `BookingForm` ~lines 240–270 and its save body)
- Modify: `client/src/components/Sidebar.jsx:56` (menu entry after Tenants)
- Modify: `client/src/lib/modules.js:11` (`prospects: 'prospects'`)
- Test: `tests/prospects-preset.test.js` (create) for the pure helper

**Interfaces:**
- Consumes: the routes and `Prospect` shape from Task 1; `prospect_id` on lease save from Task 2.
- Produces: `leasePreset(p: Prospect) → { prospect_id, company_id, building_id, unit_id, start_date, source, tenant: { full_name, phone, email } }` exported from `client/src/lib/prospects.js` (create; pure, so node:test can import it). `<Prospects onLease={(p) => void} canLease={boolean} />`.

- [ ] **Step 1: Write the failing test** `tests/prospects-preset.test.js`:
  - full row → exactly the object above, `start_date` = `move_in_date`, empty strings for missing phone/email.
  - row with `unit_id: null, building_id: null, move_in_date: null` → `unit_id: ''`, `building_id: ''`, `start_date: ''`, tenant still filled.

- [ ] **Step 2: Run to verify it fails**
  Run: `npm test -- tests/prospects-preset.test.js`
  Expected: FAIL, module not found.

- [ ] **Step 3: Write `client/src/lib/prospects.js` and `Prospects.jsx`.** Copy the Tenants screen's look (search box, cards/table via `useView`/`usePaged`, `FIELD`, round icon buttons). Above the list: status chips (All, New, Viewing booked, Applied, Leased, Lost) with counts. Each row: name, phone/email, unit or building wanted, move-in date, source, status, follow-up date (shown in warn colour with "Follow up today" / "Follow up overdue" when `due`), lease ref when leased. Add/Edit in a sheet: name, phone, email, building (Select), unit (Select, filtered to the building), move-in date (DateField), source (Select from `/leasing/sources`), status (Select of `STATUSES` labels; picking Lost shows a required "Why lost" field), follow-up date, notes. Buttons per row: **Make lease** (only when `canLease` and not leased; hidden on Lost), Edit, Delete (confirm `Delete <name>?`). Leased rows show the lease ref instead of Make lease.

- [ ] **Step 4: Wire it in.** Sidebar: `{ module: 'prospects', Ico: UserPlus, color: 'amber', label: 'Prospects', hint: 'People interested in a unit', ... onClick: () => onLeasing('prospects') }`. Leasing.jsx: `if (tab === 'prospects') return <Page title="Prospects" onBack={onBack}><Prospects canLease={can('leasing')} onLease={(p) => setForm({ preset: leasePreset(p) })} /></Page>;`. `BookingForm`: when `preset.tenant` is given, start `tenant` from it (tenantMode `'new'`); start `v.source` from `preset.source`; send `prospect_id: preset.prospect_id` in the save body. On save from a prospect, land on the lease as today (`onDone` unchanged).

- [ ] **Step 5: Run tests and build**
  Run: `npm test -- tests/prospects-preset.test.js` → PASS. `cd client && npm run build` → builds with no errors.

- [ ] **Step 6: Check it in the browser** (local dev, local DB): add a prospect with a unit and a date → Make lease → form opens with name, phone, email, source, unit, start date filled → save as Draft (documents asked for) → back on Prospects the row shows Leased with the ref. Delete the draft → the row shows Make lease again.

- [ ] **Step 7: Commit**
  `git add client/src/components/Prospects.jsx client/src/lib/prospects.js client/src/components/Leasing.jsx client/src/components/Sidebar.jsx client/src/lib/modules.js tests/prospects-preset.test.js`
  `git commit -m "feat(leasing): Prospects tab; Make lease opens the lease form filled in"`

---

### Task 4: Follow-up reminders

**Files:**
- Modify: `server/leasingAlerts.js` (`DEFAULTS` line 23, `RULES` line 39, settings save ~line 83, the rule loop beside `contract` ~line 138)
- Modify: `client/src/components/LeasingAlerts.jsx` (lines 24, 29, 32, 47, 143 — the `workorder` lines are the pattern)
- Modify: `client/src/components/Leasing.jsx:1316` (`alertModule`: `prospects: 'prospects'`) and `openAlert` (`a.open === 'prospects'` → `setTab('prospects')`)
- Test: `tests/prospects.test.js`

**Interfaces:**
- Consumes: `listProspects(..., today)` and `due` from Task 1.
- Produces: alert rule `prospect`, default `{ on: true }`; alert `{ rule: 'prospect', key: 'prospect:<id>', open: 'prospects', level: 'warn', title: 'Follow up <Name>', detail: '<unit or building wanted> · prospect since <date>', fires: follow_up === today }`.

- [ ] **Step 1: Write the failing test** `a prospect's follow-up day raises an alert, until it is leased or lost` → follow_up `'2026-10-29'`; `listAlerts` at `'2026-10-29'` has one `prospect` alert titled `Follow up Sara` with `fires === true`; at `'2026-10-30'` still listed, `fires === false`; after marking lost → no alert; rule turned off in settings → no alert.

- [ ] **Step 2: Run to verify it fails**
  Run: `npm test -- tests/prospects.test.js`
  Expected: FAIL, no `prospect` alert.

- [ ] **Step 3: Implement** the rule next to `contract`, from the `due` prospects; staff who receive it are the holders of the `prospects` module (as `workorder` uses `workorders`). Client: label "Prospects", icon `UserPlus`, settings line "A prospect on their follow-up day, every day until they are leased or lost.", action "Open prospects".

- [ ] **Step 4: Run to verify it passes**
  Run: `npm test -- tests/prospects.test.js tests/document-alerts.test.js tests/leasing.test.js` → PASS. `cd client && npm run build` → no errors.

- [ ] **Step 5: Commit**
  `git commit -am "feat(leasing): an alert on a prospect's follow-up day"`

---

## After the last task

Full suite (`npm test`), expect only the known saifsys/inventory/push failures. Tell Francis what is built and that nothing is deployed; staff need the **Prospects** module ticked on their People profile to see it.
