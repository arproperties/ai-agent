# Activity Tracker (desktop add-on for Reem)

A small Windows tray app, one copy per employee PC, that records how the workday was spent
on the computer and, at the end of the day, hands the day's summary to Reem. Reem emails one
daily report to HR. **No AI anywhere: it uses no AI credits.**

It is an add-on, not a change to Reem: its own folder `activity-tracker/` in this repo with
its own `package.json` and `CLAUDE.md`, never in Reem's build, tests or deploy (the same
arrangement as `aol-connector/`). Reem's side is one small file, `server/tracker.js`, mounted
like the saifsys inbound door, so the rest of Reem is untouched.

Francis asked for it on 2026-11-15. Rules he set: it must not slow the laptop; no AI credits;
do not disturb the existing Reem app; the report goes by email to HR
(hr@ainalreemproperty.com) or the master. He then dropped the AI altogether: "it's just
sending activity to the HR email". Earlier version of this document (same day) had a chat
agent and a mailbox on each PC; both are gone.

Status: design, awaiting Francis's approval. Nothing built.

## Why

HR and management want to know how office time is spent per person, without anyone filling
in a timesheet. The tracker does the counting; HR reads one email a day.

## Goals

- Record, on the PC itself, which app and window was in front, for how long, and when the
  person was idle or away.
- At the end of each day, send the day to Reem automatically. If the PC is off or offline,
  send it the next time it is on. Nothing is lost, nobody presses anything.
- Reem emails **one daily digest** to HR covering everyone: per person, first and last
  activity, active hours, idle, away, and time by app. A CSV is attached for Excel.
- Invisible in daily use: tray icon, never slows typing, calls or the browser, never spins
  the fan.
- The person always sees that it is running.

## Non-goals (version one)

- No AI, no chat, no agent. Reem's chats may later be allowed to read `tracker_days` (a tiny
  kit); not now.
- No screenshots, key logging, webcam, clipboard, or reading of what is typed.
- No mail login on any PC. Mail goes out from Reem's company mailbox, which is already set up.
- No live view. HR sees a day the evening it ends, not minute by minute.
- No macOS or Linux build. No automatic updates (a new version is a new installer).

## Anti-goals

- The laptop gets slow, hot or loses battery because of it.
- An employee finds out later that it was tracking them.
- Any manual step after the install (starting a service, typing a password each day).
- Reem's existing screens, routes or timers behave differently because this exists.

## The hard constraint: it must not slow the laptop

Francis's laptop is the reference machine: 12 GB RAM, 4-core Intel i7-1065G7 (2019,
low-power), Intel integrated graphics. Anything fine there is fine on the office PCs.

Budget, measured with the app in the tray:

| What | Limit |
|------|-------|
| CPU, 10-minute average | under 1% |
| RAM, all of the app's processes together | under 100 MB |
| Disk writes | one batch per minute, a few KB |
| Network | one small request to Reem per day (plus retries if it failed) |

How the design stays inside it:

1. **A 5-second glance, not a watch.** Every 5 seconds the main process asks Windows once
   for the front window (app name + title). Idle time is Electron's
   `powerMonitor.getSystemIdleTime()`, a system call. Lock, unlock, sleep, resume and
   shutdown are events Electron already receives.
2. **Rows are spans, not samples.** A span is "this app, this title, from–to". A new row only
   when the front window changes or idle starts/ends. A day is a few hundred rows. Rows are
   kept in memory and written to SQLite once a minute.
3. **No window.** The app starts with Windows, hidden, tray icon only. The only window is
   the small Today/Settings sheet, created when the tray icon is clicked and destroyed when
   closed. Idle, the app is just the Node main process (about 50–80 MB).
4. **Low priority.** The main process sets itself to below-normal Windows priority.
5. **Proven, not assumed.** `npm run perf` runs the app in tray mode for 10 minutes,
   samples CPU and RAM every 10 seconds, and fails if the table above is exceeded. It runs
   before every release.

## How a day flows

```
employee PC                               Reem (EC2)                         HR
───────────                               ──────────                         ──
08:40 first activity ──┐
      spans → SQLite   │  (all day, local)
18:30 Dubai, or PC    ─┘
      shutting down   ──POST /api/from-tracker/day──▶ tracker_days row
      (after 15:00)        X-Tracker-Key: <device key>
                                                     19:00 Dubai timer
                                                     one digest for all ──────▶ email
                                                     people, CSV attached       hr@…
```

