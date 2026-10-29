# Actions (Add / Edit / Delete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three ticks per person, **Add**, **Edit**, **Delete**, on a new **Actions** tab of their People profile. They decide what that person can change in every module they hold, across the whole app, today and for every feature added later.

**Architecture:** Modules already decide what a person *sees* (`server/modules.js`, `module_access`, `moduleGate` on `/api`). Actions decide what they may *change*, checked in the same gate. The HTTP method gives the action (POST = add, PUT/PATCH = edit, DELETE = delete), and a short override list covers the POSTs that change something that already exists. New routes are covered automatically. Riley's write tools carry the same check. The client gets `actions` from `/auth/me` and hides buttons with `canDo(action)`.

**Tech Stack:** Node/Express, Postgres (`db.prepare`), React (Vite), `node --test`.

**Spec:** This plan's own **Design** section (agreed in chat with Francis 2026-10-29). Earlier context: `docs/superpowers/specs/2026-10-11-module-access-design.md`.

## Design (as agreed)

- **No View tick.** Modules = view. Actions = change.
- **Central, not per module:** one Add, one Edit and one Delete per person. Each applies to every module that person holds. Delete on = can delete anything in the modules they see.
- **Master** always has all three. Their ticks show locked on, like Chats in Modules.
- **Covered:** every shared business record behind `/api`. That means leasing (leases, payments, charges, deposits, docs, inspections, tenants, sources, services, work orders, history), properties (companies, buildings, units, photos, documents, floor plans, renewals), accounts (expenses, recurring bills), `/buildings`, `/inventory`, `/recurring-payments` and `/imports`.
- **Not covered (a person's own things):** Chats, AI chats, messenger, to-dos, routines, team reminders, suggestions, meetings, transcripts, push, email/mailbox, their own login. With Add off, Diana can still write a to-do and chat.
- **Stays master-only (setup, not records):** `/admin/*`, agents, region, alert rules and wording, QuickBooks connection, HR link, responsibilities, who runs each building (`/buildings` staff routes, `PUT /properties/buildings/:id/staff`).
- **What opens up:** routes that are `requireMaster` today only because they change or delete records switch to the action check. That covers delete payment, delete expense, delete work order, and properties add/edit/delete (companies, buildings, units, photos, company docs, documents, floor plan save/read).
- **Starting point:** everyone who is not master and exists when the table first appears gets **Add + Edit**, Delete off, so nobody loses what they can do today. New accounts start with **nothing** ticked, the same as Modules.
- **Wording of a refusal:** `403 { error: 'You are not allowed to add here. Ask the master.' }` (with `add` / `edit` / `delete`).

## Global Constraints

- Action keys are exactly `'add'`, `'edit'`, `'delete'`. Labels are exactly `Add`, `Edit`, `Delete`.
- Table name `action_access (user_id, action)`, the same shape as `module_access`.
- The tab is labelled `Actions` and sits right after `Modules` in `Admin.jsx` `TABS`.
- Every change goes through `actorContext`, so the Activity log records the ticks. Add an `action_access` label to the activity LABELS (see the activity-log rule).
- Never use a native `<select>`. Use the same tick-row component Modules uses.
- Local only. No deploy or push until Francis says so.

## Review Focus

1. **A POST that is really an edit or delete** (upload a slip, confirm a lease, send a reminder, renew, refund a deposit, mark paid). Someone with Add but no Edit must not be able to change an existing record through it. Pinned by the override-table test in Task 2.
2. **Riley as a back door.** Diana with Delete off asks Riley to change or delete something. The tool must refuse just like the screen. Pinned in Task 3.
3. **Master-only setup routes staying master-only** after `requireMaster` is lifted from record routes. Diana with all three ticks still gets 403 on region, alert settings and `/admin`. Pinned in Task 2.
4. **Hidden button but working route.** The UI is cosmetic, so the server must refuse even when the button is shown by mistake. Every Task 2 test hits the route directly.
5. **Cascades.** Deleting a lease removes its payments. Someone without Delete can't delete a lease, so the cascade can't happen either. Pinned in Task 2.

---

### Task 1: Storage and the actions a person holds

**Files:**
- Modify: `server/db.js` (after `module_access`, ~line 801)
- Create: `server/actions.js`
- Modify: `server/auth.js:50` (`publicUser` adds `actions`)
- Modify: `server/admin.js` (~line 358, beside the modules routes)
- Modify: `tests/helpers/db.js` (add `giveActions(userId, keys)`)
- Test: `tests/actions.test.js`

**Interfaces:**
- Produces: `ACTIONS = [{key:'add',label:'Add'},{key:'edit',label:'Edit'},{key:'delete',label:'Delete'}]`; `userActions(user) -> Promise<string[]>` (master gets all three, in that order); `listActionAccess(userId) -> {master:boolean, actions:[{key,label,on}]}`; `setActionAccess(userId, keys:string[]) -> Promise<number>` (replaces the whole set, refuses unknown keys with 400, is a no-op for master); routes `GET/PUT /admin/users/:id/actions` (body `{actions:[...]}`); `/auth/me` user gains `actions: string[]`.

- [ ] **Step 1: Write failing tests** in `tests/actions.test.js`:
  - `nothing ticked is no actions, and the master has all three`: a fresh user returns `[]`, master returns `['add','edit','delete']`.
  - `ticking replaces the whole set, drops duplicates, refuses an unknown key`: `setActionAccess(sara, ['delete','add','delete'])` returns 2 and `userActions` gives `['add','delete']`; `['view']` rejects with `/Unknown action: view/`.
  - `existing staff start with add and edit`: when the table is created with users already present, every non-master has `['add','edit']` (test the seeding SQL through the same `fresh` pattern as `saifsys_access`, db.js:766-777).
  - `the profile list and /auth/me carry the actions`.
- [ ] **Step 2: Run** `node --test tests/actions.test.js`. Expected: FAIL, cannot find `../server/actions.js`.
- [ ] **Step 3: Implement.** Create the table with the `fresh` seed (`INSERT ... SELECT id, unnest(ARRAY['add','edit']) FROM users WHERE role IS DISTINCT FROM 'master'`). Write `server/actions.js` mirroring `modules.js` lines 28-64. Add the two admin routes behind the router's existing master guard. Add `actions` to `publicUser`.
- [ ] **Step 4: Run** `node --test tests/actions.test.js tests/modules.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(leasing): Add, Edit and Delete per person, stored beside modules`

### Task 2: One gate for every change

**Files:**
- Modify: `server/modules.js` (the `moduleGate` / `needed` area, lines 74-120)
- Modify: `server/actions.js` (`actionFor`, `OVERRIDES`, `actionGate`)
- Modify: `server/index.js:75` (mount `actionGate` right after `moduleGate`)
- Modify: `server/leasing.js:1484`, `server/expenses.js:345`, `server/workOrders.js:355`, `server/properties.js:469-514`, `server/floorPlans.js:85-87`: drop `requireMaster` from record routes (the list in Design → "What opens up"). Keep it on `properties.js:486` (building staff).
- Test: `tests/actions.test.js`

**Interfaces:**
- Consumes: `userActions` (Task 1), `needed(method, path)` from `modules.js`.
- Produces: `actionFor(method, path) -> 'add'|'edit'|'delete'|null` (null = not a record route, or a read); `actionGate(req,res,next)`.

`actionFor` rules, in this order:
1. GET/HEAD gives null.
2. The path is not under a covered prefix (`/leasing`, `/properties`, `/accounts`, `/buildings`, `/inventory`, `/recurring-payments`, `/imports`) gives null.
3. The first matching entry in `OVERRIDES` (an array of `[regex, method, action]`) decides.
4. Otherwise DELETE gives `'delete'`, PUT/PATCH gives `'edit'`, and POST gives `'add'`.

Master-only setup routes keep their own `requireMaster` inside the router, so the gate only adds a check and never removes one.

Building `OVERRIDES`: list every `POST` under the covered prefixes (`grep -nE "Routes\.post\(" server/{leasing,leasingHistory,inspections,workOrders,properties,floorPlans,renewals,expenses,recurringPayments,inventory,buildings,imports,tenantImport,leaseImport,leasingAlerts}.js`). Give each one that changes an existing record `'edit'`. Examples: `/payments/:id/file`, `/bookings/:id/confirm`, `/bookings/:id/renew`, deposit refund, `/alerts/reminder` send, `/recurring-payments/.../paid`, `/properties/documents/read`, `/buildings/:id/plan/read`. Give any POST that removes something `'delete'`, such as import undo. Put a one-line comment on each entry saying why, the same way `RULES` is commented.

- [ ] **Step 1: Write failing tests**:
  - `the method is the action`: `actionFor('POST','/leasing/bookings')==='add'`, `('PUT','/leasing/bookings/5')==='edit'`, `('DELETE','/leasing/payments/9')==='delete'`, `('GET','/leasing/bookings')===null`, `('POST','/todos')===null`.
  - `a POST that changes an existing record is an edit`: one assertion per OVERRIDES entry. Pick three named ones: `('POST','/leasing/payments/3/file')==='edit'`, `('POST','/leasing/bookings/3/confirm')==='edit'`, `('POST','/leasing/alerts/reminder')==='edit'`.
  - `every POST route under a covered prefix is classified on purpose`: build the express app, walk `app._router.stack` for POST routes under covered prefixes, and assert each is either a create (listed in a `CREATES` array in the test) or in OVERRIDES. A new POST then fails the test until someone decides what it is.
  - `Diana with leasing but no delete cannot delete a payment; with delete she can` (HTTP through the real app, as `modules.test.js` does with express).
  - `no delete means no deleting a lease, so its payments stay` (cascade).
  - `with add but no edit, uploading a slip to an existing payment is refused`.
  - `all three ticks still do not reach master setup`: `PUT /leasing/region`, `PUT /leasing/alerts/settings`, `GET /admin/users` return 403 for Diana.
  - `the module gate still comes first`: Delete ticked but no Accounts module means `DELETE /accounts/expenses/1` returns 403.
  - `the refusal says what was missing`: body `{error:'You are not allowed to delete here. Ask the master.'}`.
- [ ] **Step 2: Run** `node --test tests/actions.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `actionFor`, `OVERRIDES`, `actionGate` (master passes; otherwise `userActions(req.user).includes(action)` or 403), mount it, and remove the listed `requireMaster`s.
- [ ] **Step 4: Run** `npm test`. Expected: everything that passed before still passes, apart from the ~22 known saifsys/inventory/push fails. Fix any existing test that assumed a staff member could write with no actions by calling `giveActions(id, ['add','edit'])` in its setup.
- [ ] **Step 5: Commit** `feat(leasing): one gate for every change: what a person may add, edit or delete`

### Task 3: Riley obeys the same three ticks

**Files:**
- Modify: `server/leasingKit.js:680-722` (`TOOL_ACTIONS`, check in `run` and filter in `definitions`)
- Modify: `server/renewals.js` (renewal tools), `server/chat.js:323-328` (pass `actions: await userActions(user)` into `leasingKit`), and any other kit that writes shared records (`expenses`, work orders) found by `grep -n "Kit(" server/chat.js`
- Test: `tests/actions.test.js`

**Interfaces:**
- Consumes: `userActions` (Task 1).
- Produces: `leasingKit(user, { modules, actions, ... })`. When `actions` is left out, every tool is allowed (the same as `modules`, so existing callers and tests keep working).

`TOOL_ACTIONS`: `leasing_add_*` and `renewal_start` map to `'add'`. `leasing_change_booking`, `leasing_confirm_booking`, `leasing_update_work_order` and `leasing_record_inspection` map to `'edit'`. Read tools are not listed. A write tool missing from `TOOL_ACTIONS` is refused, so a new Riley tool has to be classified before anyone can use it.

- [ ] **Step 1: Write failing tests**:
  - `without add, Riley does not carry the add tools`: `leasingKit(diana, {modules:['leasing'], actions:['edit']}).definitions` has no `leasing_add_booking` but has `leasing_change_booking`.
  - `a tool called anyway is refused`: `run({name:'leasing_add_booking',...})` returns `is_error` with `/not allowed to add/`.
  - `every write tool is classified`: each key of the kit's `change` object is in `TOOL_ACTIONS`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/actions.test.js tests/modules.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(leasing): Riley changes only what the person may change by hand`

### Task 4: The Actions tab and hiding buttons

**Files:**
- Create: `client/src/lib/actions.js` (`setActions(list)`, `canDo(key)`, built like `lib/modules.js`)
- Modify: `client/src/App.jsx:190` (`setActions(me?.actions)` next to `setModules`)
- Modify: `client/src/components/Admin.jsx:218` (`['actions','Actions']` after Modules), `:275`, new `AppActions({person})` beside `AppModules` (`:359`), reusing its tick rows. Master shows all three locked on. The heading line reads exactly: `Tick what {name} may do in the parts of the app they have. Seeing is set in Modules.`
- Modify: every module screen's add / edit / delete control: `BookingPayments`, `BookingCard`, `BookingDocs`, `Leasing`, `TenantHistory`, `Inspections`, `WorkOrders`, `Properties`, `PropertyPhoto`, `CompanyDocs`, `Documents`, `DocumentSheet`, `Renewal`, `AccountsPage`, `SourceList`, `ServiceList`, `Buildings`, `Inventory`, `InventoryCard`, `LeaseImport`, `TenantImport`, `LeasingAlerts` (reminder send = edit), `Building3D`. Where a control is hidden today with `role === 'master'` only because it changes records, switch it to `canDo(...)`. Leave master checks on setup controls.

- [ ] **Step 1:** `cd client && npm run build`. Expected: builds.
- [ ] **Step 2: Check by hand** with `npm run dev` against the local `lease_live` copy (never live):
  - Admin: the Actions tab shows three ticks; ticking saves and survives a reload; master's are locked.
  - Diana (Add+Edit): no bin icons anywhere; record a payment works.
  - Tick Delete for Diana, sign in as her: the payment bin shows and works.
  - Untick Add: the new lease, add payment and add tenant buttons are gone.
  - The Activity log shows who changed Diana's actions.
- [ ] **Step 3: Commit** `feat(leasing): Actions tab on a person's profile; buttons follow their ticks`

### Task 5: Keep it covered for future features

**Files:**
- Modify: `server/actions.js` header comment (the rule below)
- Memory: new `actions-rule.md` plus a `MEMORY.md` line

- [ ] **Step 1:** At the top of `server/actions.js`, comment: *every new record route is covered by its method. A POST that changes something existing goes in OVERRIDES. A new Riley write tool goes in TOOL_ACTIONS. A new button uses canDo. The coverage tests fail until this is done.*
- [ ] **Step 2:** Save memory `actions-rule`: lease app Add/Edit/Delete since this build; how to cover a new feature (the three lines above); link [[activity-log-rule]].
- [ ] **Step 3: Commit** `docs(leasing): how a new feature joins Add, Edit and Delete`
