# Activity Tracker (desktop)

A small Windows desktop app, one copy per employee PC, that records how the workday was
spent on the computer and lets one AI agent answer questions about it, write the day's
report, and work the person's mailbox. Built the way Reem is built, but it is **not part of
Reem**: its own folder `activity-tracker/` in this repo, own `package.json` and `CLAUDE.md`,
never in Reem's build, tests or deploy (the same arrangement as `aol-connector/`).

Francis asked for it on 2026-11-15 with three requirements: local AI support similar to
Reem, an email connector, one default agent. And one hard rule: **it must not make the
laptop slow.** That rule shapes every choice below.

Status: design, awaiting Francis's approval. Nothing built.

## Why (assumption, to confirm)

Francis has not yet said why he wants it. The design assumes: each person wants a quick way
to see their own day, write their daily report and keep up with mail without opening five
windows, and the company gets the daily report. If the real reason is that **management
wants to see how office time is spent**, version one changes in four places: pause and
"delete my data" become company decisions, the consent screen becomes a notice of company
monitoring, each PC must send a daily summary to Reem (a `/api/from-tracker` door, a login
on the PC), and the AI should go through Reem's server (one key, Reem's billing per person)
instead of a key typed on each PC. That is the open question at the end of this document.

## Open questions for Francis

1. **Who is it for**: the person's own tool, or the company watching the team? (See Why.)
2. **Whose AI key sits on each PC?** A key typed in Settings means either Francis's company
   key on every employee PC (any employee could lift and spend it, no per-person cost), or
   each employee making their own Anthropic account (a manual step, against the anti-goals).
   My recommendation: the app logs in with the person's Reem account and Reem's server does
   the thinking, so there is one key on the server and Reem's per-person billing applies.
   That adds a small Reem-side route and is approach 3 under AI below. If the answer to
   question 1 is "the company", this is clearly the way; if it is a personal tool for
   Francis alone, a typed key is fine.

## Goals

- Record, on the PC itself, which app and window was in front, for how long, and when the
  person was idle or away.
- One chat screen with one agent that can read that record and the person's mailbox.
- Email through the person's own account (Titan, Gmail, Outlook, AOL) with login typed in
  the app's settings.
- Stay invisible in daily use: lives in the system tray, never slows typing, video calls
  or the browser, never spins the fan.
- The person always knows it is running and can pause it.

## Non-goals (version one)

- No screenshots, no key logging, no webcam, no reading of what is typed.
- No central server or manager dashboard. Each PC keeps its own data. A later version may
  send daily summaries to Reem; the record is kept in a shape that makes that easy.
- No macOS or Linux build.
- No multiple agents, no agent assignments, no modules. One agent, one person.
- No automatic updates. A new version is a new installer.

## Anti-goals (what would make it a failure even if it works)

- The laptop gets slow, hot or loses battery because of it.
- An employee finds out later that it was tracking them.
- Someone has to do a manual step (start a service, install a model, open a terminal) for
  it to work. It must work on its own after the installer.

## The hard constraint: it must not slow the laptop

Francis's own laptop is the reference machine: 12 GB RAM, 4-core Intel i7-1065G7 (2019,
low-power), Intel integrated graphics, no Ollama installed. Anything that is fine there is
fine on the office PCs.

Budget, measured with the app in the tray and no chat open:

| What | Limit |
|------|-------|
| CPU, 10-minute average | under 1% |
| RAM, all of the app's processes together | under 150 MB |
| Disk writes | one batch per minute, a few KB |
| Network | mail header check every 10 minutes, nothing else |
| Background AI | none, ever |

How the design keeps inside it:

1. **Tracking is a 5-second glance, not a watch.** Every 5 seconds the main process asks
   Windows once for the front window (app name + title). Idle time comes from Electron's
   `powerMonitor.getSystemIdleTime()`, which is a system call, not a poll of the mouse.
   Lock, unlock, sleep and resume are events Electron already receives.
2. **Rows are spans, not samples.** A span is "this app, this title, from–to". A new row is
   written only when the front window changes or idle starts/ends. A day is a few hundred
   rows, not 17,000 samples. Rows are kept in memory and written to SQLite once a minute.
3. **No window until asked.** The app starts with Windows, hidden, tray icon only. The chat
   window (Chromium renderer, the heavy part of Electron) is created the first time the
   tray icon is clicked and destroyed when closed, so the idle app is just the Node main
   process (about 60–90 MB).
4. **No local AI model runs by default.** See AI below. Nothing is loaded, nothing is
   warming up, nothing runs when the person is not chatting.
5. **Mail is headers only in the background.** Every 10 minutes it fetches new headers
   (from, subject, date) over IMAP, nothing else. Bodies and attachments are fetched only
   when the agent or the person opens that email.
