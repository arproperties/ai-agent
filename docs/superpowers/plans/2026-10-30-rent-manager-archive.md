# Rent Manager Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can enter a tenant's active lease alone (switch-over billing date, opening balance, deposit already held), and add old Rent Manager leases later, in any order, to a history-only Archive.

**Architecture:** Part 1 reuses the lease's existing `billed_from` / `import_batch` / `deposit_due` / `addCharge` machinery and adds one payment method, `rent_manager`, that the money-out-of-the-app paths (QuickBooks, Zego, receipts, reports) skip. Part 2 is a new module `server/leaseArchive.js` with its own four tables, never joined by any live-money query, plus one client screen `Archive.jsx` and a "Previous leases" section on the lease card.

**Tech Stack:** Node (ESM) + Express + Postgres (`db.prepare(...).get/all/run`, `tx`), multer for files, React + Tailwind client, `node:test` tests.

**Spec:** `docs/superpowers/specs/2026-10-30-rent-manager-archive-design.md`

## Global Constraints

- Branch `leasing-bookings`. Nothing is pushed or deployed until Francis says so; deploy target is the USA server (jnrpro.co), never the DO droplet.
- Tests: `TEST_DATABASE_URL` must point at a DB named `*_test` that is **not** `jarvis_test` (use `prospects_test`). Run with `npm test -- tests/<file>`.
- Ignore the ~22 saifsys/inventory/push test failures; they are not ours.
- Every new route sits under `/api/leasing/...` so the Actions gate (`server/actions.js`) covers it by method: POST = add, PUT = edit, DELETE = delete. `tests/actions.test.js` must stay green.
- Every new button that adds/edits/deletes is shown only with `canDo('add'|'edit'|'delete')` from `client/src/lib/actions.js`.
- New tables get a line in `LABELS` (`server/activity.js`) and are added to `TABLES` in `tests/helpers/db.js`.
- No native `<select>`: use `client/src/components/Select.jsx`. Dates via `DateField`, shown MM/DD/YYYY (`usDate`). Money to the cent (`money()`).
- Archive data must never change: balances, schedules, overdue, alerts, unit occupancy/Vacant, inspections, QuickBooks, Zego, tenant emails, reports' money totals.
- Code style: match `server/leasing.js` / `server/workOrders.js` — doc comment above each export in plain words, `bad(message, status)` errors in plain English.

## Review Focus

1. **An archived lease whose dates overlap a live lease on the same unit** must not block creating or confirming the live one → Task 4 test `archive never blocks a live lease`.
2. **A tenant deleted after their archived leases were entered** must leave the archive readable with their name → Task 4 test `a removed tenant's archive keeps the name`.
3. **`billed_from` changed after payments exist** must be refused like any other schedule change → Task 1 test `billed_from cannot move once rent is paid`.
4. **A "Paid in Rent Manager" payment on a day that also has real payments** must leave the real ones in the QuickBooks deposit → Task 2 test `qb deposit skips Rent Manager money but keeps the rest`.
5. **Removing an archived lease with files** must delete its files from disk, not leave orphans → Task 4 test `removing an archived lease removes its files`.

---

### Task 1: Switch-over lease (server)

**Files:**
- Modify: `server/leasing.js` — `bookingFields` (~line 200–288), `makeBooking` (~388), `updateBooking` "fixed" list (~457)
- Modify: `server/properties.js:165` — `move_in_due`
- Test: `tests/leasing-switchover.test.js` (new)

**Interfaces:**
- Produces: `createBooking` / `updateBooking` body accepts `billed_from: 'YYYY-MM-01' | ''` and `from_rent_manager: boolean` (create only). A lease made with `from_rent_manager: true` has `import_batch = 'rent-manager-by-hand'`.

- [ ] **Step 1: Write the failing tests** in `tests/leasing-switchover.test.js`, set up like `tests/leasing-rentmanager.test.js` (company → building → unit, `addTenant`, staff via `makeUser`). Base lease: start `2025-03-01`, end `2027-02-28`, rent 1000, monthly, confirmed.

