# Primary case per chat

## Why

A chat about one case often brings up others: "how did we handle 198822?", "compare with the
Haley case". Right now every case number counts the same, so the agent can mix them up: it
might put another case's dates, parties or deadlines into the case the chat is about.

The idea: **the case named in a chat's first message becomes that chat's primary case.** Any
other case mentioned later is a **reference**. The agent can use it to compare or for
precedent, but it never treats it as the case being worked on.

## What stays the same

- A chat whose first message names no case behaves exactly as it does today: no extra prompt
  text, no chip, no new tool.
- Chats that already exist get no primary case (the column is NULL), so they behave as today
  too.
- Routing, agents, kits, carry-in, the Shelf and email all work as they do now. This only adds
  a block to the context, labels to recalled excerpts, and a small chip.
- Nothing is emailed or pushed, so no feature flag is needed.
- A person without the `case_focus` module (see "Who gets it") gets none of this.

## Who gets it: a module, ticked per person

This is a new entry in `MODULES` (`server/modules.js`):

```js
// Not a screen: what a chat does when its first case is named (server/primaryCase.js).
{ key: 'case_focus', label: 'Primary case', about: 'The first case named in a chat becomes its main case; other cases mentioned later are kept apart as references.', everyone: true },
```

- `everyone: true`: `giveToEveryoneOnce` gives it once to everyone who already has an account.
  The master can then untick it on any person's People profile, so it can go to everyone or
  only to some people.
- Not `company`, so external users can have it too. Their case-folder chats are the main
  reason for this feature.
- Someone added later starts without it, like every other module, until it is ticked.
- `chat()` checks `userModules(user).includes('case_focus')` once. Without it, no detection
  runs, no columns are written, nothing is added to the prompt and no chip is shown. The
  load returns `primary_case` only when they hold the module.
- Client: one row in the settings menu's module list.
- Taking the module away leaves any saved `primary_case` in the database, but it is not used.
  Ticking it again brings it back.

## How it works

### 1. Spotting the case on the first message (server, pure, `server/primaryCase.js`)

`detectCase({ text, fileNames, folders, legalCases })` returns
`{ number, key, partyA, partyB, source } | null`. It runs on every message until a primary
case is set. The first message that names a case sets it, even if it is not message #1
("hi" first, then the case). It stops once a case has been set. **Once set, the primary case is locked for
the life of the chat: nothing can change or remove it, not the user, not the agent, not a
later message.** To work on another case, start a new chat. It checks in this order and stops at
the first match:

