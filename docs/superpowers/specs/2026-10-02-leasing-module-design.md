# Leasing module — design plan

Date: 2026-10-02
Status: draft, for review (nothing built yet)
Saifsys: not used. This module keeps its own data.

## 1. The problem

The company (or several companies) owns buildings, and each building has many units.
Units are rented for 1, 2 or 6 months, or leased for a year or more. Today this is
tracked separately and by hand, which causes three problems:

1. **Creating a booking** is slow, and nothing stops a unit from being booked twice.
2. **Follow-up** is hard because rent comes in every month. Missed or late payments are
   noticed late, or not at all. **Automatic alerts matter most.**
3. **Reports** (who paid, who owes, what is empty) take a lot of manual work.

## 2. What success looks like

- Staff can book a free unit in under 2 minutes. Overlapping bookings for the same unit
  are impossible.
- Every rent payment due is known to the system the day the booking is made.
- The responsible person's phone buzzes before a payment is due, on the day, and every
  few days while it is overdue, until someone marks it paid.
- The boss can open one screen and see, per company or building: occupancy, rent
  collected vs. due this month, who is overdue, and which leases end soon.

## 3. Out of scope (for now)

- Online payment by tenants (card or payment link).
- A tenant-facing portal or app.
- Accounting (general ledger, VAT returns). We export to Excel for the accountant.
- Registering Ejari or Tawtheeq automatically. Staff do that on the government portal; we
  store the number and the file.
- Maintenance requests (Tenant care already covers the inbox).
- Any Saifsys link.

## 4. Key decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Short stays and yearly leases are **one thing: a Booking**, with a type (`short_term` / `lease`) | One form, one alert engine, one set of reports. The only differences are the contract and the alert wording. |
| D2 | When a booking is saved, the system **writes out the full payment schedule** (one row per installment) | Alerts and reports become simple questions: "which rows are due or unpaid?" |
| D3 | Payments are recorded **against an installment** and can be partial | Tenants often pay part now and the rest later. The amount still owed must be exact. |
| D4 | Payment methods: **cheque (including post-dated), bank transfer, cash, card** | UAE leases often use post-dated cheques. Cheques get their own status (held → deposited → cleared / bounced). |
| D5 | **Every booking has a contract document** | A short stay gets a generated booking agreement (PDF). A lease gets the Ejari/Tawtheeq number plus the uploaded signed contract. |
| D6 | Alerts use the **existing push and reminder machinery** (`push.js`, the minute timer in `reminders.js`, sent-once log like `reminders_sent`) | It is already proven in production, and staff already get notifications on their phones. |
| D7 | Access follows the **existing master role**. Other staff are assigned to companies or buildings and only see those. | Matches how Jarvis already handles permissions. |
| D8 | Money is stored in **fils (integer)**, currency AED | No rounding errors in reports. |

## 5. Data model

```
companies ─┬─ buildings ─┬─ units ─── bookings ─┬─ installments ─── payments
           │             │                      ├─ documents (contract, IDs, cheque scans)
           │             │                      └─ booking_events (history)
           └─ leasing_staff (who looks after which company/building)
tenants ───────────────────────────────┘
```

### companies
id, name, trade_license_no, trn (VAT no.), address, phone, email, logo_file, created_at

### buildings
id, company_id, name, emirate, area, address, plot_no, makani_no, notes

### units
id, building_id, unit_no, floor, type (`studio`, `1BR`, `2BR`, `shop`, `office`, `parking`…),
size_sqft, furnished (bool), dewa_premise_no (no rent on the unit: the price is decided
per booking, at the time of booking), status (`available` / `blocked` for maintenance). Whether a unit is
occupied is **not stored**. It is worked out from its bookings, so it can never go out of date.
Unique: (building_id, unit_no).

### tenants
id, kind (`person` / `company`), full_name, nationality, emirates_id_no, emirates_id_expiry,
passport_no, phone, whatsapp, email, company_trade_license (for company tenants), notes.
A tenant can have many bookings over time.

