# Lease renewals by Reem: design

Date: 2026-10-14 · Status: approved in chat (Francis, for the boss)

## Goal

Replace the staff-driven saifsys renewal process with Reem. Every word between the
landlord and the tenant goes by email, from the first notice to the confirmation.
No staff are in the loop. A person is involved only for:

- the DLD rental index check: one screenshot per renewal, which the boss already does;
- decisions outside the boss's rules;
- collecting the original cheques and registering Ejari after the renewal.

The master ticks the **Lease renewals** module for whoever should get these.

## Decisions (from the chat)

| Topic | Decision |
|---|---|
| When to start | 120 days before the lease ends |
| DLD index | No API: the paid one is AED 31,500/yr, and the free calculator has a reCAPTCHA we will not bypass. Per renewal, the person checks the DLD calculator and uploads a screenshot. Reem reads it and shows the figures read-only, and one tap sends the notice. |
| Negotiation | Reem decides within the boss's floor. It accepts at or above the floor and counters below it, at most 2 rounds, splitting the difference. Anything else goes to the boss. |
| Closing | The tenant sends back the signed renewal agreement and photos of the cheques. Reem checks the signature and that the cheque count, amounts, dates and payee match. |
| saifsys | Only over its Jarvis HTTP API, kept small: one read for leases due, one read for a quote, one write (`renew`) at the end. The write runs saifsys's own initiate and convert code, so accounting is unchanged. |
| Mailbox | The Tenant care inbox (already connected) sends and receives renewal emails. |

## Flow

1. **Open (daily, about 08:00 Dubai).** `realestate/renewals_due?days=120` lists active
   leases ending within 120 days that have no open saifsys renewal workflow. Reem opens one
   case per lease (unique on lease id and end date) in state `dld_needed`, and buzzes the
   module holders: "DLD check needed for N leases".
2. **DLD.** On the Lease renewals screen, the case shows the building, unit, type, rent and
   end date, with a link to the DLD calculator. The person uploads a screenshot. Reem reads
   the allowed increase and the average rent, and shows what it read next to the offer it
   will make. Two buttons: **Send notice**, or upload again.
   - Offer = current rent × (1 + allowed %).
   - If the notice would go fewer than 90 days before the end, the law allows no increase:
     the offer is the current rent, and the card says why.
