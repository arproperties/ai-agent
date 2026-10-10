# Work Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A work order module for the leasing app: a repair is raised on a unit, links itself to the lease and tenant living there, moves through a status flow, and keeps a history of every change.

**Architecture:** One new server module, `server/workOrders.js`, owns three new tables (`lease_work_orders`, `lease_work_order_events`, `lease_work_order_files`), the rules and the routes. Tenant History, Riley's tools and the alerts read from it; nothing else writes to its tables. One new client page, `WorkOrders.jsx`, is the list, the form and the detail view, and is opened from the menu, a unit, a lease and a tenant's history.

**Tech Stack:** Node 22 (ES modules), Express 5, Postgres via the `db` / `tx` wrapper in `server/db.js`, `node --test`, React + Tailwind + lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-10-work-orders-design.md`. Read it before starting.

## Global Constraints

- Branch `leasing-bookings` only. Never commit to, merge into or push to `main`. Do not push or deploy at all: Francis says when.
- **Before Task 1:** run `git status --short`. If `server/db.js` or `server/properties.js` show as modified, another piece of work (the documents register) is uncommitted in them. Stop and ask Francis to commit it first; do not commit those hunks yourself.
- Each commit stages only the files its task names (`git add <paths>`), never `git add -A`.
- No cost, price, invoice amount or charge anywhere in this module (spec D3).
- Only office staff use it: no new role, no technician login (spec D2).
- Never a native `<select>`: use `client/src/components/Select.jsx`.
- Statuses, exactly: `open`, `assigned`, `in_progress`, `done`, `closed`, `cancelled`. Priorities, exactly: `low`, `normal`, `urgent`.
- Reference format: `WO-<year of reported_on>-<id padded to 4>`, e.g. `WO-2026-0014`.
- Event rows (`lease_work_order_events`) are insert-only. No function updates or deletes one.
- Errors are thrown with `bad(message, status)` from `server/leasing.js`; messages are plain sentences a clerk can read.
- Comments and messages follow the file they are in: short, plain, saying why.
- Tests need `TEST_DATABASE_URL` pointing at a database whose name ends in `_test`. One file: `npm test -- tests/work-orders.test.js`. Everything: `npm test`. `tests/drawing.test.js` crashes on Windows for an unrelated reason; that one failure is expected.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. A fault reported after the lease's last day while the tenant has not moved out yet: no confirmed lease covers that day, so it must save without error as a vacant-unit work order. (Test in Task 1.)
2. A reference whose year changed because `reported_on` was edited across New Year: the old reference must still find it, since only the number identifies it. (Test in Task 5.)
3. Deleting a unit that has work orders: refused, with a message that names work orders, not only leases. (Test in Task 1.)
4. A status sent that equals the current one, with nothing else changed: returns the work order as it is and writes no event. (Test in Task 2.)
5. An urgent work order raised when the only person to tell is the one who raised it: no push, no error. (Test in Task 6.)

## File Structure

| File | Responsibility |
|------|----------------|
| `server/db.js` (modify) | The three tables. |
| `server/workOrders.js` (create) | Rules, routes, the move of old notes, the urgent push. |
| `server/properties.js` (modify) | One error message, when a unit cannot be deleted. |
| `server/index.js` (modify) | Mount the routes; run the move at start-up. |
| `server/leasingHistory.js` (modify) | Maintenance comes from work orders; new `maintenance` notes refused. |
| `server/leasingKit.js` (modify) | Riley's three tools; the history line. |
| `server/leasingAlerts.js` (modify) | The `workorder` rule and the overdue alert. |
| `tests/work-orders.test.js` (create) | Every rule above. |
| `tests/leasing-history.test.js`, `tests/helpers/db.js` (modify) | Updated for the move; new tables in the reset list. |
| `client/src/components/WorkOrders.jsx` (create) | List, form, detail view with timeline. |
| `client/src/components/Leasing.jsx`, `Sidebar.jsx`, `Inspections.jsx`, `TenantHistory.jsx`, `LeasingAlerts.jsx`, `client/src/App.jsx` (modify) | Entry points and the menu. |

---

### Task 1: Tables, raising a work order, the list

**Files:**
- Modify: `server/db.js` (after the `prop_inspection_photos` block, near line 1375)
- Modify: `server/properties.js` (the `23503` message in `remove`, near line 127)
- Modify: `tests/helpers/db.js:44`
- Create: `server/workOrders.js`
- Test: `tests/work-orders.test.js`

**Interfaces:**
- Consumes: `db`, `tx` from `server/db.js`; `bad`, `isDate`, `bookingRef`, `todayHere` from `server/leasing.js`.
- Produces:
  - `STATUS` — `{ open: 'Open', assigned: 'Assigned', in_progress: 'In progress', done: 'Done', closed: 'Closed', cancelled: 'Cancelled' }`
  - `PRIORITIES` — `['low', 'normal', 'urgent']`; `LIVE` — `['open', 'assigned', 'in_progress']`
  - `workOrderRef(w) → 'WO-2026-0001'`
  - `leaseOn(unitId, 'YYYY-MM-DD') → { booking_id, tenant_id, tenant, start_date } | null`
  - `createWorkOrder(body, by, today?) → work order`
  - `getWorkOrder(id, today?) → work order` with `files: [{ id, file_name, file_mime }]` and `events: [{ id, kind, detail, created_at, who }]` (oldest first); throws 404
  - `listWorkOrders({ status, building_id, unit_id, booking_id, tenant_id, priority, overdue, q }, today?) → work order[]` (no files or events), newest first
  - A work order has: `id, ref, unit_id, unit_no, building_id, building, booking_id, lease_ref, tenant_id, tenant, category, priority, detail, reported_by, reported_on, status, assigned_to, scheduled_on, resolution, done_on, cancel_reason, created_by, raised_by, created_at, overdue`

- [ ] **Step 1: Write the failing tests**

Create `tests/work-orders.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, remove } from '../server/properties.js';
import { createBooking } from '../server/leasing.js';
import { createWorkOrder, getWorkOrder, listWorkOrders } from '../server/workOrders.js';

test.after(() => closeDb());

const AT = '2026-10-25';

// Sara has unit 101 from 15 September to 14 November. Unit 102 is empty.
async function tower() {
  await reset();
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const building = await create('building', { name: 'Tower' }, c.id);
  const u1 = await create('unit', { unit_no: '101' }, building.id);
  const u2 = await create('unit', { unit_no: '102' }, building.id);
  const bk = await createBooking({ unit_id: u1.id, start_date: '2026-09-15', end_date: '2026-11-14', rent_amount: 4500, status: 'confirmed',
    tenant: { full_name: 'Sara', phone: '050 123 4567' } }, staff);
  return { staff, building, u1, u2, bk, sara: bk.tenant_id };
}

test('a work order is raised on a unit and links itself to the lease and tenant of that day', async () => {
  const { staff, u1, u2, bk, sara } = await tower();
  await assert.rejects(createWorkOrder({ detail: 'x' }, staff, AT), /Choose the unit/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: ' ' }, staff, AT), /Say what is wrong/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', priority: 'asap' }, staff, AT), /low, normal or urgent/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', reported_on: '2026-13-40' }, staff, AT), /not a date/);
  await assert.rejects(createWorkOrder({ unit_id: u1.id, detail: 'x', reported_on: '2026-10-26' }, staff, AT), /in the future/);

  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_by: 'Sara' }, staff, AT);
  assert.deepEqual([ac.ref, ac.status, ac.priority, ac.reported_on, ac.unit_no, ac.building, ac.tenant, ac.tenant_id, ac.booking_id, ac.lease_ref, ac.raised_by, ac.overdue],
    ['WO-2026-0001', 'open', 'normal', AT, '101', 'Tower', 'Sara', sara, bk.id, bk.ref, 'Staff', false]);
  assert.deepEqual(ac.events.map((e) => [e.kind, e.detail, e.who]), [['created', 'Raised for Sara', 'Staff']]);
  assert.deepEqual(ac.files, []);

  // An empty unit: the work order has no tenant.
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway' }, staff, AT);
  assert.deepEqual([paint.tenant, paint.tenant_id, paint.booking_id, paint.lease_ref], [null, null, null, null]);
  assert.deepEqual(paint.events.map((e) => e.detail), ['Raised for the vacant unit']);

  // Reported after the lease's last day: nobody's lease covers it, so it is the unit's alone.
  const late = await createWorkOrder({ unit_id: u1.id, detail: 'Door handle loose', reported_on: '2026-11-20' }, staff, '2026-11-25');
  assert.equal(late.tenant, null);

  // Given an assignee from the start, it starts as assigned.
  const leak = await createWorkOrder({ unit_id: u1.id, detail: 'Leak under the sink', assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-28', priority: 'urgent' }, staff, AT);
  assert.deepEqual([leak.status, leak.assigned_to, leak.scheduled_on], ['assigned', 'Cool Air LLC', '2026-10-28']);
  assert.deepEqual(leak.events.map((e) => [e.kind, e.detail]), [['created', 'Raised for Sara'], ['assigned', 'Assigned to Cool Air LLC']]);

  await assert.rejects(getWorkOrder(999), /not found/);
});

test('the list is filtered by status, place, tenant, priority, lateness and words', async () => {
  const { staff, building, u1, u2, bk, sara } = await tower();
  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_on: '2026-10-20' }, staff, AT);
  const leak = await createWorkOrder({ unit_id: u1.id, category: 'Plumbing', detail: 'Leak under the sink', priority: 'urgent', assigned_to: 'Pipes Co', scheduled_on: '2026-10-22' }, staff, AT);
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway', scheduled_on: '2026-10-30' }, staff, AT);
  await db.prepare("UPDATE lease_work_orders SET status = 'closed' WHERE id = ?").run(paint.id);
  const ids = async (q) => (await listWorkOrders(q, AT)).map((w) => w.id);

  assert.deepEqual(await ids({}), [paint.id, leak.id, ac.id], 'newest reported first, then newest made');
  assert.deepEqual(await ids({ status: 'active' }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ status: 'closed' }), [paint.id]);
  assert.deepEqual(await ids({ unit_id: u2.id }), [paint.id]);
  assert.deepEqual(await ids({ building_id: building.id }), [paint.id, leak.id, ac.id]);
  assert.deepEqual(await ids({ building_id: 999 }), []);
  assert.deepEqual(await ids({ tenant_id: sara }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ booking_id: bk.id }), [leak.id, ac.id]);
  assert.deepEqual(await ids({ priority: 'urgent' }), [leak.id]);
  assert.deepEqual(await ids({ overdue: 'true' }), [leak.id], 'scheduled before today and not done');
  assert.deepEqual(await ids({ q: 'sink' }), [leak.id]);
  assert.deepEqual(await ids({ q: 'wo-2026-0001' }), [ac.id]);
  assert.deepEqual(await ids({ q: 'pipes' }), [leak.id]);
  assert.equal((await listWorkOrders({}, AT)).find((w) => w.id === leak.id).overdue, true);
  assert.equal((await listWorkOrders({}, AT)).find((w) => w.id === paint.id).overdue, false, 'a closed one is never overdue');
});

