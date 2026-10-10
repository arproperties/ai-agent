# Document renewals with Riley — design (Part 2 of 2)

Date: 2026-10-10
Status: draft, for review (nothing built yet)
Branch: `leasing-bookings`
Builds on: `2026-10-10-documents-register-design.md` (Part 1, built)

## 1. The problem

Part 1 tells the business that a policy is due. It does not help renew it. The person
renewing does not know the insurance market, has no list of insurers to ask, and would
have to write to several companies, wait, read each reply and compare offers that are
laid out differently. So renewals get left to the last week, or simply rolled over with
the same insurer at whatever price is asked.

## 2. What success looks like

- From a due document, one tap starts its renewal.
- Riley finds who to ask, writes the request to each, reads what comes back and lays the
  offers side by side against the current policy, with a recommendation and her reasons.
- The person types almost nothing. They tick, confirm and approve.
- **No email leaves without a person seeing it and pressing send.**
- Choosing an offer and filing the new policy closes the renewal and the alert.

## 3. Out of scope

- Sending anything automatically, including chasers.
- Paying a premium, or accepting an offer on an insurer's website.
- Renewals for `remind` documents (licences, certificates): they keep Part 1's alerts.
- A verdict on whether an insurer can be trusted. Riley shows what she found and where.
- WhatsApp. A quote that arrives there is uploaded by hand.

## 4. Key decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **A renewal is a case** attached to one document, with stages, not a fixed form. | The route changes: a quote may come by email, by upload, or never. Asked for by the business 2026-10-10. |
| D2 | **Riley prepares, a person sends.** Every outgoing email is a draft in the existing approval flow (`email_drafts`, Approve / Reject). | Decided by the business 2026-10-10. The emails go out in the company's name. The flow is already built and tested. |
| D3 | **The current insurer is always on the list.** Riley knows it from the policy. | The cheapest quote to get, and the baseline every other offer is judged against. |
| D4 | **Other suppliers are suggested from a web search, and each email address is confirmed by a person once** before anything is drafted to it. | A search finds the company reliably, and its email address unreliably. |
| D5 | **Suppliers are kept**, so next year starts from the list. | The work of finding and confirming them is done once. |
| D6 | **Reading the inbox is automatic; nothing else is.** Riley looks for replies from the suppliers she wrote to, and reads their attachments. | Reading changes nothing and sends nothing. Waiting for a person to press "check" would stall every renewal. |
| D7 | **What Riley reads from a quote is shown, not typed**, and is marked as hers until a person confirms the comparison. | The same rule as Part 1: the AI fills, the person checks. |
| D8 | **"Trust" is evidence with its sources**, never a score: is the insurer licensed here, its published rating, how long it has traded. | A made-up score would be believed. Sources can be checked. |
| D9 | Emails go from the **mailbox of the person who started the renewal**. With no mailbox that can send, Riley still writes the request and offers it to copy or open in their own mail. | The app sends only through a person's connected mailbox. The same fallback tenant reminders use. |
| D10 | Only the **master** starts, changes or decides a renewal. | It commits the company to a supplier. |

## 5. The stages

A renewal moves through these. Any stage can be returned to.

1. **Suppliers.** The current insurer is listed. "Find more" has Riley search for
   insurers and brokers that cover this kind of policy where the building is, and show
   each with its website, what it does, and the address she found. The person ticks the
   ones to ask and confirms or corrects each email address. Suppliers used before are
   offered first.
2. **Requests.** Riley writes one request per ticked supplier from what is on file: the
   kind of cover, the property and its address, the sum insured, the current expiry, and
   when a reply is needed. The current policy schedule is attached. Each is a draft the
   person reads, can edit, and approves. Approved drafts go out through the existing
   outbox. A request to the current insurer asks for renewal terms.
3. **Quotes.** As replies come in, Riley matches each to its supplier, reads the
   attachment and records the offer: premium, sum insured, deductible, what is covered,
   notable exclusions, and how long the offer stands. A reply that is a question, not a
   quote, is shown as one, with a suggested answer as a draft. A supplier that has not
   answered after five days is flagged, with a follow-up drafted and waiting. A quote
   received another way is uploaded and read the same way.
4. **Comparison.** The offers beside the current policy, one row per figure, with what is
   better and worse in each marked. Under it, Riley's recommendation in a few sentences:
   which she would take, why, and what she is unsure of. Beside each supplier, what she
   found about it (D8), with links.