3. **Notice (email + PDF).** Sets out the new rent, the period, the number of cheques, the
   renewal charges (from saifsys's quote for that rent), a reply-by date, and "Reply to this
   email to accept, or tell us what you would like to propose." State: `notice_sent`.
4. **Replies.** The Tenant care poller passes every email that answers a case (In-Reply-To
   or References match one of our message ids, or the sender is the tenant of an open case)
   to renewals, not to its own building/unit asking. Reem fetches the full email with
   attachments and reads it with Claude for the case's state:
   - `accept` → agreed at the current offer.
   - `counter N`, N ≥ floor → agreed at N.
   - `counter N`, N < floor:
     - rounds left → offer max(floor, midpoint rounded up to 500), round + 1;
     - no rounds left → the boss decides.
   - `reject` → polite confirmation of non-renewal and the move-out terms. State
     `not_renewing`; boss told.
   - `question` → answered only from the case's own facts; anything else goes to the boss.
   - `unclear` → the boss decides.
5. **Agreed.** Reem emails the renewal agreement PDF (parties, unit, period, rent, cheque
   schedule, charges, the building's terms, signature lines) and asks for it signed, plus
   photos of the cheques and the documents saifsys lists for the building. State `agreed`.
6. **Checking.** Each later email's images and PDFs are read with Claude:
   - Is there a signed agreement?
   - The cheques: amount, date and payee of each.
   - Results add up across emails.
   - Problems → an email listing exactly what to fix.
   - All good → `converting`.
7. **Renew in saifsys.** `act realestate_renewal/renew` creates the saifsys workflow at the
   agreed rent, marks it accepted with the negotiation summary, and converts it. saifsys
   builds the new lease, installments and invoices as today, and does not carry over the
   old Ejari number. State `renewed`. Reem emails the tenant a confirmation, and each module
   holder gets a to-do: "Collect the original cheques and register Ejari for {unit}".
   (As built: the to-do goes to the person who acts in saifsys, the master who saved the
   settings, not to every module holder, so it is not ticked twice.)
8. **Silence.**
   - Reminders 7 and 14 days after our last email.
   - If there is still no reply by 60 days before the end → `no_reply`, boss told.
   - In `agreed`, the same reminders ask for the missing items.

## Built differently from the plan above (2026-10-14)

- **Short leases are left out.** A lease shorter than 300 days (a monthly let) gets no
  case: 9 of the 42 leases due in the local copy were monthly.
- **Matching by sender.** An email matched only by its sender (not on the thread) and read
  as `unclear` is left alone, not sent to the boss: a tenant writing about a leak is not
  answering the renewal. The email stays in the inbox for the staff.
- **Papers sent again.** A cheque sent again for the same amount and date replaces the
  earlier one, so a corrected payee clears the problem.
- **Short-notice rule.** The 90-day rule is checked again at the moment the notice is sent,
  not only when the screenshot is read.

## The boss's rules (Lease renewals → Settings, master only)

- **Floor:** lowest acceptable rent as % over current rent. Default 0, meaning never below
  the current rent. A different % per building can be set.
- **Counter rounds:** default 2.
- **Payee name on cheques:** the landlord company name.
- **Act in saifsys as:** the master who saves the settings. Their connected email must be on
  a saifsys user, the same rule as ARS bookings.
- **Switched on:** off until the master switches it on. Nothing is emailed while it is off.

## Boss decisions (state `boss`)

The case shows the tenant's own words and what Reem suggests. The buttons:

- **Accept AED X** (the tenant's figure);
- **Offer AED Y** (typed);
- **Not renewing**.

Reem writes and sends the email for whichever is chosen.

## Pieces

**saifsys** (small):
- `modules/realestate/includes/renewal_service.php`: `re_renewal_quote`,
  `re_renewal_initiate` and `re_renewal_convert`, moved out of the two pages. The pages call
  them, so their behaviour does not change.
- `api/jarvis/v1/modules/realestate.php`: actions `renewals_due` and `renewal_quote`.
- `api/jarvis/v1/modules/realestate_renewal.php`: action `renew`, added to
  `JARVIS_ACT_MODULES`. It is idempotent per lease and refuses if staff already have an open
  workflow. It checks `expected_total` against its own figure, like ARS bookings.

**Reem:**
- `server/renewals.js`: tables, engine, emails and routes.
- `server/renewalAi.js`: Claude reading of replies, screenshots and attachments, behind one
  injectable function so tests need no API.
- `server/tenantCare.js`: one hook, so that renewal replies skip the building/unit asking.
- The `renewals` module in `server/modules.js`.
- `client/src/components/Renewals.jsx` and its menu row.

## Errors

- saifsys down → the case keeps its state and is retried on the next tick. The error shows
  on the case.
- Mail send failure → the case shows the error, and the next tick retries the same email
  (same Message-ID, so it is not duplicated).
- `renew` refused (e.g. staff started one, or the total changed) → state `boss` with
  saifsys's words.
- Nothing is guessed. Anything Reem cannot read with confidence goes to the boss.

## Tests (`tests/renewals.test.js`, injected mail, AI and saifsys)

- Opening cases is idempotent.
- Offer maths, including the 90-day rule.
- The floor and rounds logic.
- Reply routing by thread and by sender.
- Cheque checks.
- `renew` is called once, even on a double tick.
- Reminders and the 60-day `no_reply`.
- The module guard.

saifsys: `tests/renewal_service_test.php` (quote matches initiate; renew is idempotent),
rolled back.