test('a unit with work orders is not deleted, and the message says why', async () => {
  const { staff, u2 } = await tower();
  await createWorkOrder({ unit_id: u2.id, detail: 'Repaint the hallway' }, staff, AT);
  await assert.rejects(remove('unit', u2.id), /work orders/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- tests/work-orders.test.js`
Expected: FAIL, `Cannot find module '../server/workOrders.js'`.

- [ ] **Step 3: Add the tables**

In `server/db.js`, directly after the `await db.exec(...)` block that creates `prop_inspections` and `prop_inspection_photos`, add:

```js
// A repair to a unit, from the day it is reported to the day it is fixed. It belongs to the
// unit; the lease and tenant are the ones the unit had that day, filled in by the server
// (workOrders.js), or none when it was empty. Nothing is charged: repairs are under the AMC.
//   status: open → assigned → in_progress → done → closed, or cancelled.
//   tenant: their name as it was, kept if the lease or the tenant goes.
//   lease_work_order_events: its history, one row per change, written and never changed.
//   lease_work_order_files: photos and files, any number.
await db.exec(`
  CREATE TABLE IF NOT EXISTS lease_work_orders (
    id SERIAL PRIMARY KEY,
    unit_id       INTEGER NOT NULL REFERENCES prop_units(id) ON DELETE RESTRICT,
    booking_id    INTEGER REFERENCES lease_bookings(id) ON DELETE SET NULL,
    tenant_id     INTEGER REFERENCES lease_tenants(id) ON DELETE SET NULL,
    tenant        TEXT,
    category      TEXT,
    priority      TEXT NOT NULL DEFAULT 'normal',
    detail        TEXT NOT NULL,
    reported_by   TEXT,
    reported_on   DATE NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    assigned_to   TEXT,
    scheduled_on  DATE,
    resolution    TEXT,
    done_on       DATE,
    cancel_reason TEXT,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_lease_work_orders_unit ON lease_work_orders(unit_id, reported_on);
  CREATE INDEX IF NOT EXISTS idx_lease_work_orders_tenant ON lease_work_orders(tenant_id, reported_on);
  CREATE INDEX IF NOT EXISTS idx_lease_work_orders_booking ON lease_work_orders(booking_id);
  CREATE TABLE IF NOT EXISTS lease_work_order_events (
    id SERIAL PRIMARY KEY,
    work_order_id INTEGER NOT NULL REFERENCES lease_work_orders(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    detail     TEXT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_lease_work_order_events ON lease_work_order_events(work_order_id);
  CREATE TABLE IF NOT EXISTS lease_work_order_files (
    id SERIAL PRIMARY KEY,
    work_order_id INTEGER NOT NULL REFERENCES lease_work_orders(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    file_name   TEXT,
    file_mime   TEXT,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  BIGINT DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_lease_work_order_files ON lease_work_order_files(work_order_id);
`);
```

In `tests/helpers/db.js`, in `TABLES`, change the end of the leasing line from

```js
'prop_inspections', 'prop_inspection_photos',
```

to

```js
'prop_inspections', 'prop_inspection_photos', 'lease_work_orders', 'lease_work_order_events', 'lease_work_order_files',
```

In `server/properties.js`, in `remove`, change the unit's message:

```js
unit: 'This unit has leases. Cancel or delete them first.'
```

to

```js
unit: 'This unit has leases or work orders, so it is kept.'
```

Then check nothing else asserts the old text: `grep -rn "This unit has leases" tests client/src`. Update any test that does to match `/leases or work orders/`.

- [ ] **Step 4: Write `server/workOrders.js`**

```js
import { db, tx } from './db.js';
import { bad, isDate, bookingRef, todayHere } from './leasing.js';

// Work orders: a repair to a unit, from the report to the fix. It belongs to the unit, and
// carries the lease and tenant the unit had on the day it was reported, which the server
// works out, so one is never tied to the wrong tenant; an empty unit's has neither.
//
// Only the office writes here: the technician or the AMC vendor is a name typed in. Nothing
// is charged and nothing is sent to the tenant. Every change is written to its history
// (lease_work_order_events), and a row of that history is never changed afterwards.

export const STATUS = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', done: 'Done', closed: 'Closed', cancelled: 'Cancelled' };
export const PRIORITIES = ['low', 'normal', 'urgent'];
export const LIVE = ['open', 'assigned', 'in_progress']; // not done yet
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

/** WO-2026-0014. The number alone identifies it: the year is the year it was reported. */
export const workOrderRef = (w) => `WO-${w.reported_on.slice(0, 4)}-${String(w.id).padStart(4, '0')}`;

const SELECT = `SELECT w.id, w.unit_id, w.booking_id, w.tenant_id, w.tenant, w.category, w.priority, w.detail, w.reported_by, w.status, w.assigned_to,
    w.resolution, w.cancel_reason, w.created_by, w.created_at, ${day('w.reported_on')} AS reported_on, ${day('w.scheduled_on')} AS scheduled_on, ${day('w.done_on')} AS done_on,
    u.unit_no, bl.id AS building_id, bl.name AS building, r.name AS raised_by, ${day('b.start_date')} AS lease_start
  FROM lease_work_orders w
  JOIN prop_units u ON u.id = w.unit_id
  JOIN prop_buildings bl ON bl.id = u.building_id
  LEFT JOIN users r ON r.id = w.created_by
  LEFT JOIN lease_bookings b ON b.id = w.booking_id`;
const shape = ({ lease_start, ...w }, today) => ({ ...w, ref: workOrderRef(w), lease_ref: w.booking_id ? bookingRef({ id: w.booking_id, start_date: lease_start }) : null,
  overdue: LIVE.includes(w.status) && !!w.scheduled_on && w.scheduled_on < today });

const log = (id, kind, detail, by) => db.prepare('INSERT INTO lease_work_order_events (work_order_id, kind, detail, user_id) VALUES (?, ?, ?, ?)').run(id, kind, detail || null, by ?? null);

/** The confirmed lease a unit had on a day, with its tenant; null when it was empty. */
export async function leaseOn(unitId, on) {
  return (await db.prepare(`SELECT b.id AS booking_id, b.tenant_id, t.full_name AS tenant, ${day('b.start_date')} AS start_date
    FROM lease_bookings b JOIN lease_tenants t ON t.id = b.tenant_id
    WHERE b.unit_id = ? AND b.status = 'confirmed' AND ?::date BETWEEN b.start_date AND b.end_date
    ORDER BY b.start_date DESC LIMIT 1`).get(Number(unitId) || 0, on)) || null;
}
const linkOf = (lease) => ({ booking_id: lease?.booking_id ?? null, tenant_id: lease?.tenant_id ?? null, tenant: lease?.tenant ?? null });

export async function getWorkOrder(id, today = todayHere()) {
  const w = await db.prepare(`${SELECT} WHERE w.id = ?`).get(Number(id) || 0);
  if (!w) throw bad('That work order was not found.', 404);
  const files = await db.prepare('SELECT id, file_name, file_mime FROM lease_work_order_files WHERE work_order_id = ? ORDER BY id').all(w.id);
  const events = await db.prepare(`SELECT e.id, e.kind, e.detail, e.created_at, p.name AS who
    FROM lease_work_order_events e LEFT JOIN users p ON p.id = e.user_id WHERE e.work_order_id = ? ORDER BY e.id`).all(w.id);
  return { ...shape(w, today), files, events };
}

/** What a person types on a work order, checked. `partial`: only what was sent. */
function fields(body = {}, today, { partial = false } = {}) {
  const out = {};
  if ('category' in body) out.category = text(body.category, 60);
  if ('reported_by' in body) out.reported_by = text(body.reported_by, 120);
  if ('assigned_to' in body) out.assigned_to = text(body.assigned_to, 120);
  if (!partial || 'priority' in body) {
    out.priority = body.priority == null || body.priority === '' ? 'normal' : body.priority;
    if (!PRIORITIES.includes(out.priority)) throw bad('The priority is low, normal or urgent.');
  }
  if (!partial || 'detail' in body) {
    out.detail = text(body.detail, 2000);
    if (!out.detail) throw bad('Say what is wrong.');
  }
  if (!partial || 'reported_on' in body) {
    const v = String(body.reported_on ?? '').trim() || (partial ? '' : today);
    if (!isDate(v)) throw bad('The date is not a date.');
    if (v > today) throw bad('The reported date cannot be in the future.');
    out.reported_on = v;
  }
  if ('scheduled_on' in body) {
    const v = String(body.scheduled_on ?? '').trim();
    if (v && !isDate(v)) throw bad('The scheduled date is not a date.');
    out.scheduled_on = v || null;
  }
  return out;
}

/** Raise a work order on a unit. Its lease and tenant are whoever had the unit on the reported day. */
export async function createWorkOrder(body = {}, by, today = todayHere()) {
  const unit = await db.prepare('SELECT id FROM prop_units WHERE id = ?').get(Number(body.unit_id) || 0);
  if (!unit) throw bad('Choose the unit.');
  const f = fields(body, today);
  const lease = await leaseOn(unit.id, f.reported_on);
  const row = { ...f, ...linkOf(lease), unit_id: unit.id, status: f.assigned_to ? 'assigned' : 'open', created_by: by ?? null };
  const id = await tx(async () => {
    const cols = Object.keys(row);
    const made = await db.prepare(`INSERT INTO lease_work_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
    await log(made.id, 'created', lease ? `Raised for ${lease.tenant}` : 'Raised for the vacant unit', by);
    if (row.assigned_to) await log(made.id, 'assigned', `Assigned to ${row.assigned_to}`, by);
    return made.id;
  });
  return getWorkOrder(id, today);
}

/** The list, newest first. `status: 'active'` is everything not closed or cancelled. */
export async function listWorkOrders({ status, building_id, unit_id, booking_id, tenant_id, priority, overdue, q } = {}, today = todayHere()) {
  const where = [];
  const args = [];
  const add = (sql, ...v) => { where.push(sql); args.push(...v); };
  if (status === 'active') add("w.status NOT IN ('closed', 'cancelled')");
  else if (STATUS[status]) add('w.status = ?', status);
  if (Number(building_id)) add('bl.id = ?', Number(building_id));
  if (Number(unit_id)) add('w.unit_id = ?', Number(unit_id));
  if (Number(booking_id)) add('w.booking_id = ?', Number(booking_id));
  if (Number(tenant_id)) add('w.tenant_id = ?', Number(tenant_id));
  if (PRIORITIES.includes(priority)) add('w.priority = ?', priority);
  if (overdue === true || overdue === 'true' || overdue === '1') add("w.status IN ('open', 'assigned', 'in_progress') AND w.scheduled_on < ?::date", today);
  const words = String(q ?? '').trim().toLowerCase();
  if (words) {
    add(`lower(concat_ws(' ', 'WO-' || to_char(w.reported_on, 'YYYY') || '-' || lpad(w.id::text, 4, '0'), u.unit_no, bl.name, w.tenant, w.category, w.detail, w.assigned_to)) LIKE ?`, `%${words}%`);
  }
  const rows = await db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY w.reported_on DESC, w.id DESC`).all(...args);
  return rows.map((w) => shape(w, today));
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/work-orders.test.js`
Expected: PASS, 3 tests.

Also run `npm test -- tests/properties.test.js tests/leasing.test.js` to confirm the message change broke nothing. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/properties.js server/workOrders.js tests/helpers/db.js tests/work-orders.test.js
git commit -m "feat: Leasing - work orders: a repair is raised on a unit and links itself to the lease and tenant of that day"
```

---

### Task 2: Changing a work order: assignment, schedule, status, reopening, notes, deleting

**Files:**
- Modify: `server/workOrders.js`
- Test: `tests/work-orders.test.js`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:
  - `updateWorkOrder(id, body, by, today?) → work order`. `body` may hold any of `category, priority, detail, reported_by, reported_on, assigned_to, scheduled_on`, plus `status` (with `resolution`, optional `done_on` for `done`; `cancel_reason` for `cancelled`), or `reopen: true` (with optional `note`).
  - `addWorkOrderNote(id, note, by, today?) → work order`
  - `removeWorkOrder(id) → { ok: true }` (the caller checks the user is the master)

- [ ] **Step 1: Write the failing tests**

Add to the import line in `tests/work-orders.test.js`:

```js
import { createWorkOrder, getWorkOrder, listWorkOrders, updateWorkOrder, addWorkOrderNote, removeWorkOrder } from '../server/workOrders.js';
```

Append:

```js
test('a work order moves forward step by step, and each step is written in its history', async () => {
  const { staff, u1 } = await tower();
  const boss = await makeUser('Boss');
  const w = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling' }, staff, AT);

  await assert.rejects(updateWorkOrder(w.id, { status: 'flying' }, staff, AT), /not a status/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'assigned' }, staff, AT), /who it is assigned to/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'closed' }, staff, AT), /Only a work order that is done/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'done' }, staff, AT), /Say what was done/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'cancelled' }, staff, AT), /Say why/);

  // Typing an assignee on an open one makes it assigned; a date is its schedule.
  let now = await updateWorkOrder(w.id, { assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-28' }, boss, AT);
  assert.deepEqual([now.status, now.assigned_to, now.scheduled_on], ['assigned', 'Cool Air LLC', '2026-10-28']);
  now = await updateWorkOrder(w.id, { status: 'in_progress' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { status: 'open' }, staff, AT), /already in progress/);
  await assert.rejects(updateWorkOrder(w.id, { status: 'done', resolution: 'x', done_on: '2026-10-26' }, staff, AT), /in the future/);
  now = await updateWorkOrder(w.id, { status: 'done', resolution: 'Replaced the compressor' }, staff, AT);
  assert.deepEqual([now.status, now.resolution, now.done_on], ['done', 'Replaced the compressor', AT]);
  await assert.rejects(updateWorkOrder(w.id, { status: 'cancelled', cancel_reason: 'x' }, staff, AT), /cannot be cancelled/);
  now = await updateWorkOrder(w.id, { status: 'closed' }, boss, AT);
  assert.equal(now.status, 'closed');

  assert.deepEqual(now.events.map((e) => [e.kind, e.detail, e.who]), [
    ['created', 'Raised for Sara', 'Staff'],
    ['assigned', 'Assigned to Cool Air LLC', 'Boss'],
    ['scheduled', 'Scheduled for 2026-10-28', 'Boss'],
    ['status', 'Assigned → In progress', 'Staff'],
    ['status', 'In progress → Done: Replaced the compressor', 'Staff'],
    ['status', 'Done → Closed', 'Boss'],
  ]);
});

test('a step can be skipped, an assignee taken off, and the words changed', async () => {
  const { staff, u1, u2 } = await tower();
  // A five-minute fix: open straight to done.
  const bulb = await createWorkOrder({ unit_id: u1.id, detail: 'Bulb out' }, staff, AT);
  const done = await updateWorkOrder(bulb.id, { status: 'done', resolution: 'Changed the bulb', done_on: '2026-10-24' }, staff, AT);
  assert.deepEqual([done.status, done.done_on], ['done', '2026-10-24']);

  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', assigned_to: 'Pipes Co' }, staff, AT);
  let now = await updateWorkOrder(w.id, { assigned_to: '' }, staff, AT);
  assert.deepEqual([now.status, now.assigned_to], ['open', null], 'with nobody on it, it is open again');
  now = await updateWorkOrder(w.id, { detail: 'Leak under the kitchen sink', priority: 'urgent', category: 'Plumbing' }, staff, AT);
  assert.deepEqual([now.detail, now.priority, now.category], ['Leak under the kitchen sink', 'urgent', 'Plumbing']);
  assert.equal(now.events.at(-1).detail, 'Changed: type to Plumbing, priority to urgent, description');
  await assert.rejects(updateWorkOrder(w.id, { detail: ' ' }, staff, AT), /Say what is wrong/);

  // Nothing new: nothing is written.
  const before = now.events.length;
  now = await updateWorkOrder(w.id, { status: 'open', priority: 'urgent' }, staff, AT);
  assert.equal(now.events.length, before);

  // A reported day before the lease began: it is no longer the tenant's.
  now = await updateWorkOrder(w.id, { reported_on: '2026-09-01' }, staff, AT);
  assert.deepEqual([now.tenant, now.booking_id], [null, null]);
  now = await updateWorkOrder(w.id, { reported_on: '2026-10-01' }, staff, AT);
  assert.equal(now.tenant, 'Sara');

  // Cancelled with its reason.
  const paint = await createWorkOrder({ unit_id: u2.id, detail: 'Repaint' }, staff, AT);
  const off = await updateWorkOrder(paint.id, { status: 'cancelled', cancel_reason: 'Owner will repaint next year' }, staff, AT);
  assert.deepEqual([off.status, off.cancel_reason, off.events.at(-1).detail], ['cancelled', 'Owner will repaint next year', 'Open → Cancelled: Owner will repaint next year']);
});

test('a finished work order is reopened before it is changed, and notes can always be added', async () => {
  const { staff, u1 } = await tower();
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'AC not cooling', assigned_to: 'Cool Air LLC' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { reopen: true }, staff, AT), /not finished/);
  await updateWorkOrder(w.id, { status: 'done', resolution: 'Regassed' }, staff, AT);
  await updateWorkOrder(w.id, { status: 'closed' }, staff, AT);
  await assert.rejects(updateWorkOrder(w.id, { detail: 'Something else' }, staff, AT), /Reopen it to change it/);

  await assert.rejects(addWorkOrderNote(w.id, '  ', staff, AT), /Write the note/);
  let now = await addWorkOrderNote(w.id, 'Tenant says it is warm again', staff, AT);
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['note', 'Tenant says it is warm again']);

  now = await updateWorkOrder(w.id, { reopen: true, note: 'Not cooling again' }, staff, AT);
  assert.deepEqual([now.status, now.resolution, now.done_on], ['in_progress', null, null], 'it has an assignee, so work carries on');
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['reopened', 'Closed → In progress: Not cooling again']);

  // One with nobody on it goes back to open.
  const bulb = await createWorkOrder({ unit_id: u1.id, detail: 'Bulb out' }, staff, AT);
  await updateWorkOrder(bulb.id, { status: 'cancelled', cancel_reason: 'Duplicate' }, staff, AT);
  now = await updateWorkOrder(bulb.id, { reopen: true }, staff, AT);
  assert.deepEqual([now.status, now.cancel_reason], ['open', null]);
});

test('only a work order nobody has started is deleted; after that it is cancelled, so its history is kept', async () => {
  const { staff, u1 } = await tower();
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Typed twice by mistake' }, staff, AT);
  const started = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', assigned_to: 'Pipes Co' }, staff, AT);
  await assert.rejects(removeWorkOrder(started.id), /Cancel it instead/);
  assert.deepEqual(await removeWorkOrder(w.id), { ok: true });
  await assert.rejects(getWorkOrder(w.id), /not found/);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_work_order_events WHERE work_order_id = ?').get(w.id)).n, 0);
  await assert.rejects(removeWorkOrder(999), /not found/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- tests/work-orders.test.js`
Expected: FAIL, `updateWorkOrder` is not exported.

- [ ] **Step 3: Implement**

In `server/workOrders.js`, add `import { rmSync } from 'node:fs';` at the top, and after `STATUS`:

```js
const STEPS = ['open', 'assigned', 'in_progress', 'done']; // forward only; closed and cancelled have rules of their own
```

Append to the file:

```js
/** A finished one goes back to work: in progress when somebody is on it, open when nobody is. */
async function reopen(now, note, by, today) {
  if (LIVE.includes(now.status)) throw bad(`${now.ref} is not finished.`, 409);
  const status = now.assigned_to ? 'in_progress' : 'open';
  const why = text(note, 500);
  await tx(async () => {
    await db.prepare('UPDATE lease_work_orders SET status = ?, resolution = NULL, done_on = NULL, cancel_reason = NULL WHERE id = ?').run(status, now.id);
    await log(now.id, 'reopened', `${STATUS[now.status]} → ${STATUS[status]}${why ? `: ${why}` : ''}`, by);
  });
  return getWorkOrder(now.id, today);
}

/**
 * Change a work order: its words, who is on it, when they come, or its status. Each kind of
 * change is one line of its history. `reopen: true` takes a finished one back to work.
 */
export async function updateWorkOrder(id, body = {}, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  if (body.reopen) return reopen(now, body.note, by, today);
  if (['closed', 'cancelled'].includes(now.status)) throw bad(`${now.ref} is ${STATUS[now.status].toLowerCase()}. Reopen it to change it.`, 409);
  const f = fields(body, today, { partial: true });
  const changed = (k) => k in f && f[k] !== now[k];
  const set = {};
  const events = [];

  const words = [['category', 'type'], ['priority', 'priority'], ['detail', 'description'], ['reported_by', 'reported by'], ['reported_on', 'reported date']].filter(([k]) => changed(k));
  for (const [k] of words) set[k] = f[k];
  if (words.length) events.push(['edited', `Changed: ${words.map(([k, name]) => (k === 'detail' ? name : `${name} to ${f[k] ?? 'none'}`)).join(', ')}`]);
  // Reported on another day: the lease and tenant are those of that day.
  if (changed('reported_on')) Object.assign(set, linkOf(await leaseOn(now.unit_id, f.reported_on)));

  let status = now.status;
  if (changed('assigned_to')) {
    set.assigned_to = f.assigned_to;
    events.push(['assigned', f.assigned_to ? `Assigned to ${f.assigned_to}` : 'Assignee removed']);
    if (f.assigned_to && status === 'open') status = 'assigned';
    if (!f.assigned_to && status === 'assigned') status = 'open';
  }
  if (changed('scheduled_on')) {
    set.scheduled_on = f.scheduled_on;
    events.push(['scheduled', f.scheduled_on ? `Scheduled for ${f.scheduled_on}` : 'Schedule cleared']);
  }

  const to = body.status;
  if (to != null && to !== status) {
    if (!STATUS[to]) throw bad('That is not a status.');
    const from = status;
    let note = '';
    if (to === 'cancelled') {
      if (!LIVE.includes(from)) throw bad('A work order that is done cannot be cancelled.', 409);
      set.cancel_reason = text(body.cancel_reason, 500);
      if (!set.cancel_reason) throw bad('Say why it is cancelled.');
      note = set.cancel_reason;
    } else if (to === 'closed') {
      if (from !== 'done') throw bad('Only a work order that is done can be closed.', 409);
    } else {
      if (STEPS.indexOf(to) < STEPS.indexOf(from)) throw bad(`${now.ref} is already ${STATUS[from].toLowerCase()}.`, 409);
      if (to === 'assigned' && !('assigned_to' in set ? set.assigned_to : now.assigned_to)) throw bad('Say who it is assigned to.');
      if (to === 'done') {
        set.resolution = text(body.resolution, 2000);
        if (!set.resolution) throw bad('Say what was done.');
        const on = String(body.done_on ?? '').trim() || today;
        if (!isDate(on)) throw bad('The date is not a date.');
        if (on > today) throw bad('The finished date cannot be in the future.');
        set.done_on = on;
        note = set.resolution;
      }
    }
    events.push(['status', `${STATUS[from]} → ${STATUS[to]}${note ? `: ${note}` : ''}`]);
    status = to;
  }
  if (status !== now.status) set.status = status;

  const cols = Object.keys(set);
  if (!cols.length) return now;
  await tx(async () => {
    await db.prepare(`UPDATE lease_work_orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), now.id);
    for (const [kind, detail] of events) await log(now.id, kind, detail, by);
  });
  return getWorkOrder(now.id, today);
}

/** A line somebody adds to the history: "tenant not home, coming back Thursday". Allowed whatever its status. */
export async function addWorkOrderNote(id, note, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  const words = text(note, 1000);
  if (!words) throw bad('Write the note.');
  await log(now.id, 'note', words, by);
  return getWorkOrder(now.id, today);
}

/** Delete one raised by mistake. Once somebody is on it, it is cancelled instead, so what happened is kept. */
export async function removeWorkOrder(id) {
  const now = await getWorkOrder(id);
  if (now.status !== 'open' || now.assigned_to) throw bad(`${now.ref} has been started. Cancel it instead, so its history is kept.`, 409);
  const files = await db.prepare('SELECT file_path FROM lease_work_order_files WHERE work_order_id = ?').all(now.id);
  await db.prepare('DELETE FROM lease_work_orders WHERE id = ?').run(now.id);
  for (const f of files) rmSync(f.file_path, { force: true });
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/work-orders.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/workOrders.js tests/work-orders.test.js
git commit -m "feat: Leasing - a work order is assigned, scheduled, done, closed, cancelled or reopened, and every change is kept in its history"
```

---

### Task 3: Files and routes

**Files:**
- Modify: `server/workOrders.js`
- Modify: `server/index.js` (imports near line 29; mounts near line 90)
- Test: `tests/work-orders.test.js`

**Interfaces:**
- Consumes: `saveFile(file, dir) → { file_path, file_name, file_mime }` and `sendDoc(req, res, row)` from `server/properties.js`; `requireMaster` from `server/auth.js`; `DATA_DIR` from `server/config.js`.
- Produces:
  - `addWorkOrderFiles(id, files, by, today?) → work order`
  - `getWorkOrderFile(fileId) → { id, work_order_id, file_path, file_name, file_mime }`
  - `removeWorkOrderFile(fileId, by) → { ok: true }`
  - `workOrderUnits() → [{ id, unit_no, building_id, building }]`
  - `workOrderLink(unitId, on?, today?) → { tenant, ref }` (both null for an empty unit)
  - `workOrderRoutes` (Express router), mounted at `/api/leasing`:

```
GET    /work-orders                 → { work_orders, master }
GET    /work-orders/units           → [{ id, unit_no, building_id, building }]
GET    /work-orders/link?unit_id=&on= → { tenant, ref }
POST   /work-orders                 → work order
GET    /work-orders/:id             → work order (+ master)
PUT    /work-orders/:id             → work order
DELETE /work-orders/:id             → { ok }      master only
POST   /work-orders/:id/notes       → work order  body { note }
POST   /work-orders/:id/files       → work order  multipart field "files"
GET    /work-orders/files/:id/file  → the file
DELETE /work-orders/files/:id       → { ok }
```

- [ ] **Step 1: Write the failing test**

Add `existsSync` and the new functions to the imports of `tests/work-orders.test.js`:

```js
import { existsSync } from 'node:fs';
import { createWorkOrder, getWorkOrder, listWorkOrders, updateWorkOrder, addWorkOrderNote, removeWorkOrder,
  addWorkOrderFiles, getWorkOrderFile, removeWorkOrderFile, workOrderUnits, workOrderLink } from '../server/workOrders.js';
```

Append:

```js
test('a work order takes several files, each removed by itself, and all go when it is deleted', async () => {
  const { staff, u1 } = await tower();
  const file = (name, mime = 'image/jpeg') => ({ buffer: Buffer.from(name), originalname: name, mimetype: mime });
  const w = await createWorkOrder({ unit_id: u1.id, detail: 'Leak under the sink' }, staff, AT);
  await assert.rejects(addWorkOrderFiles(w.id, [], staff, AT), /Choose a file/);
  await assert.rejects(addWorkOrderFiles(999, [file('a.jpg')], staff, AT), /not found/);

  const two = await addWorkOrderFiles(w.id, [file('before.jpg'), file('report.pdf', 'application/pdf')], staff, AT);
  assert.deepEqual(two.files.map((f) => [f.file_name, f.file_mime]), [['before.jpg', 'image/jpeg'], ['report.pdf', 'application/pdf']]);
  assert.deepEqual([two.events.at(-1).kind, two.events.at(-1).detail], ['file_added', 'Added before.jpg, report.pdf']);
  const paths = (await db.prepare('SELECT file_path FROM lease_work_order_files ORDER BY id').all()).map((r) => r.file_path);
  assert.ok(paths.every((p) => existsSync(p)));
  assert.equal((await getWorkOrderFile(two.files[0].id)).file_name, 'before.jpg');

  await removeWorkOrderFile(two.files[0].id, staff);
  assert.equal(existsSync(paths[0]), false);
  await assert.rejects(removeWorkOrderFile(two.files[0].id, staff), /Not found/);
  const now = await getWorkOrder(w.id, AT);
  assert.deepEqual(now.files.map((f) => f.file_name), ['report.pdf']);
  assert.deepEqual([now.events.at(-1).kind, now.events.at(-1).detail], ['file_removed', 'Removed before.jpg']);

  await removeWorkOrder(w.id);
  assert.ok(paths.every((p) => !existsSync(p)), 'deleting the work order deletes its files');
});

test('the form is told the units there are, and whose a unit is on a day', async () => {
  const { u1, u2, bk } = await tower();
  assert.deepEqual((await workOrderUnits()).map((u) => [u.unit_no, u.building]), [['101', 'Tower'], ['102', 'Tower']]);
  assert.deepEqual(await workOrderLink(u1.id, '2026-10-01', AT), { tenant: 'Sara', ref: bk.ref });
  assert.deepEqual(await workOrderLink(u1.id, '', AT), { tenant: 'Sara', ref: bk.ref }, 'no day given is today');
  assert.deepEqual(await workOrderLink(u2.id, '2026-10-01', AT), { tenant: null, ref: null });
  assert.deepEqual(await workOrderLink(u1.id, 'yesterday', AT), { tenant: null, ref: null }, 'a day that is not a date links to nobody');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- tests/work-orders.test.js`
Expected: FAIL, `addWorkOrderFiles` is not exported.

- [ ] **Step 3: Implement**

At the top of `server/workOrders.js`, the imports become:

```js
import { Router } from 'express';
import multer from 'multer';
import { rmSync } from 'node:fs';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { requireMaster } from './auth.js';
import { saveFile, sendDoc } from './properties.js';
import { bad, isDate, bookingRef, todayHere } from './leasing.js';
```

Append:

```js
// ---------- files ----------

const FILE_DIR = `${DATA_DIR}/leasing`;

/** Attach files: as many as are sent, added to the ones it has. */
export async function addWorkOrderFiles(id, files, by, today = todayHere()) {
  const now = await getWorkOrder(id, today);
  if (!files?.length) throw bad('Choose a file to attach.');
  const names = [];
  for (const file of files) {
    const f = saveFile(file, FILE_DIR);
    await db.prepare('INSERT INTO lease_work_order_files (work_order_id, file_path, file_name, file_mime, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(now.id, f.file_path, f.file_name, f.file_mime, by ?? null);
    names.push(f.file_name);
  }
  await log(now.id, 'file_added', `Added ${names.join(', ')}`, by);
  return getWorkOrder(now.id, today);
}

export const getWorkOrderFile = async (id) => {
  const f = await db.prepare('SELECT id, work_order_id, file_path, file_name, file_mime FROM lease_work_order_files WHERE id = ?').get(Number(id) || 0);
  if (!f) throw bad('Not found', 404);
  return f;
};

export async function removeWorkOrderFile(id, by) {
  const f = await getWorkOrderFile(id);
  await db.prepare('DELETE FROM lease_work_order_files WHERE id = ?').run(f.id);
  rmSync(f.file_path, { force: true });
  await log(f.work_order_id, 'file_removed', `Removed ${f.file_name}`, by);
  return { ok: true };
}

// ---------- what the form asks ----------

/** Every unit, for the form's picker. */
export const workOrderUnits = () => db.prepare(`SELECT u.id, u.unit_no, bl.id AS building_id, bl.name AS building
  FROM prop_units u JOIN prop_buildings bl ON bl.id = u.building_id ORDER BY lower(bl.name), u.unit_no`).all();

/** Whose a unit is on a day (today when none is given), so the form can say who the work order will be for. */
export async function workOrderLink(unitId, on, today = todayHere()) {
  const d = String(on ?? '').trim() || today;
  const lease = isDate(d) ? await leaseOn(unitId, d) : null;
  return { tenant: lease?.tenant ?? null, ref: lease ? bookingRef({ id: lease.booking_id, start_date: lease.start_date }) : null };
}

// ---------- routes ----------

export const workOrderRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_FILES = 10; // in one go; more can be added after
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES } });
const isMaster = (req) => req.user.role === 'master';

workOrderRoutes.get('/work-orders', wrap(async (req, res) => res.json({ work_orders: await listWorkOrders(req.query), master: isMaster(req) })));
workOrderRoutes.get('/work-orders/units', wrap(async (req, res) => res.json(await workOrderUnits())));
workOrderRoutes.get('/work-orders/link', wrap(async (req, res) => res.json(await workOrderLink(req.query.unit_id, req.query.on))));
workOrderRoutes.get('/work-orders/files/:id/file', wrap(async (req, res) => sendDoc(req, res, await getWorkOrderFile(req.params.id))));
workOrderRoutes.delete('/work-orders/files/:id', wrap(async (req, res) => res.json(await removeWorkOrderFile(req.params.id, req.user.id))));
workOrderRoutes.post('/work-orders', wrap(async (req, res) => res.json(await createWorkOrder(req.body, req.user.id))));
workOrderRoutes.get('/work-orders/:id', wrap(async (req, res) => res.json({ ...(await getWorkOrder(req.params.id)), master: isMaster(req) })));
workOrderRoutes.put('/work-orders/:id', wrap(async (req, res) => res.json(await updateWorkOrder(req.params.id, req.body, req.user.id))));
workOrderRoutes.delete('/work-orders/:id', requireMaster, wrap(async (req, res) => res.json(await removeWorkOrder(req.params.id))));
workOrderRoutes.post('/work-orders/:id/notes', wrap(async (req, res) => res.json(await addWorkOrderNote(req.params.id, req.body?.note, req.user.id))));
workOrderRoutes.post('/work-orders/:id/files', upload.array('files', MAX_FILES), wrap(async (req, res) => res.json(await addWorkOrderFiles(req.params.id, req.files, req.user.id))));
```

In `server/index.js`, after `import { inspectionRoutes } from './inspections.js';` add:

```js
import { workOrderRoutes } from './workOrders.js';
```

and after the `app.use('/api/leasing', historyRoutes);` line add:

```js
app.use('/api/leasing', workOrderRoutes); // repairs to a unit, linked to its lease and tenant, each with its history
```

- [ ] **Step 4: Run the tests, and check the server starts**

Run: `npm test -- tests/work-orders.test.js`
Expected: PASS, 9 tests.

Run: `node --check server/index.js && node --check server/workOrders.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add server/workOrders.js server/index.js tests/work-orders.test.js
git commit -m "feat: Leasing - a work order takes photos and files, and is reached over /api/leasing/work-orders"
```

---

### Task 4: The old maintenance notes become work orders, and Tenant History reads from them

**Files:**
- Modify: `server/workOrders.js` (add `moveMaintenanceNotes`)
- Modify: `server/leasingHistory.js`
- Modify: `server/index.js` (start-up, near line 402)
- Test: `tests/work-orders.test.js`, `tests/leasing-history.test.js`

**Interfaces:**
- Consumes: `listWorkOrders`, `LIVE` from Task 1.
- Produces:
  - `moveMaintenanceNotes() → number` (how many were moved)
  - `tenantHistory(tenantId, today?)` now returns `{ tenant, current, summary, items }`. `current` is `{ unit_id, unit_no, building } | null`: the unit the tenant has today. A maintenance item that is a work order has `wo` (its reference), `status`, `priority`, `overdue`, `assigned_to`, and `files: []`; `resolved_on` is its `done_on` once done, else null. A note that could not be moved has no `wo`.
  - `addLog` refuses `kind: 'maintenance'` with "An entry is a complaint. Maintenance is raised as a work order."

- [ ] **Step 1: Write the failing tests**

Add `moveMaintenanceNotes` to the `workOrders.js` import in `tests/work-orders.test.js`, add

```js
import { tenantHistory } from '../server/leasingHistory.js';
```

and append:

```js
test('the maintenance notes of a tenant’s history become work orders, once, with their files', async () => {
  const { staff, u1, bk, sara } = await tower();
  const note = (detail, on, resolved, resolution, booking = bk.id) => db.prepare(`INSERT INTO lease_tenant_log (tenant_id, booking_id, kind, category, detail, reported_by, happened_on, resolved_on, resolution, created_by, created_at)
    VALUES (?, ?, 'maintenance', 'AC', ?, 'Sara', ?, ?, ?, ?, 1760000000) RETURNING id`).run(sara, booking, detail, on, resolved, resolution, staff);
  const open = await note('AC not cooling', '2026-10-01', null, null);
  const fixed = await note('Filter blocked', '2026-09-20', '2026-09-22', 'Cleaned the filter');
  const loose = await note('Before any lease', '2026-01-05', null, null, null);
  await db.prepare("INSERT INTO lease_tenant_log (tenant_id, booking_id, kind, detail, happened_on) VALUES (?, ?, 'complaint', 'Loud music', '2026-10-02')").run(sara, bk.id);
  await db.prepare("INSERT INTO lease_tenant_log_files (log_id, file_path, file_name, file_mime, uploaded_by) VALUES (?, '/tmp/wo-before.jpg', 'before.jpg', 'image/jpeg', ?)").run(open.id, staff);

  assert.equal(await moveMaintenanceNotes(), 2);
  const [a, b] = await listWorkOrders({ tenant_id: sara }, AT);
  assert.deepEqual([a.detail, a.status, a.reported_on, a.unit_id, a.booking_id, a.tenant, a.category, a.reported_by, a.raised_by, a.done_on],
    ['AC not cooling', 'open', '2026-10-01', u1.id, bk.id, 'Sara', 'AC', 'Sara', 'Staff', null]);
  assert.deepEqual([b.detail, b.status, b.reported_on, b.done_on, b.resolution], ['Filter blocked', 'closed', '2026-09-20', '2026-09-22', 'Cleaned the filter']);
  const full = await getWorkOrder(a.id, AT);
  assert.deepEqual(full.files.map((f) => f.file_name), ['before.jpg']);
  assert.deepEqual(full.events.map((e) => [e.kind, e.detail, String(e.created_at)]), [['created', 'Moved from the tenant’s history', '1760000000']]);
  assert.equal((await getWorkOrder(b.id, AT)).events[0].detail, 'Moved from the tenant’s history, resolved 2026-09-22');

  // What is left behind: the complaint, and the note with no lease to take its unit from.
  assert.deepEqual((await db.prepare('SELECT id, kind FROM lease_tenant_log ORDER BY id').all()).map((r) => r.kind), ['maintenance', 'complaint']);
  assert.equal((await db.prepare('SELECT id FROM lease_tenant_log WHERE kind = ?').get('maintenance')).id, loose.id);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_tenant_log_files').get()).n, 0);

  assert.equal(await moveMaintenanceNotes(), 0, 'a second run finds nothing to move');
  assert.equal((await listWorkOrders({}, AT)).length, 2);
});

test('a tenant’s history shows their work orders as maintenance, and counts the ones not done', async () => {
  const { staff, u1, u2, bk, sara } = await tower();
  const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling', reported_on: '2026-10-20' }, staff, AT);
  const leak = await createWorkOrder({ unit_id: u1.id, detail: 'Leak', reported_on: '2026-10-21' }, staff, AT);
  const off = await createWorkOrder({ unit_id: u1.id, detail: 'Typed twice', reported_on: '2026-10-22' }, staff, AT);
  await createWorkOrder({ unit_id: u2.id, detail: 'Somebody else’s unit' }, staff, AT);
  await updateWorkOrder(leak.id, { status: 'done', resolution: 'Tightened the trap' }, staff, AT);
  await updateWorkOrder(off.id, { status: 'cancelled', cancel_reason: 'Duplicate' }, staff, AT);

  const h = await tenantHistory(sara, AT);
  const mine = h.items.filter((i) => i.type === 'maintenance');
  assert.deepEqual(mine.map((i) => [i.wo, i.date, i.status, i.resolved_on, i.resolution, i.ref, i.unit_no]), [
    [leak.ref, '2026-10-21', 'done', AT, 'Tightened the trap', bk.ref, '101'],
    [ac.ref, '2026-10-20', 'open', null, null, bk.ref, '101'],
  ]);
  assert.deepEqual([h.summary.maintenance, h.summary.maintenance_open], [2, 1], 'a cancelled one is not counted');
  assert.deepEqual(h.current, { unit_id: u1.id, unit_no: '101', building: 'Tower' });
  assert.equal((await tenantHistory(sara, '2026-12-01')).current, null, 'after the lease, they have no unit');
});
```

In `tests/leasing-history.test.js`:

1. Add to the imports:

```js
import { createWorkOrder, updateWorkOrder } from '../server/workOrders.js';
```

2. In the `tower()` fixture, return the unit too: change `return { staff, bk, sara: bk.tenant_id, rent };` to `return { staff, bk, u1, sara: bk.tenant_id, rent };`.

3. In the test `'complaints and maintenance are logged against the tenant and the booking of that day, resolved, changed and removed'`:
   - change `const { staff, bk, sara } = await tower();` to `const { staff, bk, u1, sara } = await tower();`
   - change `/complaint or maintenance/` to `/is a complaint/`
   - after that line add: `await assert.rejects(addLog(sara, { kind: 'maintenance', detail: 'x' }, staff, AT), /raised as a work order/);`
   - replace the two lines

     ```js
     const ac = await addLog(sara, { kind: 'maintenance', category: 'AC', detail: 'AC not cooling' }, staff, AT);
     assert.equal(ac.date, AT, 'with no date it is today');
     ```

     with

     ```js
     const ac = await createWorkOrder({ unit_id: u1.id, category: 'AC', detail: 'AC not cooling' }, staff, AT);
     const quiet = await addLog(sara, { kind: 'complaint', detail: 'Bins left out' }, staff, AT);
     assert.equal(quiet.date, AT, 'with no date it is today');
     await removeLog(quiet.id);
     ```

   - replace `await updateLog(ac.id, { resolved: true }, AT);` with `await updateWorkOrder(ac.id, { status: 'done', resolution: 'Regassed' }, staff, AT);`

4. In the test `'an entry takes several attachments, each opened or removed by itself, and all go with the entry'`, change

   ```js
   const leak = await addLog(sara, { kind: 'maintenance', category: 'Plumbing', detail: 'Leak under the sink' }, staff, AT);
   ```

   to

   ```js
   const leak = await addLog(sara, { kind: 'complaint', category: 'Damage', detail: 'Broke the lobby door' }, staff, AT);
   ```

   and in the two lines of that test that find the entry in the history, change `.find((i) => i.id === leak.id)` to `.find((i) => i.type === 'complaint' && i.id === leak.id)`.

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- tests/work-orders.test.js tests/leasing-history.test.js`
Expected: FAIL, `moveMaintenanceNotes` is not exported.

- [ ] **Step 3: Implement the move**

Append to `server/workOrders.js` (before the `// ---------- routes ----------` section):

```js
// ---------- the notes that came before ----------

/**
 * Maintenance used to be a line in a tenant's history (lease_tenant_log). Each of those
 * becomes a work order on the unit of its lease: open if it was open, closed if it was
 * resolved, with its files. Run at every start; once a note is moved it is gone from the
 * old table, so a second run finds nothing. A note with no lease has no unit, and stays.
 */
export async function moveMaintenanceNotes() {
  const notes = await db.prepare(`SELECT l.id, l.tenant_id, l.booking_id, l.category, l.detail, l.reported_by, l.resolution, l.created_by, l.created_at,
      ${day('l.happened_on')} AS happened_on, ${day('l.resolved_on')} AS resolved_on, b.unit_id, t.full_name AS tenant
    FROM lease_tenant_log l JOIN lease_bookings b ON b.id = l.booking_id JOIN lease_tenants t ON t.id = l.tenant_id
    WHERE l.kind = 'maintenance' ORDER BY l.id`).all();
  for (const n of notes) {
    await tx(async () => {
      const { id } = await db.prepare(`INSERT INTO lease_work_orders (unit_id, booking_id, tenant_id, tenant, category, detail, reported_by, reported_on, status, resolution, done_on, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(n.unit_id, n.booking_id, n.tenant_id, n.tenant, n.category, n.detail, n.reported_by, n.happened_on,
        n.resolved_on ? 'closed' : 'open', n.resolved_on ? n.resolution : null, n.resolved_on, n.created_by, n.created_at);
      await db.prepare('INSERT INTO lease_work_order_events (work_order_id, kind, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'created', `Moved from the tenant’s history${n.resolved_on ? `, resolved ${n.resolved_on}` : ''}`, n.created_by, n.created_at);
      // The files stay where they are on disk; only the rows that point at them move.
      await db.prepare(`INSERT INTO lease_work_order_files (work_order_id, file_path, file_name, file_mime, uploaded_by, created_at)
        SELECT ?::int, file_path, file_name, file_mime, uploaded_by, created_at FROM lease_tenant_log_files WHERE log_id = ? ORDER BY id`).run(id, n.id);
      await db.prepare('DELETE FROM lease_tenant_log WHERE id = ?').run(n.id);
    });
  }
  return notes.length;
}
```

In `server/index.js`, change the import added in Task 3 to

```js
import { workOrderRoutes, moveMaintenanceNotes } from './workOrders.js';
```

and directly after the `startLeasingAlerts();` line add:

```js
  // Maintenance once typed into a tenant's history is a work order now; this moves what is left of it.
  moveMaintenanceNotes().then((n) => n && console.log(`[work-orders] moved ${n} maintenance note${n === 1 ? '' : 's'} from the tenants' histories`)).catch((e) => console.error('[work-orders]', e.message));