### bookings
| field | notes |
|------|-------|
| id, ref | ref is a readable code, e.g. `BK-2026-0142` |
| unit_id, tenant_id | |
| type | `short_term` (under 12 months) or `lease` (12 months or more). Suggested from the dates; staff can change it. |
| start_date, end_date | end date is exclusive in calculations and shown inclusive on screen |
| rent_amount, rent_period | e.g. 4,500 per `month`, or 60,000 per `year` |
| payment_frequency | `monthly`, `quarterly`, `every_4_months`, `every_6_months`, `yearly`, `upfront`, `custom` (cheques with their own dates) |
| security_deposit, deposit_status | `held` / `refunded` / `partly_refunded` / `kept` |
| other_charges | commission, admin fee, DEWA deposit, chiller… (each one is a one-off installment row) |
| status | `draft` → `confirmed` → `active` → `ended` / `cancelled` / `renewed` |
| contract_no | Ejari/Tawtheeq no. for leases, or the generated agreement no. for short stays |
| responsible_user_id | the staff member who gets the alerts |
| notes, created_by, created_at |

**Rule:** two bookings in `confirmed` / `active` cannot overlap on the same unit. The
database enforces this with an exclusion constraint on (unit_id, daterange), so the app
does not have to remember to check.

### installments (the payment schedule)
id, booking_id, seq, kind (`rent` / `deposit` / `fee`), due_date, amount, amount_paid,
status (`upcoming` / `due` / `partly_paid` / `paid` / `overdue` / `waived`), waived_reason.

How the schedule is made when a booking is confirmed:
- Rent: from start_date, one row each period up to end_date. If the last period is
  shorter, it is **pro-rated by days** (staff can override the amount).
- Deposit and one-off fees: one row each, due on start_date.
- `custom`: staff type in the cheque dates and amounts (this matches 4 or 12 post-dated cheques).
- If the dates, rent or frequency change on a confirmed booking, the schedule is rebuilt
  **only for unpaid future rows**. Paid rows never change.

### payments
id, installment_id, amount, method (`cheque` / `transfer` / `cash` / `card`), received_on,
reference (transfer ref), cheque_no, cheque_bank, cheque_date,
cheque_status (`held` / `deposited` / `cleared` / `bounced` / `replaced`), receipt_no,
recorded_by, notes.
- A payment counts toward `amount_paid` when it is received, **except a cheque, which only
  counts once it clears**. A bounced cheque puts the installment back to unpaid and sends
  an alert at once.
- Every payment can produce a receipt PDF on the company letterhead (we reuse the ACE
  receipt layout we already have).

### documents
id, owner (booking / tenant / unit), kind (`contract`, `emirates_id`, `passport`,
`trade_license`, `cheque_scan`, `other`), file, uploaded_by, uploaded_at. Uses the existing
file storage.

### booking_events
An activity log: created, confirmed, payment recorded, cheque bounced, renewed, cancelled,
note added. Who did it, and when. This answers "what happened with this tenant?"

### leasing_staff
user_id, company_id or building_id, role (`manager` / `staff` / `viewer`). The master sees everything.

## 6. Main flows

### 6.1 Create a booking
1. Choose company → building → **dates** → the list shows only the units free for those
   dates (with default rent filled in).
2. Choose or create a tenant. If a tenant with the same Emirates ID or phone already
   exists, the system says so.
3. Rent, frequency, deposit, fees. A preview of the payment schedule updates as you type.
4. Upload documents (ID, passport, cheque scans).
5. Save as **draft**, or **confirm**. Confirming locks the unit for those dates and creates the schedule.
6. Contract: for a short stay, generate the booking agreement PDF. For a lease, enter the
   Ejari/Tawtheeq no. and upload the signed contract. (A booking can be confirmed without
   the contract, but it then appears on the "missing contract" list and creates an alert.)

