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

(Filled in from `npm run perf` on Francis's laptop before each release.)

## For developers

See `CLAUDE.md` in this folder.