1. **A file name in Reem's own folder pattern.** `Case - E-205791 - JEFF AKHTAR ET AL vs
   JEREMY MITCHELL ET AL.pdf` is the pattern from `caseMatch.js` read backwards
   (`DEFAULT_PATTERN`), which gives the number and both parties. This is the message in the
   screenshot.
2. **One of the user's own case folders or legal cases.** If the text or a file name matches
   `caseRegex(case_number)` for a `case_folders` row (their own, by `user_id`) or a
   `legal_cases` row (only when they have the `legal` module), that case wins, with its
   parties.
3. **A case-shaped number next to case words.** "case", "file", "matter", "claim", "قضية",
   "دعوى" within a few words of a token like `E-205791`, `205791` or `2024/1234`. This needs
   at least 4 digits and must not look like a phone number, amount (AED/$/,000), date or unit
   number.

If two different cases are equally strong in one message, it picks neither and checks the
next message again. Because the case cannot be changed afterwards, a wrong guess would stay
for the whole chat. Guessing wrong would cause the very mix-up this is meant to
stop. No model call is made: the check is free, instant and testable.

### 2. Storing it (`server/db.js`)

```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS primary_case JSONB;
-- { number, key, partyA, partyB, source: 'first_message' | 'set_by_user', folderId?, legalCaseId? }
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reference_cases JSONB NOT NULL DEFAULT '[]';
-- [{ number, key, firstSeenMessageId }]: other cases seen in later messages
```

No new table, so `tests/helpers/db.js` `TABLES` is unchanged.

On every later message, the same detector (steps 2 and 3 only) collects any **other** case
keys it finds and adds them to `reference_cases`. It never changes `primary_case`.

### 3. Telling the agent (`server/chat.js` `systemPrompt`)

This goes in the uncached `context` half, next to `<earlier_chats>`, and only when
`primary_case` is set:

```
<primary_case number="E-205791" parties="Jeff Akhtar et al vs Jeremy Mitchell et al">
This conversation is about case E-205791. "The case", "my case", "this file", deadlines,
drafts and to-dos all mean this case unless {user} clearly names another.
Other cases mentioned here are references: use them only to compare, for precedent, or
because {user} asked about them. Always name a reference case by its number when you use it.
Never carry a reference case's parties, dates, amounts, deadlines or rulings over to E-205791.
If you are not sure which case a fact belongs to, say so and ask.
The primary case is fixed for this chat. If {user} wants another case to be the main one,
tell them to start a new chat for it.
Reference cases so far: 198822, 2024/1234.
</primary_case>
```

**Recalled excerpts get labels** (`knowledge.js` output, in `chat.js`). An excerpt from a file
whose title or name matches the primary case's `caseRegex` is marked
`[primary case E-205791]`. One matching a reference case is marked `[reference: 198822]`.
Mislabelled RAG chunks are the most likely way the agent mixes facts up, and these labels
cost nothing. The recall query also gets the primary case number added, so the main case's
files rank first.

**Carried chats** (`chatRecap.js`): a chat brought in that has a different primary case gets
`case="..."` on its `<chat>` tag, so the agent knows those notes are about a reference case.

**Case kit** (external users, `caseKit.js`): tools that take a case number use the primary
case when the agent leaves the number out.

### 4. Seeing it (client, read-only)

- A new SSE event, `send('primaryCase', { primary, references })`, is sent after `meta` on the
  turn where the case is set, and again when a new reference case is added.
- `Chat.jsx` shows a small chip under the header line ("Auto-picks from your 8 agents"):
  **⚖ Case E-205791**. Tapping it shows the parties and the reference cases seen so far.
  **The chip only shows the case: it has no Change or Remove.**
- The existing conversation load returns `primary_case` and `reference_cases`, so the chip is
  there when an old chat is reopened.
- When there is no primary case, there is no chip and the layout is the same as today.

### 5. Locked: no way to change it

- There is no route that writes `primary_case`. The only write is the one in `chat()`:
  `UPDATE conversations SET primary_case = ? WHERE id = ? AND user_id = ? AND primary_case IS NULL`.
  The `IS NULL` makes it write once even if two messages arrive together.
- There is no agent tool for it either. The `<primary_case>` block tells the agent the case is
  fixed for this chat. If the user asks to switch, the agent says to start a new chat for that
  case, and can still discuss the other case here as a reference.

## Tests

- `tests/primary-case-detect.test.js`, pure with no DB:
  - the folder-pattern file name gives the number and both parties
  - "check case 205791" matches; "call 0501234567", "AED 205,791", "unit 2057" and
    "26/10/2026" do not
  - two different cases in the first message give `null`
  - Arabic case words work
  - `E-205791`, `E 205791` and `e205791` all give the same key (reuses `caseKey`)
- `tests/primary-case.test.js`, real DB:
  - the first message sets it; a later message with another number adds a reference and
    leaves the primary alone
  - once set, no later message (even one naming only another case) changes it
  - a folder match only uses the user's own `case_folders`, never another user's (this is the
    SQL-scoping test)
  - a legal-case match only applies with the `legal` module
  - without `case_focus`, nothing is detected or saved
  - "hi" first and the case second still sets it
- `systemPrompt` unit check: no `<primary_case>` block when the chat has no primary case, so
  today's prompt is unchanged byte for byte and its cache keeps matching.

## Order of work

1. `primaryCase.js` detector and its pure tests
2. `case_focus` module entry and its settings-menu row; DB columns and the write-once
   set and reference collection in `chat()`, with the DB tests
3. `<primary_case>` prompt block and excerpt labels
4. SSE event and the read-only chip in `Chat.jsx`
5. Carried-chat `case=` attribute and the caseKit default
6. Try it on the screenshot flow locally: send the case PDF first, then ask about another case
   number, and check that the answer keeps them apart

## Decided

1. The first message that names a case sets it, not strictly message #1.
2. It is a per-person module (`case_focus`): given to everyone once, and the master can
   untick it for anyone.
3. The primary case cannot be changed or removed once set: there is no route, no tool and
   nothing on the chip. Another case means a new chat.

---

# Part 2: case side panels (files on the left, timer on the right)

## Why

A chat about a case leaves empty space on both sides on a laptop. That space can show:
- **on the left**, every Shelf file that belongs to the case, so Jeff can open one without
  leaving the chat;
- **on the right**, a timer that runs while he works on the case, so he can later see how much
  time each case took. This is the more important of the two.

## Who sees them

Only chats that have a primary case, for people with the `case_focus` module. Any other chat
looks exactly as it does today.

## Layout

- **Wide screens (≥ 1280px):** three columns. The left rail is about 260px, the chat stays
  `max-w-6xl` in the middle, and the right rail is about 240px. Below 1280px the chat would
  get squeezed, so:
- **Phones and narrow screens:** no side rails. The ⚖ chip from Part 1 also shows the
  running time (**⚖ E-205791 · 0:42**). Tapping it opens a sheet with two tabs: *Files* and
  *Time*.

## Left: the case's files

New route `GET /api/case-focus/:conversationId/files`. It checks that the chat is the user's
own and has a primary case, then returns the user's Shelf documents that:
1. have `case_folder_id` set to the case folder whose `case_key` matches the primary case
   (the PDFs and emails the case folder made, with the summary first, like `caseRoutes.js`
   already sorts them); **or**
2. have a title or name that matches `caseRegex(primary.number)`. These are files saved by
   hand, like "save case 205791 to my shelf".

Each list is the user's own files only (`d.user_id = ?`). A private agent's `ownFilesOnly`
rule applies too, the same as `shelfKit`.

- Each row shows a file icon, the title, and the date. Tapping a row opens the file in the
  existing file viewer (the one the Shelf uses).
- At the top: "12 files · E-205791". At the bottom: a link, "Open in Shelf".
- The list refreshes when the reply's `files` event brings in a newly attached file that
  matches.
- Files of reference cases are **not** listed. This panel is the primary case only, to keep
  with Part 1.

## Right: the case timer

### What counts as time

The timer **starts with the first message Jeff sends** in the chat. **Only he pauses it**:
there is no idle rule and no automatic pause. It keeps running while he reads, thinks, takes
a call, or has another tab in front, until he presses **Pause**.

- **Resume:** press Resume, or send a message in the chat.
- **Reading a file** opened from the left panel counts as time on the case, because the timer
  simply keeps running.
- **Only stops when the chat isn't open:** it does stop when he leaves the chat, closes Reem,
  or the laptop or phone sleeps, because nothing is open to count. When he comes back to the
  chat, it is paused and shows "Paused · send a message or press Resume". It does not quietly
  start again, so the time he was away is never booked.
- **Opening an old case chat** does not start the timer on its own, so looking up an old case
  for a moment costs nothing. The right panel (or the chip on a phone) shows a large
  **▶ Resume** button. One tap starts counting, for example when he opens the case to read its
  files or prepare for a call without typing anything. If the chat has never been timed, the
  button says **▶ Start**.

### Kept on the server, not in the browser

New table:

```sql
CREATE TABLE IF NOT EXISTS case_time (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,          -- caseKey(primary.number): the same case across chats
  case_number TEXT NOT NULL,       -- as written, for showing
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  day DATE NOT NULL,               -- Dubai date (dubaiDate()), for per-day totals
  seconds INTEGER NOT NULL DEFAULT 0,
  last_beat_at BIGINT,
  UNIQUE (user_id, case_key, conversation_id, day)
);
```

This table is added to `TABLES` in `tests/helpers/db.js`.

- While the timer is running, the client sends `POST /api/case-focus/:conversationId/beat`
  every 30 seconds, and once more when it pauses. The server adds the time since
  `last_beat_at`, **capped at 120 seconds per beat**. A sleeping laptop or a lost connection
  therefore cannot add hours, and a closed tab loses at most 30 seconds. The cap is 120
  rather than 60 because browsers slow timers in background tabs to about once a minute, and
  a running timer in a background tab must still count.
- The case comes from the conversation's own `primary_case` on the server, never from the
  client, so time cannot be booked to a case the chat is not about.
- Time follows the **case**, not the chat. Three chats about E-205791 add up to one total.

### What the right panel shows

```
⏱  0:42:10        ⏸ Pause
   this session

