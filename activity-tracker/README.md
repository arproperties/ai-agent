# Activity Tracker

A small Windows tray app for the employee PCs at the office. It counts how the workday is spent
on the computer (which program and window is in front, idle time, locked time) and at the end
of the day sends one summary to Reem. Reem emails HR one report a day for everyone.

No AI is involved. Nothing but the daily summary leaves the PC. The detail is deleted after 30 days.

## Installing on a PC (three steps, done once)

1. In Reem, as the master: **Settings → Activity reports → New device**. Pick the person, give the
   PC a name (like "Front desk"), press **Make key** and copy the key. It is shown only once.
2. On that PC, run `Activity Tracker Setup x.y.z.exe`. It installs for the signed-in Windows user,
   needs no admin rights, and starts with Windows from then on. Windows may show
   "Windows protected your PC" the first time: **More info → Run anyway** (the installer is not signed).
3. The tracker opens a screen saying what it records and what it does not. Paste the key and press
   **I understand, start**. The green dot appears in the tray.

That is all. The person never has to do anything again. Clicking the tray icon shows today's
totals; right-click has **Send today now** if HR wants a day before 18:30.

## Buddy

Reem's pet sits on the desktop, always on top, and can be dragged anywhere; it remembers its spot.
It watches the mouse while you work, dozes after three idle minutes, sleeps when the PC is locked,
waves when the day has gone to Reem, and goes grey if Reem no longer knows the PC. Now and then it
says a short line from a fixed list, never more than once an hour, and suggests a stretch after two
hours without a break. Right-click it for the menu: Today, Send today now, Character (Buddy, Jelly,
Bolt, Miso), and "Buddy talks" to switch the lines off. Click it for today's times. No AI is involved.

## What HR gets

One email a day at 19:00 Dubai (the time is a Reem setting) with, per person: first and last
activity, active time, idle time, away time and the top programs, plus a CSV with one row per
person per program. People whose PC has not reported show as "no report yet" and appear in the
next day's email once it arrives; a day that changed after HR saw it is listed as "Updated".
Any stretch the tracker was not running is printed as a gap.

## Keeping the laptop fast

The app glances at the front window once every 5 seconds, writes to disk once a minute, opens no
window until the icon is clicked, uses no GPU and runs at below-normal priority. The budget is
under 1% CPU and about 100 MB of memory in the tray; `npm run perf` measures it before a release.

## Measured

`npm run perf` on Francis's laptop (12 GB, i7-1065G7), version 0.2.0 with Buddy on screen, ten minutes, 2026-11-19:

| | Result | Budget |
|---|---|---|
| CPU, 10-minute average | 0.56% of the machine (4.4% of one core) | under 1% |
| Memory, private working set (Task Manager's "Memory" column) | 56 MB average, 66 MB peak | target 100 MB, fail at 150 MB |
| Memory, total working set (shared Chromium pages counted once per process) | 290 MB average, 296 MB peak, flat from the first sample | guard at 300 MB |
| Processes | 3: main, network helper, Buddy's window | |

Buddy's window is transparent, and Windows re-composites a transparent window on every frame
anything in it moves, software or GPU alike: with Reem's looping animations it cost half a core
(5.5% of the machine). So on the desktop Buddy is still almost all the time and moves in short
bursts, a bob every twelve seconds or so and a blink every five, which brings it to the figure
above. The private figure is what the laptop gives up; the total counts the same shared DLLs
three times and sits flat at about 290 MB, so the guard is at 300 MB to catch a leak or a fourth
process rather than this baseline.

## For developers

See `CLAUDE.md` in this folder.
