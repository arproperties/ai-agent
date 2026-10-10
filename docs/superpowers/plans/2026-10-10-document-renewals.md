# Document Renewals Implementation Plan

**Goal:** From a due document, Riley finds who to ask, drafts the quote requests, reads the replies, compares the offers and recommends one. A person approves every email.

**Architecture:** One new server module, `server/renewals.js`, holds the renewal case and every step. Each step that needs a model, the web or the inbox takes it as an argument, so tests run on stubs. Outgoing mail is only ever an `email_drafts` row in `pending`; the existing approval route and outbox send it. One new client page, `Renewal.jsx`, shows the five stages.

**Tech stack:** Node 22 ESM, Express 5, Postgres, `node:test`, `@anthropic-ai/sdk` (the `claude` client in `server/ai.js`, with the web search tool as `server/chat.js` uses it), `imapflow` through `server/imap.js`, React + Vite + Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-10-document-renewals-design.md`

This plan was written for inline execution by its author, at the owner's instruction to finish Part 2 unattended. It fixes the interfaces and the tests; the code is written test-first against them.

## Global constraints

- Branch `leasing-bookings`. Never `main`. No push, no deploy.
- **No code path sends an email.** The only thing this feature writes towards sending is a `pending` draft. Tests assert it.
- A supplier's email must be confirmed by a person before anything is drafted to it.
- Reading the inbox is read-only (`recentInbox`, `emailParts`).
- Everything under `/api/properties/renewals` is master-only.
- AI output is parsed defensively: unknown keys dropped, bad dates dropped, and a failed call degrades to "not read", never to an error that blocks the person.
- Never a browser `<select>`; dates through `DateField` / `usDate`.
- Tests: `TEST_DATABASE_URL` → a `_test` database; `npm test -- tests/renewals.test.js`.

## Data (`server/db.js`)

- `prop_suppliers`: `id, name (unique, case-blind), email, phone, website, kind, found_by, email_confirmed, notes, about (JSON), created_at`
- `prop_renewals`: `id, document_id → prop_documents (cascade), status (open | decided | renewed | not_renewing | cancelled), opened_by, chosen_quote_id, compared (JSON), closing (JSON), created_at, closed_at`
- `prop_renewal_requests`: one per supplier on a renewal: `id, renewal_id, supplier_id, draft_id → email_drafts (set null), subject, body, manual_sent_at, chaser_draft_id, chased_at, seen (JSON list of email ids), reply_kind, reply_note, replied_at`; unique `(renewal_id, supplier_id)`
- `prop_renewal_quotes`: `id, renewal_id, supplier_id, premium, sum_insured, deductible, cover, exclusions, valid_until, note, source (email | upload), email_id, file_path, file_name, file_mime, created_at`

A request's state is worked out, not stored: `listed` (no draft) → `drafted` (draft pending) → `sending` → `sent` (draft sent, or marked sent by hand) → `replied`; a rejected, failed or deleted draft returns it to `listed`.

## Interfaces (`server/renewals.js`)

Every function's last argument is `deps`, defaulting to the real thing: `{ think, search, account, inbox, parts, push }`.

- `startRenewal(documentId, by) → view` — idempotent per document name and owner; lists the current insurer from the document's details.
- `getRenewal(id) → view`; `listRenewals() → rows`; `openByDocument() → Map(document_id → { id, asked, quotes })`; `notRenewing() → Set(document_id)`
- `findSuppliers(id, deps) → { known, found }` — saves nothing.
- `addSuppliers(id, list) → view`; `removeSupplier(id, supplierId) → view`; `listSuppliers()`, `updateSupplier(sid, body)`, `removeSupplierForGood(sid)`
- `draftRequests(id, supplierIds, by, deps) → view` — one pending draft each, the policy attached; with no mailbox that can send, the text is kept on the request for copying.
- `editRequest(id, requestId, { subject, body }, by) → view`; `markSent(id, requestId) → view`
- `checkReplies(id, deps) → { quotes, questions }`; `readReply({ text, files }, deps) → { kind, … }`; `addQuote(id, supplierId, file, deps) → view`; `removeQuote(id, quoteId) → view`
- `chase(id, by, deps) → view` — a follow-up draft for each request sent five or more days ago with no reply, once.
- `lookUp(supplierId, deps) → supplier`; `compare(id, deps) → view`
- `decide(id, quoteId, by, deps) → view`; `closeRenewal(id, status) → view`
- `runRenewals(deps)` and `startRenewals()` — the timer: check replies, tell the opener and the master of a new quote, flag and chase the silent.
- `renewalRoutes` (Express router).

## Tasks

Each is test-first in `tests/renewals.test.js`, then committed.

1. **The case and its suppliers.** Tables; `startRenewal`, `getRenewal`, `findSuppliers`, `addSuppliers`, `removeSupplier`, `closeRenewal`; a renewal becomes `renewed` once a newer copy of its document is filed; alerts skip a `not_renewing` document and carry the renewal's progress and id.
   Tests: one open renewal per document; the current insurer is listed unconfirmed; a search result is not saved until added; adding with an email confirms it; not renewing silences the alert; filing the renewed copy closes the case.
2. **Requests.** `draftRequests`, `editRequest`, `markSent`, `chase`; `store()` split out of `draftFiles.gather`.
   Tests: an unconfirmed address is refused; one pending draft per supplier with the policy attached; the current insurer is asked for renewal terms; a model failure falls back to plain wording; no sendable mailbox keeps the text for copying; a rejected draft frees the request; a chaser only after five days, once; **every draft is `pending`**.
3. **Replies and quotes.** `emailParts` in `imap.js`; `readReply`, `checkReplies`, `addQuote`, `removeQuote`, `runRenewals`.
   Tests: a reply is matched by sender address after the send time and read once; a quote is recorded with its file; a question is kept as a question; unreadable replies are still shown as received; an uploaded quote is read the same way; the timer tells of a new quote once.
4. **Comparison and decision.** `lookUp`, `compare`, `decide`.
   Tests: the table holds the current policy and each offer; verdicts and the recommendation come from the model and survive its failure as "not compared"; a supplier is looked up once; deciding drafts the acceptance and the thank-yous, all `pending`.
5. **Routes and Riley's tools.** `renewalRoutes` mounted before the properties routes; four tools in `leasingKit.js`: `renewal_status`, `renewal_start`, `renewal_check_replies`, `renewal_compare`.
   Tests: non-masters are refused by the router; the tools return text and send nothing.
6. **The screens.** `Renewal.jsx` (five stages); "Start renewal" / "Open renewal" on the document sheet and the alert; `npm run build`.
7. **Whole-branch review**, one fix pass, full suite.