```js
test('a lease from Rent Manager bills only from the switch-over 1st', async () => {
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  const rent = (await bookingPayments(bk.id, '2026-10-30')).filter((r) => r.kind === 'rent');
  assert.deepEqual(rent.map((r) => r.due_date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  const b = await getBooking(bk.id);
  assert.equal(b.import_batch, 'rent-manager-by-hand');
  assert.equal(b.moved_in, true);
});
test('billed_from must be a 1st inside the lease', async () => {
  await assert.rejects(createBooking({ ...base, billed_from: '2026-11-15' }, staff), /1st of a month/);
  await assert.rejects(createBooking({ ...base, billed_from: '2025-01-01' }, staff), /inside the lease/);
  await assert.rejects(createBooking({ ...base, billed_from: '2027-03-01' }, staff), /inside the lease/);
});
test('without billed_from a lease bills from its start as before', async () => {
  const bk = await createBooking(base, staff);
  assert.equal((await bookingPayments(bk.id, '2026-10-30')).find((r) => r.kind === 'rent').due_date, '2025-03-01');
});
test('a Rent Manager lease is not move-in due on the unit list', async () => {
  await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  assert.equal((await listUnits(bl.id, '2026-10-30'))[0].move_in_due, false);
});
test('the old deposit sits on its real date', async () => {
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true, security_deposit: 500, deposit_due: '2023-04-01' }, staff);
  assert.equal((await bookingPayments(bk.id, '2026-10-30')).find((r) => r.kind === 'deposit').due_date, '2023-04-01');
});
test('billed_from cannot move once rent is paid', async () => {
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  await payBooking(bk.id, { amount: 1000, method: 'cash', received_on: '2026-11-01' }, staff, '2026-11-02');
  await assert.rejects(updateBooking(bk.id, { billed_from: '2026-12-01' }, staff));
});
```

- [ ] **Step 2: Run** `npm test -- tests/leasing-switchover.test.js` → FAIL (billed_from ignored; import_batch null).

- [ ] **Step 3: Implement.**
  - `bookingFields`: accept `billed_from` — empty → `null`; else must be `isDate`, end in `-01` (`'Bill in this app from must be the 1st of a month.'`), and lie within the lease's months: `>= first of start month` and `<= end_date` (`'Bill in this app from must be inside the lease.'`). Validate against the row's / old booking's dates (in `updateBooking` use merged values).
  - `makeBooking`: when `isTrue(body.from_rent_manager)`, merge `{ import_batch: 'rent-manager-by-hand' }` into `extra` (so `followsOn` is skipped, as for imports) and log `'Entered from Rent Manager: tenant already living there, no move-in inspection'`.
  - `updateBooking`: add `'billed_from'` to the `fixed` field list so a change after payments is refused by the existing guard.
  - `properties.js` `move_in_due`: add `AND b.import_batch IS NULL`.

- [ ] **Step 4: Run** the test file → PASS. Then `npm test -- tests/leasing-*.test.js` → no new failures.

- [ ] **Step 5: Commit** `feat(leasing): a lease from Rent Manager bills from a switch-over 1st and needs no move-in`

---

### Task 2: "Paid in Rent Manager" payment method

**Files:**
- Modify: `server/leasing.js:657` `METHODS`
- Modify: `server/qbSync.js` — `depositEntry` (~99) and the deposit-days query (~210)
- Modify: `server/zego.js:203-207` `sameOnLease`
- Modify: `server/leasingReceipt.js` — refuse a receipt for this method
- Modify: `server/leasingReports.js` — any sum of money received over `lease_payments`
- Modify: client payment-method list in `client/src/components/BookingPayments.jsx` (or wherever the client keeps it)
- Test: `tests/leasing-switchover.test.js`, `tests/qb-sync.test.js`