```

- [ ] **Step 4: Make Tenant History read from work orders**

In `server/leasingHistory.js`:

1. Add the import:

```js
import { listWorkOrders, LIVE } from './workOrders.js';
```

2. Replace the header comment's sentence beginning "Late rent is never written down" through "(lease_tenant_log_files)." with:

```js
// Late rent is never written down: it is worked out from the schedule and its payments each
// time, so it stays right when a payment is added, changed or deleted. A complaint is a plain
// record a person types in (lease_tenant_log), with any number of files (lease_tenant_log_files):
// it charges nothing and sends nothing. Maintenance is the tenant's work orders
// (server/workOrders.js), read here and changed there; a maintenance note older than work
// orders, with no lease to take a unit from, is still in the log and still shown.
```

3. Change

```js
const KINDS = new Set(['complaint', 'maintenance']);
```

to

```js
const KINDS = new Set(['complaint']); // maintenance is a work order now
```

4. In `logFields`, change `throw bad('An entry is a complaint or maintenance.');` to `throw bad('An entry is a complaint. Maintenance is raised as a work order.');`

5. Add, above `tenantHistory`:

```js
/** A work order as a line of the history. Once done, the day it was done is the day it was resolved. */
const asMaintenance = (w) => ({ type: 'maintenance', id: w.id, wo: w.ref, status: w.status, priority: w.priority, overdue: w.overdue, tenant_id: w.tenant_id, booking_id: w.booking_id,
  ref: w.lease_ref, unit_no: w.unit_no, building: w.building, date: w.reported_on, category: w.category, detail: w.detail, reported_by: w.reported_by, assigned_to: w.assigned_to,
  resolved_on: LIVE.includes(w.status) ? null : w.done_on, resolution: w.resolution, logged_by: w.raised_by, files: [] });

