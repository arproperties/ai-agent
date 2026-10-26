# Case folders from the inbox (external users only) — design

Date: 2026-10-25 · Status: draft, awaiting Francis's approval

## Why

External users (today: jeff / legal.akhtar, a lawyer) get case correspondence by
email. They want one place per case on their Shelf, built from their inbox
without filing by hand, kept up to date as new mail arrives, and easy to send to
anyone.

## Who it is for

**External users only.** Reem staff and master see no change at all: no new
menus, no new chat tools, no new Shelf behaviour. Everything this feature makes
stays inside the external user's walled-off space (same wall as PR #3: master
does not see it either).

## How it works (Francis's words, tidied)

1. In chat the external user says something loose — "pull the information from
   my inbox", "pull case Soutex E - 205791", "update the Soutex case". A case
   number is optional.
2. The app finds the case email(s), reads the **first (oldest) email** of the
   case and works out the **case number** (e.g. `Soutex E - 205791`),
   **Party A** and **Party B**. The AI fills these; the user does not type them.
3. It collects **every email that mentions that case number, and no others**.
4. A **card** appears in chat before anything is saved:
   - proposed folder name, e.g. `Case - Soutex E - 205791 - Party A vs Party B`
     (editable on the card = rename before saving)
   - how many emails were found, and their date range
   - a question: **"Save all info as PDF into the Shelf?"** with choices:
     - ☑ One full case PDF (summary + all emails)
     - ☐ A separate PDF per email
   - Save / Cancel
5. On Save it creates the folder on the Shelf and puts the chosen PDFs in it.

## The full case PDF

One PDF per case:
- **Summary first** — the parties, case number, what has happened (short
  timeline), latest position, anything pending or awaiting reply.
- **Then every email in full**, oldest first (from, to, date, subject, body).
- It is **one file that gets replaced** when updated, not a new copy each time.
- Must handle Arabic text (see Constraints).

## Staying up to date

- When a new email mentioning a tracked case number arrives in the user's
  inbox, the app adds it to the case and **rewrites the summary PDF** (and adds a
  per-email PDF if that option was chosen). No card needed for updates.
- Asking in chat ("update the Soutex case", or days later "any new emails on
  Soutex?") does the same immediately.
- Re-pulling a case that already has a folder updates that folder; it never
  makes a duplicate.

## Folders and naming

- Real folders on the external user's Shelf (today's Shelf only has 12 fixed
  categories; this adds named folders for external users only).
- **Default name pattern:** `Case - [Case Number] - [Party A] vs [Party B]`.
- **The user can set their own pattern** in their settings, using the pieces
  case number, Party A, Party B, plus free text. New folders use it.
- **Rename** any folder at any time from the Shelf. Renaming does not stop
  updates (the case is tracked by its number, not its folder name).

## Sharing a case folder

Both ways, from a Share button on the folder:
- **By email** — sends the full case PDF as an attachment (to any address),
  from the user's connected mailbox.
- **By link** — a view-only page in the browser, no login needed, showing that
  folder's files and always the latest version. The user can turn a link off.

## Goals

- From a loose chat request to a saved, named case folder in one confirm.
- Exactly the right emails — all of that case, none of any other.
- The summary stays current without the user asking.

## Non-goals

- Anything for Reem staff or master.
- Joining up with the Legal cases module (closed to external users, one party
  only — kept separate on purpose).
- Editing or replying to emails from the case folder.

## Anti-goals (a failure even if it "works")

- An email from a different case ending up in the folder.
- A share link that exposes anything beyond that one folder.
- Any of this showing up for, or changing anything for, Reem staff or master.
- Testing against the real company mailbox — tests use stubs only.

## Constraints

- **Arabic PDFs:** the PDF maker refuses non-English text on `local/all`. The
  Arabic fix (commit `f7e6616`, branch `fix/arabic-pdf`) must come in first.
- **Mail search cap:** IMAP `searchEmail` (`server/imap.js:235`) returns at
  most 25 results; collecting a case needs an uncapped version. Outlook
  (`server/outlook.js:121`) must work too.
- **No new-mail watcher exists** for personal mailboxes; `server/mailRouting.js`
  (3-minute poll with `last_uid`) is the pattern to copy.
- **External fence:** new routes must be added to `EXTERNAL_OPEN`
  (`server/access.js`) and gated with `isExternal`.
- **Cards:** follow the existing proposal-card pattern (`server/inventory.js` +
  `InventoryCard.jsx`); the chat kit is given to external users only.
- Nothing deploys until Francis says so; Reem changes go branch → PR.

## Calls I made (Francis to check)

- If no case number is given and several cases are found in the inbox, one card
  per case (most recent first), each saved separately.
- Case number matching tolerates spacing/dash differences
  (`Soutex E - 205791`, `Soutex E-205791`, `SoutexE205791`).
- Email attachments are saved as their original files in the folder alongside
  the PDFs (not merged into the PDF).
- New-mail check every few minutes; updates are quiet (the folder shows "updated
  <time>, N new"), no phone push.
- Share links don't expire on their own; the user turns them off.
- Sharing by email sends the full case PDF only, not per-email PDFs.
- **Inbox and Sent both count**, so the user's own replies are in the case and
  the summary's "latest position" is right. The watcher checks both.
- **Matching = subject or body, but not text quoted from earlier emails.**
  The card lists the emails found and the user can untick any before saving,
  so a stray email never gets in silently.
- **No case number given:** the AI looks through the last 30 days of mail for
  case references and shows at most 5 cards.
- **Party A vs Party B:** in the order the first email writes them. If one is
  missing, the card says "Party B unknown" and the user fixes it by renaming.
- **Deleting the case folder stops tracking.** Deleting one file inside only
  removes that file; the next update rewrites the summary PDF but doesn't bring
  back deleted attachments. The folder also has a "Stop updating" switch.
- **Share by email** goes out from the user's connected mailbox. If that
  mailbox can't send (read-only Outlook), the app's normal outgoing mail is
  used, with the user's address as reply-to.
- **Branch:** new branch from `main`, with the Arabic fix (`fix/arabic-pdf`,
  PR #7) merged into it first; one PR. Tests use stub mailboxes only.

## Left to the builder

Table design, how folders sit beside the existing `documents.folder` field,
the share-link token scheme, poll interval, AI prompt wording, PDF layout.
