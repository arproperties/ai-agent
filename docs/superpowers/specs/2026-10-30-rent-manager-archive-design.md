# Rent Manager Archive — design

Date: 2026-10-30 · Branch: `leasing-bookings` (lease app, jnrpro.co) · Status: draft, awaiting Francis's approval

## Why

The boss's data is moving off Rent Manager. Entering every tenant's whole history the
"proper" way — the 2023 lease, renew it into 2024, renew into 2025, pass the deposit on each
time, every payment on the right lease — works, but it is far too slow for staff. Units
101–316 were done that way (by hand, matching Rent Manager to the cent); the rest are not.

Staff want to enter **today's active lease first** so they can start using the app, and fill
in the old history later, whenever they have time. The trouble: the app's renewal chain only
works if leases go in oldest-first. Entering today's lease first and then adding older leases
behind it breaks the deposit (it should sit on the oldest lease and be passed forward), the
renewal links, and risks old leases being billed, flagged overdue, or asked for inspections.

The boss wants an **Archive**: old leases are recorded as history, separate from the live
system, so the order they are entered in no longer matters.

## The idea in one line

The **active lease holds all live money**. The **archive is history only** and never changes
any balance, bill, deposit, alert or inspection.

## Goals

1. Staff can enter a tenant's active lease alone, with its deposit and what the tenant owes
   today, and the app is correct from day one (matches Rent Manager's Balance Due and
   deposit held).
2. Later, in any order, staff can add the tenant's old Rent Manager leases to an archive,
   each with its old payments and old work orders as typed lines, and attachments.
3. Anyone looking at a lease, tenant or unit sees the full history in one place.

## Non-goals

- No import from Rent Manager exports or AI reading of screenshots (tried before — not
  accurate). Entry is by hand; staff are in Rent Manager downloading the attachments anyway.
- No converting an archived lease into a live lease, ever.
- No change to units 101–316 already entered as full live chains. They stay as they are.
- No late-fee history (late-fee rule is still undecided by the boss).

## Anti-goals (would be a failure even if it "works")

- Anything in the archive changing a live number: balance, rent roll, overdue, deposit held,
  reports, QuickBooks sync, Zego matching, dashboard occupancy/Vacant, alerts, tenant emails.
- An archived lease blocking a unit as "occupied" for its dates, or clashing with a live lease's dates.
- An archived lease triggering a move-in or move-out inspection.

## Part 1 — Active lease entered first (mostly existing features)

Entered with the normal lease form, as staff do now. Two things need to be easy:

- **Deposit already held.** The deposit was paid years ago in Rent Manager. Staff enter the
  deposit amount and its real paid date. The app already supports a deposit charged before
  the lease start (`deposit_due`) and a payment dated in the past; that is the mechanism.
  The lease then holds the deposit and gives it back at move-out, as any lease does.
  No renewal link, no `passDeposit` needed.
  The "deposit charged on" date is already on the form (`Leasing.jsx`).
- **Billing starts at switch-over, not at the lease start.** A lease that began in 2025
  would otherwise bill every month since 2025 and show them all overdue. The form gets a
  "Bill in this app from" date, which sets the existing `billed_from` (today only the Rent
  Roll import sets it). Rent before that date counts as billed in Rent Manager.
  Optional: left empty, the lease bills from its start as today. The active lease's own
  past payments are **not** typed in; staff attach Rent Manager's ledger PDF to the lease
  documents as proof. *(Claude's call — Francis unsure; can add record-only history lines
  on the active lease later if the boss asks.)*
- **Opening balance.** The tenant's **whole Rent Manager Balance Due on the switch-over day**
  goes in as **one dated charge** labelled "Balance brought forward from Rent Manager"
  (existing `addCharge`, already on the Payments screen in `BookingPayments.jsx`). Old debts
  are collected on the live lease, because the archive is read-only.
- **Opening credit** (tenant is in credit in Rent Manager). There is no way today to add a
  credit without recording a payment (`keep_credit` only keeps the excess of a real
  payment), and a made-up payment would reach QuickBooks sync, reports and receipts.
  New: a payment method **"Paid in Rent Manager"** for money that came in before the
  switch-over (the old deposit, an opening credit). Recorded like a payment, so the
  existing deposit and credit logic just works, but skipped by QB sync, Zego matching,
  receipts and money-received reports.