/** The unit a tenant has today, where a new work order of theirs would go. */
const unitToday = async (tenantId, today) => (await db.prepare(`SELECT b.unit_id, u.unit_no, bl.name AS building
  FROM lease_bookings b JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id
  WHERE b.tenant_id = ? AND b.status = 'confirmed' AND ?::date BETWEEN b.start_date AND b.end_date
  ORDER BY b.start_date DESC LIMIT 1`).get(tenantId, today)) || null;
```

6. In `tenantHistory`, replace the body from `const log = ...` to the end of the function with:

```js
  const log = (await db.prepare(`${LOG_SELECT} WHERE l.tenant_id = ?`).all(tenant.id)).map((l) => shape(l, files));
  // A cancelled work order was never maintenance done for them, so it is left out.
  const orders = (await listWorkOrders({ tenant_id: tenant.id }, today)).filter((w) => w.status !== 'cancelled').map(asMaintenance);
  const all = [...log, ...orders];
  const of = (type) => all.filter((l) => l.type === type);
  const open = (list) => list.filter((l) => !l.resolved_on && (!l.wo || LIVE.includes(l.status))).length;
  const ORDER = { maintenance: 0, complaint: 1, late: 2 };
  return {
    tenant,
    current: await unitToday(tenant.id, today),
    summary: {
      late: late.length, late_unpaid: late.filter((l) => !l.paid_on).length,
      late_days: late.length ? Math.round(late.reduce((t, l) => t + l.days_late, 0) / late.length) : 0, // on average
      late_fees: money(late.reduce((t, l) => t + (l.fee || 0), 0)),
      complaints: of('complaint').length, complaints_open: open(of('complaint')),
      maintenance: of('maintenance').length, maintenance_open: open(of('maintenance')),
    },
    items: [...late, ...all].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : ORDER[a.type] - ORDER[b.type] || (b.id || 0) - (a.id || 0))),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/work-orders.test.js tests/leasing-history.test.js`
Expected: PASS (11 tests in the first file, 5 in the second).

- [ ] **Step 6: Commit**

```bash
git add server/workOrders.js server/leasingHistory.js server/index.js tests/work-orders.test.js tests/leasing-history.test.js
git commit -m "feat: Leasing - the maintenance notes of a tenant's history become work orders, and the history reads maintenance from them"
```

---

### Task 5: Riley raises, updates and looks up work orders

**Files:**
- Modify: `server/leasingKit.js`
- Test: `tests/work-orders.test.js`

**Interfaces:**
- Consumes: `createWorkOrder`, `updateWorkOrder`, `addWorkOrderNote`, `getWorkOrder`, `listWorkOrders`, `STATUS` from `server/workOrders.js`; `find`, `unitOf`, `reads`, `writes`, `STATUS` (the kit's own status-line map), `LEASING_TOOLS` already in `leasingKit.js`.
- Produces: three tools: `leasing_work_orders` (read), `leasing_add_work_order`, `leasing_update_work_order`.

- [ ] **Step 1: Write the failing test**

Add to the imports of `tests/work-orders.test.js`:

```js
import { leasingKit } from '../server/leasingKit.js';
```

Append:

```js
test('Riley raises a work order, moves it on, and says what is open', async () => {
  const { staff, u1 } = await tower();
  const kit = leasingKit({ id: staff, role: 'member' });
  const run = async (name, input) => kit.run({ id: 't1', name, input });
  for (const name of ['leasing_work_orders', 'leasing_add_work_order', 'leasing_update_work_order']) assert.ok(kit.definitions.some((d) => d.name === name), name);

  let r = await run('leasing_add_work_order', { building: 'tower', unit_no: '999', detail: 'AC not cooling' });
  assert.ok(r.is_error);
  assert.match(r.content, /no unit "999"/);

  // A fixed day inside Sara's lease, so the test reads the same whenever it is run.
  r = await run('leasing_add_work_order', { building: 'tower', unit_no: '101', detail: 'AC not cooling', category: 'AC', priority: 'urgent', reported_on: '2026-10-01' });
  assert.equal(r.is_error, undefined);
  const [w] = await listWorkOrders({ unit_id: u1.id });
  assert.match(r.content, new RegExp(`^Work order ${w.ref} raised`));
  assert.match(r.content, /for Sara/);
  assert.deepEqual([w.priority, w.category, w.created_by], ['urgent', 'AC', staff]);

  r = await run('leasing_update_work_order', { work_order: w.ref, assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-28', note: 'Vendor called' });
  assert.match(r.content, /Assigned/);
  const now = await getWorkOrder(w.id);
  assert.deepEqual([now.status, now.assigned_to, now.events.at(-1).detail], ['assigned', 'Cool Air LLC', 'Vendor called']);

  // The year of a reference can be stale; the number is what finds it.
  r = await run('leasing_update_work_order', { work_order: `WO-2019-${String(w.id).padStart(4, '0')}`, status: 'done', resolution: 'Regassed' });
  assert.match(r.content, /Done/);
  r = await run('leasing_update_work_order', { work_order: w.ref });
  assert.ok(r.is_error);
  assert.match(r.content, /Say what to change/);
  r = await run('leasing_update_work_order', { work_order: 'the AC one' });
  assert.match(r.content, /Give the work order reference/);

  r = await run('leasing_work_orders', { building: 'tower' });
  assert.match(r.content, new RegExp(`${w.ref} \\(Done, urgent\\): unit 101, Tower, Sara; AC: AC not cooling`));
  r = await run('leasing_work_orders', { building: 'tower', unit_no: '102' });
  assert.match(r.content, /No work orders/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- tests/work-orders.test.js`
Expected: FAIL, `leasing_work_orders` is missing from the definitions.

- [ ] **Step 3: Implement**

In `server/leasingKit.js`:

1. Add the import (the kit already has a constant named `STATUS`, so this one is renamed):

```js
import { createWorkOrder, updateWorkOrder, addWorkOrderNote, getWorkOrder, listWorkOrders, STATUS as WORK_STATUS } from './workOrders.js';
```

2. In the header comment, after the sentence ending "photos are added on the screens.", add a line:

```js
// She raises a work order for a repair, moves it on as she is told (assigned, done, closed…) and says what is open.
```

3. In `LEASING_TOOLS`, after the `leasing_unit_inspections` entry, add:

```js
  {
    name: 'leasing_work_orders',
    description: 'The work orders (repairs to a unit): what is wrong, its status, who is on it, when they come, and what was done. Each is linked to the tenant who had the unit when it was reported. '
      + 'Use it for "what is open in unit 303", "what is overdue", or before raising one, so the same fault is not raised twice. Repairs are under the AMC: no cost is kept. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        building: { ...str, description: 'Only this building (part of its name is enough).' },
        unit_no: { ...str, description: 'Only this unit; needs the building.' },
        tenant: { ...str, description: "Only this tenant's (part of the name is enough)." },
        status: { type: 'string', enum: ['active', 'open', 'assigned', 'in_progress', 'done', 'closed', 'cancelled', 'all'], description: 'Default active: everything not closed or cancelled.' },
        overdue: { type: 'boolean', description: 'true: only those whose scheduled day has passed and are not done.' },
      },
    },
  },
```

and after the `leasing_confirm_booking` entry (the last one), add:

```js
  {
    name: 'leasing_add_work_order',
    description: `Raise a work order: a repair to a unit (the AC is not cooling, a tap leaks). It links itself to the tenant in the unit that day; an empty unit's has no tenant. Look at leasing_work_orders first: a fault already raised is updated, not raised again. ${ASK}`,
    input_schema: {
      type: 'object',
      properties: {
        building: str, unit_no: str,
        detail: { ...str, description: 'What is wrong, in the words the user gave.' },
        category: { ...str, description: 'AC, Plumbing, Electrical, Appliance, Pest control, or another word.' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'Default normal. urgent only when the user says so.' },
        reported_by: { ...str, description: 'Who told the office: the tenant, the watchman…' },
        reported_on: { ...str, description: 'YYYY-MM-DD. Default today.' },
        assigned_to: { ...str, description: 'The technician or vendor, when the user names one.' },
        scheduled_on: { ...str, description: 'YYYY-MM-DD, the day the work is planned for.' },
      },
      required: ['building', 'unit_no', 'detail'],
    },
  },
  {
    name: 'leasing_update_work_order',
    description: 'Change a work order, by its reference (WO-2026-0014): who is on it, when they come, its priority, its status, or add a note to its history. '
      + 'Statuses go forward: open, assigned, in_progress, done (needs what was done), then closed; or cancelled (needs why). A finished one is taken back to work with reopen. Only what the user has said.',
    input_schema: {
      type: 'object',
      properties: {
        work_order: { ...str, description: 'The reference, like WO-2026-0014.' },
        status: { type: 'string', enum: ['assigned', 'in_progress', 'done', 'closed', 'cancelled'] },
        resolution: { ...str, description: 'With done: what was done.' },
        cancel_reason: { ...str, description: 'With cancelled: why.' },
        reopen: { type: 'boolean', description: 'true: a done, closed or cancelled one goes back to work.' },
        assigned_to: { ...str, description: 'The technician or vendor. Empty takes them off.' },
        scheduled_on: { ...str, description: 'YYYY-MM-DD. Empty clears it.' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'] },
        note: { ...str, description: 'A line for its history: "tenant not home, coming back Thursday".' },
      },
      required: ['work_order'],
    },
  },
```

4. After the `bookingId` function, add:

```js
/** A work order's id from its reference (WO-2026-0014). The number finds it; the year is only for reading. */
function workOrderId(ref) {
  const id = Number(String(ref || '').match(/^\s*WO-\d{4}-(\d+)\s*$/i)?.[1]);
  if (!id) throw new Error('Give the work order reference, like WO-2026-0014.');
  return id;
}

/** A work order in one line, as Riley is told it. */
const workOrderLine = (w) => `${w.ref} (${WORK_STATUS[w.status]}${w.overdue ? ', OVERDUE' : ''}${w.priority !== 'normal' ? `, ${w.priority}` : ''}): unit ${w.unit_no}, ${w.building}, ${w.tenant || 'vacant'}; `
  + `${w.category ? `${w.category}: ` : ''}${w.detail}; reported ${w.reported_on}${w.assigned_to ? `; assigned to ${w.assigned_to}` : ''}${w.scheduled_on ? `; scheduled ${w.scheduled_on}` : ''}`
  + `${w.done_on ? `; done ${w.done_on}: ${w.resolution}` : ''}${w.cancel_reason ? `; cancelled: ${w.cancel_reason}` : ''}`;
```

5. In `reads`, after `leasing_unit_inspections`, add:

```js
  leasing_work_orders: async (input) => {
    const q = { status: input.status === 'all' ? '' : input.status || 'active', overdue: input.overdue === true };
    if (input.building) {
      const b = await find('prop_buildings', 'building', input.building);
      q.building_id = b.id;
      if (input.unit_no) {
        const unit = await unitOf(b, input.unit_no);
        if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
        q.unit_id = unit.id;
      }
    } else if (input.unit_no) throw new Error('Say which building the unit is in.');
    if (input.tenant) q.tenant_id = (await find('lease_tenants', 'tenant', input.tenant)).id;
    const rows = await listWorkOrders(q);
    return rows.length ? `Work orders (today is ${todayHere()}), newest first:\n${rows.slice(0, 60).map((w) => `- ${workOrderLine(w)}`).join('\n')}${rows.length > 60 ? `\n…and ${rows.length - 60} more not shown.` : ''}`
      : 'No work orders match.';
  },
```

6. In `reads.leasing_tenant_history`, replace the `line` arrow's second branch

```js
      : `- ${i.date} ${i.type === 'complaint' ? 'Complaint' : 'Maintenance'}${i.category ? ` (${i.category})` : ''}, ${i.resolved_on ? `resolved ${i.resolved_on}${i.resolution ? ` (${i.resolution})` : ''}` : 'open'}: ${i.detail}${where(i)}`);
```

with

```js
      : `- ${i.date} ${i.type === 'complaint' ? 'Complaint' : `Maintenance${i.wo ? ` ${i.wo}` : ''}`}${i.category ? ` (${i.category})` : ''}, `
        + `${i.resolved_on ? `resolved ${i.resolved_on}${i.resolution ? ` (${i.resolution})` : ''}` : i.wo ? WORK_STATUS[i.status].toLowerCase() : 'open'}: ${i.detail}${where(i)}`);
```

7. In `writes(user)`, after `leasing_confirm_booking`, add:

```js
    leasing_add_work_order: async (input) => {
      const b = await find('prop_buildings', 'building', input.building);
      const unit = await unitOf(b, input.unit_no);
      if (!unit) throw new Error(`${b.name} has no unit "${input.unit_no}". Look at leasing_list units.`);
      const body = { unit_id: unit.id, detail: input.detail };
      for (const f of ['category', 'priority', 'reported_by', 'reported_on', 'assigned_to', 'scheduled_on']) if (input[f] != null) body[f] = input[f];
      const w = await createWorkOrder(body, user.id);
      return `Work order ${w.ref} raised ${w.tenant ? `for ${w.tenant}` : 'for the vacant unit'}: ${workOrderLine(w)}.\nPhotos can be added on the screens (Leasing, Work orders).`;
    },
    leasing_update_work_order: async (input) => {
      const id = workOrderId(input.work_order);
      const body = {};
      for (const f of ['status', 'resolution', 'cancel_reason', 'reopen', 'assigned_to', 'scheduled_on', 'priority']) if (input[f] != null) body[f] = input[f];
      const note = String(input.note ?? '').trim();
      if (!Object.keys(body).length && !note) throw new Error('Say what to change.');
      // With reopen the note is the reason it was reopened; otherwise it is a line of its own.
      if (Object.keys(body).length) await updateWorkOrder(id, body.reopen ? { ...body, note } : body, user.id);
      if (note && !body.reopen) await addWorkOrderNote(id, note, user.id);
      return `Work order changed. It is now: ${workOrderLine(await getWorkOrder(id))}.`;
    },
```

8. In the kit's own `STATUS` map (the status lines shown while a tool runs), add:

```js
  leasing_work_orders: 'Looking at the work orders…', leasing_add_work_order: 'Raising the work order…', leasing_update_work_order: 'Changing the work order…',
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/work-orders.test.js tests/leasing-history.test.js`
Expected: PASS (12 tests in the first file).

Then check nothing counts the tools: `grep -rn "LEASING_TOOLS.length\|definitions.length" tests`. If a test asserts a number of leasing tools, raise it by 3.

- [ ] **Step 5: Commit**

```bash
git add server/leasingKit.js tests/work-orders.test.js
git commit -m "feat: Leasing - Riley raises a work order, moves it on as she is told, and says what is open or overdue"
```

---

### Task 6: Alerts: a new urgent one, and one past its scheduled day

**Files:**
- Modify: `server/workOrders.js` (`createWorkOrder` gains the push)
- Modify: `server/leasingAlerts.js`
- Modify: `client/src/components/LeasingAlerts.jsx` (the maps a new rule must be in, or the Alerts screen crashes on it)
- Test: `tests/work-orders.test.js`

**Interfaces:**
- Consumes: `listWorkOrders` (Task 1); `getSettings`, `saveSettings`, `runAlerts`, `listAlerts`, `openAlerts`, `RULES`, `DEFAULTS` in `leasingAlerts.js`; `setBuildingStaff(buildingId, userIds)` from `server/properties.js`.
- Produces:
  - `createWorkOrder(body, by, today?, { push }?)` — `push(userIds, { title, body, url, tag })` is injected by tests; in production it is `sendPush` from `server/push.js`.
  - A new alert rule `workorder` (`getSettings().workorder.on`, default `true`). An overdue work order appears in `listAlerts()` as `{ rule: 'workorder', key: 'workorder:<id>', open: 'workorder', work_order_id, level, title, detail, fires: true, … }`.
  - Push URL for a new urgent one: `/?leasing=workorders` (handled by the client in Task 7).

- [ ] **Step 1: Write the failing tests**

Add to the imports of `tests/work-orders.test.js`:

```js
import { create, remove, setBuildingStaff } from '../server/properties.js';
import { runAlerts, listAlerts, saveSettings, getSettings } from '../server/leasingAlerts.js';
```

(the first replaces the existing `create, remove` import). Append:

```js
test('a new urgent work order buzzes the building’s staff and the master, not the one who raised it', async () => {
  const { staff, building, u1 } = await tower();
  const keeper = await makeUser('Keeper');
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  await setBuildingStaff(building.id, [keeper, staff]);
  const sent = [];
  const push = async (to, note) => { sent.push([[...to].sort((a, b) => a - b), note]); };

  await createWorkOrder({ unit_id: u1.id, detail: 'Bulb out' }, staff, AT, { push });
  assert.deepEqual(sent, [], 'a normal one buzzes nobody');

  const w = await createWorkOrder({ unit_id: u1.id, category: 'Plumbing', detail: 'Water pouring through the ceiling', priority: 'urgent' }, staff, AT, { push });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], [keeper, master].sort((a, b) => a - b));
  assert.deepEqual(sent[0][1], { title: 'Urgent: Plumbing · Unit 101, Tower', body: `${w.ref}: Water pouring through the ceiling`, url: '/?leasing=workorders', tag: `work-order-${w.id}` });

  // Raised by the only person there is to tell: nothing is sent, and nothing breaks.
  await setBuildingStaff(building.id, []);
  await createWorkOrder({ unit_id: u1.id, detail: 'Gas smell', priority: 'urgent' }, master, AT, { push });
  assert.equal(sent.length, 1);

  // A push that fails does not stop the work order being raised.
  const made = await createWorkOrder({ unit_id: u1.id, detail: 'Sparks from a socket', priority: 'urgent' }, staff, AT, { push: async () => { throw new Error('push down'); } });
  assert.equal(made.status, 'open');

  // Switched off by the master: nothing goes.
  await saveSettings({ workorder: { on: false } }, AT);
  await createWorkOrder({ unit_id: u1.id, detail: 'Flood', priority: 'urgent' }, staff, AT, { push });
  assert.equal(sent.length, 1);
});

