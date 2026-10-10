# Documents register — design (Part 1 of 2)

Date: 2026-10-10
Status: draft, for review (nothing built yet)
Branch: `leasing-bookings`

## 1. The problem

Documents that expire (insurance policies, licences, certificates, maintenance contracts)
are kept in different places and renewed late. Today the app only keeps documents for a
**company**; a building or a unit has nowhere to put one. A company document shows as
"due" on its screen 30 days before it expires, but nothing buzzes a phone.

The business rule: **a policy is renewed within the 3 months before it expires.** So the
work has to start 90 days out, not 30.

## 2. What success looks like

- One screen lists every document of every company, building and unit, soonest expiry
  first.
- Adding one takes a name, a file and an expiry date. The AI reads the file and fills in
  what it can; a person confirms.
- The day a document enters its renewal window, it is on the Alerts screen and the right
  phones buzz. They keep buzzing until the renewed copy is filed.
- The old copy stays, under the new one, as history.

## 3. Out of scope (Part 2, its own design)

- Riley running a renewal: writing quote requests, reading the replies from the inbox,
  comparing quotes, chasing.
- Looking up an insurer's licence or rating.
- Riley answering questions about documents in chat.

Part 1 stores what Part 2 will need (how a document is renewed, and the figures the AI
read from it), and nothing more.

## 4. Key decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **One register, not an insurance feature.** A document is a name, a file, an expiry date and an owner. Insurance is one kind. | Asked for by the business 2026-10-10. Licences and certificates need the same alerts. |
| D2 | **Grow `prop_documents`** rather than add a table. It gains a building or unit as owner. | It already has the name, number, dates, file and the history rule. One table means one screen and one alert rule. |
| D3 | **History stays as it works today:** two documents with the same name under the same owner are one document, renewed. The newest (latest expiry) decides the status; the others are listed under it. | Already built and tested for company documents. Filing the renewed copy is what closes the alert. |
| D4 | **Each document has its own renewal window**, 90 days unless changed. | The 3-month rule is the default, but a trade licence or a short contract may need a different lead time. |
| D5 | **The AI suggests, a person saves.** Reading a file never writes anything. | A wrong expiry date read by a machine and never checked is worse than no date. |
| D6 | Alerts go through the **existing leasing alerts** (`leasingAlerts.js`): same screen, same push, same sent-once log, same quiet hours. | Proven, and staff already look there. |
| D7 | Only the **master** adds, changes or removes; everyone signed in can read. | The rule company documents already follow. |

## 5. Data

`prop_documents` changes (all additive, done with `ALTER TABLE … IF NOT EXISTS` in
`server/db.js`; the tests build their schema from the same file):

| Column | Type | Meaning |
|--------|------|---------|
| `company_id` | now nullable | owner, when it is a company's document |
| `building_id` | FK `prop_buildings`, cascade | owner, when it is a building's |
| `unit_id` | FK `prop_units`, cascade | owner, when it is a unit's |
| `renew_days` | integer, default 90 | how long before expiry the renewal window opens (0–365) |
| `renew_by` | text, default `remind` | `remind` (one issuer: just track it) or `quotes` (shopped around). Part 2 reads this. |
| `details` | text (JSON), default `{}` | figures the AI read and the person confirmed: `insurer`, `premium`, `sum_insured`, `deductible`, `cover`. Free-form; Part 2 compares quotes against it. |

A check constraint holds that **exactly one** of the three owners is set. Existing rows
all have `company_id`, so they pass unchanged.

## 6. Status

`docStatus()` stops using the fixed 30 days and uses the document's own window:

- `on_file` — no expiry date
- `valid` — expires later than `renew_days` from today
- `due` — inside the renewal window
- `expired` — past its expiry date

**A change to notice:** existing company documents get the 90-day default, so they will
show as due 90 days out instead of 30.

## 7. Server (`server/properties.js`)

The company-only functions become owner-aware. Everything that exists keeps working: the
company cards on the Properties home still read `GET /properties/docs`.

- `GET /properties/documents?company_id=&building_id=&status=` — the register: one row per
  document name per owner (the newest copy), with its owner's names, status, days left and
  how many copies sit under that name. Sorted: expired, then due, then valid by expiry,
  then on file. A building filter leaves out company documents.
- `GET /properties/documents/:id/history` — every copy under that document's name and owner.
- `POST /properties/documents` — add, the owner in the body (`company_id`, `building_id` or
  `unit_id`). `POST /properties/companies/:id/docs` stays, calling the same.