Today          1:15
This week      3:40
All time      12:05
   across 4 chats

Last 7 days  ▁▃▅▂▇▁▃
```

`GET /api/case-focus/:conversationId/time` returns today, this week, all time and the last 7
days for this case. These are Jeff's own times only (`user_id = ?`).

### Seeing time across all cases

A **Time on cases** list in the settings menu, under the `case_focus` module row. It shows one
row per case with today, this week, this month and all time, newest first. It has a date
range, and **Download CSV** for billing.

**Only the person themselves sees their time, the master included.** Every `case_time` query
is `WHERE user_id = req.user.id`. There is no route that takes another person's id, and none
on the People profile.

## Tests (Part 2)

- `tests/case-time.test.js`, real DB:
  - a beat adds the time since the last beat; a gap of more than 120 seconds adds only 120
  - the master asking for another user's time gets nothing; there is no such route
  - a beat on a chat with no primary case, or someone else's chat, is refused
  - two chats with the same case add up to one all-time total
  - a beat just after midnight in Dubai lands on the new day, not the UTC day
  - the files route returns case-folder files and title matches, never another user's files,
    and never a reference case's files
- Client, by hand:
  - leave it running in a background tab for 10 minutes and check that about 10 minutes are
    added
  - Pause stops it, and Resume or a sent message starts it
  - leave the chat and come back, and check that it is paused with Resume showing
  - open an old case chat, press Resume without typing, and check that it counts
  - check the layout at 1280px and at phone width

## Order of work (Part 2, after Part 1)

1. `case_time` table, the beat and time routes, and their tests
2. The files route and its test
3. The timer hook in the client (start on send, beats, Pause and Resume, paused on return)
4. The three-column layout at ≥ 1280px, plus the chip and sheet on phones
5. The Time on cases list and CSV
6. Try it with Jeff's E-205791 chat locally

## Decided (Part 2)

1. Manual pause only: there is no idle rule. It runs from the first message until Pause, and
   stops only when the chat is not open at all.
2. Time totals are seen only by the person themselves, never by the master.
3. Reading a file from the left panel counts as time on the case.
