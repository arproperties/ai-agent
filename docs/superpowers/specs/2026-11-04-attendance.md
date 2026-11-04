# Attendance

Who worked which day, read from what the teams already post, and checked person by person
for each pay period (26th to the next 25th). Built after doing the 26 Sep – 25 Oct period
by hand from the ATTENDANCE GROUP WhatsApp export.

## What comes in

- **WhatsApp export** (zip with media, or the chat text alone). The browser opens the zip
  itself (`client/src/lib/zip.js`) and sends only `_chat.txt` and the photos the server has
  not read before (`POST /attendance/imports/new-photos`), so a monthly export is a small
  upload. Chat days are re-read only when their text changed (`attendance_chat_days.hash`).
- **Excel / CSV**, **PDF** (typed or scanned), **photos** of a list. Optional company and
  date for files that do not say.

## Reading (`server/attendanceRead.js`)

1. Each chat day's lists and each photo are read by Haiku 5.5 into rows
   (date, poster, team label, name, status, hours, note).
2. Everything new is sorted at once by Sonnet 5.5: `poster | team label` → company and
   section (`attendance_teams`), and `company | written name` → person (`attendance_names`).
   Learnt once, so next month only new lists and names are asked about.
3. Rows are saved as `attendance_entries`.

Rules learnt from the first real period:
- The export has CRLF line endings.
- A list headed with yesterday's date is today's when its poster already sent one for
  yesterday (29 Sep, 3 Oct); otherwise it is a late list for the day written.
- Two names on the same list on the same day are two people (Hussain / Azhar).
- People move company (Eng Hany → Heroes Zone / Ayla Residence / JVC School): the names
  step sees everyone known, with companies, dates and hours, to join them.

## Checking (`server/attendance.js`, `client/src/components/Attendance.jsx`)

- **Complete** = on a list every day of the period except single days on their own.
  Two or more days in a row on no list → needs a look, with the reason shown. This is
  exactly the rule the office applied by hand to the 74 people of the first period.
- A period still running is judged up to the last day any list was read for.
- Tabs **To verify / Verified / Skipped**; one person per screen, complete ones first.
  Verify or Skip moves to the next. Skipped people stay in the report, marked.
- Tap a day: every list that said it, with the message text or the photo, and team photos
  that day (headcount only). A day can be set by hand; that wins over every list.
- **Same person as…** merges two people: days, spellings and future lists.
- **Report**: a zip with `Summary.xlsx` and one file per person under Complete / Incomplete;
  verified, skipped or not checked is written in each file and in the summary.

## Not yet

- Sending verified attendance to saifsys (needs a write screen on the saifsys side; matched
  by HR employee code as in `hr_links`).
- Sharing the export straight from WhatsApp to Reem (PWA share target).
