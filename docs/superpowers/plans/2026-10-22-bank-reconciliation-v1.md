# Reconciliation, version 1 (simple) — plan

Status: plan only, not started. Lease app (leasing-bookings, USA server).
Background page (how bank reconciliation works, clickable example):
https://claude.ai/artifact/6eZ6YFvpw4b8DdEn2Ydpft

## Settled with Francis on 2026-10-22

- The boss's own buildings only. No rent collected for other owners, so no trust account
  and no three-way reconciliation.
- **No expenses in version 1.** Francis asked to be reminded about expenses after
  reconciliation is done.
- The company uses two outside programs: **Zego** (gozego.com, online rent collection)
  and **QuickBooks**. For reconciliation, Francis will send the **report from Zego**.
  So version 1 reconciles the lease app against Zego, not against the bank statement.

## Why Zego changes the plan

Zego collects tenants' rent (ACH, card) and pays it into the bank in batches. Its report
lists each tenant payment, and which batch (deposit) it went in. That means:

- The grouping step ("Make a deposit") is already done by Zego for online payments. We
  read it from the report instead of asking staff to do it.
- The question version 1 answers becomes: **does every payment Zego collected appear in
  the lease app, with the right tenant, amount and date, and nothing extra?**
- The bank side (does Zego's batch reach the bank?) is something QuickBooks can already
  reconcile. We do not rebuild it in version 1.

## How it works for staff

1. Each month (or week), download the payments report from Zego and upload it in
   **Accounts → Reconcile**, choosing the period.
2. The app reads each line (tenant, unit, amount, date, Zego reference, batch) and pairs
   it with a lease payment: same tenant or unit, same amount, date within 5 days.
3. Every line ends in one of these states:
   - **Matched** — nothing to do.
   - **In Zego, not in the app** — a payment nobody recorded. One click records it on the
     right lease from the Zego line (reference filled in), after a staff member checks it.
   - **In the app, not in Zego** — usually cash, money order or a payment made outside
     Zego: staff confirm "paid outside Zego". Otherwise it is a mistake to fix.
   - **Amount differs** — shown side by side; staff fix whichever is wrong.
   - **Returned / reversed in Zego** (bounced ACH, chargeback) — the app payment is
     marked returned and the rent shows as owed again.
4. When every line is settled, press **Finish**. The period locks. Reopening is master
   only and shows in the Activity log.

## The Accounts module

New menu place `{ key: 'accounts', label: 'Accounts' }` in `server/modules.js`, own tick
on People profiles. Version 1 tabs:

| Tab | What it shows |
|---|---|
| Reconcile | Upload a Zego report, review lines, settle, finish |
| History | Every finished period, its uploaded report and a summary PDF |

(Bank accounts, Deposits and Expenses tabs come later, if needed.)

## Data (new tables, picked up by the Activity log automatically)

- `zego_reports` — id, period_from, period_to, file, uploaded_by, status (`open` |
  `finished`), finished_by, finished_at.
- `zego_lines` — id, report_id, date, tenant, unit, amount, zego_reference, batch,
  kind (payment | return | fee), fingerprint (so a line is never counted twice across
  overlapping reports), matched payment_id, state, note.
- `lease_payments` gets `zego_reference` and `returned_on`.

## Build order

1. **Read the Zego report.** Needs a real sample file first (see questions). Parser plus
   tests built from that sample.
2. **Accounts module, Reconcile tab: upload and auto-match.**
3. **Settle the leftovers:** record missing payment, paid outside Zego, fix amount,
   returned payment.
4. **Finish and lock, History tab, summary PDF.**
5. **Riley:** "is September reconciled?", "which Zego payments are not in the app?".

## Questions before building

1. **A sample Zego report** for one recent month, exactly as downloaded (CSV, Excel or
   PDF). Everything depends on its columns.
2. Does the Zego report show the unit or a Zego account number for each tenant? (Decides
   how lines are tied to leases.)
3. Do some tenants still pay outside Zego (cash, money order, check)?
4. Is QuickBooks already used to reconcile the bank each month? If yes, version 1 stops
   at Zego; if no, a bank-statement step can come later.

## After this: expenses (reminder)

Francis asked to be reminded about expenses once reconciliation is done. Bring it up
then; check how QuickBooks is used for bills before planning anything.