**Interfaces:**
- Produces: method key `'rent_manager'`, label `'Paid in Rent Manager'`. Exported SQL fragment `NOT_RENT_MANAGER = "p.method <> 'rent_manager'"` from `server/leasing.js` for the other modules.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/leasing-switchover.test.js
test('an opening credit and an old deposit are recorded as Paid in Rent Manager', async () => {
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true, security_deposit: 500, deposit_due: '2023-04-01' }, staff);
  await payBooking(bk.id, { amount: 500, method: 'rent_manager', received_on: '2023-04-01' }, staff, '2026-10-30');
  assert.equal((await depositState(bk.id)).held, 500);
  await payBooking(bk.id, { amount: 200, method: 'rent_manager', received_on: '2026-10-31', keep_credit: true }, staff, '2026-10-31');
  assert.equal((await ledger(bk.id, '2026-10-31')).balance, -200);
});
test('an opening balance is one charge', async () => {
  const bk = await createBooking({ ...base, billed_from: '2026-11-01', from_rent_manager: true }, staff);
  await addCharge(bk.id, { label: 'Balance brought forward from Rent Manager', due_date: '2026-10-31', amount: 777.5 }, staff);
  assert.equal((await ledger(bk.id, '2026-10-31')).balance, 777.5);
});
// tests/qb-sync.test.js — set up QB settings as the file already does
test('qb deposit skips Rent Manager money but keeps the rest', async () => {
  // one lease; on 2026-11-02: a 'rent_manager' payment of 200 and a 'cash' payment of 1000
  const e = await entryFor('deposit:2026-11-02', s, '2026-11-03');
  assert.equal(totalOf(e), 1000); // totalOf: sum of the entry's line amounts, as the file's other tests read them
});
test('a day with only Rent Manager money has no qb deposit', async () => {
  assert.equal(await entryFor('deposit:2026-10-31', s, '2026-11-03'), null);
});
```

- [ ] **Step 2: Run** both files → FAIL (`rent_manager` unknown method / included in deposit).

- [ ] **Step 3: Implement.** Add `['rent_manager', 'Paid in Rent Manager']` to `METHODS`. Export `NOT_RENT_MANAGER`. Add it to the `WHERE` of `qbSync.depositEntry`, the deposit-days query at ~210, `zego.sameOnLease`, and every money-received sum in `leasingReports.js`. `leasingReceipt.js`: a payment with this method → `bad('Paid in Rent Manager: there is no receipt for it.', 409)`; the client hides the receipt button for it. Client method list: add the option with hint "Money received before the switch-over. Kept out of QuickBooks."

- [ ] **Step 4: Run** both files → PASS; `npm test -- tests/zego.test.js tests/leasing-reports.test.js` → PASS.

- [ ] **Step 5: Commit** `feat(leasing): Paid in Rent Manager, kept out of QuickBooks, Zego, receipts and reports`

---

### Task 3: Switch-over on the lease form (client)

**Files:**
- Modify: `client/src/components/Leasing.jsx` — `BookingForm` initial state (~312), step 3 "Contract & notes" section (~678), lease card detail list (~927)

**Interfaces:**
- Consumes: Task 1 body fields `from_rent_manager`, `billed_from`.

- [ ] **Step 1: Add** a `Group title="Rent Manager"` in step 3: a checkbox **"Already living here — moved over from Rent Manager"** (new leases only). When ticked, show `DateField` **"Bill in this app from"** with hint *"The 1st of the month this app takes over. Rent before it was billed in Rent Manager."* Default it to the 1st of next month. Send both fields on save. On the lease card's detail list add `['Billed here from', b.billed_from && fmt(b.billed_from)]`.
- [ ] **Step 2: Verify in the browser** (`npm run dev`, local lease DB): make a lease 03/01/2025–02/28/2027 ticked from Rent Manager, billing 11/01/2026 → Payments shows rent from 11/01/2026; Add charge "Balance brought forward from Rent Manager"; record the deposit with method "Paid in Rent Manager" dated 04/01/2023; no move-in badge on the unit.
- [ ] **Step 3: Commit** `feat(leasing): lease form takes a Rent Manager switch-over date`

---

### Task 4: Archive (server)

**Files:**
- Modify: `server/db.js` — new tables (append after the work-order tables, ~1708)
- Create: `server/leaseArchive.js`
- Modify: `server/index.js` — mount `archiveRoutes` at `/api/leasing` before `leasingRoutes` (~111)
- Modify: `server/leasingHistory.js` `tenantHistory` — add `archive` list
- Modify: `server/activity.js` `LABELS`; `tests/helpers/db.js` `TABLES`
- Test: `tests/lease-archive.test.js` (new)

**Tables** (all `created_at BIGINT DEFAULT ${NOW}`):
- `lease_archive`: `id SERIAL PK, unit_id INT NOT NULL REFERENCES prop_units ON DELETE RESTRICT, tenant_id INT REFERENCES lease_tenants ON DELETE SET NULL, tenant_name TEXT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, rent_amount NUMERIC, security_deposit NUMERIC, ended_how TEXT NOT NULL, unpaid_at_end NUMERIC, notes TEXT, created_by INT REFERENCES users ON DELETE SET NULL`. Index `(unit_id, start_date)`, `(tenant_id)`.
- `lease_archive_payments`: `id, archive_id INT NOT NULL REFERENCES lease_archive ON DELETE CASCADE, received_on DATE NOT NULL, amount NUMERIC NOT NULL, method TEXT NOT NULL, reference TEXT, notes TEXT, file_path, file_name, file_mime, created_by`.
- `lease_archive_work_orders`: `id, archive_id … CASCADE, reported_on DATE NOT NULL, detail TEXT NOT NULL, resolution TEXT, done_on DATE, cost NUMERIC, created_by`.
- `lease_archive_files`: `id, archive_id … CASCADE, work_order_id INT REFERENCES lease_archive_work_orders ON DELETE CASCADE, title TEXT, category TEXT, file_path TEXT NOT NULL, file_name, file_mime, uploaded_by`.

**Interfaces (all exported from `server/leaseArchive.js`):**
- `ENDED = [['renewed','Renewed'],['moved_out','Moved out'],['evicted','Evicted'],['transferred','Transferred to another unit']]`
- `ARCHIVE_METHODS = [...METHODS without 'zego' and 'rent_manager', ['check','Check']]`
- `listArchive({ unit_id, tenant_id, building_id, q }) → [{ id, unit_id, unit_no, building, tenant_id, tenant, start_date, end_date, rent_amount, ended_how, payments, work_orders, files }]` (counts; oldest first)
- `getArchive(id) → { ...row, payments: [...], work_orders: [{ ..., files: [...] }], files: [...] }` — `files` = those with no `work_order_id`
- `addArchive(body, by) → row` · `updateArchive(id, body, by) → row` · `removeArchive(id) → { ok: true }`
- `addArchivePayment(archiveId, body, file, by)` · `updateArchivePayment(id, body)` · `removeArchivePayment(id)`
- `addArchiveWorkOrder(archiveId, body, by)` · `updateArchiveWorkOrder(id, body)` · `removeArchiveWorkOrder(id)`
- `addArchiveFiles(archiveId, files, { title, category, work_order_id }, by)` · `removeArchiveFile(id)` · `getArchiveFile(id)`
- `previousLeases(bookingId) → listArchive rows for that booking's tenant_id + unit_id`
- Routes (`archiveRoutes`): `GET /archive`, `GET /archive/meta` (ENDED, ARCHIVE_METHODS), `GET /archive/:id`, `POST /archive`, `PUT /archive/:id`, `DELETE /archive/:id`, `POST /archive/:id/payments` (multer single `file`), `PUT|DELETE /archive/payments/:id`, `POST /archive/:id/work-orders`, `PUT|DELETE /archive/work-orders/:id`, `POST /archive/:id/files` (multer array `files`, max 10, 25 MB), `GET /archive/files/:id/file`, `GET /archive/payments/:id/file`, `DELETE /archive/files/:id`, `GET /bookings/:id/previous`.