### 6.2 Record a payment
From the booking, or from the overdue list, staff tap an installment, then **Record
payment**, then choose the method and amount, then save. A receipt is offered. For cheques,
recording when the cheque is deposited, clears or bounces is one tap each.

### 6.3 End, renew or cancel
- **Renew:** copies the booking with new dates and rent. The old booking becomes `renewed` and the new one is linked to it.
- **End:** check-out date, deposit settlement (refund, deductions with reasons), final status.
- **Cancel:** reason required. Unpaid future installments are marked `waived` and the unit is free again.

### 6.4 Every day
At 08:00 UAE time a job moves installments from `upcoming` to `due` to `overdue` and
bookings from `confirmed` to `active` to `ended`, then sends the alerts below.

## 7. Alerts (the most important part)

Each alert is a phone push to the booking's responsible person. It also appears in their
alerts list inside Jarvis. Each alert is sent **once per (rule, installment, date)**, using
the same sent-once log idea as `reminders_sent`, so a server restart never repeats them.

| Rule | When | Who |
|------|------|-----|
| Payment coming up | 3 days before due date | responsible |
| Payment due today | on the due date, 09:00 | responsible |
| Overdue | 1, 3 and 7 days after, then every 7 days until paid or waived | responsible. From 7 days, the building's manager too. |
| Cheque to deposit | on the cheque date for a `held` cheque | responsible |
| Cheque bounced | immediately when marked | responsible + manager |
| Lease ending | 90, 60 and 30 days before end_date (short stays: 14 and 3 days) | responsible |
| Missing contract | 3 days after confirmation if there is no contract no./file | responsible |
| Emirates ID expiring | 30 days before expiry, for active tenants | responsible |
| Daily summary | 08:30: "Today: 4 due (AED 18,500), 3 overdue (AED 12,000)" | managers + master |

Settings (master only): the day offsets above, quiet hours (no push 22:00–08:00; anything
due then waits until morning), and on/off per rule.

**Phase 4 (optional): reminders to the tenant.** WhatsApp or email to the tenant 3 days
before the due date and when overdue, using a template the boss approves. Off by default,
because the wording toward tenants is a business decision.

## 8. Contracts

| Booking | What we keep |
|---------|--------------|
| Short stay (1–11 months) | A **booking agreement** generated by the system (PDF, bilingual EN/AR if needed): parties, unit, dates, rent and schedule, deposit, house rules, signature lines. It is signed on paper, and the scan is uploaded. |
| Lease (12 months+) | The **Ejari (Dubai) / Tawtheeq (Abu Dhabi)** number, plus the uploaded signed tenancy contract. |

The agreement wording must be checked by the company's lawyer or PRO before first use.
Furnished short stays may also come under DTCM holiday-home rules. **The business needs to confirm this.**

## 9. Reports

Every report can be filtered by company, building, date range and staff member, and
exported to Excel and PDF.

1. **Dashboard (home):** occupancy %, units vacant today, rent due this month vs.
   collected, overdue total, leases ending in 60 days, missing contracts.
2. **Rent roll:** every unit, tenant, rent, frequency, contract dates and status.
3. **Overdue / aging:** amount owed per tenant, grouped 0–30 / 31–60 / 61–90 / 90+ days.
4. **Collections:** payments received in a period, by method, by building. Cheques held for deposit.
5. **Expiring leases:** the next 30/60/90 days, with renewal status.
6. **Vacancy:** vacant units and the number of days each has been vacant.
7. **Tenant statement:** one tenant's installments and payments, printable to send to them.

## 10. Reem (the AI) on top

Read-only tools, used only after the data screens work:
- "Who is overdue in Building X?" / "How much did we collect in September?"
- "Is unit 304 free from 1 Nov to 31 Dec?"
- "Draft a polite reminder to the tenant of 1204." This produces a draft only; a person sends it.