5. **Decision.** The person picks an offer. Riley drafts the acceptance to that supplier
   and a short thank-you to the others, each for approval. When the new policy document
   arrives it is filed as the renewed copy (Part 1's "Add a renewal", read by the AI),
   which closes the renewal and the alert. A renewal can also be closed as "not renewing",
   which stops the document's alerts.

## 6. Data

Four new tables in `server/db.js`.

- `prop_suppliers` — a company that can be asked: `name`, `email`, `phone`, `website`,
  `kind` (insurer, broker, contractor), `region`, `found_by` (`policy`, `search`,
  `person`), `email_confirmed` (boolean), `notes`, `about` (JSON: what Riley found, with
  sources and the date).
- `prop_renewals` — one case: `document_id` (the copy being renewed), `stage`, `status`
  (`open`, `decided`, `renewed`, `not_renewing`, `cancelled`), `opened_by`, `chosen_quote_id`,
  `recommendation` (text), `created_at`, `closed_at`. At most one open case per document
  name and owner.
- `prop_renewal_requests` — one per supplier asked: `renewal_id`, `supplier_id`,
  `draft_id` (the email draft), `sent_at`, `message_id`, `chased_at`, `state`
  (`drafted`, `sent`, `replied`, `declined`, `no_reply`).
- `prop_renewal_quotes` — one offer: `renewal_id`, `supplier_id`, `premium`,
  `sum_insured`, `deductible`, `cover`, `exclusions`, `valid_until`, `source`
  (`email`, `upload`), `email_id`, the stored file, `read_by_ai` (boolean), `confirmed`
  (boolean).

Part 1's `not renewing` gap is closed here: a document whose latest renewal is
`not_renewing` raises no alert.

## 7. Server

A new module, `server/renewals.js`, with its routes under `/api/properties/renewals`.
Each AI step is its own function taking the model client as an argument, so tests use a
stub (as `documentReader.js` does).

- `startRenewal(documentId, by)` — opens the case and lists the current insurer.
- `findSuppliers(renewalId)` — one model call with web search; returns candidates. Saves
  nothing until a person ticks them.
- `draftRequests(renewalId, supplierIds, by)` — writes the requests and creates the drafts
  through `createDraft()`. Refuses a supplier whose email is not confirmed.
- `checkReplies(renewalId)` — searches the opener's mailbox for mail from each supplier's
  address since the request was sent, and reads attachments through `attachmentText()`.
  Run on a timer for open renewals, and on demand.
- `readQuote(file | email)` — the offer as fields. Nothing guessed; what is not in the
  document is left empty.
- `compare(renewalId)` — the table and the recommendation.
- `decide(renewalId, quoteId, by)` and `close(renewalId, status, by)`.

Riley gets matching tools in `server/leasingKit.js`, so the same steps can be asked for
in chat ("start the renewal for Tower's fire insurance", "have the quotes come in?"). The
tools call the functions above; they add no second path, and none of them sends.

## 8. Alerts

Two additions to the existing rule set, both to the person who opened the renewal and
the master:

- **A quote has arrived** — the day it is read.
- **A supplier has not replied** — five days after its request went, once.

The Part 1 document alert carries the renewal's stage in its detail line
("3 asked · 1 quote in").

## 9. Screens

- **Start renewal** on a due `quotes` document: on its alert, its row in the register and
  its sheet.
- **The renewal page:** the five stages as steps across the top, the current one open.
  Everything Riley produced is shown read-only with a "Riley" mark; the person's actions
  are ticks, an email address to confirm, Approve on a draft, and the choice of offer.
- **Suppliers** under Properties: the kept list, to correct or remove.

## 10. Errors

- No mailbox that can send: requests are written and offered to copy (D9); replies are
  then uploaded by hand.
- The search finds nothing, or fails: the stage says so and the person can add a supplier
  themselves.
- A reply that cannot be read: shown as received, with its file, for the person to open.
- Two replies from one supplier: the later quote replaces the earlier in the comparison;
  both are kept.
- A draft rejected: the request returns to "not asked" and can be drafted again.

## 11. Tests

- The case: one open renewal per document; stages; closing as renewed and as not
  renewing; the alert stops for `not_renewing`.
- Suppliers: a candidate is not saved until ticked; an unconfirmed address cannot be
  drafted to; the current insurer comes from the document's details.
- Requests: one draft per supplier, pending, never sent by the code under test; a
  rejected draft frees the request.
- Replies: matched by sender address and date; a quote read from a stubbed model; a
  non-quote reply kept as a question; no reply after five days flagged once.
- Comparison and decision: the table against the current policy; choosing drafts the
  acceptance and the thank-yous, all pending.
- Nothing in any test path sends an email.

## 12. Build order

Three steps, each usable when it lands:

1. The case, suppliers and requests (stages 1–2).
2. Replies and quotes (stage 3), with the two alerts.
3. Comparison, decision and Riley's chat tools (stages 4–5).
