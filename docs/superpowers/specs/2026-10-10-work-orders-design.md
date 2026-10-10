# Work orders — design

Date: 2026-10-10
Status: draft, for review (nothing built yet)
Branch: `leasing-bookings` (the leasing app). Saifsys and the staff-app jobs in `server/buildings.js` are not used.

## 1. The problem

When a tenant reports a fault (the AC is not cooling, a tap leaks), the office has nowhere
to track it from the report to the fix. Today it can only be typed as a "maintenance" note
in Tenant History: a line of text that is either open or resolved. That note does not say
who is fixing it, when they are coming, or what happened along the way, and it cannot be
found from the unit or the lease.

## 2. What success looks like

- The office raises a work order in under a minute and always knows what is open, who has
  it and when it is due.
- One work order is visible from the unit, from the lease and from the tenant, without
  being typed three times.
- Every change to a work order is kept: what changed, who changed it, when.
- A unit's page shows every repair ever done in it, across all its tenants.

## 3. Decisions made with Francis (2026-10-10)

| # | Decision | Why |
|---|----------|-----|
| D1 | A work order belongs to a **unit**. The lease and tenant are links filled in automatically. | The repair is to the unit, whoever lives there. One record, three views. |
| D2 | **Office staff only** update work orders. The technician or vendor is a name typed on it. | Matches how the rest of leasing works. No new role, no technician login. |
| D3 | **No cost is recorded**, and nothing is charged to the tenant. | Repairs are covered by the tenant's AMC (annual maintenance contract). |
| D4 | A work order **can exist without a tenant**, for a vacant unit. | Damage found at move-out is fixed before the next tenant arrives. |
| D5 | The maintenance notes in Tenant History **become work orders**. | Two maintenance lists would disagree with each other. |

## 4. Out of scope

- Cost, invoice amounts, charging a tenant, vendor payments.
- A login or screen for technicians, and a tenant-facing way to report a fault.
- A list of vendors or AMC contracts (the name is typed; it can become a list later).
- Planned or repeating maintenance (a yearly AC service). A work order is one job.
- Changing a unit's status. A work order never blocks a unit or stops a lease.
- Complaints and late rent in Tenant History: unchanged.

## 5. Data model

```
prop_units ─── lease_work_orders ─┬─ lease_work_order_events  (the history)
                 │        │       └─ lease_work_order_files   (photos, files)
   lease_bookings┘        └lease_tenants
```

### lease_work_orders

| Column | Notes |
|--------|-------|
| `id` | The reference is made from it: `WO-2026-0014` (year of `reported_on`, id padded to 4), the same way a lease reads `LS-2026-0007`. |
| `unit_id` | Required. `ON DELETE RESTRICT`: a unit with work orders is not deleted. |
| `booking_id` | The lease, or NULL for a vacant unit. `ON DELETE SET NULL`. |
| `tenant_id` | The tenant of that lease, or NULL. `ON DELETE SET NULL`. |
| `tenant` | The tenant's name as it was, kept if the lease or tenant goes (as `prop_inspections.tenant` does). |
| `category` | A free word: AC, Plumbing, Electrical, Appliance, Pest control, Other. |
| `priority` | `low` \| `normal` \| `urgent`. Default `normal`. |
| `detail` | What is wrong. Required. |
| `reported_by` | Who told the office (the tenant, the watchman…). Free text. |
| `reported_on` | DATE. Not in the future. Default today. |
| `status` | `open` \| `assigned` \| `in_progress` \| `done` \| `closed` \| `cancelled`. |
| `assigned_to` | The technician or vendor, typed in. |
| `scheduled_on` | DATE the work is planned for. May be in the future. |
| `resolution` | What was done. Required to mark it done. |
| `done_on` | DATE the work was finished. |
| `cancel_reason` | Required to cancel. |
| `created_by`, `created_at` | As everywhere else. |

Indexes on `(unit_id, reported_on)`, `(tenant_id, reported_on)` and `(booking_id)`.

### lease_work_order_events

`id`, `work_order_id` (`ON DELETE CASCADE`), `kind`, `detail`, `user_id`, `created_at`.

`kind` is one of: `created`, `status`, `assigned`, `scheduled`, `edited`, `note`, `file_added`,
`file_removed`, `reopened`. `detail` is a readable line ("Assigned to Cool Air LLC",
"In progress → Done: replaced the compressor"). There is no code path that updates or
deletes an event row; they go only when the work order itself is deleted (see 6.4).

### lease_work_order_files

`id`, `work_order_id` (`ON DELETE CASCADE`), `file_path`, `file_name`, `file_mime`,
`uploaded_by`, `created_at`. Files live on disk under `data/leasing`, saved with the
existing `saveFile` and served with `sendDoc`. Up to 10 per upload, 25 MB each, as
Tenant History does today.

## 6. Rules

### 6.1 Linking to the lease and tenant

When a work order is raised for a unit, the server looks for the lease that unit had on
`reported_on`: a confirmed lease whose dates cover that day. If there is one, `booking_id`,
`tenant_id` and `tenant` are filled from it. If there is none, all three stay empty and the
work order is for the vacant unit.

Raising one from a tenant's or a lease's page is the same thing with the unit already
chosen. If `reported_on` is later changed, the link is worked out again.

Staff never pick the lease by hand, so a work order cannot be tied to the wrong tenant.

### 6.2 Status

```
open → assigned → in_progress → done → closed
  └──────────┴──────────┴──→ cancelled
```

