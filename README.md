# Jarvis — personal AI agents

Express + React (Vite, Tailwind v4) PWA. Multiple agents with personas, file knowledge (RAG), long-term memory and voice.

## Run

```bash
npm run setup      # first time only
npm run dev        # dev: http://localhost:5173 (API on :3001)
npm run build && npm start   # production: http://localhost:3001
```

Needs Node 22+ and PostgreSQL 14+. Keys live in `.env` at the project root:

| Key | Used for |
|---|---|
| `DATABASE_URL` | Postgres, e.g. `postgres://user:pass@127.0.0.1:5432/aiagent`. The schema is created on first boot. |
| `CLAUDE_API_KEY` | Chat, reading attachments, learning memories |
| `OPENAI_API_KEY` | Voice only: mic (speech→text) and read-aloud (text→speech) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` | Email for "Forgot password?" links (any SMTP provider). If unset, the reset link is printed in the server console. |
| `EMAIL_KEY` | Encrypts saved email passwords (32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Changing it means reconnecting email. |
| `EMAIL_SEND_PER_HOUR` | Sends allowed per user per hour, once they have turned sending on for a mailbox (default 20) |
| `EMAIL_SEND_PER_DAY` | Sends allowed per user per day (default 100) |
| `EMAIL_MAX_RECIPIENTS` | Most recipients on one email, To and Cc together (default 10) |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Optional: lets users connect Outlook so agents can read their email (see below) |
| `REGISTRATION_CODE` | Optional invite code people must enter to create an account. **Set it before putting the app online**, or anyone can sign up and use your API credits. |

## How it works

- **Password reset** — "Forgot password?" emails a one-time link valid for 1 hour; using it signs the account out everywhere else. Admin fallback: `npm run reset-password -- someone@example.com NewPassword123`.
- **Web search** — agents verify UAE laws, fees, tax and labour rules on the web (official .gov.ae sources first) before stating them, and show the sources under the reply. Uses Anthropic's server-side web search, billed per search.
- **Scanned PDFs** — PDFs without a text layer (scans, photos of documents) are read by Claude, including Arabic, stamps and handwriting notes.

- **Accounts** — anyone can register (email + password). Each user has their own private agents, chats, files and memory. Passwords are hashed with scrypt; sessions are httpOnly cookies.
- **Smart routing** — you never pick an agent. For every message Claude Haiku reads your team's personas (and each agent's files) plus the conversation, and hands the message to the best agent. Follow-ups stay with the same agent. Start a message with `@Name` to force one.

- **Agents** — each has its own persona, model, voice and optional private files. Describe each agent's expertise clearly in its persona: that is what the router uses.
- **Files (RAG)** — attach PDFs, Word, text/CSV or images in chat (they go to your shared library, used by every agent) or add them to one agent in its settings. Text is split into chunks and indexed with local embeddings (free, runs on this machine) plus keyword search. Relevant chunks are added to every question.
- **Auto-organised files** — every file you share (in chat or on the Files screen) is stored, read by Claude Haiku and filed automatically: a clear title, a folder (Contracts, Tenancy & Property, Invoices, HR, IDs, Company & Licenses…), a short summary with parties/amounts/dates, tags and the document date. Duplicates are detected. Originals are kept in `data/uploads/` and can be opened, downloaded, moved or deleted from the Files screen. Agents see the library, so "find my tenancy contract" works.
- **Expiry watch** — while filing, Claude also reads the date a document stops being valid: a trade licence, an establishment card, a residence visa, an Emirates ID, a tenancy contract, an insurance policy. It costs nothing extra, because it rides along in the call that was already reading the file. What is running out then appears at the top of the Shelf, as a count on the Shelf button, and as a line on the first screen when it is inside a month. Every expiry can be corrected or cleared by hand in the file's details — the classifier does get it wrong. Files added before this existed have no expiry: `npm run backfill-expiry` lists what it would ask about and changes nothing; `npm run backfill-expiry -- --apply` does it, at one Claude call per file.
- **To-do** — menu → **To-do**. A list of what you have to do, each item with an optional reminder. The reminder is a time, not a notification: when it arrives the todo moves to **Due now** at the top of the list, puts a count on the To-do button, and shows as a line on the first screen. Nothing is emailed and nothing is pushed — Jarvis cannot reach you when the app is closed, and the screens say so rather than letting you assume otherwise. You can also just say it in chat: *"remind me to renew the trade licence on 5 October at 10am"*. Agents can add, read, reschedule and tick off todos, and each one records which agent raised it. They deliberately cannot delete: completing is reversible and visible, deleting is neither.
- **Routines** — menu → **To-do** → the **Routines** tab. The things that come back: the tablets each morning, the report each Monday, the VAT return each quarter, a licence each year. Deliberately not a repeat flag on a todo — a todo is finished and leaves, a routine never is, and recurring items sitting in the todo list for ever would mean that list is never empty and its badge stops meaning anything. Pick Daily, Weekly, Monthly, Yearly, Fortnightly or Quarterly, or any "every N" from chat. The first occurrence fixes the time of day, the weekday, and the day of the month; the 31st stays the 31st wherever there is one and clamps only where there isn't. Missing a few turns leaves one thing owed, not a pile of them, and a daily routine shows the last seven days so you can see what you actually did. Ticking a turn off and un-ticking it are exact opposites. Put one down with **Pause**, which keeps its history. Agents can add, list, tick off and pause them, and know to use a routine for "every" and a todo for one-offs.
- **Memory** — after each reply Claude Haiku extracts lasting facts ("User prefers short answers"). They are shared by all your agents and recalled in every future chat. See/edit them under Memory & files.
- **Email** — menu → **Email**. Enter your address and password under **Email account** and every agent can search and read that mailbox when you ask about your email. Works with any IMAP mailbox (Titan, Gmail with an app password, Zoho, Yahoo, cPanel hosting…); the mail server is found automatically from the address (change it under **Advanced**). Reading is always on and always read-only: mail is opened without marking it as read. Tick **Allow sending and actions** and agents can also write drafts and replies, mark emails read or unread, and file them in folders — but they can never send anything themselves: every draft waits, in the Email sheet and in the chat, until you tap Approve, and sends are rate-limited and logged. They still cannot delete email. Emails are fetched when needed, not copied into Jarvis; the password is stored encrypted with `EMAIL_KEY`. If the login fails with the right password, turn on IMAP access in your email settings.
- **Outlook email** (optional, hidden until `MS_CLIENT_ID` is set) — for mailboxes hosted by Microsoft. Menu → **Email** → **Connect**. After signing in with Microsoft, every agent can search and read that mailbox when you ask about your email (read-only: no sending, replying, moving or deleting). Emails are fetched when needed, not copied into Jarvis. Disconnect from the same screen; to fully revoke access also remove "Jarvis" at account.microsoft.com → Privacy → Apps and services.
- **When something breaks** — a crash in the app used to leave a white screen and no trace. It now shows "Something went wrong" with a reload button, and reports itself: the message, the stack and who met it are written to `error_log`, along with faults on the server. Master sees them under People, behind an amber button that only appears when there is something to see. Kept for a month, then dropped. No external service and nothing to pay for.
- **Data** — chats, agents, files metadata, memories and the search index are in Postgres; the uploaded originals and the embedding model are on disk in `data/`. Back up both.

## Tests

Tests run against a real throwaway Postgres database — what they check is SQL scoping,
which a mock cannot verify.

```bash
createdb jarvis_test
psql -d jarvis_test -c 'CREATE EXTENSION vector;'   # may need: sudo -u postgres psql -d jarvis_test -c 'CREATE EXTENSION vector;'

TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test
```

The schema is created automatically on the first run. **Every test truncates every
table**, so the harness refuses to start unless the database name ends in `_test`.
Never point `TEST_DATABASE_URL` at the live database.

## Deploy

`./deploy.ps1` builds the client and ships it to jarvis.eloquentservice.com (nginx serves `client/dist`, pm2 runs the API on 127.0.0.1:3001). The server's own `.env` is never overwritten.

## Outlook setup (once)

Microsoft only lets registered apps read mail, so register Jarvis once (free):

1. Open [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** → **New registration**. You need a work (Microsoft 365) or free Azure account; a plain Outlook.com login can't create registrations.
2. Name it `Jarvis`. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (so Hotmail/Outlook.com and work mailboxes both work).
3. Redirect URI: platform **Web**, `http://localhost:5173/api/outlook/callback`. Later add your live address too, e.g. `https://your-domain.com/api/outlook/callback` (under **Authentication**).
4. Copy the **Application (client) ID** → `MS_CLIENT_ID` in `.env`.
5. **Certificates & secrets** → **New client secret** → copy its **Value** → `MS_CLIENT_SECRET`. It expires (up to 24 months); create a new one before then.
6. Restart the server. Permissions (`Mail.Read`, `User.Read`, `offline_access`) are requested when you connect; nothing to add by hand.

## iPhone

The app must be served over **HTTPS** to install. Quick test from your phone:

```bash
npm run build && npm start
npx cloudflared tunnel --url http://localhost:3001   # gives you an https URL
```

Open the URL in Safari → Share → **Add to Home Screen**. For a permanent URL deploy to any Node host (Render, Railway, a VPS) with a persistent disk for `data/`.