- **Day end on the PC**: the first of (a) 18:30 Dubai time, (b) Windows shutting down or the
  user signing out after 15:00, (c) the next start of the app if (a) and (b) were missed
  (PC was off, no internet). Each day is sent once; a resend replaces the row (same person,
  same date), so a late PC never duplicates.
- **What is sent** (JSON, a few KB): date, first_seen, last_seen, active_seconds,
  idle_seconds, away_seconds, apps[] (name, seconds, top 5 titles with seconds). Raw spans
  stay on the PC and are deleted after 30 days. Reem never sees second-by-second data.
- **Day end on Reem**: a timer at 19:00 Dubai sends the digest for today. People whose PC
  has not reported yet are listed as "no report yet"; when their day arrives later, it is
  included in the next evening's email under "Late: yesterday". HR therefore gets exactly
  one email a day, every day the switch is on.

## Reem's side (`server/tracker.js`, deliberately small)

Mounted in `index.js` with two lines, like the saifsys door:

- `POST /api/from-tracker/day` — public route guarded by the device key (header
  `X-Tracker-Key`, compared with `timingSafeEqual` as `fromSaifsys.js` does). The key maps to
  a Reem person. Body as above. Upsert into `tracker_days`.
- Tables (idempotent DDL in `db.js`, added to `TABLES` in the test helper):
  - `tracker_devices` (id, user_id, key_hash, name, created_at, last_seen_at)
  - `tracker_days` (user_id, date, first_seen, last_seen, active_seconds, idle_seconds,
    away_seconds, apps jsonb, received_at; primary key user_id+date)
- `startTracker()` — the 19:00 Dubai timer. Only runs when the Settings switch is on, and,
  as with every timer that emails real people, off production only with `LOCAL_SENDING=on`.
  Sends with `sendMail()` from `mailer.js` (the company mailbox). Started under `billAs`
  for consistency even though it makes no AI calls.
- Settings (master only, in Reem's Settings screen under a new "Activity reports" row,
  per the rule that every switch lives in the UI): **on/off** (off by default), **HR email**
  (default hr@ainalreemproperty.com), **send time** (default 19:00), **include window
  titles in the report** (default on; off sends app totals only), and the list of devices
  with a **"New device" button** that creates a key for a chosen person and shows it once.
- `GET /api/tracker/days?from&to` — master only, for the Settings screen's "last 7 days"
  table and so a future chat kit has something to call. No other screen.

Access: the master sees all days. Nobody else has a screen in version one. The rule goes in
`access.js` as `trackerReach(user)` so it is testable without HTTP.

## The report email

Subject: `Activity report — Sat 15 Nov 2026`. Body, plain text and simple HTML:

```
Activity report — Sat 15 Nov 2026

Name          First   Last    Active   Idle    Away   Top apps
Francisca     08:52   17:41   6h 48m   52m     1h 10m Excel 3h 10m · Chrome 2h 05m · Outlook 1h 02m
Tauqeer       09:10   18:02   7h 20m   38m     30m    AutoCAD 4h 30m · Chrome 1h 50m · WhatsApp 1h
Ali           —       —       no report yet

Late: Fri 14 Nov
Ali           08:30   17:15   7h 05m   40m     45m    Chrome 3h · Word 2h 30m

Attached: activity-2026-11-15.csv (one row per person per app, with top titles).
```

"Away" is locked/asleep; "Idle" is no mouse or keyboard for over 3 minutes while unlocked.

## Pairing a PC with a person

1. Master, in Reem Settings → Activity reports → New device: picks the person, gets a key
   (shown once, copyable).
2. Francis installs the tracker on that PC and pastes the key into its first-run screen.
   Stored with Electron `safeStorage` (encrypted by Windows for that user).
3. Tracker calls `POST /api/from-tracker/hello` once to confirm the key and show the
   person's name; from then on it is silent until day end.

This is the only manual step and Francis does it at install, so employees never do anything.

## First run and consent

