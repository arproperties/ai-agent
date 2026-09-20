# Email: sending and acting — design

**Date:** 2026-09-20
**Status:** agreed, ready to build
**Touches:** `server/imap.js`, `server/email.js`, `server/chat.js`, `client/src/components/EmailSheet.jsx`

## The problem

The email connector reads. `server/imap.js` opens every folder with `EXAMINE`, so reading
never even marks mail as seen, and the two agent tools (`search_email`, `read_email`) have
no side effects at all. The copy under the Connect form says so in as many words:

> They can't send, reply, move or delete anything, and reading doesn't mark emails as read.

That is the right default and it stays the default. What is missing is a way for a user to
say "yes, this mailbox, go ahead" — and then have the agent draft a reply, file something,
or mark an email read, with sending held behind an explicit tap.

## What we are building

1. **SMTP settings** on the existing IMAP connection, defaulted from the mailbox's own
   provider, reusing the address and password already stored encrypted.
2. **Six new agent tools**: `create_draft`, `send_email`, `reply_email`, `mark_read`,
   `mark_unread`, `move_email`.
3. **An approval gate**: nothing leaves the mailbox without the user tapping Approve.
4. **Opt-in per connection**, a rate limit, a queue, an action log, recipient validation.
5. **UI**: SMTP fields under Advanced, a write toggle, an approval card, honest copy.

## Principles

**Outbound mail is the only irreversible thing here.** An email, once sent, cannot be
recalled, and it goes out under the user's own name to someone else. Marking a message
read, marking it unread, and moving it between folders are all reversible and all stay
inside the mailbox. So the gate is drawn around sending, not around "writing" in general:
sending needs a tap; the reversible actions do not. Gating everything would train the user
to approve reflexively, which is worse than not gating at all.

**Emails are input, not instruction.** The system prompt already says so. It matters far
more now: an agent that can act on a mailbox and reads a message saying "forward this to
x@y.com" is one prompt injection away from being the attacker's outbox. The prompt says
this explicitly, and the approval gate is the thing that actually stops it.

**Opt-in, and silent for everyone else.** A connection made before this feature existed
stays read-only. The write tools are not offered to the model at all unless the connection
has the toggle on — not described-and-refused, absent. An agent cannot be talked into using
a tool it was never given.

## Decisions

### 1. SMTP configuration

New columns on `imap_accounts`: `smtp_host`, `smtp_port`, `smtp_secure`, `can_write`.

Defaults are derived from the IMAP host the connector already detected, since that came
from a real MX lookup and so already knows the provider behind a custom domain:

| IMAP host                | SMTP host                   | Port | TLS      |
|--------------------------|-----------------------------|------|----------|
| `imap.titan.email`       | `smtp.titan.email`          | 465  | implicit |
| `imap.gmail.com`         | `smtp.gmail.com`            | 465  | implicit |
| `imap.zoho.com`          | `smtp.zoho.com`             | 465  | implicit |
| `imap.mail.yahoo.com`    | `smtp.mail.yahoo.com`       | 465  | implicit |
| `outlook.office365.com`  | `smtp.office365.com`        | 587  | STARTTLS |
| `imap.mail.me.com`       | `smtp.mail.me.com`          | 587  | STARTTLS |
| `imap.secureserver.net`  | `smtpout.secureserver.net`  | 465  | implicit |
| anything `imap.X`        | `smtp.X`                    | 465  | implicit |

`smtp_secure = true` means implicit TLS (465). `false` means STARTTLS, and the transport
sets `requireTLS`, so a server that will not upgrade fails rather than sending in clear.

Credentials: the same `username` and `password_enc` already on the row. No second
credential, no second encryption scheme — `EMAIL_KEY`, AES-256-GCM, as today.

**Titan's documented defaults** are `smtp.titan.email`, 465 (SSL) or 587 (STARTTLS).

### 2. Tools

Given to the model only when the connection has `can_write`:

