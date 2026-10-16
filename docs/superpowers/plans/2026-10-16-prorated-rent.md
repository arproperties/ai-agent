# Prorated First-Month Rent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lease can charge a part first month (prorated by days) and then full rent on the 1st of every month, with the part month billed either at move-in or added to the second month's bill.

**Architecture:** One new column `lease_bookings.prorate` (`NULL` | `'first'` | `'second'`). `schedule(b)` in `server/leasing.js` builds a 1st-of-the-month schedule when it is set, and every row carries the share of a month it bills, so repeating charges are prorated the same way. The booking form gets a "First month" choice and its summary (`plan()` in `Leasing.jsx`) mirrors the server.

**Tech Stack:** Node 22 + Express + PostgreSQL (`server/`), React + Vite + Tailwind (`client/`), `node:test` (`tests/`).

**Spec:** this document. The decisions below came from Francis on 2026-10-16: Rent Manager prorates the first month, then bills on the 1st; he wants a choice between "from the first month" and "from the second month".

## Global Constraints

- Branch: work in a git worktree on a new branch made from `leasing-bookings`. Never `main`. Do not push or deploy until Francis says so. A deploy is the USA server only (see memory `usa-ec2-server`), never `deploy.ps1`.
- Tests: run against a database whose name ends in `_test`. Use `jarvis_leaseimp_test` (it already exists), not the shared `_test` DB another session may be using: `TEST_DATABASE_URL=<.env DATABASE_URL with the db name replaced by jarvis_leaseimp_test> node --test --test-force-exit --test-concurrency=1 tests/*.test.js`. Known failures unrelated to this work: `drawing.test.js`, the video `sh` test (Windows), and the work-order file test when run from a path under `.claude\`.
- Never use a native `<select>`: use the app's `Select.jsx` or the `Pick` toggle already in `Leasing.jsx`.
- The comment style is plain, full sentences explaining *why*, like the code around it.
- Money is rounded with `money()` (2 decimals). Day counts are inclusive of both ends, worked out with `dayNo()`.
- **Daily rate = monthly rent ÷ the number of days in that calendar month.** Example: $1,100, move-in 17 Oct 2026 (31-day month, 15 days lived) = 1100 × 15 / 31 = **$532.26**.
- `prorate` values and their meaning:
  - `NULL`: no proration. Rent is due on the move-in day of every month, exactly as today. All existing leases stay like this.
  - `'first'`: the part month is billed on the move-in day; full rent is then due on the 1st of each month.
  - `'second'`: nothing is billed in the move-in month; the part month is added to the bill on the 1st of the next month.
- Proration only applies when `payment_frequency = 'monthly'`. It works with rent per month or per year (it uses `monthlyRent(b)`).
- A lease that starts on the 1st has no part first month, but its last month is still prorated if it ends before a month's end.
- A lease imported from Rent Manager (`billed_from` set) keeps `importedSchedule` and ignores `prorate`.
- Labels in the form: group title **"First month"**. Options: **"Full month from move-in"** (`NULL`), **"Prorated, paid at move-in"** (`'first'`), **"Prorated, added to 2nd month"** (`'second'`). Default for a new lease made on the form: `'first'`.

## Review Focus

1. Move-in on the last day of a month (31 Oct): 1 day ÷ 31. Must not be 0 or a full month.
2. February move-in (28/29 days): the share uses 28 or 29, not 30 or 31.
3. A `'second'` lease that ends inside its move-in month (17–31 Oct): there is no next 1st, so the part month is billed at move-in instead of being lost.
4. A lease that starts on the 1st and ends mid-month: only the last row is prorated.
5. Editing `prorate` on a lease that already has a payment is refused (409), like the other money terms.

---

### Task 1: The column and the schedule

**Files:**
- Modify: `server/db.js` (next to the `import_batch` / `billed_from` block, around line 1440): `ALTER TABLE lease_bookings ADD COLUMN IF NOT EXISTS prorate TEXT;` with a 2-line comment.
- Modify: `server/leasing.js`: `BOOKING_SELECT` (add `b.prorate`), `bookingFields`, `schedule`, `writeSchedule`, `updateBooking` (the `fixed` list), `renewBooking` (copy `prorate`).
- Test: `tests/leasing-prorate.test.js` (new).

**Interfaces:**
- Produces: `schedule(b)` rows are `{ due, amount, tax?, share }`. `share` is the number of months the row bills (1 for a full month, e.g. 0.4839 for 15/31, 1.4839 for a `'second'` row). Rows from the existing paths get `share` too: `step` for normal rows (or the remaining months on the last one), 1 for each imported row.
- Produces: `bookingFields` accepts `prorate` (`''`/`null` → `NULL`, `'first'`, `'second'`). Anything else → 400 `'Unknown proration.'`. `prorate` set with a `payment_frequency` other than `'monthly'` (from the body, or from the old row on an update) → 400 `'Proration needs monthly payments.'`.

- [ ] **Step 1: Write the failing tests** in `tests/leasing-prorate.test.js`. Pure `schedule()` tests need no DB; build `b` as a plain object `{ start_date, end_date, rent_amount, rent_period: 'month', payment_frequency: 'monthly', prorate, tax_percent: null }`.

```js
test('prorated at move-in: the part month on the move-in day, then the 1st', () => {
  const s = schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' });
  assert.deepEqual([s[0].due, s[0].amount], ['2026-10-17', 532.26]);
  assert.deepEqual([s[1].due, s[1].amount], ['2026-11-01', 1100]);
  assert.deepEqual([s.at(-1).due, s.at(-1).amount, s.length], ['2027-10-01', 1100, 13]);
});
test('prorated into the 2nd month: nothing at move-in, the part added to the 1st', () => {
  const s = schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'second' });
  assert.deepEqual([s[0].due, s[0].amount, s.length], ['2026-11-01', 1632.26, 12]);
});
test('the edges of a month', () => {
  assert.equal(schedule({ ...B, start_date: '2026-10-31', end_date: '2027-10-31', prorate: 'first' })[0].amount, 35.48); // 1 day of 31
  assert.equal(schedule({ ...B, start_date: '2027-02-15', end_date: '2028-01-31', prorate: 'first' })[0].amount, 550); // 14 of 28 days
  const short = schedule({ ...B, start_date: '2026-10-17', end_date: '2026-10-31', prorate: 'second' });
  assert.deepEqual(short.map((r) => [r.due, r.amount]), [['2026-10-17', 532.26]]); // no next 1st: billed at move-in
  const mid = schedule({ ...B, start_date: '2026-11-01', end_date: '2027-04-15', prorate: 'first' });
  assert.deepEqual([mid[0].amount, mid.at(-1).due, mid.at(-1).amount], [1100, '2027-04-01', 550]); // 15 of 30
});
test('yearly rent, tax, and no proration', () => {
  assert.equal(schedule({ ...B, rent_amount: 13200, rent_period: 'year', start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' })[0].amount, 532.26);
  assert.equal(schedule({ ...B, tax_percent: 8.25, start_date: '2026-10-17', end_date: '2027-10-31', prorate: 'first' })[0].amount, 576.17); // 532.26 + 43.91
  assert.equal(schedule({ ...B, start_date: '2026-10-17', end_date: '2027-10-16', prorate: null })[1].due, '2026-11-17'); // as today
});
```

  DB tests in the same file (use `reset`, `create`, `addTenant`, `createBooking`, `updateBooking`, `takePayment` as `tests/lease-import.test.js` does):
  - `createBooking({..., start_date: '2026-10-17', end_date: '2027-10-31', rent_amount: 1100, payment_frequency: 'monthly', prorate: 'first', fees: [{ label: 'Pet', amount: 50, repeats: true }], status: 'confirmed' })`: the first fee row is due `2026-10-17` with amount `24.19` (50 × 15/31). With `'second'`, the first fee row is due `2026-11-01` with `74.19`.
  - `getBooking(id).prorate === 'first'`.
  - `createBooking` with `prorate: 'first', payment_frequency: 'quarterly'` rejects with `/Proration needs monthly payments/`. `prorate: 'weekly'` rejects with `/Unknown proration/`.
  - After a payment on the first row, `updateBooking(id, { prorate: 'second' })` rejects with status 409.
  - The deposit is still due on `start_date`.

- [ ] **Step 2: Run them and see them fail.** `node --test tests/leasing-prorate.test.js` (with `TEST_DATABASE_URL` as in Global Constraints). Expected: failures on `prorate`/amounts.

- [ ] **Step 3: Implement.**
  - `schedule(b)`: keep `if (b.billed_from) return importedSchedule(b);` first, then `if (b.prorate && b.payment_frequency === 'monthly') return proratedSchedule(b);`, else the existing code (add `share` to its rows).
  - New `function proratedSchedule(b)` next to `importedSchedule`. Algorithm:
    - `dim(d)` = days in d's month. `part(from, to)` = inclusive days ÷ `dim(from)`.
    - If the start is not the 1st, `head = part(start, min(monthEnd(start), end))`. Otherwise there is no head.
    - Walk the 1sts after the start month (or from the start itself when it is a 1st) while `≤ end`. Each one's share is 1, or `part(first, end)` when the end falls before that month's end.
    - `'first'`: the head is its own row due on `start`. `'second'`: the head is added to the first 1st's share. If there is no 1st, it is its own row on `start`.
    - Each row: `rent = money(monthlyRent(b) * share)`, `tax = taxOn(b, rent)`, `{ due, amount: money(rent + tax), tax?, share }`.
  - `writeSchedule`: a repeating fee on each rent row is `money(f.amount * r.share)` (tax on that). One-time fees and the deposit stay on `first` as now.
  - `bookingFields`: validate `prorate` as in Interfaces. On update, `updateBooking` passes the merged frequency check: do the frequency check in `updateBooking` with `{ ...old, ...row }`, and in `makeBooking` with `row`.
  - `updateBooking` `fixed`: add `'prorate'` to the first list (string compare).
  - `renewBooking`: add `prorate` to the INSERT columns and values.

- [ ] **Step 4: Run them and see them pass**, then the whole suite. Expected: only the known unrelated failures.

- [ ] **Step 5: Commit.** `git commit -m "feat: Leasing: a lease can prorate its first month and then bill on the 1st, paid at move-in or with the 2nd month"`

### Task 2: The booking form

**Files:**
- Modify: `client/src/components/Leasing.jsx`: `plan(v)` (around line 115), the form's initial state (around line 160, add `prorate: start?.prorate ?? (start?.id ? null : 'first')`), step 3 "Rent and charges" (around line 369), the summary that uses `plan()`, and `BookingCard`'s terms line (around line 584).

**Interfaces:**
- Consumes: the server accepts `prorate` on create and update (Task 1).

- [ ] **Step 1: Make `plan(v)` mirror the server.** When `v.prorate && v.payment_frequency === 'monthly'`, compute the head share as in Task 1. With `'first'`, `firstRent` = `monthly × head`. With `'second'`, `firstRent` = 0 at move-in, and return `second: { due: <the 1st after start>, amount: monthly × (1 + head) }`. `total` = `monthly × (head + full months + tail share)`. Keep the current maths when `prorate` is not set.
- [ ] **Step 2: Add the "First month" group** on step 3, below Rent. Show it only when the start date is not a 1st and Paid is Monthly. Use `<Pick>` with the three labels from Global Constraints. Under it, one line: `"{days} of {daysInMonth} days = {aed(amount)}"` for `'first'`, or `"{aed(amount)} added to the bill on {date}"` for `'second'`. When Paid changes away from Monthly, set `prorate` to `null`.
- [ ] **Step 3: The summary** (the panel that shows `plan()`'s first payment and total) says "Paid at move-in" or "With the 2nd month" when it applies.
- [ ] **Step 4: `BookingCard`'s terms** add `· prorated` when `b.prorate` is set.
- [ ] **Step 5: Verify:** `npm run build` passes. Then run the app locally (`npm run dev` / the `run` skill), make a lease starting 17 Oct with $1,100, and check that the form shows `15 of 31 days = USD 532.26` and the Payments page lists 17 Oct $532.26, then 1 Nov $1,100. Repeat with "added to 2nd month": 1 Nov $1,632.26.
- [ ] **Step 6: Commit.** `git commit -m "feat: Leasing: the lease form chooses how the first month is charged"`

## Out of scope (say so to Francis at the end)

- Riley (chat) and the 3D-view quick lease do not send `prorate`, so leases they make work as today (no proration).
- Daily / per-night bookings: a separate topic.
