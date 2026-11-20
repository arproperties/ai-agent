# Buddy on the desktop

Francis found the tracker's tray icon boring: "I was expecting a funny AI pet, always on display,
movable." Approved 2026-11-19. Reem's own pet (Buddy, `client/src/components/Pet.jsx`) moves to
the desktop as the Activity Tracker's face. **No AI, no credits**: every line is from a fixed list.

## What it is

- A small frameless, transparent, always-on-top window (190×200) with one of Reem's four
  characters (Buddy, Jelly, Bolt, Miso), drawn exactly as in Reem (`ui/characters.js` and
  `ui/buddy.css` are copies of Reem's; change Reem first, then copy).
- Drag it anywhere; the spot is remembered and pulled back on screen if a monitor goes away.
- Moods from what the tracker already counts (`src/mood.js`, tested): working (watches the
  pointer, blinks), sleep (3 idle minutes or a locked screen), happy (the day just went to
  Reem), alert (unpaired: grey, asks to be paired), think (first run: waiting for the key).
- Lines: a fixed list per mood, at most one an hour; a stretch nudge after two hours without a
  three-minute break; the unpaired line at most every ten minutes. "Buddy talks" can be turned
  off in its menu.
- Click Buddy: today's sheet. Right-click: Today, Send today now, Character, Buddy talks.
- It replaces the hidden 1×1 window that heard Windows shutting down (`session-end`), so the
  process count stays at three. If its page ever dies it is reopened after a second.
- Nothing to close, hide or quit (the spec's rule for employees stands).

## Files

- `src/mood.js` + `tests/mood.test.js` — moods, lines, nudge timing, screen clamping.
- `ui/buddy.html`, `ui/buddy.css`, `ui/characters.js` — the window.
- `src/main.js` — `openBuddy()`, `buddyState()`, `buddyMenu()`, IPC `buddy-state`/`buddy-click`/`buddy-menu`.
- `src/preload.js` — the four Buddy calls.

## Checks before release

1. `npm test` green; `npm start` against live Reem with a test device: Buddy appears, drags,
   survives a monitor change, shows the right mood, opens the sheet on click, the menu on right-click.
2. `npm run perf`: CPU under 1%, private memory under 150 MB (target 100) with Buddy visible.
3. `npm run dist`, version bumped to 0.2.0; install over 0.1.0 on Francis's laptop, pairing kept.