6. **Low priority.** The main process sets itself to below-normal Windows priority so
   anything the person is doing wins the CPU.
7. **Proven, not assumed.** `npm run perf` runs the app in tray mode for 10 minutes and
   samples its CPU and RAM every 10 seconds; it fails if the table above is exceeded.
   This runs before every release.

## AI

"Local AI support similar to Reem": Reem's agents are Claude models in the cloud; only its
search embeddings are local. The same split is right here, for the laptop's sake.

**Default: Claude Haiku 5.5 in the cloud** (`claude-haiku-5-5`), the same model Reem's Auto
uses to do the work. Fast, costs cents a day for one person, and uses none of the laptop.
The API key is typed once in Settings and stored with Electron's `safeStorage` (encrypted by
Windows for this user), never in a file in plain text.

**Switch: local model (off by default).** Settings has a "Use a local AI model" toggle. When
on, the app talks to Ollama on `127.0.0.1:11434` with Qwen 3 4B. Rules for the switch:

- Ollama is not bundled. If it is not installed, the toggle explains what to install and
  stays off. (Installing a 2–3 GB model is a manual step, so this can never be the default;
  see Anti-goals.)
- The model is loaded only when a chat message is sent and Ollama is told to unload it
  5 minutes after the last message (`keep_alive`). Nothing stays in RAM between chats.
- The toggle carries a plain warning: on a laptop like Francis's a local model answers at a
  few words per second and takes about 3 GB of RAM while it is answering.

Why a local model is not the default: on this CPU with no usable GPU, a 4B model answers at
roughly 5–8 words per second and an 8B model at 2–4, with the fan on. That is the opposite
of "not slow". Privacy is the one argument for local, and the data the cloud model sees is
the person's own activity summary and mail, sent only when they ask a question.

**No embeddings in version one.** Activity and mail search are plain SQL (`LIKE` and
SQLite FTS5 on titles, subjects and senders). Reem's 384-dim local model is not loaded.
Can be added later if search quality needs it.

## The agent

One agent, no persona settings in version one, a fixed system prompt: who the person is
(name from Settings), today's date in Dubai time, a one-paragraph summary of today's
activity so far, and the tool list. The tool loop is the Reem pattern: a `kit` returning
`{ definitions, run(block) }`, cards for anything that acts (`onCard`).

