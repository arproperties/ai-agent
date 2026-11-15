# CLAUDE.md

Context for working in this folder. Francis prefers short, plain-step answers; detail only when asked.

**This folder lives inside the Reem repo** (`arproperties/ai-agent`, folder `activity-tracker/`)
only for storage on GitHub, like `aol-connector/`. It is its own program with its own
`package.json`; Reem's build, tests and deploy never touch it, and it is not deployed to the
server at all: it ships as a Windows installer that Francis runs on each employee PC.

## What this is

A Windows **tray app** that counts how the workday is spent on one PC (which program and window
is in front, idle, locked) and, at the end of the day, sends one small summary to Reem.
Reem's side is `server/tracker.js` (the door `/api/from-tracker/*`, the master's Settings →
Activity reports page, and the 19:00 email to HR). **There is no AI anywhere**: Francis wanted
it to cost no credits, and counting minutes needs none.

Spec: `docs/superpowers/specs/2026-11-15-activity-tracker-design.md`. Plan with the JSON
contract: `docs/superpowers/plans/2026-11-15-activity-tracker.md`.

## Files

- `src/spans.js` — a glance every 5 s → spans ("this window, from–to", kinds active/idle/away). Pure.
- `src/summary.js` — spans of one Dubai date → the contract JSON; title cleaning; midnight split. Pure.
- `src/store.js` — the PC's SQLite file (`node:sqlite`, built into Electron's Node: nothing to compile).
- `src/dayEnd.js` — when to send (18:30 Dubai, or a shutdown after 15:00, or at next start). Pure.
- `src/reem.js` — `hello` and `sendDay` to Reem's door; a 401 is a `PairingError`.
- `src/main.js` — Electron: tray, timers, windows, IPC. Wiring only; decisions live above.
- `ui/firstrun.html` — consent text + the pairing key. `ui/sheet.html` — today's totals and "Send today now".
- `scripts/make-icons.js` — draws the two tray icons as PNG with plain Node. `scripts/perf.js` — the budget gate.
- `package.json` `build.npmRebuild: false` — electron-builder must not try to compile anything: `get-windows`
  ships a prebuilt N-API binary that Electron loads as is, and SQLite is `node:sqlite`, built in. With the
  default on, the build fails on a machine without Visual Studio.

## Rules that shape the code (from the spec)

- Must not slow the laptop: under 1% CPU and about 100 MB RAM in the tray (`npm run perf`
  fails above 150 MB), writes once a minute, no window until the tray icon is clicked,
  `app.disableHardwareAcceleration()`, below-normal priority, one request to Reem a day.
- No screenshots, keystrokes or camera. Only app names, window titles, idle and lock times.
- No Quit, no pause, no "launch at startup" tick for employees. Any stretch the tracker was not
  running is reported to HR as a gap, never hidden.
- Everything that decides something is a pure module with `node:test` tests; `main.js` only wires.

## Commands

```bash
npm install          # once; also downloads Electron (node node_modules/electron/install.js if it did not)
npm test             # the pure modules against node:test
npm start            # the tray app, for real (first run asks for a pairing key)
npm run perf         # 10 minutes in the tray, prints CPU and RAM, fails over budget
npm run dist         # the installer: dist/Activity Tracker Setup x.y.z.exe (unsigned)
```

Running against a local Reem without typing: `REEM_URL=http://localhost:3001 TRACKER_DATA_DIR=<folder> TRACKER_PAIR_KEY=<key> npm start`.
Neither variable exists on an employee PC. From a shell that sets `ELECTRON_RUN_AS_NODE=1` (Claude Code's
does), prefix the start with `env -u ELECTRON_RUN_AS_NODE`, or Electron runs as plain Node and
fails on the first `import` with "does not provide an export named 'BrowserWindow'".

## Pairing a PC (what Francis does at install)

1. Reem → Settings → Activity reports → New device: pick the person, name the PC, copy the key.
2. Run the installer on that PC (per-user, no admin; accept the one-time SmartScreen "Run anyway").
3. Paste the key into the first-run screen and press "I understand, start". Done; it starts with Windows.