- `PUT /properties/docs/:id`, `DELETE /properties/docs/:id`, `GET /properties/docs/:id/file`
  — unchanged, plus the new fields. A document's owner is not changed by an edit.
- `POST /properties/documents/read` — master only. Takes a file, returns suggested fields,
  saves nothing (see §8).
- `GET /properties/places` — the companies, buildings and units, for the owner picker.

## 8. The AI reads the file (`server/documentReader.js`, new)

One function: `readDocument(file) → { title, number, issue_date, expiry_date, renew_by, details }`.

- A PDF or image goes to Claude as the file itself (so a scanned policy works), with a
  short instruction to return those fields as JSON and to leave out anything it cannot see.
- Dates come back as `YYYY-MM-DD` and are checked; a date that is not one is dropped.
- A value is never guessed: no expiry on the page means no expiry suggested.
- Any failure (no key, a refusal, a timeout, an odd file type) returns `{}`. The form
  stays empty and the person types. Reading can never block saving.
- The model client is passed in, so tests give it a stub.

## 9. Alerts (`server/leasingAlerts.js`)

A new rule `document`, with a setting the master can change on the Alerts settings:

```
document: { on: true, days: [60, 30, 7], every: 7 }
```

For the newest copy of each document name per owner, with an expiry date:

| When | Level | Buzzes a phone |
|------|-------|----------------|
| The window opens (`renew_days` before expiry) | info | yes, that day |
| Each of `days` before expiry | info, `warn` from 30 days in | yes, that day |
| The expiry day | bad | yes |
| After expiry | bad | every `every` days |

- It is on the Alerts screen the whole time it is inside the window or expired, whether or
  not a notice went out.
- Title: `Fire insurance expires in 90 days` / `Fire insurance has expired`. Detail: the
  owner (`Al Noor Tower` or `Unit 204, Al Noor Tower` or the company) and the date.
- Who hears: the building's staff (`prop_building_staff`) for a building's or a unit's
  document, and the master always. A company's document goes to the master only.
- These alerts belong to no lease, so they are added beside the lease ones rather than
  through the booking helper, and they respect the screen's company / building filter.
- It closes itself: once a newer copy is filed, that copy decides, and the alert is gone.
- `open: 'documents'` takes the person to the document on the register.

## 10. Screens (client)

- **Documents**, its own row in the sidebar (a Leasing page, like Alerts), with a badge of
  how many are due or expired. A list: name, owner, expiry, status chip. Filters: company,
  building, status — with the themed searchable `Select.jsx`, never a browser `<select>`.
  Dates in the region's format (`usFormat`).
- **Add / edit form** (`DocumentForm.jsx`, shared): choose the owner (company, building or
  unit), attach the file. The file is sent to `/documents/read` and the boxes still empty
  fill in, marked as suggested until the person touches them. Fields: name, number, issue
  date, expiry date, renewal window (days), how it is renewed, notes; for `quotes`
  documents the figures in `details`.
- **A document's sheet** (`DocumentSheet.jsx`, shared): the current copy, "Add a renewal"
  (prefilled with the same name, owner and window), and the older copies under it.
- **Properties:** the company cards keep their Documents tab, now using the shared form
  and sheet (so company documents get the AI reading and the renewal window too). A
  building's page gains a **Documents** tab: that building's documents and its units'.
- **Alerts:** the new rule shows with the others, with its own switch and days in settings.
  Tapping one opens that document on the register.

## 11. Errors

- No owner, or more than one: refused with a plain message.
- No name: "Give the document a name." (as today).
- A bad date, or a window outside 0–365: refused, naming the field.
- Removing a building or unit removes its documents and their files (cascade, then the
  files are deleted from disk).

## 12. Tests

In `tests/`, run in `/root/jarvis-dev` on the droplet, never against production:

- Register: a document for each kind of owner; exactly-one-owner is enforced; the list's
  order and filters; history groups by owner and name, newest first.
- Status: the four states around a 90-day window and around a changed window.
- Alerts: the window opening, each chosen day, the expiry day, the repeat after expiry;
  who is told for each kind of owner; sent once a day; quiet hours; closed by a renewed copy.
- Reader: a stubbed model's answer becomes the suggested fields; a bad date is dropped; a
  failure gives `{}`; nothing is written.
- The existing company-document tests still pass.