test('a work order past its scheduled day is an alert, once a day, until it is done', async () => {
  const { staff, building, u1, u2 } = await tower();
  const keeper = await makeUser('Keeper');
  await setBuildingStaff(building.id, [keeper]);
  assert.equal((await getSettings()).workorder.on, true);
  const w = await createWorkOrder({ unit_id: u2.id, category: 'AC', detail: 'Service the AC', assigned_to: 'Cool Air LLC', scheduled_on: '2026-10-22' }, staff, AT);
  await createWorkOrder({ unit_id: u1.id, detail: 'Not due yet', scheduled_on: '2026-10-30' }, staff, AT);

  const mine = (await listAlerts({}, AT)).filter((a) => a.rule === 'workorder');
  assert.deepEqual(mine.map((a) => [a.key, a.open, a.work_order_id, a.level, a.title, a.detail, a.fires]), [
    [`workorder:${w.id}`, 'workorder', w.id, 'warn', `${w.ref} is overdue: AC`, 'Unit 102, Tower · scheduled 2026-10-22 · 3 days late · Cool Air LLC', true],
  ]);
  assert.deepEqual((await listAlerts({ building_id: 999 }, AT)).filter((a) => a.rule === 'workorder'), [], 'another building’s list does not show it');

  // Each person is told once a day: the sent-once log says who, whatever else was in their notice.
  const told = async (on) => (await db.prepare("SELECT user_id FROM lease_alerts_sent WHERE key = ? AND to_char(day, 'YYYY-MM-DD') = ? ORDER BY user_id").all(`workorder:${w.id}`, on)).map((r) => r.user_id);
  const both = [staff, keeper].sort((a, b) => a - b);
  assert.ok((await runAlerts(AT, 9)).length > 0);
  assert.deepEqual(await told(AT), both, 'the one who raised it and the building’s staff');
  assert.deepEqual(await runAlerts(AT, 10), [], 'nobody is told twice in one day');
  await runAlerts('2026-10-26', 9);
  assert.deepEqual(await told('2026-10-26'), both, 'again the next day');

  await updateWorkOrder(w.id, { status: 'done', resolution: 'Serviced' }, staff, '2026-10-26');
  assert.deepEqual((await listAlerts({}, '2026-10-27')).filter((a) => a.rule === 'workorder'), []);

  // The master switches the rule off.
  const late = await createWorkOrder({ unit_id: u2.id, detail: 'Late again', scheduled_on: '2026-10-20' }, staff, AT);
  assert.equal((await listAlerts({}, AT)).filter((a) => a.rule === 'workorder').length, 1);
  await saveSettings({ workorder: { on: false } }, AT);
  assert.equal((await listAlerts({}, AT)).filter((a) => a.rule === 'workorder').length, 0);
  assert.ok(late.id);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- tests/work-orders.test.js`
Expected: FAIL: the first on `sent.length` (0 instead of 1), the second on `getSettings().workorder` being undefined.

- [ ] **Step 3: Implement the rule and the overdue alert**

In `server/leasingAlerts.js`:

1. Add the import:

```js
import { listWorkOrders } from './workOrders.js';
```

2. In `DEFAULTS`, after the `eid` line, add:

```js
  workorder: { on: true },                               // a work order past its scheduled day, and a new urgent one
```

3. Change `RULES` to:

```js
export const RULES = ['overdue', 'due', 'upcoming', 'ending', 'contract', 'eid', 'workorder'];
```

4. In `saveSettings`, in the `next` object after the `eid:` line, add:

```js
    workorder: { on: on('workorder') },
```

5. In `openAlerts`, directly before the line `const rank = { bad: 0, warn: 1, info: 2 };`, add:

```js
  // A work order whose day has passed and is still not done. It has no lease when its unit
  // is empty, so it is placed by its unit; whoever raised it and the building's staff hear of it.
  if (cfg.workorder.on) {
    const here = new Map(s.list.map((b) => [b.id, b]));
    for (const w of await listWorkOrders({ overdue: true }, s.today)) {
      const bl = here.get(w.building_id);
      if (!bl) continue;
      const d = s.T - dayNo(w.scheduled_on);
      out.push({ rule: 'workorder', key: `workorder:${w.id}`, work_order_id: w.id, booking_id: w.booking_id, tenant: w.tenant, unit_no: w.unit_no, building: w.building, building_id: w.building_id, company: bl.company,
        owner: w.created_by, staff: s.staffOf.get(w.building_id) || [], level: w.priority === 'urgent' ? 'bad' : 'warn', open: 'workorder', days: d,
        title: `${w.ref} is overdue${w.category ? `: ${w.category}` : ''}`,
        detail: `Unit ${w.unit_no}, ${w.building} · scheduled ${w.scheduled_on} · ${d} day${d === 1 ? '' : 's'} late${w.assigned_to ? ` · ${w.assigned_to}` : ''}`, fires: true });
    }
  }
```

6. Update the file's header comment: after "(3 days before, on the day, 1, 3 and 7 days after…)" nothing changes, but add at the end of the first paragraph: `A work order past its scheduled day is one of them, every day until it is done.`

- [ ] **Step 4: Implement the urgent push**

In `server/workOrders.js`, change `createWorkOrder`'s signature and its last line:

```js
export async function createWorkOrder(body = {}, by, today = todayHere(), { push } = {}) {
```

```js
  const made = await getWorkOrder(id, today);
  // Raised all the same if the buzz fails: the work order is what matters.
  if (made.priority === 'urgent') await tellUrgent(made, by, push).catch((e) => console.error('[work-orders]', e.message));
  return made;
}
```

and add above it:

```js
/**
 * A new urgent work order buzzes the building's staff and the master at once, whatever the
 * hour: it is urgent. Not the person who raised it, who knows. The master's "work orders"
 * alert rule switches it off (loaded when needed: leasingAlerts.js reads this file too).
 */
async function tellUrgent(w, by, push) {
  const { getSettings } = await import('./leasingAlerts.js');
  if (!(await getSettings()).workorder.on) return;
  const people = await db.prepare(`SELECT user_id AS id FROM prop_building_staff WHERE building_id = ?
    UNION SELECT id FROM users WHERE role = 'master'`).all(w.building_id);
  const to = people.map((p) => p.id).filter((id) => id !== by);
  if (!to.length) return;
  const send = push || (await import('./push.js')).sendPush;
  await send(to, { title: `Urgent: ${w.category || 'work order'} · Unit ${w.unit_no}, ${w.building}`, body: `${w.ref}: ${w.detail.slice(0, 140)}`, url: '/?leasing=workorders', tag: `work-order-${w.id}` });
}
```

- [ ] **Step 5: Keep the Alerts screen from crashing on the new rule**

In `client/src/components/LeasingAlerts.jsx`:

1. Add `Wrench` to the `lucide-react` import.
2. In `ALERT_KINDS`, after the `['eid', …]` entry, add:

```js
  ['workorder', 'Work orders', Wrench, 'from-sky-400 to-cyan-600 shadow-sky-500/30', 'Work orders overdue'],
```

3. In `RULE`, add: `workorder: ['Work orders', Wrench],`
4. In `DOES`, add: `workorder: 'Open work order',`
5. In `TINT`, add: `workorder: 'from-sky-400 to-cyan-600',`
6. In the settings `cards` list, after the `['contract', …]` entry, add:

```js
    ['workorder', 'Work orders', Wrench, 'A work order past its scheduled day, every day until it is done; and a new urgent one, at once, whatever the hour.', []],
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/work-orders.test.js tests/leasing-money.test.js tests/leasing-extras.test.js`
Expected: PASS (14 tests in the first file). If a test in the other two compares the whole settings object or the list of rules, add `workorder: { on: true }` / `'workorder'` to what it expects.

Run: `npm run build`
Expected: the client builds with no error.

- [ ] **Step 7: Commit**

```bash
git add server/workOrders.js server/leasingAlerts.js client/src/components/LeasingAlerts.jsx tests/work-orders.test.js
git commit -m "feat: Leasing - a new urgent work order buzzes the building's staff, and one past its scheduled day is an alert until it is done"
```

(Also stage any test file adjusted in Step 6.)

---

### Task 7: The Work Orders page and its place in the menu

**Files:**
- Create: `client/src/components/WorkOrders.jsx`
- Modify: `client/src/components/Sidebar.jsx`, `client/src/components/Leasing.jsx`, `client/src/App.jsx`

**Interfaces:**
- Consumes: the routes of Task 3; `api` from `../lib/api` (`get`, `post`, `put`, `del`, `upload`); `Page`, `Select`, `DateField`; `usDate` from `../lib/usFormat`.
- Produces: `export default function WorkOrders({ scope, title, preset, openId, startNew, onBack })`
  - `scope`: `{ unit_id } | { booking_id } | { tenant_id } | undefined` — narrows the list; with one, the list shows every status.
  - `title`: the page title (default `'Work orders'`).
  - `preset`: `{ unit_id }` for a new one, or null.
  - `openId`: a work order to open straight away.
  - `startNew`: open the new-work-order form straight away.
  - `onBack`: leaves the page.
  - Also exported: `WO_STATUS` — `{ [status]: [label, pill classes] }`, used by Tenant History in Task 8.

- [ ] **Step 1: Write `client/src/components/WorkOrders.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Ban, Check, CheckCheck, Loader2, MessageSquarePlus, Paperclip, Pencil, Play, Plus, RotateCcw, Search, Trash2, Wrench, X } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Page from './Page';
import Select from './Select';
import DateField from './DateField';

// Work orders: a repair to a unit, from the report to the fix. Raised on a unit, it links
// itself to the tenant living there (the server works that out: server/workOrders.js), and
// everything done to it is kept in its timeline. The same page is the whole list (from the
// menu), or one unit's, one lease's or one tenant's (`scope`). Repairs are under the AMC, so
// there is no cost anywhere.

const FIELD = 'w-full rounded-xl border border-stroke bg-white/[0.03] px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const OUTLINE = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm hover:bg-white/5';
const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3 py-1.5 text-xs text-mute hover:bg-white/5 hover:text-txt';
const ROUND = 'grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
const CHIP = (on) => `rounded-full px-3 py-1.5 text-sm ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;
const CARD = 'rounded-2xl border border-stroke bg-surface p-4';

export const WO_STATUS = {
  open: ['Open', 'bg-warn/15 text-warn'], assigned: ['Assigned', 'bg-p3/15 text-p3'], in_progress: ['In progress', 'bg-p1/15 text-p1'],
  done: ['Done', 'bg-ok/15 text-ok'], closed: ['Closed', 'bg-white/10 text-mute'], cancelled: ['Cancelled', 'bg-white/10 text-mute'],
};
const PRIORITY = [['low', 'Low'], ['normal', 'Normal'], ['urgent', 'Urgent']];
const FILTERS = [['active', 'Active'], ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['done', 'Done'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['', 'All']];
const CATEGORIES = ['AC', 'Plumbing', 'Electrical', 'Appliance', 'Pest control', 'Other']; // the usual ones, a tap each; anything else can be typed
const LIVE = ['open', 'assigned', 'in_progress'];
const BATCH = 10; // files the server takes in one go
const fileUrl = (f) => `/api/leasing/work-orders/files/${f.id}/file`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const when = (seconds) => new Date(Number(seconds) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const Label = ({ text, need, children, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="mb-1 block text-xs text-txt/80">{text}{need && <span className="text-p2"> *</span>}</span>
    {children}
  </label>
);

const Pill = ({ w }) => (
  <span className="flex flex-wrap items-center gap-1">
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${WO_STATUS[w.status][1]}`}>{WO_STATUS[w.status][0]}</span>
    {w.priority === 'urgent' && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] text-bad">Urgent</span>}
    {w.overdue && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] text-bad">Overdue</span>}
  </span>
);

