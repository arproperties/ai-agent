# Jarvis — personal AI agents

Express + React (Vite, Tailwind v4) PWA. Multiple agents with personas, file knowledge (RAG), long-term memory and voice.

## Run

```bash
npm run setup      # first time only
npm run dev        # dev: http://localhost:5173 (API on :3001)
npm run build && npm start   # production: http://localhost:3001
```

Needs Node 22.13+ (uses built-in SQLite). Keys live in `.env` at the project root:

| Key | Used for |
|---|---|
| `CLAUDE_API_KEY` | Chat, reading attachments, learning memories |
| `OPENAI_API_KEY` | Voice only: mic (speech→text) and read-aloud (text→speech) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` | Email for "Forgot password?" links (any SMTP provider). If unset, the reset link is printed in the server console. |
| `EMAIL_KEY` | Encrypts saved email passwords (32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Changing it means reconnecting email. |
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
- **Memory** — after each reply Claude Haiku extracts lasting facts ("User prefers short answers"). They are shared by all your agents and recalled in every future chat. See/edit them under Memory & files.
- **Email** — menu → **Email**. Enter your address and password under **Email account** and every agent can search and read that mailbox when you ask about your email. Works with any IMAP mailbox (Titan, Gmail with an app password, Zoho, Yahoo, cPanel hosting…); the mail server is found automatically from the address (change it under **Advanced**). Read-only: mail is opened without marking it as read, and nothing is sent, moved or deleted. Emails are fetched when needed, not copied into Jarvis; the password is stored encrypted with `EMAIL_KEY`. If the login fails with the right password, turn on IMAP access in your email settings.
- **Outlook email** (optional, hidden until `MS_CLIENT_ID` is set) — for mailboxes hosted by Microsoft. Menu → **Email** → **Connect**. After signing in with Microsoft, every agent can search and read that mailbox when you ask about your email (read-only: no sending, replying, moving or deleting). Emails are fetched when needed, not copied into Jarvis. Disconnect from the same screen; to fully revoke access also remove "Jarvis" at account.microsoft.com → Privacy → Apps and services.
- **Data** — everything is in `data/jarvis.db` (SQLite). Back up that folder.

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