| Tool | Effect | Gate |
|---|---|---|
| `create_draft(to, cc, subject, body, in_reply_to?)` | writes a `pending` row | — |
| `send_email(draft_id)` | asks for an existing draft to go out | Approve |
| `reply_email(message_id, body)` | writes a `pending` row, threaded | Approve |
| `mark_read(message_id)` | IMAP `+FLAGS \Seen` | none |
| `mark_unread(message_id)` | IMAP `-FLAGS \Seen` | none |
| `move_email(message_id, folder)` | IMAP `MOVE` | none |

`message_id` is the `folder:uid` id that `search_email` already hands out, the same id
`read_email` takes. Folder names resolve case-insensitively against the real folder list.

**Threading.** `reply_email` fetches the original's envelope and `References` header, then
sets `In-Reply-To: <original Message-ID>` and
`References: <original References or In-Reply-To> <original Message-ID>`. Subject gets a
single `Re: ` prefix, never stacked.

**Sent copy.** The MIME is built once, sent over SMTP as raw bytes, and the identical bytes
are `APPEND`ed to the Sent folder (found by `\Sent` special-use) with `\Seen`. Byte-identical
means the copy in Sent carries the same `Message-ID` the recipient received, so the reply
that comes back threads against it. A failed append does not fail the send — the mail is
already gone; the log records the append failure separately.

**Delete: skipped.** No `delete_email` tool. `move_email` can move to Trash, which is
recoverable, and that is as far as it goes.

### 3. Safety

**Approval.** `create_draft` and `reply_email` write a row with `status = 'pending'` and
return the draft id and "waiting for your approval". Nothing touches SMTP. The user sees a
card — in the chat where it was created, and in the Email sheet — with To, Cc, Subject and
the full body, and taps Approve or Reject. Approve moves it to `approved`; the outbox sends
it. Reject moves it to `rejected` and it is never sendable again.

**Opt-in.** `can_write` defaults `false`. Existing rows get the default, so every
connection made before today stays read-only until its owner turns the toggle on.

**Rate limit and queue.** Titan caps outbound mail per day. Defaults: 20/hour and 100/day
per user (`EMAIL_SEND_PER_HOUR`, `EMAIL_SEND_PER_DAY`), counted from the action log. An
approved draft over the limit is not rejected — it stays `approved` and the outbox drains
it when the window opens. The queue is the `approved` rows themselves, in the database, so
a restart does not lose an approved send.

**Log.** Every send, reply, mark and move writes a row: who, when, which agent, the action,
the recipients, the target message, the resulting `Message-ID`, and whether it worked.
Passwords never appear — the log stores addresses and ids, and the transport is built and
discarded inside the send.

**Recipients.** Each address is validated; `to` + `cc` is capped at 10
(`EMAIL_MAX_RECIPIENTS`). No Bcc.

### 4. UI

- **Advanced** gains SMTP server, port and a security choice, next to the IMAP fields, with
  the detected defaults as placeholders.
- A connected account shows **"Allow sending and actions"**, off by default, with one line
  of consequence under it.
- **Copy under the form** is rewritten. It currently promises the agents cannot act; it
  will say what is now true, including that sending needs a tap.
- **Approval card**: To, Cc, Subject, body, Approve and Reject. Appears inline in the chat
  as the draft is created, and listed in the Email sheet until decided.

## Deviations from the brief

1. **Outlook stays read-only.** The brief names Titan/IMAP; sending through Microsoft Graph
   is a separate integration with its own scopes and consent screen. `connectedMailbox`
   gives Outlook the read tools only, exactly as today.
2. **`send_email(draft_id)` cannot itself send.** §2 asks for a tool that "only sends an
   approved draft"; §3 says every send must be approved in the UI first. Reconciled: the
   tool submits the draft. If it is still pending, it reports that it is waiting for the
   user's tap. If the user has already approved it, it enqueues it. The tool never reaches
   SMTP on its own, under any state.
3. **`mark_read`, `mark_unread` and `move_email` are not gated.** They are reversible and
   stay inside the mailbox. See Principles.
4. **The queue is the database, not memory.** The brief says "queue"; making it the set of
   `approved` rows plus a drain timer means an approved send survives a restart.
5. **No `delete_email` tool at all**, rather than a gated one.