One screen that says what is recorded (app names, window titles, idle and lock times), what
is not (no screenshots, no keystrokes, no camera, no files), and that a daily summary goes to
HR at the company. Tracking starts after "I understand". This is the consent step the UAE
legal review (pending from the Looki research) needs; the wording is Francis's to finalise.
The tray icon is always visible while tracking.

Pause: version one has **no pause button** (HR's report would be incomplete without saying
so). If Francis wants one, the paused time is reported as "paused" rather than hidden.

## Screens on the PC (one small sheet)

```
┌───────────────────────────────────────┐
│ Activity Tracker          ● recording  │
│ Francisca · reports to HR at day end   │
├───────────────────────────────────────┤
│ Today   active 6h 12m · idle 48m       │
│   Excel            3h 10m  ████████    │
│   Chrome           2h 05m  █████       │
│   Outlook          1h 02m  ███         │
├───────────────────────────────────────┤
│ Last report sent: yesterday 18:30 ✓    │
│ [Send today now]  [Launch at startup ✓]│
└───────────────────────────────────────┘
```

Tray right-click: Open, Send today now, Quit.

## Data on the PC

SQLite via `better-sqlite3` at `%APPDATA%\activity-tracker\data.db`.

- `spans` (id, started_at, ended_at, app, title, kind: active|idle|away)
- `days` (date, first_seen, last_seen, active_seconds, idle_seconds, away_seconds,
  sent_at) — kept current by the minute flush
- `settings` (key, value; the device key encrypted with `safeStorage`)

Spans older than 30 days are deleted nightly. Clock: the PC's local time, converted to Dubai
time at send; the day boundary is Dubai midnight.

## Approaches considered

**Where the email comes from**

1. **PC → Reem → HR (chosen).** One mailbox (Reem's, already configured), one email a day
   for HR, the HR address is a Reem setting, days are kept in Reem for later. The PC needs
   only a device key.
2. Each PC emails HR directly over SMTP. Needs the company mail password on every PC and
   gives HR one email per person per day. Dropped.
3. Each PC writes a file to a shared drive / Google Sheet. No Reem connection, no email,
   and a sharing login on each PC. Dropped.

**AI**

None. Francis's conclusion, and correct: counting minutes per app needs no model. If a
written summary per person is ever wanted, that is a later, separate switch with a visible
cost, off by default.

**Desktop shell**

1. **Electron (chosen).** Same language as Reem, tray + a tiny sheet, 50–80 MB idle with no
   window open. Easiest for Francis to maintain.
2. Tauri (Rust shell). About 30 MB idle, the lightest. Dropped: the tracker code would be
   Rust, which nobody here maintains.
3. A Windows service with no UI plus a separate tray exe. Lightest of all but two programs
   and a C#/.NET toolchain. Dropped.

**Tracking method**

1. **Front window every 5 s + system idle time (chosen).** Light, no driver.
2. Windows event hooks (`SetWinEventHook`). Exact and zero-poll but needs a native addon.
   Can replace the poll later without changing the data shape.

## Stack (my picks)

- Electron (current stable); the small sheet in plain HTML/CSS or a tiny React + Vite page,
  builder's choice; no Tailwind build needed for one sheet.
- `get-windows` (maintained successor of `active-win`) for the front window.
- `better-sqlite3` for the local DB.
- `electron-builder` → one NSIS installer, per-user, no admin rights. **Unsigned** in version
  one: Francis installs each copy himself and accepts the one-time SmartScreen click.
- Tests: `node:test` for poll → spans logic and the day summary; Reem-side tests in Reem's
  suite for the device key check and `trackerReach`; `npm run perf` for the budget.

## Left to the builder

- Title cleaning so grouping reads well (strip " - Google Chrome", "- Excel" suffixes; group
  browser tabs by site where the title allows).
- The exact JSON shape and the CSV columns.
- Retry schedule when Reem is unreachable (proposal: every 15 minutes, then at next start).
- Installer icon and the name shown in Windows.
- Email HTML styling (match the password-reset email in `mailer.js`).

## Open for Francis

1. Include window titles in the HR report, or app totals only? (Default in the design: titles
   on, with a switch.) Titles show more, but also show personal browsing.
2. A pause button for employees, yes or no? (Default: no.)