**Rules:** unit required (`'Choose a unit.'`); `tenant_id` or typed `tenant_name` required (`'Choose the tenant or type their name.'`); with `tenant_id`, `tenant_name` is copied from the tenant's `full_name` at save; both dates required and `end_date >= start_date`; money ≥ 0 or empty; `ended_how` in `ENDED`; payment amount > 0, date required, method in `ARCHIVE_METHODS`; work order `detail` and `reported_on` required. Files saved with `saveFile(file, ARCHIVE_DIR)` (`ARCHIVE_DIR = ${DATA_DIR}/lease-archive`) and served with `sendDoc`. Any delete removes the row's files from disk (`rmSync(..., { force: true })`), including all files under a removed archived lease.

- [ ] **Step 1: Write the failing tests** in `tests/lease-archive.test.js`:

```js
test('an archived lease with its payments, work orders and files reads back', …)          // getArchive shape, oldest-first order
test('archive needs a unit, a tenant or name, and dates in order', …)                      // each /message/ above
test('a past tenant can be a typed name only, and no tenant record is made', …)           // count(lease_tenants) unchanged
test('a removed tenant\'s archive keeps the name', …)                                       // delete tenant (no live leases) → tenant_id null, tenant 'Jane Old'
test('archive never touches live money', async () => {
  // live lease on unit, ledger balance B and bookingPayments rows R; add archive on same unit+tenant
  // with dates overlapping the live lease, 3 payments, 1 work order → ledger(...).balance === B,
  // bookingPayments deepEqual R, listUnits unchanged, listWorkOrders({}) length unchanged
});
test('archive never blocks a live lease', …)        // archive 2024-01-01..2024-12-31 on unit; createBooking confirmed same dates → succeeds
test('previous leases are the tenant\'s own in that unit, oldest first', …)  // 2 archives same tenant+unit (entered 2024 then 2023), 1 other tenant → previousLeases returns [2023, 2024]
test('removing an archived lease removes its files', …)  // addArchiveFiles with a buffer file; removeArchive; existsSync(path) === false
test('tenant history lists archived leases', …)    // tenantHistory(t.id).archive length 2
```