- **No move-in inspection.** The form gets an "already living here (from Rent Manager)"
  tick that sets `import_batch`. Note: the unit list's `move_in_due`
  (`server/properties.js:165`) checks only `renewed_from`. It must also skip leases with
  `import_batch`, or these leases will still ask for a move-in.

## Part 2 — The Archive (new)

### What an archived lease holds

Typed by staff, from Rent Manager:

- Unit (picked), and tenant: picked from existing tenants, **or a typed name** for a past
  tenant who isn't in the app. A typed name never creates a tenant record, so past tenants
  don't appear in tenant lists, searches or email lists.
- Start date, end date
- Monthly rent
- Deposit amount
- How it ended: **Renewed**, **Moved out**, **Evicted**, **Transferred to another unit**
- Notes (free text)
- Attachments: any files (contract, ledger PDF, notices, ID…) with a title/category like lease documents

Plus two lists:

- **Old payments** — each line: date, amount, method, reference/notes, optional attachment
  (receipt, check image).
- **Old work orders** — each line: date reported, what the problem was, what was done,
  date done, cost, optional attachments (photos, invoice).

If the tenant left owing money, the archived lease can show "Unpaid at end: $X" as a typed
figure, with a note that it was carried to the active lease. It is a display figure only.

### Rules

- An archived lease, its payments and its work orders are **records only**. They are not
  installments, not payments on any ledger, not work orders on the Work Orders board.
- They never appear in: rent roll, balances, overdue, alerts, dashboard occupancy/Vacant,
  reports' money totals, QuickBooks sync, Zego matching, tenant emails, inspections, the
  unit-availability check.
- Order of entry does not matter. A 2023 lease can be added after the 2025 one.
- Archived leases can be **edited and deleted** (staff will make typos), under the Actions
  Add/Edit/Delete ticks like everything else.

### Where it is seen

- On a **live lease**: a "Previous leases (Rent Manager)" section listing that tenant's
  archived leases in that unit, oldest first.
- On the **tenant**: all their archived leases, any unit (a tenant who transferred units
  shows both).
- On the **unit**: all archived leases for that unit, any tenant.
- An **Archive** list (its own tab or a filter under Leasing — builder's call) to find and add
  archived leases, searchable by tenant / unit / year.

Clicking an archived lease opens it read-only-looking with an Edit button, clearly labelled
**Archived · from Rent Manager** so nobody mistakes it for live.

## Decided (by Francis)

- Active lease first, archive later, in any order.
- Archive entry is manual, not import.
- Old payments and old work orders are **typed lines with optional attachment**, not just PDFs.
- Archive never touches live money.

## Calls made by Claude (Francis can override)

- **Old unpaid balance → one opening-balance charge on the active lease**, not left on the
  archived lease (an archived lease can't collect money).
- **Typed fields per archived lease** kept to dates, rent, deposit, how it ended, notes.
- **Archive in its own tables** (e.g. `lease_archive`, `lease_archive_payments`,
  `lease_archive_work_orders`, `lease_archive_files`), not a status on `lease_bookings`.
  Reason: many queries pick leases by `status <> 'cancelled'` or by unit/date; a new status
  would have to be excluded from every one of them, and missing one breaks live numbers —
  the main anti-goal. Separate tables can't leak.
- Archived leases are linked by **tenant + unit**, not by `renewed_from`.
- **Money from before the switch-over uses a "Paid in Rent Manager" payment method**, kept
  out of QuickBooks, Zego, receipts and money-received reports.
- Archived payments may use **Check** as a method (history only; live payments still have none).
- **Past tenants not in the app go in the archive as a typed name**, not as a tenant record.

## Constraints (from how this app is built)

- Every new route and button joins the **Actions** Add/Edit/Delete permission ticks
  (server-gated).
- New tables need **activity log** labels (LABELS / SKIP_TABLES in the activity log code).
- Dropdowns use the themed searchable `Select.jsx`, never a native `<select>`.
- Dates shown MM/DD/YYYY (US app). Money to the cent.
- Files stored like lease documents / work order files today.
- Tests: use a test DB that isn't `jarvis_test`; follow existing `tests/leasing-*.test.js` style.
- Nothing deployed until Francis says so; deploy target is the USA server (jnrpro.co).

## Left to the builder

- Exact screen layout, tab vs filter for the Archive list.
- Table/column names and API routes.
- Whether payment methods list matches the live one (and whether to add "Check" — live has
  none; Rent Manager has checks — worth asking Francis once).
- How the active-lease form exposes "deposit paid on" and "opening balance".