/** Send picked files a batch at a time; what is left is handed back if one fails, to try again. */
async function sendFiles(id, picked, onLeft) {
  let left = picked;
  while (left.length) {
    const form = new FormData();
    left.slice(0, BATCH).forEach((f) => form.append('files', f));
    await api.upload(`/leasing/work-orders/${id}/files`, form);
    left = left.slice(BATCH);
    onLeft(left);
  }
}

/** A new work order, or one being changed. The unit is chosen once: a repair does not move. */
function WorkOrderForm({ start, preset, onDone, onCancel }) {
  const [v, setV] = useState({ unit_id: preset?.unit_id || '', category: '', priority: 'normal', detail: '', reported_by: '', reported_on: today(), assigned_to: '', scheduled_on: '', ...start });
  const [units, setUnits] = useState([]);
  const [link, setLink] = useState(null); // whose unit it is on the reported day
  const [id, setId] = useState(start?.id || null); // set once a new one is saved, so a failed upload is tried again on the same one
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (f) => (e) => setV({ ...v, [f]: e.target.value });
  useEffect(() => { api.get('/leasing/work-orders/units').then(setUnits).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!v.unit_id) { setLink(null); return; }
    api.get(`/leasing/work-orders/link?unit_id=${v.unit_id}&on=${v.reported_on || ''}`).then(setLink).catch(() => setLink(null));
  }, [v.unit_id, v.reported_on]);

  const save = async (e) => {
    e.preventDefault();
    if (!v.unit_id) { setError('Choose the unit.'); return; }
    setBusy(true); setError('');
    const body = { unit_id: v.unit_id, category: v.category, priority: v.priority, detail: v.detail, reported_by: v.reported_by, reported_on: v.reported_on, assigned_to: v.assigned_to, scheduled_on: v.scheduled_on };
    try {
      const saved = await (id ? api.put(`/leasing/work-orders/${id}`, body) : api.post('/leasing/work-orders', body));
      setId(saved.id);
      await sendFiles(saved.id, picked, setPicked);
      onDone(saved);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={save} className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Unit" need wide>
          <Select value={v.unit_id} onChange={set('unit_id')} disabled={!!id} placeholder="Choose the unit" aria-label="Unit" className={FIELD}
            options={units.map((u) => ({ value: u.id, label: `Unit ${u.unit_no} · ${u.building}` }))} />
          {v.unit_id && link && <span className="mt-1 block text-xs text-mute">{link.tenant ? `For ${link.tenant} (${link.ref}), who has the unit on that day.` : 'The unit is vacant on that day: this work order will have no tenant.'}</span>}
        </Label>
        <Label text="Type" wide>
          <div className="mb-2 flex flex-wrap gap-1">
            {CATEGORIES.map((c) => <button key={c} type="button" onClick={() => setV({ ...v, category: c })} className={CHIP(v.category === c)}>{c}</button>)}
          </div>
          <input value={v.category || ''} onChange={set('category')} maxLength={60} placeholder="Or type your own" className={FIELD} />
        </Label>
        <Label text="What is wrong" need wide>
          <textarea value={v.detail || ''} onChange={set('detail')} required rows={4} maxLength={2000} className={`${FIELD} resize-none`} />
        </Label>
        <Label text="Priority">
          <div className="flex gap-1 rounded-full border border-stroke p-0.5 text-sm">
            {PRIORITY.map(([k, l]) => <button key={k} type="button" onClick={() => setV({ ...v, priority: k })} aria-pressed={v.priority === k} className={`flex-1 ${CHIP(v.priority === k)}`}>{l}</button>)}
          </div>
        </Label>
        <Label text="Reported on" need><DateField value={v.reported_on || ''} onChange={set('reported_on')} required className={FIELD} /></Label>
        <Label text="Reported by"><input value={v.reported_by || ''} onChange={set('reported_by')} maxLength={120} placeholder="The tenant, the watchman…" className={FIELD} /></Label>
        <Label text="Assigned to"><input value={v.assigned_to || ''} onChange={set('assigned_to')} maxLength={120} placeholder="The technician or the AMC vendor" className={FIELD} /></Label>
        <Label text="Scheduled for"><DateField value={v.scheduled_on || ''} onChange={set('scheduled_on')} className={FIELD} /></Label>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs text-txt/80">Photos and files</span>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
            <Paperclip size={15} className="shrink-0" /> <span>Add photos, videos or files (as many as you need)</span>
            <input type="file" multiple accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={(e) => { setPicked([...picked, ...e.target.files]); e.target.value = ''; }} />
          </label>
          {picked.length > 0 && (
            <ul className="mt-2 divide-y divide-stroke/60 rounded-xl border border-stroke text-sm">
              {picked.map((f, n) => (
                <li key={`${f.name}-${n}`} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <button type="button" onClick={() => setPicked(picked.filter((_, i) => i !== n))} aria-label={`Take off ${f.name}`} title="Take off" className={`${ROUND} hover:text-txt`}><X size={15} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-mute">Repairs are under the AMC: nothing is charged, and nothing is sent to the tenant.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** One work order: what it is, what can be done to it next, its files and its timeline. */
function WorkOrderView({ id, onBack, onEdit }) {
  const [w, setW] = useState(null);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState({ resolution: '', done_on: today() });
  const [note, setNote] = useState('');
  const load = () => api.get(`/leasing/work-orders/${id}`).then(setW).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const act = async (fn) => { setError(''); try { await fn(); setFinishing(false); await load(); } catch (e) { setError(e.message); } };
  const put = (body) => act(() => api.put(`/leasing/work-orders/${id}`, body));

  if (!w) return <Page title="Work order" onBack={onBack}>{error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}</Page>;

  const live = LIVE.includes(w.status);
  const attach = (e) => { const files = [...e.target.files]; e.target.value = ''; act(() => sendFiles(w.id, files, () => {})); };
  const facts = [
    ['Unit', `Unit ${w.unit_no} · ${w.building}`],
    ['Tenant', w.tenant ? `${w.tenant}${w.lease_ref ? ` · ${w.lease_ref}` : ''}` : 'None: the unit was vacant'],
    ['Reported', [fmt(w.reported_on), w.reported_by && `by ${w.reported_by}`].filter(Boolean).join(' ')],
    ['Assigned to', w.assigned_to || 'Nobody yet'],
    ['Scheduled for', w.scheduled_on ? fmt(w.scheduled_on) : 'Not scheduled'],
    w.done_on && ['Done', `${fmt(w.done_on)}: ${w.resolution}`],
    w.cancel_reason && ['Cancelled', w.cancel_reason],
    ['Raised by', w.raised_by || '—'],
  ].filter(Boolean);

  return (
    <Page title={`${w.ref}${w.category ? ` · ${w.category}` : ''}`} onBack={onBack}
      action={!['closed', 'cancelled'].includes(w.status) && <button onClick={() => onEdit(w)} className={OUTLINE}><Pencil size={15} /> Edit</button>}>
      <div className="max-w-3xl space-y-4">
        <div className={CARD}>
          <Pill w={w} />
          <p className="mt-3 whitespace-pre-wrap text-sm">{w.detail}</p>
          <dl className="mt-4 divide-y divide-stroke/60 border-t border-stroke text-sm">
            {facts.map(([k, val]) => (
              <div key={k} className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-mute">{k}</dt><dd className="text-right">{val}</dd></div>
            ))}
          </dl>
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
          {finishing ? (
            <form onSubmit={(e) => { e.preventDefault(); put({ status: 'done', ...done }); }} className="mt-4 space-y-2">
              <textarea autoFocus required value={done.resolution} onChange={(e) => setDone({ ...done, resolution: e.target.value })} rows={3} maxLength={2000} placeholder="What was done" className={`${FIELD} resize-none text-sm`} />
              <div className="flex flex-wrap items-center gap-2">
                <DateField value={done.done_on} onChange={(e) => setDone({ ...done, done_on: e.target.value })} required className={`${FIELD} max-w-[12rem] py-2 text-sm`} />
                <button className={PRIMARY}><Check size={15} /> Mark done</button>
                <button type="button" onClick={() => setFinishing(false)} className="rounded-full px-3 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
              </div>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {['open', 'assigned'].includes(w.status) && <button onClick={() => put({ status: 'in_progress' })} className={OUTLINE}><Play size={15} /> Start work</button>}
              {live && <button onClick={() => setFinishing(true)} className={PRIMARY}><Check size={15} /> Mark done</button>}
              {w.status === 'done' && <button onClick={() => put({ status: 'closed' })} className={PRIMARY}><CheckCheck size={15} /> Close</button>}
              {!live && <button onClick={() => { const why = prompt('Why is it reopened? (optional)'); if (why !== null) put({ reopen: true, note: why }); }} className={OUTLINE}><RotateCcw size={15} /> Reopen</button>}
              {live && <button onClick={() => { const why = prompt('Why is this work order cancelled?'); if (why) put({ status: 'cancelled', cancel_reason: why }); }} className={`${GHOST} hover:text-bad`}><Ban size={14} /> Cancel work order</button>}
              {w.master && w.status === 'open' && !w.assigned_to && (
                <button onClick={async () => { if (!confirm(`Delete ${w.ref}? It was raised by mistake.`)) return; try { await api.del(`/leasing/work-orders/${w.id}`); onBack(); } catch (e) { setError(e.message); } }} className={`${GHOST} hover:text-bad`}><Trash2 size={14} /> Delete</button>
              )}
            </div>
          )}
        </div>

        <div className={CARD}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Photos and files</p>
            <label className={`${GHOST} cursor-pointer`}><Paperclip size={13} /> Add
              <input type="file" multiple accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={attach} />
            </label>
          </div>
          {w.files.length === 0 ? <p className="mt-2 text-sm text-mute">None yet.</p> : (
            <ul className="mt-2 divide-y divide-stroke/60 text-sm">
              {w.files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-1.5">
                  <Paperclip size={14} className="shrink-0 text-mute" />
                  <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-p3 hover:underline">{f.file_name}</a>
                  <button onClick={() => confirm(`Remove ${f.file_name}?`) && act(() => api.del(`/leasing/work-orders/files/${f.id}`))} aria-label={`Remove ${f.file_name}`} title="Remove" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={CARD}>
          <p className="text-sm font-medium">History</p>
          <form onSubmit={(e) => { e.preventDefault(); act(async () => { await api.post(`/leasing/work-orders/${w.id}/notes`, { note }); setNote(''); }); }} className="mt-2 flex gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note: tenant not home, coming back Thursday…" className={`${FIELD} min-w-0 flex-1 py-2 text-sm`} />
            <button disabled={!note.trim()} className={OUTLINE}><MessageSquarePlus size={15} /> Add</button>
          </form>
          <ol className="mt-3 space-y-3 border-l border-stroke pl-4">
            {w.events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-p1" />
                <p className="text-sm">{e.detail}</p>
                <p className="text-xs text-mute">{when(e.created_at)}{e.who && ` · ${e.who}`}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Page>
  );
}

export default function WorkOrders({ scope, title = 'Work orders', preset = null, openId = null, startNew = false, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(scope ? '' : 'active'); // one unit's or one tenant's list is its whole record
  const [building, setBuilding] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(openId); // the id being looked at
  const [form, setForm] = useState(startNew ? {} : null); // {} for a new one, or the work order being changed

  const load = () => {
    const p = new URLSearchParams({ status, ...(scope || {}) });
    if (building) p.set('building_id', building);
    if (urgent) p.set('priority', 'urgent');
    if (overdue) p.set('overdue', 'true');
    if (q.trim()) p.set('q', q.trim());
    return api.get(`/leasing/work-orders?${p}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [status, building, urgent, overdue, q]);

  if (form) {
    const back = () => { setForm(null); load(); };
    return (
      <Page title={form.id ? `Edit ${form.ref}` : 'New work order'} onBack={back}>
        <WorkOrderForm start={form.id ? form : null} preset={preset} onCancel={back} onDone={(saved) => { setForm(null); setOpen(saved.id); load(); }} />
      </Page>
    );
  }
  if (open) return <WorkOrderView id={open} onBack={() => { setOpen(null); load(); }} onEdit={setForm} />;

  const rows = data?.work_orders;
  const buildings = [...new Map((rows || []).map((w) => [w.building_id, w.building]))];
  return (
    <Page title={title} onBack={onBack} action={<button onClick={() => setForm({})} className={PRIMARY}><Plus size={16} /> New work order</button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reference, unit, tenant, words" aria-label="Search work orders" className={`${FIELD} pl-10`} />
          </div>
          {!scope && (building || buildings.length > 1) && (
            <Select value={building} onChange={(e) => setBuilding(e.target.value)} aria-label="Building" className={FIELD} wrap="w-56"
              options={[{ value: '', label: 'All buildings' }, ...buildings.map(([id, name]) => ({ value: id, label: name }))]} />
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([k, l]) => <button key={k} onClick={() => setStatus(k)} aria-pressed={status === k} className={CHIP(status === k)}>{l}</button>)}
          <span className="mx-1 w-px self-stretch bg-stroke" />
          <button onClick={() => setUrgent(!urgent)} aria-pressed={urgent} className={CHIP(urgent)}>Urgent</button>
          <button onClick={() => setOverdue(!overdue)} aria-pressed={overdue} className={CHIP(overdue)}>Overdue</button>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {!rows ? !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />
          : rows.length === 0 ? <p className="py-3 text-sm text-mute">No work orders here.</p> : (
            <ul className="space-y-3">
              {rows.map((w) => (
                <li key={w.id}>
                  <button onClick={() => setOpen(w.id)} className={`${CARD} flex w-full items-start gap-3 text-left hover:border-p1/50`}>
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-400 to-blue-500 text-white"><Wrench size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">{w.ref}{w.category ? ` · ${w.category}` : ''}</span>
                        <Pill w={w} />
                      </span>
                      <span className="mt-0.5 block text-xs text-mute">Unit {w.unit_no} · {w.building} · {w.tenant || 'Vacant'} · reported {fmt(w.reported_on)}</span>
                      <span className="mt-1.5 block truncate text-sm text-txt/80">{w.detail}</span>
                      <span className="mt-1 block text-xs text-mute">{[w.assigned_to ? `Assigned to ${w.assigned_to}` : 'Nobody assigned', w.scheduled_on && `scheduled ${fmt(w.scheduled_on)}`, w.done_on && `done ${fmt(w.done_on)}`].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Page>
  );
}
```

- [ ] **Step 2: Put it in the menu**

In `client/src/components/Sidebar.jsx`:

1. Add `Wrench` to the `lucide-react` import.
2. In `places`, directly after the `Tenants` entry, add:

```js
    { Ico: Wrench, color: 'from-sky-400 to-cyan-600 shadow-sky-500/30', label: 'Work orders', hint: 'Repairs: what is open, and who has it', here: leasingOpen && leasingTab === 'workorders', onClick: () => onLeasing('workorders') },
```

In `client/src/components/Leasing.jsx`:

1. Add the import: `import WorkOrders from './WorkOrders';`
2. In `LeasingPage`, replace the `openAlert` line with:

```js
  const openAlert = (a) => (a.open === 'tenants' ? setTab('tenants') : a.open === 'workorder' ? setForm({ workOf: { openId: a.work_order_id } }) : openBooking(a.booking_id, { pay: 'payOf', docs: 'docsOf' }[a.open]));
```

3. Directly after the line `if (form?.historyOf) return <TenantHistory … />;`, add:

```jsx
  // Work orders opened from somewhere else: an alert, a lease, a tenant's history. Back returns there.
  if (form?.workOf) {
    const from = form.back;
    return <WorkOrders {...form.workOf} onBack={() => (from ? (setForm(from), setKey((k) => k + 1)) : close())} />;
  }
```

4. Directly before the line `if (tab === 'calendar') return …`, add:

```jsx
  if (tab === 'workorders') return <WorkOrders key={key} onBack={onBack} />;
```

In `client/src/App.jsx`:

1. Replace the `notifiedLeasing` line (near line 39) with:

```js
const notifiedLeasing = ['alerts', 'workorders'].includes(params.get('leasing')) ? params.get('leasing') : null; // a leasing alert (rent due, overdue, a lease ending), or an urgent work order
```

2. In the `leasingTab` state (near line 58), change `notifiedLeasing ? 'alerts' : 'overview'` to `notifiedLeasing || 'overview'`.
3. In the `tapped` handler (near line 107), replace the `leasing` line with:

```js
      if (['alerts', 'workorders'].includes(where.get('leasing'))) { setLeasingTab(where.get('leasing')); setPanel('leasing'); return; }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: builds with no error and no "is not exported" warning.

- [ ] **Step 4: Check it in the browser**

Run `npm run dev`, open `http://localhost:5173`, sign in, and in the sidebar open **Work orders**. Check each:

- "New work order": choosing a leased unit shows "For <tenant> (LS-…)"; a vacant unit shows the vacant line. The unit picker is the themed, searchable one.
- Save one with a photo → it opens on its detail page with the photo listed and "Raised for …" in the history.
- Start work → Mark done (needs words) → Close → Reopen: the pill changes each time and each step is a line in the history with your name.
- Add a note; cancel another work order with a reason; the list's status chips, Urgent, Overdue and the search all narrow the list.
- As the master, a fresh open work order shows Delete; one with an assignee does not.

If the dev server cannot be run here, say so plainly in the report instead of claiming this step.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/WorkOrders.jsx client/src/components/Sidebar.jsx client/src/components/Leasing.jsx client/src/App.jsx
git commit -m "feat: Leasing - the Work orders page: the list with its filters, raising one, and its detail with photos and a timeline"
```

---

### Task 8: Work orders on the unit, the lease and the tenant's history

**Files:**
- Modify: `client/src/components/Inspections.jsx` (the unit's page)
- Modify: `client/src/components/Leasing.jsx` (`BookingCard`, `Bookings`, `LeasingPage`)
- Modify: `client/src/components/TenantHistory.jsx`

**Interfaces:**
- Consumes: `WorkOrders` and `WO_STATUS` from Task 7; `tenantHistory` response of Task 4 (`current`, and `wo` / `status` on maintenance items).
- Produces: nothing new for other tasks.

- [ ] **Step 1: The unit**

A unit's page is its Inspections page (opened from Properties, and from a lease). In `client/src/components/Inspections.jsx`:

1. Add `Wrench` to the `lucide-react` import, and `import WorkOrders from './WorkOrders';`.
2. In `Inspections`, next to the other `useState` lines, add:

```js
  const [orders, setOrders] = useState(false); // the unit's work orders are open
```

3. Change the `action` block to put the button first:

```jsx
  const action = data && (
    <div className="flex gap-2">
      <button onClick={() => setOrders(true)} className={OUTLINE} title="Every repair done in this unit, whoever lived in it"><Wrench size={16} /> <span className="hidden sm:inline">Work orders</span></button>
      {next?.also ? button(next.also, OUTLINE) : next?.late && step === 'move_in' ? button('move_out', OUTLINE) : !next && button('make_ready', OUTLINE)}
      {step && button(step, PRIMARY)}
    </div>
  );
```

4. Directly before the final `return (` that renders ``<Page title={`Inspections · ${place}`}``, add (it must stay below every hook in the component):

```jsx
  if (orders) return <WorkOrders scope={{ unit_id: unit.id }} title={`Work orders · ${place}`} preset={{ unit_id: unit.id }} onBack={() => setOrders(false)} />;
```

- [ ] **Step 2: The lease**

In `client/src/components/Leasing.jsx`:

1. Add `Wrench` to the `lucide-react` import.
2. `BookingCard` takes a new prop `onWork`: add it to the destructured props, and in its `actions` list, directly after the `Change end date` entry, add:

```js
    b.status === 'confirmed' && [Wrench, 'Work orders', onWork, 'Repairs raised for this tenant during the lease'],
```

3. `Bookings` takes a new prop `onWork` and passes it down. Find where it renders `<BookingCard` (two places: the grid and the list) with `grep -n "<BookingCard" client/src/components/Leasing.jsx`; each passes `onInspect={(start) => onInspect(b, start)}` or similar. Beside it, add `onWork={() => onWork(b)}` in both.
4. In `LeasingPage`, in the `<Bookings … />` element, add:

```jsx
onWork={(b) => setForm({ workOf: { scope: { booking_id: b.id }, title: `Work orders · ${b.ref}`, preset: { unit_id: b.unit_id } } })}
```

- [ ] **Step 3: The tenant's history**

In `client/src/components/TenantHistory.jsx`:

1. Add `ChevronRight` to the `lucide-react` import, and `import { WO_STATUS } from './WorkOrders';`.
2. Update the header comment's last sentence to: `(server/leasingHistory.js); complaints are typed in here, each with as many attachments as it needs; maintenance is the tenant's work orders, opened from here and changed on their own page.`
3. `Item` takes a new prop `onWork`. At the top of `Item`, after `const late = i.type === 'late';`, add:

```js
  const order = !!i.wo; // a work order: shown here, changed on its own page
```

   Change the `pill` line to:

```js
  const pill = late ? (open ? [`${aed(i.left)} still owed`, 'bg-bad/15 text-bad'] : ['Paid late', 'bg-warn/15 text-warn'])
    : order ? [WO_STATUS[i.status][0], WO_STATUS[i.status][1]]
      : open ? ['Open', 'bg-warn/15 text-warn'] : ['Resolved', 'bg-ok/15 text-ok'];
```

   Change the title line `<p className="text-sm font-medium">…</p>` to:

```jsx
            <p className="text-sm font-medium">{late ? `Rent ${days(i.days_late)} late` : `${order ? `${i.wo} · ` : ''}${name}${i.category ? ` · ${i.category}` : ''}`}</p>
```

   In the meta line, add the assignee: change the array to

```js
                {[i.reported_by && `Reported by ${i.reported_by}`, i.assigned_to && `Assigned to ${i.assigned_to}`, i.logged_by && `Logged by ${i.logged_by}`, i.resolved_on && `${order ? 'Done' : 'Resolved'} ${fmt(i.resolved_on)}${i.resolution ? `: ${i.resolution}` : ''}`].filter(Boolean).join(' · ')}
```

   Change the buttons block so a work order has one button:

```jsx
          {late ? open && <button onClick={() => onPay(i.booking_id)} className={GHOST}><Banknote size={14} /> Payments</button>
            : order ? <button onClick={() => onWork(i)} className={GHOST}>Open <ChevronRight size={14} /></button> : (
            <>
              {open ? !resolving && <button onClick={() => setResolving(true)} className={GHOST}><Check size={14} /> Resolve</button>
                : <button onClick={() => act(() => api.put(`/leasing/log/${i.id}`, { resolved: false, resolution: '' }))} aria-label="Open again" title="Open again" className={`${ROUND} hover:text-txt`}><RotateCcw size={15} /></button>}
              <button onClick={() => onEdit(i)} aria-label="Edit" title="Edit" className={`${ROUND} hover:text-txt`}><Pencil size={15} /></button>
              <button onClick={() => confirm(`Delete this ${name.toLowerCase()} entry?`) && act(() => api.del(`/leasing/log/${i.id}`))} aria-label="Delete" title="Delete" className={`${ROUND} hover:text-bad`}><Trash2 size={15} /></button>
            </>
          )}
```

4. `TenantHistory` takes a new prop `onWorkOrder`. Change its signature to `export default function TenantHistory({ tenant, onBack, onPay, onWorkOrder })`, and add inside it:

```js
  const mine = { scope: { tenant_id: tenant.id }, title: `Work orders · ${tenant.full_name}`, preset: h?.current ? { unit_id: h.current.unit_id } : null };
```

   Change the "Add maintenance" button to raise a work order:

```jsx
        <button onClick={() => onWorkOrder({ ...mine, startNew: true })} className={OUTLINE} title={h?.current ? `A work order for unit ${h.current.unit_no}, ${h.current.building}` : 'A work order'}><Plus size={16} /> <span className="hidden sm:inline">Add </span>maintenance</button>
```

   Change the list's `<Item … />` to pass `onWork` and a key that cannot collide with a complaint's id:

```jsx
            : <ul className="space-y-3">{items.map((i) => <Item key={i.wo || `${i.type}-${i.id || `${i.booking_id}-${i.date}`}`} i={i} onPay={onPay} onEdit={setEntry} onChanged={load} onWork={(o) => onWorkOrder({ ...mine, openId: o.id })} />)}</ul>}
```

5. In `client/src/components/Leasing.jsx`, change the `historyOf` line in `LeasingPage` to:

```jsx
  if (form?.historyOf) return <TenantHistory key={key} tenant={form.historyOf} onBack={close} onPay={pay} onWorkOrder={(w) => setForm({ workOf: w, back: { historyOf: form.historyOf } })} />;
```

   (`key={key}` makes the history load again when the user comes back from a work order.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: builds with no error.

- [ ] **Step 5: Check it in the browser**

With `npm run dev` running:

- Properties → a building → a unit's **Inspections** → **Work orders**: lists every work order of that unit, including closed ones and ones from an earlier tenant; "New work order" has the unit already chosen. Back returns to the unit's inspections.
- Leasing → a confirmed lease → **Work orders**: lists only that lease's; a new one has the unit chosen and says it is for that tenant.
- Tenants → a tenant's **History**: the Maintenance tile counts their work orders (open = not done); each shows its WO reference and status; **Open** goes to it and Back returns to the history, with the count updated. **Add maintenance** opens the new-work-order form for their unit. Complaints still add, resolve, edit and delete as before.
- Alerts: give a work order a scheduled date in the past → it shows under Alerts as "WO-… is overdue", and the row opens it.

If the dev server cannot be run here, say so plainly in the report instead of claiming this step.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Inspections.jsx client/src/components/Leasing.jsx client/src/components/TenantHistory.jsx
git commit -m "feat: Leasing - a unit, a lease and a tenant's history each show their work orders, and raise one from where they are"
```

---

### Task 9: The whole suite, and a last look

**Files:** none new.

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: every test passes except the known `tests/drawing.test.js` crash on Windows. If any other test fails, read it: a test that compared the whole alert settings, the list of rules, the number of leasing tools or the old "This unit has leases" message needs its expectation updated to the new behaviour; anything else is a real fault to fix before going on.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no error.

- [ ] **Step 3: Check the spec against what was built**

Read `docs/superpowers/specs/2026-10-10-work-orders-design.md` section by section and confirm each rule has code and a test. Confirm with `grep -rni "cost\|invoice\|charge" server/workOrders.js client/src/components/WorkOrders.jsx` that the only hits are the sentences saying nothing is charged.

- [ ] **Step 4: Commit anything Step 1 changed**

```bash
git add tests
git commit -m "test: Leasing - the alert and tool tests know about work orders"
```

(Skip if nothing changed.) Do not push and do not deploy: tell Francis it is ready on `leasing-bookings` and what was and was not checked in the browser.