- [ ] **Step 2: Run** `npm test -- tests/lease-archive.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** tables, `server/leaseArchive.js`, routes, mount, `tenantHistory.archive = await listArchive({ tenant_id })`, `LABELS` lines (`lease_archive: 'Archived lease'`, `lease_archive_payments: 'Archived payment'`, `lease_archive_work_orders: 'Archived work order'`, `lease_archive_files: 'Archived file'`, each with an `about`), add the four tables to `TABLES`.
- [ ] **Step 4: Run** `npm test -- tests/lease-archive.test.js tests/actions.test.js tests/activity-*.test.js tests/leasing-*.test.js` → PASS (no new failures).
- [ ] **Step 5: Commit** `feat(leasing): Rent Manager archive — old leases, payments, work orders and files, kept apart from live money`

---

### Task 5: Archive screen and Previous leases (client)

**Files:**
- Create: `client/src/components/Archive.jsx`
- Modify: `client/src/components/Leasing.jsx` — `BOOKING_TABS` (~1389) add `['archive', 'Archive']`, render `<Archive />` for it; `BookingCard` (~826) "Previous leases (Rent Manager)" section; tenant history view shows `archive`

**Interfaces:**
- Consumes: Task 4 routes.

- [ ] **Step 1: Build `Archive.jsx`** following `Prospects.jsx`'s patterns (`api`, `Select`, `DateField`, `Pager`, `canDo`, `FIELD`/`PRIMARY` classes):
  - **List:** filters Building → Unit (`Select`), tenant search; rows show unit, tenant, MM/DD/YYYY–MM/DD/YYYY, rent, how it ended, counts. "Add old lease" button (`canDo('add')`).
  - **Form:** unit, tenant (`Select` of tenants **or** "Not in the app — type name"), start, end, monthly rent, deposit, how it ended, unpaid at end, notes.
  - **Detail:** a clear badge **"Archived · from Rent Manager — history only, no billing"**; Edit/Delete (`canDo`); three sections, each with add/edit/delete lines: **Payments** (date, amount, method, reference, optional file), **Work orders** (reported, what was wrong, what was done, done on, cost, files), **Files** (title, category, upload many).
- [ ] **Step 2: Lease card:** on a confirmed lease, fetch `GET /leasing/bookings/:id/previous` when the card opens; if any, show "Previous leases (Rent Manager)" as a short list (dates · rent · how it ended), each opening the archive detail.
- [ ] **Step 3: Tenant history:** show the tenant's archived leases under their live ones, labelled Archived.
- [ ] **Step 4: Verify in the browser:** add a 2024 then a 2023 archived lease for one tenant in a unit with a live lease; Previous leases lists 2023 first; add a payment with a slip, a work order with a photo, a file; delete one payment; the live lease's Payments and balance are unchanged; a staff user without Delete sees no delete buttons. `npm run build` passes.
- [ ] **Step 5: Commit** `feat(leasing): Archive tab and Previous leases on the lease card`