- Typing an assignee on an open work order moves it to `assigned`.
- A step may be skipped going forward (open straight to done for a five-minute fix).
- `done` needs `resolution`; `done_on` defaults to today.
- `closed` means the office has confirmed the fault is gone. Only a `done` one can be closed.
- `cancelled` needs a reason, and is not allowed from `done` or `closed`.
- A `done`, `closed` or `cancelled` work order can be **reopened**: it goes back to
  `in_progress` (or `open` if it has no assignee), and the history says so.

### 6.3 History

Every create, status change, assignment, reschedule, edit of the words, and file added or
removed writes one event in the same transaction as the change. Staff can also add a plain
note ("tenant not home, coming back Thursday"), which is an event of kind `note`.

### 6.4 Deleting

Only the master can delete a work order, and only while it is `open` with no assignee
(a mistake, a duplicate). After that it can only be cancelled, so the trail is kept.

### 6.5 Access

The same as leases: a leasing user sees and changes work orders for the buildings they
look after; the master sees all.

## 7. Moving the old maintenance notes

Once, at start-up in `db.js`, inside a transaction, for every `lease_tenant_log` row with
`kind = 'maintenance'` that has a `booking_id`:

- make a work order on that lease's unit, with the same tenant, category, detail,
  `reported_by` and date;
- unresolved → `open`; resolved → `closed`, with `done_on = resolved_on` and the old
  `resolution` text;
- write one `created` event, dated as the old entry, saying it came from Tenant History;
- repoint its files to `lease_work_order_files` (the files on disk are not moved);
- delete the old row.

A note with no `booking_id` has no unit to hang on, so it stays where it is and Tenant
History keeps showing it as before. Running the move a second time finds nothing left to
move.

After this, `lease_tenant_log` takes complaints only: adding a `maintenance` entry is refused.

## 8. Where it shows

### Work Orders page (new, in the Leasing menu)

- A list, newest first: reference, unit and building, tenant, category, priority, status,
  assignee, scheduled date. An overdue one (scheduled date passed, not yet done) is marked.
- Filters: status (default: everything not closed or cancelled), building, priority,
  overdue. A search box over reference, unit, tenant and words.
- "New work order": pick the unit with the searchable `Select.jsx` (never a native
  select); the form shows which tenant it will be linked to before saving.
- Detail view: the fields, the files, the buttons for the next status, and the timeline.

### Elsewhere

- **Unit** (Properties): a "Work orders" list of every one on that unit, any tenant.
- **Lease** (`BookingCard.jsx`): the ones raised during that lease, with a button to raise one.
- **Tenant History** (`TenantHistory.jsx`): the Maintenance entries come from work orders.
  The tile keeps its two numbers: total (cancelled ones not counted) and open (not yet
  done). "Add maintenance" opens the new work order form for that tenant's current unit.
  Riley's tenant-history answer reads the same figures.

## 9. Riley

Three tools in `leasingKit.js`, following the ones already there:

- raise a work order (unit, what is wrong, category, priority);
- update one (status, assignee, scheduled date, what was done, a note);
- list them (by unit, tenant, building, status, overdue).

So "the AC in 303 is not cooling, urgent" raises one, and "what is open in building A?"
is answered from the list.

## 10. Alerts

Using the leasing alert machinery (`leasingAlerts.js`, `push.js`, the sent-once log
`lease_alerts_sent`), to the building's staff, the person who raised it and the master:

- a new `urgent` work order: a push at once;
- an overdue one (scheduled date passed, still not done): once a day, within quiet hours
  rules, until it is done, rescheduled or cancelled.

Both sit under one new rule the master can switch off in the alert settings.

## 11. Code

| File | What |
|------|------|
| `server/db.js` | The three tables and the one-time move (section 7). |
| `server/workOrders.js` (new) | The rules and the routes, mounted under `/api/leasing`. |
| `server/leasingHistory.js` | Maintenance read from work orders; `maintenance` entries refused. |
| `server/leasingKit.js` | Riley's three tools; the tenant-history wording. |
| `server/leasingAlerts.js` | The two alerts and their rule. |
| `client/src/components/WorkOrders.jsx` (new) | The page, the form, the detail view. |
| `Properties.jsx`, `BookingCard.jsx`, `TenantHistory.jsx`, `Sidebar.jsx`, `App.jsx` | The lists and the menu entry. |
| `tests/work-orders.test.js` (new), `tests/helpers/db.js` | Tests; the new tables in the reset list. |

Routes:

```
GET    /work-orders                 list, with filters
POST   /work-orders                 raise one
GET    /work-orders/:id             one, with files and history
PUT    /work-orders/:id             change fields or status
DELETE /work-orders/:id             master only, open and unassigned only
POST   /work-orders/:id/notes       add a note to the history
POST   /work-orders/:id/files       attach files
GET    /work-orders/files/:id/file  open a file
DELETE /work-orders/files/:id       remove a file
```

## 12. Testing

Server tests, written before the code, one per rule:

- linking: a unit with a running lease, a vacant unit, a changed `reported_on`;
- each status step, each refused step, reopening;
- an event is written for every kind of change, and none can be changed;
- deleting: allowed only for the master on an open, unassigned one;
- the move: open and resolved notes, files carried over, notes without a lease left alone,
  a second run moves nothing;
- Tenant History counts and Riley's tenant-history answer after the move;
- the two alerts fire once and respect the rule being off.

Then the screens are checked by hand in the browser: raise, assign, finish, close, reopen,
from each of the three places.

## 13. Build order

1. Tables, rules, routes and tests.
2. The move of the old notes, and Tenant History reading from work orders.
3. The Work Orders page.
4. The lists on the unit and the lease.
5. Riley's tools.
6. Alerts.