Reem never records payments or changes bookings. People do that on the screens.

## 11. Screens

1. **Leasing home:** dashboard tiles + today's alerts.
2. **Properties:** companies → buildings → units (grid by floor, coloured by status: vacant / occupied / ending soon / overdue).
3. **Bookings:** list with filters, plus the **New booking** wizard (6.1).
4. **Booking page:** details, schedule with paid/unpaid, payments, documents, history, actions.
5. **Tenants:** list and profile (all their bookings, total owed).
6. **Payments:** due today, overdue, cheques to deposit (where staff spend their day).
7. **Reports.**
8. **Settings:** staff assignments, alert rules, agreement template, receipt numbering.

These must be usable on a phone. The people chasing payments are not at a desk.

## 12. Build phases

Each phase is usable on its own and is approved before the next one starts. The
property structure (company → building → unit) is built and filled with real data
**before** any leasing work. Bookings, payments and alerts all hang off units, so the
units have to be right first.

| Phase | Delivers | Done when |
|-------|----------|-----------|
| **1a. Company registration** | companies (details, logo, trade licence + TRN, documents), master-only create/edit, list + profile page | every company of the group is registered with its documents |
| **1b. Buildings** | buildings under a company (emirate, area, plot/Makani, documents), staff assignment per company/building | every real building is entered under the right company, and staff only see theirs |
| **1c. Units** | units under a building (no., floor, type, size, furnished, default rents, DEWA no., blocked/available), floor grid view, Excel import for units | all units of every building are in, and none is duplicated |
| **1d. Tenants & bookings** | tenants, bookings with the no-overlap rule, booking documents | staff can enter current tenants, and double-booking is impossible |
| **2. Schedule & payments** | installment generation, record payments, cheque statuses, receipts, booking agreement PDF | every current tenant's schedule matches what the office expects |
| **3. Alerts** | daily job, all alert rules, push + in-app list, daily summary, settings | one full week with alerts arriving correctly and no duplicates |
| **4. Reports** | dashboard + the 7 reports + Excel/PDF export | the boss can get the monthly numbers without asking anyone |
| **5. Reem + tenant reminders** (optional) | read-only Reem tools; WhatsApp/email reminders to tenants | after the boss approves the wording |

**Data migration (alongside phase 1–2):** an Excel import template for buildings, units,
tenants and current bookings, plus payments already received. This brings the existing
records in on day one instead of retyping them.

## 13. Testing

- Unit tests for the parts most likely to break: schedule generation (monthly, yearly,
  custom cheques, pro-rated last month, mid-booking changes), overlap rule, status
  changes, alert rules with sent-once behaviour, cheque bounce bringing a debt back.
- Run in the dev copy (`/root/jarvis-dev`) with test data. Never against production.
- Before go-live: enter one real building in parallel with the current method for one
  month and compare the numbers.

## 14. Risks

| Risk | Mitigation |
|------|-----------|
| Alerts depend on the server timer staying alive | the dashboard and lists still show what is due/overdue, so alerts are a convenience on top, not the only signal |
| Bad imported data gives wrong alerts on day one | import shows a preview + errors. Alerts start the day **after** import is approved. |
| Staff stop recording payments, so everyone looks overdue | overdue list is the daily working screen, and the manager sees unrecorded-looking cases after 7 days |
| Contract wording is legally wrong | lawyer/PRO approves the template before use |

## 15. Open questions for the business

1. How do tenants usually pay: post-dated cheques, monthly transfer/cash, or a mix? (The design supports all of these. The answer sets which screen we polish first.)
2. Which emirates are the buildings in (Ejari vs. Tawtheeq)?
3. Who should get alerts: one person per building, or per booking?
4. Is VAT charged on any units (commercial units, short stays)? If so, receipts need TRN and VAT lines.
5. Should tenants ever get automatic reminders, or only staff?
6. Where are the current records today (Excel, paper, another system)? This tells us what the import needs.