Tools (about 9, well under Reem's ~70):

| Tool | What |
|------|------|
| `activity_day(date)` | spans of one day, grouped by app, with totals and idle time |
| `activity_range(from, to)` | daily totals for a period (for weekly reports) |
| `activity_search(text, from, to)` | window titles matching text (e.g. a client name) |
| `idle_periods(date)` | away/idle stretches of a day |
| `mail_recent(n)` | latest headers |
| `mail_search(text)` | headers matching text |
| `mail_read(id)` | one email's body, attachments listed |
| `mail_send(to, subject, body, replyTo?)` | **card**: the person confirms before it is sent |
| `remember(text)` | a short note the agent keeps (e.g. "Fridays I work from home") |

Typical asks: "what did I do today", "write my daily report and send it to Tauqeer",
"how much time on Excel this week", "any mail from the bank I haven't answered".

Billing: one person, one key, so no per-job billing table. The app keeps a running
token count per day in Settings so Francis can see the cost. (Reem's `billing.js` is for
many people sharing one key; not needed here.)

## Email connector

Reuses the code shape of `aol-connector/server.js`: `imapflow` to read, `nodemailer` to
send, `mailparser` for bodies, attachments read as in the connector (PDF text, pictures,
Word, Excel). Login (host, port, user, password or app password) is typed in Settings and
stored with `safeStorage`. Presets for Titan, Gmail and AOL fill host and port.

Which providers must work (my call, from what the project already knows): staff mail is
**Titan** (the Titan connector notes), so Titan is the one that must work, and it is plain
password IMAP like AOL, so the aol-connector code ports straight over. Gmail works with an
app password (the preset explains the two steps). **Outlook / Microsoft 365 is out of
version one**: it no longer accepts password IMAP and needs OAuth with an Azure app
registration, which is a different connector; the Settings sheet says so if someone picks it.

The IMAP connection is opened for each check and closed after; no IDLE connection is held
open (a held socket keeps the laptop's radio awake and dies on every Wi-Fi change).

## Screens (chat-only, as in Reem)

One window, one screen. Settings is a sheet over it, not a page.

```
┌─────────────────────────────────────────────┐
│ ● Tracking   Today 6h 12m · idle 48m   [⚙]  │  ← today strip, tap to expand by app
├─────────────────────────────────────────────┤
│                                             │
│   (chat with the agent, cards inline)       │
│                                             │
├─────────────────────────────────────────────┤
│ Ask about your day or mail…           [🎤] │
└─────────────────────────────────────────────┘
```

- **Today strip**: tracking on/off dot, total active, idle. Tap: a list of apps with
  minutes, today. That is the only "report" screen; everything else is asked in chat.
- **Settings sheet**: your name; API key; local model switch (with its warning); mail
  account; tracking on/pause; "launch at startup"; keep data for 90 days; a "Delete all my
  data" button.
- **Tray icon**: always there when tracking (green dot), grey when paused. Right-click:
  Open, Pause for 1 hour, Pause until tomorrow, Quit.
- **First run**: one screen that says exactly what is recorded (app names, window titles,
  idle time, lock/unlock) and what is not (no screenshots, no keystrokes, no camera), and
  that the data stays on this PC. Tracking starts only after "I understand, start".
  This is the consent step the UAE legal review (pending from the Looki research) will
  need; the wording is Francis's to finalise.

No voice in version one (the mic button is drawn but disabled), unless Francis wants Reem's
OpenAI voice path copied over.

## Data

SQLite via `better-sqlite3` at `%APPDATA%\activity-tracker\data.db`.

- `spans` (id, started_at, ended_at, app, title, kind: active|idle|locked|away)
- `days` (date, first_seen, last_seen, active_seconds, idle_seconds) — kept current by the
  minute flush so "today" needs no sum over spans
- `mail_headers` (uid, folder, from, to, subject, date, seen, has_attachments)
- `chats`, `messages` (as Reem, one person)
- `notes` (the agent's `remember`)
- `settings` (key, value; secrets encrypted with `safeStorage` before saving)

Spans older than 90 days are deleted nightly. "Delete all my data" empties every table and
the stored secrets.

Dates: the PC's local clock, but the agent is told the Dubai date; same `dubaiDate()` rule
as Reem.

## Approaches considered

**Desktop shell**

1. **Electron + Node (chosen).** Same languages as Reem, reuses the aol-connector mail code
   and Reem's kit pattern as-is. Cost: Chromium, about 60–90 MB when hidden and 150–200 MB
   with the window open. Within budget because the window exists only while in use.
2. Tauri (Rust shell, web UI). About 40 MB idle, the lightest real option. Dropped: the
   tracker and the mail code would have to be rewritten in Rust or run as a Node sidecar
   (which brings the RAM back), and nobody here maintains Rust.
3. Windows-native (.NET / WinUI). Lightest and most "Windows", but a new language, no
   reuse of anything in this repo. Dropped.

**AI**

1. **Cloud Claude by default, local model as an off-by-default switch (chosen).** Laptop
   stays fast; the person still has the local option where privacy matters more than speed.
2. Local-only (Ollama). Free and private, but slow and hot on this class of laptop, and
   needs a manual model install. Dropped as the default; kept as the switch.
3. Through Reem's server (the app logs in to Reem and Reem's chat does the thinking).
   Attractive later: one key, Reem's billing per person, Reem's agents. Dropped for version
   one because it ties the tracker to the Reem account and server work; the kit shape keeps
   it possible.

**Tracking method**

1. **Front window every 5 s + system idle time (chosen).** Light, needs no driver, enough
   to answer "what did I do today".
2. Windows event hooks (`SetWinEventHook`) for instant window-change events. More exact,
   zero polling, but needs a native addon and is fragile across Electron versions. Dropped
   for now; could replace the poll later without changing the data shape.

## Stack (Francis's calls to confirm; all my picks)

- Electron (current stable), React 19 + Vite + Tailwind v4 for the window, same as Reem's
  client, so components can be borrowed.
- `get-windows` (maintained successor of `active-win`) for the front window.
- `better-sqlite3`, `imapflow`, `nodemailer`, `mailparser`, `@anthropic-ai/sdk`.
- `electron-builder` → one NSIS installer (`ActivityTracker-Setup-x.y.z.exe`), per-user
  install, no admin rights needed. **Unsigned in version one** (my call): Francis installs
  each copy himself, so the one-time SmartScreen "More info → Run anyway" click is
  acceptable. If employees are ever to install it themselves, buy a code-signing
  certificate and add the signing step then.
- Tests: `node:test` for the span logic (poll → spans), the kit tools over a test SQLite
  file, and `npm run perf` for the budget above. No mocks for SQL, as in Reem.

## Left to the builder

- Exact Tailwind layout; borrow Reem's chat components where they fit.
- How "away" is told from "idle" (proposal: idle > 3 min = idle; lock or sleep = away).
- Title cleaning (strip " - Google Chrome", "Microsoft Excel" suffixes) so grouping by app
  reads well.
- The agent's system prompt wording.
- Installer icon and name shown in Windows.
