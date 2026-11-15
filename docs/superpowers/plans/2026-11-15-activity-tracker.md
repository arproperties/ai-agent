# Activity Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows tray app that counts time per app on each employee PC and sends the day to Reem, and a small Reem add-on that emails HR one digest a day.

**Architecture:** Two halves joined by one JSON contract. Reem's half is one server file (`server/tracker.js`) mounted like the saifsys door, three tables, one timer and one master-only Settings page. The desktop half is an Electron tray app in `activity-tracker/` whose logic (poll → spans → day summary → send) is plain Node modules tested without Electron.

**Tech Stack:** Reem side: Express 5, `pg` through `db.js`, `nodemailer` through `mailer.js`, React 19 client. Desktop: Electron, `get-windows`, `better-sqlite3`, `electron-builder`; `node:test` for both.

**Spec:** `docs/superpowers/specs/2026-11-15-activity-tracker-design.md`

## Global Constraints

- No AI calls anywhere. No `ai.js` import in `tracker.js`; no model in the desktop app.
- Reem untouched except: `server/tracker.js` (new), DDL in `server/db.js`, two mounts and one timer line in `server/index.js`, `html` parameter on `sendMail` in `server/mailer.js`, `trackerReach` in `server/access.js`, one client page plus its menu row and panel. Nothing else in `server/` or `client/` changes.
- The desktop app lives in `activity-tracker/` with its own `package.json` and `CLAUDE.md`; Reem's `npm run build`, `npm test` and deploy never touch it.
- Everything that emails real people is off by default: `tracker_settings.on` defaults false; `startTracker()` starts only under the existing `sending` flag in `index.js`.
- Every on/off is a toggle in the Reem Settings page, never only `.env`.
- Perf budget (desktop, tray mode, 10 minutes): CPU average under 1%; RAM target 100 MB, `npm run perf` fails above 150 MB; disk flush once a minute; one request to Reem a day plus retries.
- Day boundary is Dubai midnight; all times the PC sends are Dubai `HH:MM`; dates are `YYYY-MM-DD` from `dubaiDate()` (server) or the same formula (PC).
- Idle = no input over 180 seconds while unlocked. Away = locked or asleep.
- Defaults: HR email `hr@ainalreemproperty.com`; digest at `19:00`; PC day end = digest time minus 30 minutes (`18:30`); titles on; spans kept 30 days on the PC.
- No Quit, no pause, no "launch at startup" control for employees.
- Comments explain why, in plain language, matching Reem's style.

## Review Focus

1. A PC whose day runs past Dubai midnight (someone working at 00:30): spans must be split at midnight into two dates, never one day of 25 hours. Test in Task 8.
2. A resend for a day HR has already been emailed: it must appear under "Updated: <date>" in the next digest, never silently replace what HR saw. Test in Task 3 and Task 2.
3. "Include window titles" switched off: titles must be absent from the HTML, the text and the CSV alike. Test in Task 3.
4. A device the master deleted while its PC still sends: Reem answers 401 and the PC shows "This PC is no longer paired" on its sheet instead of retrying forever. Test in Task 2 (server) and Task 10 (client).
5. Digest due but SMTP not configured or HR email blank: the tick logs and leaves the rows pending for the next tick, it never marks them digested or crashes the timer. Test in Task 4.

---

## The contract (both halves implement exactly this)

Headers on every PC request: `X-Tracker-Key: <key>` (the plain key, 43 chars base64url; Reem stores only its sha256).

`POST /api/from-tracker/hello` → `200 { name: 'Francisca', device: 'Front desk PC', day_end: '18:30' }`
`POST /api/from-tracker/day` body:

```json
{
  "date": "2026-11-15",
  "first_seen": "08:52", "last_seen": "17:41",
  "active_seconds": 24480, "idle_seconds": 3120, "away_seconds": 4200,
  "running": [["08:50", "12:10"], ["12:40", "17:45"]],
  "apps": [{ "name": "Excel", "seconds": 11400,
             "titles": [{ "title": "Rent roll Nov.xlsx", "seconds": 7000 }] }]
}
```
→ `200 { ok: true, day_end: '18:30' }`. Unknown or deleted key → `401 { error: 'This PC is not paired with Reem' }`. Bad body → `400`.

---

## Part A: Reem's side

### Task 1: Tables, settings row, device keys and the door's key check

**Files:**
- Modify: `server/db.js` (append DDL after the last block, before line 2893)
- Modify: `tests/helpers/db.js:56` (add to `TABLES`)
- Create: `server/tracker.js`
- Test: `tests/tracker.test.js`

**Interfaces:**
- Produces: `settings(): Promise<{ on, hr_email, send_at, titles_on, sent_on }>`, `newDeviceKey(): string`, `keyHash(key: string): string` (sha256 hex), `dayEndOf(sendAt: 'HH:MM'): 'HH:MM'` (30 minutes earlier), `fromTracker(req, res, next)` sets `req.device = { id, user_id, name }` and `req.user` (the device's person), updates `last_seen_at`.

- [ ] **Step 1: DDL in `server/db.js`** — one `db.exec` block with a why-comment, idempotent:

```sql
CREATE TABLE IF NOT EXISTS tracker_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  "on" BOOLEAN NOT NULL DEFAULT false,
  hr_email TEXT NOT NULL DEFAULT 'hr@ainalreemproperty.com',
  send_at TEXT NOT NULL DEFAULT '19:00',
  titles_on BOOLEAN NOT NULL DEFAULT true,
  sent_on TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tracker_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT
);
CREATE TABLE IF NOT EXISTS tracker_days (
  device_id INTEGER NOT NULL REFERENCES tracker_devices(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  active_seconds INTEGER NOT NULL, idle_seconds INTEGER NOT NULL, away_seconds INTEGER NOT NULL,
  running JSONB NOT NULL DEFAULT '[]', apps JSONB NOT NULL DEFAULT '[]',
  received_at BIGINT NOT NULL,
  pending BOOLEAN NOT NULL DEFAULT true,   -- not yet in an HR email since it last arrived
  digested_at TEXT NOT NULL DEFAULT '',    -- the day of the last email it went in, '' = never
  PRIMARY KEY (device_id, date)
);
```

- [ ] **Step 2: Add `'tracker_settings', 'tracker_devices', 'tracker_days'` to `TABLES` in `tests/helpers/db.js`**

- [ ] **Step 3: Write the failing tests** in `tests/tracker.test.js` (import `./helpers/db.js` first):

```js
test('a new device key is long, random and stored only as its hash', () => {
  const k = newDeviceKey();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newDeviceKey(), k);
  assert.match(keyHash(k), /^[0-9a-f]{64}$/);
});
test('settings start off, HR address and 19:00 filled in', async () => {
  await reset();
  const s = await settings();
  assert.equal(s.on, false); assert.equal(s.hr_email, 'hr@ainalreemproperty.com');
  assert.equal(s.send_at, '19:00'); assert.equal(s.titles_on, true);
  assert.equal(dayEndOf('19:00'), '18:30'); assert.equal(dayEndOf('00:10'), '23:40');
});
test('the door: right key sets the device and its person, wrong or missing key is 401', async () => {
  await reset();
  const u = await makeUser('Francisca');
  const key = newDeviceKey();
  await db.prepare('INSERT INTO tracker_devices (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run(u.id, 'Front desk', keyHash(key), 1);
  const run = (k) => new Promise((done) => {
    const req = { get: (h) => (h === 'X-Tracker-Key' ? k : undefined) };
    const res = { status: (c) => ({ json: (b) => done({ code: c, body: b }) }) };
    fromTracker(req, res, () => done({ code: 200, device: req.device, user: req.user }));
  });
  const ok = await run(key);
  assert.equal(ok.device.name, 'Front desk'); assert.equal(ok.user.id, u.id);
  assert.equal((await run('nope')).code, 401); assert.equal((await run(undefined)).code, 401);
  assert.ok((await db.prepare('SELECT last_seen_at FROM tracker_devices WHERE id = ?').get(ok.device.id)).last_seen_at > 0);
});
```

- [ ] **Step 4: Run to verify they fail** — `$env:TEST_DATABASE_URL='postgres://...'; npm test -- tests/tracker.test.js` → FAIL, module not found.

- [ ] **Step 5: Implement in `server/tracker.js`**: `newDeviceKey` = `randomBytes(32).toString('base64url')`; `keyHash` = sha256 hex; `fromTracker` hashes the header and looks up `tracker_devices JOIN users`, compares nothing in constant time (the hash lookup is the comparison, like a password hash), 401 message exactly `This PC is not paired with Reem`, refuses `users.disabled`; `settings()` inserts the row `ON CONFLICT DO NOTHING` then selects (as `feeds.js:219`).

- [ ] **Step 6: Run tests → PASS. Commit** `feat(tracker): tables, settings and the device-key door`.

### Task 2: The door's routes: hello and day

**Files:**
- Modify: `server/tracker.js`
- Test: `tests/tracker.test.js`

**Interfaces:**
- Produces: `fromTrackerRoutes` (Router: `POST /hello`, `POST /day`), `validDay(body): { ok: true, day } | { ok: false, error }` (pure).

- [ ] **Step 1: Write the failing tests.** Mount `app.use('/api/from-tracker', fromTracker, fromTrackerRoutes)` on an express app in `test.before` as `tests/feeds.test.js` does, with a real device row and key from Task 1. Use the contract body above as `DAY`.

```js
test('hello tells the PC whose it is and when the day ends', async () => {
  const r = await post('/hello', {}, key);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'Francisca', device: 'Front desk', day_end: '18:30' });
});
test('a day is stored once per device and date; a resend replaces it and is pending again', async () => {
  assert.equal((await post('/day', DAY, key)).status, 200);
  await db.prepare('UPDATE tracker_days SET pending = false, digested_at = ?').run('2026-11-15');
  const r = await post('/day', { ...DAY, active_seconds: 30000 }, key);
  assert.deepEqual(await r.json(), { ok: true, day_end: '18:30' });
  const rows = await db.prepare('SELECT * FROM tracker_days').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].active_seconds, 30000);
  assert.equal(rows[0].pending, true, 'arrives again, so HR must hear of the change');
  assert.equal(rows[0].digested_at, '2026-11-15', 'but Reem remembers it was already emailed');
});
test('a bad day is refused: wrong date, negative seconds, apps not a list, titles over 5', async () => {
  for (const bad of [{ ...DAY, date: '15/11/2026' }, { ...DAY, active_seconds: -1 }, { ...DAY, apps: 'x' },
    { ...DAY, apps: [{ name: 'A', seconds: 1, titles: Array(6).fill({ title: 't', seconds: 1 }) }] }]) {
    assert.equal((await post('/day', bad, key)).status, 400);
  }
});
test('a deleted device gets 401 with the pairing message', async () => {
  await db.prepare('DELETE FROM tracker_devices').run();
  const r = await post('/day', DAY, key);
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'This PC is not paired with Reem');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `validDay` (date `/^\d{4}-\d{2}-\d{2}$/`, times `/^\d{2}:\d{2}$/`, integers ≥ 0, `running` an array of `[HH:MM, HH:MM]`, `apps` ≤ 50 entries each `{ name: string ≤ 120, seconds ≥ 0, titles: ≤ 5 of { title ≤ 200, seconds } }`; truncate strings rather than refuse) and the two routes; the upsert is `INSERT … ON CONFLICT (device_id, date) DO UPDATE SET … pending = true, received_at = …`, leaving `digested_at` as it was. Handlers wrapped with the usual local `wrap()`.
- [ ] **Step 4: Run → PASS. Commit** `feat(tracker): the PC's door, hello and day`.

### Task 3: Rendering the digest (pure)

**Files:**
- Modify: `server/tracker.js`
- Test: `tests/tracker.test.js`

**Interfaces:**
- Produces: `fmtSeconds(n): string` ('6h 48m', '52m', '0m'); `renderDigest({ day, people, late, updated, titlesOn }): { subject, text, html, csv }` where each entry of `people/late/updated` is `{ name, date, first_seen, last_seen, active_seconds, idle_seconds, away_seconds, running, apps }` or `{ name, date, missing: true }` and `running` gaps over 600 s between `first_seen` and `last_seen` print as `tracker not running HH:MM–HH:MM`; `topApps(apps, n = 3): string` → `Excel 3h 10m · Chrome 2h 05m`.

- [ ] **Step 1: Write the failing tests.**

```js
test('seconds read as hours and minutes', () => {
  assert.equal(fmtSeconds(24480), '6h 48m'); assert.equal(fmtSeconds(3120), '52m'); assert.equal(fmtSeconds(0), '0m');
});
test('the digest names the day, lists everyone, marks who has no report and who came late or changed', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: true,
    people: [{ name: 'Francisca', ...DAY }, { name: 'Ali', date: '2026-11-15', missing: true }],
    late: [{ name: 'Ali', ...DAY, date: '2026-11-14' }], updated: [] });
  assert.equal(d.subject, 'Activity report — Sat 15 Nov 2026');
  assert.match(d.text, /Francisca\s+08:52\s+17:41\s+6h 48m\s+52m\s+1h 10m\s+Excel 3h 10m/);
  assert.match(d.text, /Ali\s+—\s+—\s+no report yet/);
  assert.match(d.text, /Late: Fri 14 Nov/);
  assert.match(d.text, /tracker not running 12:10–12:40/, 'a gap in running shows');
  assert.match(d.csv, /^name,date,app,seconds,title,title_seconds\r?\n/);
  assert.match(d.csv, /Francisca,2026-11-15,Excel,11400,Rent roll Nov.xlsx,7000/);
  assert.match(d.html, /<table/);
});
test('titles off: no window title anywhere, in text, html or csv', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: false, people: [{ name: 'Francisca', ...DAY }], late: [], updated: [] });
  for (const part of [d.text, d.html, d.csv]) assert.doesNotMatch(part, /Rent roll/);
  assert.match(d.csv, /Francisca,2026-11-15,Excel,11400,,$/m);
});
test('a day that changed after HR saw it is listed under Updated', () => {
  const d = renderDigest({ day: '2026-11-15', titlesOn: true, people: [], late: [], updated: [{ name: 'Tauqeer', ...DAY, date: '2026-11-14' }] });
  assert.match(d.text, /Updated: Fri 14 Nov\s*\n\s*Tauqeer/);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Plain text with padded columns (name 14, times 8, durations 9); HTML a simple table styled like the password-reset email in `mailer.js`; CSV one row per person per app, with a title row per title when titles are on, header exactly `name,date,app,seconds,title,title_seconds`. Day names from `toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' })` reshaped to `Sat 15 Nov 2026`.
- [ ] **Step 4: Run → PASS. Commit** `feat(tracker): the HR digest, text, html and csv`.

### Task 4: The 19:00 timer

**Files:**
- Modify: `server/mailer.js:39-42` (`sendMail` takes and passes `html`)
- Modify: `server/tracker.js`
- Test: `tests/tracker.test.js`

**Interfaces:**
- Produces: `collect(day): Promise<{ people, late, updated }>` (everyone with a device: today's pending rows summed per person, people with no row today as `missing`; pending rows for earlier dates split by `digested_at === ''` → late, else updated); `tick({ now = Date.now(), send = sendMail } = {})`; `startTracker()` (5-minute `setInterval`, `unref`, like `startFeeds`).
- Rule: `tick` sends only when `settings().on`, Dubai minutes ≥ `send_at`, and `sent_on !== today`. After a successful send: every included row `pending = false, digested_at = today`; `sent_on = today`. If `send` throws or `hr_email` is blank: log `[tracker]`, change nothing.

- [ ] **Step 1: Write the failing tests** (two devices for one person to prove summing; `send` is a stub collecting calls):

```js
test('collect sums a person with two PCs and lists people with no report', async () => { /* two devices, one user; a second user with none; assert active_seconds doubled and missing:true */ });
test('tick sends once a day at the set time, to the HR address, then marks the rows digested', async () => {
  await db.prepare(`UPDATE tracker_settings SET "on" = true, send_at = '00:00'`).run();
  const sent = [];
  await tick({ send: async (m) => { sent.push(m); } });
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'hr@ainalreemproperty.com');
  assert.equal(sent[0].attachments[0].filename, `activity-${dubaiDate()}.csv`);
  await tick({ send: async (m) => { sent.push(m); } });
  assert.equal(sent.length, 1, 'not twice');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM tracker_days WHERE pending').get()).n, 0);
});
test('tick does nothing while the switch is off, and keeps rows pending when mail fails', async () => {
  /* on=false → send never called; then on=true with send that throws → rows still pending, sent_on still '' */
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `collect`, `tick`, `startTracker`; add `html` to `sendMail`. `startTracker` wraps `tick` in `billAs({ userId: null, job: 'other' }, …)` as `index.js:646` does for other timers.
- [ ] **Step 4: Run → PASS. Commit** `feat(tracker): one HR email a day`.

### Task 5: Master routes, access rule, and wiring into Reem

**Files:**
- Modify: `server/access.js` (add `export const trackerReach = (user) => isMaster(user);` with a why-comment)
- Modify: `server/tracker.js`
- Modify: `server/index.js` (import; `app.use('/api/from-tracker', fromTracker, fromTrackerRoutes)` next to the from-saifsys lines 121-122; `app.use('/api/tracker', requireMaster, trackerRoutes)` near line 183; `if (sending) startTracker();` near line 655 with a one-line why)
- Test: `tests/tracker.test.js`, `tests/access.test.js` if it exists (else in tracker.test.js)

**Interfaces:**
- Produces: `trackerRoutes` (Router, mounted behind `requireMaster`): `GET /` → `{ settings, devices: [{ id, user_id, name, person, created_at, last_seen_at }], days: last 7 days of rows joined with person name }`; `PUT /settings` body any of `{ on, hr_email, send_at, titles_on }` → the settings (refuse `send_at` not `HH:MM`, `hr_email` not an email); `POST /devices { user_id, name }` → `{ id, key }` (the key is shown once and never again); `DELETE /devices/:id` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**: settings round-trip and refusal (`send_at: '25:00'` → 400, `hr_email: 'x'` → 400); `POST /devices` returns a key that opens the door (reuse Task 2's `post`) and `GET /` shows the device without any key; `DELETE` then the door is 401; `trackerReach({ role: 'master' }) === true` and `false` for a normal user.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the routes and the three `index.js` lines.
- [ ] **Step 4: Run the whole suite** `npm test` → all pass (same count of pre-existing Windows-only failures as `main`, note them). **Commit** `feat(tracker): master routes and wiring`.

### Task 6: The Settings page in the client

**Files:**
- Create: `client/src/components/ActivityReports.jsx`
- Modify: `client/src/components/SettingsMenu.jsx:148` (a master-only `Row` labelled "Activity reports", icon `Timer` from lucide, props `trackerOpen`, `onTracker`)
- Modify: `client/src/App.jsx` (import; pass `trackerOpen={panel === 'tracker'} onTracker={…}` beside the feeds props at line 261; render `{panel === 'tracker' && me.role === 'master' && <ActivityReports onBack={() => setPanel(null)} />}` beside line 327)

- [ ] **Step 1: Build the page** with `Page` (as `Apps.jsx`): an on/off toggle (copy `AutoSetting` from `Feeds.jsx:105`), HR email field, send time field (`<input type="time">`), "Include window titles" toggle, the device list (person, device name, last seen, Delete), a "New device" form (person select from `api.get('/people')` or the users list the People page uses, device name) that shows the key once with a Copy button and the sentence "Paste this key into the tracker on that PC. It is shown only now.", and a "Last 7 days" table (person, date, first, last, active, idle, away). Every API error goes to the page, not `console`.
- [ ] **Step 2: Wire the row and the panel.**
- [ ] **Step 3: Verify** `npm run build` succeeds; run `npm run dev`, open Settings → Activity reports as the master, create a device, copy the key, delete it. Screenshot not required; note what was clicked.
- [ ] **Step 4: Commit** `feat(tracker): Activity reports page in Settings`.

---

## Part B: The desktop app (`activity-tracker/`)

### Task 7: Scaffold and spans (poll → spans)

**Files:**
- Create: `activity-tracker/package.json` (`"type": "module"`, scripts `start: electron .`, `test: node --test tests/`, `perf: node scripts/perf.js`, `dist: electron-builder --win nsis`; deps `better-sqlite3`, `get-windows`; devDeps `electron`, `electron-builder`; `build` section: `appId com.reem.activity-tracker`, `productName "Activity Tracker"`, `nsis: { oneClick: true, perMachine: false }`, `files: ["src/**", "ui/**"]`)
- Create: `activity-tracker/src/spans.js`
- Create: `activity-tracker/.gitignore` (`node_modules`, `dist`)
- Test: `activity-tracker/tests/spans.test.js`

**Interfaces:**
- Produces: `IDLE_AFTER = 180`; `class SpanBook { observe({ at, app, title, idleSeconds, locked }): Span | null; close(at): Span | null; running: Array<[number, number]>; markRunning(at); stopRunning(at) }` where `Span = { startedAt, endedAt, app, title, kind: 'active' | 'idle' | 'away' }`, times in epoch seconds. `observe` returns the span it just closed (when app/title/kind changed) or null.

- [ ] **Step 1: Write the failing tests.**

```js
test('the same window for a minute is one span, not twelve', () => {
  const b = new SpanBook();
  for (let t = 0; t < 60; t += 5) assert.equal(b.observe({ at: 1000 + t, app: 'Excel', title: 'Rent roll', idleSeconds: 0, locked: false }), null);
  assert.deepEqual(b.close(1060), { startedAt: 1000, endedAt: 1060, app: 'Excel', title: 'Rent roll', kind: 'active' });
});
test('changing window closes the old span; idle over 180 s becomes an idle span dated from when input stopped', () => {
  const b = new SpanBook();
  b.observe({ at: 1000, app: 'Excel', title: 'A', idleSeconds: 0, locked: false });
  const s = b.observe({ at: 1300, app: 'Excel', title: 'A', idleSeconds: 200, locked: false });
  assert.deepEqual(s, { startedAt: 1000, endedAt: 1100, app: 'Excel', title: 'A', kind: 'active' }, 'active ends when the hands left, 1300-200');
  assert.equal(b.observe({ at: 1305, app: 'Chrome', title: 'B', idleSeconds: 0, locked: false }).kind, 'idle');
});
test('locked is away regardless of idle', () => {
  const b = new SpanBook();
  b.observe({ at: 1, app: 'Excel', title: 'A', idleSeconds: 0, locked: true });
  assert.equal(b.close(10).kind, 'away');
});
test('running segments follow mark and stop', () => {
  const b = new SpanBook(); b.markRunning(100); b.stopRunning(200); b.markRunning(300);
  assert.deepEqual(b.running, [[100, 200], [300, null]]);
});
```

- [ ] **Step 2: `npm install` in `activity-tracker/`, run `npm test` → FAIL.**
- [ ] **Step 3: Implement `spans.js`.**
- [ ] **Step 4: Run → PASS. Commit** `feat(activity-tracker): scaffold and spans`.

### Task 8: The day summary (spans → contract JSON)

**Files:**
- Create: `activity-tracker/src/summary.js`
- Test: `activity-tracker/tests/summary.test.js`

**Interfaces:**
- Produces: `dubaiDate(epochSeconds): 'YYYY-MM-DD'`, `dubaiTime(epochSeconds): 'HH:MM'`; `cleanTitle(app, title): string` (strips a trailing ` - <app name>`, ` — Mozilla Firefox`, ` - Google Chrome`, ` - Microsoft Excel`/Word, and anything after ` | ` for sites that pad titles); `splitAtMidnight(spans): spans` (a span crossing Dubai midnight becomes two); `summarise(spans, running, date): DayJson` exactly in the contract shape, `apps` sorted by seconds desc, each with top 5 titles by seconds; only `active` spans count toward apps and `active_seconds`.

- [ ] **Step 1: Write the failing tests** with fixed epochs (compute them with `Date.UTC` so Dubai = UTC+4):

```js
test('a span over Dubai midnight is two spans on two dates', () => {
  const t = Date.UTC(2026, 10, 15, 19, 50) / 1000; // 23:50 Dubai
  const [a, b] = splitAtMidnight([{ startedAt: t, endedAt: t + 1200, app: 'X', title: 'T', kind: 'active' }]);
  assert.equal(dubaiDate(a.endedAt), '2026-11-15'); assert.equal(dubaiDate(b.startedAt), '2026-11-16');
  assert.equal(a.endedAt, b.startedAt); assert.equal(b.endedAt - b.startedAt, 600);
});
test('titles are cleaned of the app suffix', () => {
  assert.equal(cleanTitle('Google Chrome', 'Dubai Land Department - Google Chrome'), 'Dubai Land Department');
  assert.equal(cleanTitle('Excel', 'Rent roll Nov.xlsx - Excel'), 'Rent roll Nov.xlsx');
});
test('summarise follows the contract: totals, apps by time, five titles at most', () => {
  const d = summarise(SPANS, [[T0, T0 + 3600]], '2026-11-15'); // SPANS: 7 titles in Excel, one Chrome, one idle, one away
  assert.equal(d.date, '2026-11-15'); assert.match(d.first_seen, /^\d\d:\d\d$/);
  assert.equal(d.apps[0].name, 'Excel'); assert.equal(d.apps[0].titles.length, 5);
  assert.equal(d.active_seconds, d.apps.reduce((n, a) => n + a.seconds, 0));
  assert.deepEqual(d.running, [[dubaiTime(T0), dubaiTime(T0 + 3600)]]);
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS. Commit** `feat(activity-tracker): the day summary`.

### Task 9: Local store (SQLite)

**Files:**
- Create: `activity-tracker/src/store.js`
- Test: `activity-tracker/tests/store.test.js` (a temp file via `os.tmpdir()`, removed after)

**Interfaces:**
- Produces: `openStore(path): Store`; `Store.addSpans(spans)`, `Store.spansOn(date): Span[]`, `Store.runningOn(date): Array<[number, number]>` and `Store.addRunning(seg)`, `Store.markSent(date, epoch)`, `Store.sentAt(date): number | null`, `Store.prune(days = 30)`, `Store.get(key)/set(key, value)` for settings (`reem_url`, `device_key` (already encrypted by the caller), `consented_at`, `day_end`, `person_name`, `pair_error`), `Store.close()`. Tables `spans`, `running`, `days`, `settings` as the spec lists; DDL idempotent.

- [ ] **Step 1: Write the failing tests**: add 3 spans on two dates and read one date back; `markSent` then `sentAt`; `prune(30)` removes a span 31 days old and keeps one 29 days old; `set`/`get` round-trip; opening the same file twice does not fail (idempotent DDL).
- [ ] **Step 2: Run → FAIL. Step 3: Implement with `better-sqlite3` (synchronous API, `PRAGMA journal_mode = WAL`). Step 4: Run → PASS. Commit** `feat(activity-tracker): local store`.

### Task 10: Day end and talking to Reem

**Files:**
- Create: `activity-tracker/src/dayEnd.js`
- Create: `activity-tracker/src/reem.js`
- Test: `activity-tracker/tests/dayEnd.test.js`, `activity-tracker/tests/reem.test.js` (a local `http.createServer` stub)

**Interfaces:**
- Produces: `shouldSend({ nowDubai: 'HH:MM', dayEnd: 'HH:MM', sentAt: number | null, shuttingDown: boolean, lastTry: number | null, now: number }): boolean` — true when (a) `nowDubai >= dayEnd` and not sent today, or (b) `shuttingDown && nowDubai >= '15:00'`, or (c) sent today but new spans exist after it (the resend after 18:30 in the spec) only when `shuttingDown`; false within 15 minutes (900 s) of a failed `lastTry`. `yesterdayUnsent(store, today)`: dates with spans and no `sentAt` before today, so a PC that was off sends them on start.
- `hello(url, key): Promise<{ name, device, day_end }>`; `sendDay(url, key, day): Promise<{ ok, day_end }>`; both throw `PairingError` on 401 (message from the server) and plain `Error` otherwise; 10-second timeout via `AbortSignal.timeout`.

- [ ] **Step 1: Write the failing tests**: the five `shouldSend` cases above; `hello` and `sendDay` hit the stub and return its JSON with the header `X-Tracker-Key` seen; a 401 stub throws `PairingError` with message `This PC is not paired with Reem`; a 500 stub throws a plain `Error`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS. Commit** `feat(activity-tracker): day end and the Reem door`.

### Task 11: The Electron app: tray, poll, first run, sheet

**Files:**
- Create: `activity-tracker/src/main.js` (Electron main, ESM), `activity-tracker/src/preload.js`, `activity-tracker/ui/firstrun.html`, `activity-tracker/ui/sheet.html`, `activity-tracker/ui/icon.png` + `icon-paused.png` (16/32 px, green and grey dot)
- Create: `activity-tracker/CLAUDE.md`, `activity-tracker/README.md`

**Interfaces:**
- Consumes: everything from Tasks 7–10.
- Behaviour fixed by the spec (no choices left): `app.disableHardwareAcceleration()` before ready; `os.setPriority(process.pid, 10)` (below normal); single-instance lock; `app.setLoginItemSettings({ openAtLogin: true })` after consent; poll every 5 000 ms calling `activeWindow()` from `get-windows` plus `powerMonitor.getSystemIdleTime()` and a `locked` flag kept from `powerMonitor` `lock-screen`/`unlock-screen`/`suspend`/`resume`; flush closed spans and `running` to the store every 60 000 ms; day-end check every minute using `shouldSend`; `powerMonitor.on('shutdown')` → `close` the open span, flush, try `sendDay` (synchronously bounded: `e.preventDefault()` then `app.quit()` after send or 8 s); on start, send `yesterdayUnsent` days; `prune(30)` once a day; Reem URL fixed to `https://ainalreemproaiagent.fun` with an override in `settings.reem_url` for local testing; device key stored as `safeStorage.encryptString(key).toString('base64')`.
- Tray: icon green while polling; menu `Open`, `Send today now`; no Quit. Clicking opens the sheet (a 360×480 `BrowserWindow`, `show: false` until `ready-to-show`, destroyed on close).
- First run (no `consented_at`): a window with the consent text from the spec (what is recorded, what is not, that a daily summary goes to HR) and a key field; "I understand, start" calls `hello`, saves `person_name`, `day_end`, `consented_at`, then begins polling. A `PairingError` shows under the field.
- Sheet (`sheet.html`, data over `ipcRenderer.invoke('today')`): name line, "reports to HR at day end", today's active/idle totals, apps with minutes and a bar, "Last report sent: …" or the `pair_error` sentence `This PC is no longer paired with Reem. Ask the office to pair it again.`, and the `Send today now` button. No "launch at startup" tick.

- [ ] **Step 1: Write `main.js`, `preload.js`, the two HTML files and the icons.** Keep every pure decision in Tasks 7–10's modules; `main.js` only wires timers, Electron events and IPC.
- [ ] **Step 2: Run it** on this laptop against local Reem (`npm run dev` in Reem with a device created in Task 6; set `reem_url` to `http://localhost:3001` by running once with `REEM_URL=http://localhost:3001 npm start`). Check: consent window shows, pairing works, the tray icon appears, the sheet shows Excel/Chrome minutes after a few minutes, "Send today now" produces a `tracker_days` row in the local DB, a wrong key shows the pairing error.
- [ ] **Step 3: Write `CLAUDE.md`** (what it is, that it is separate from Reem like aol-connector, how to run, test, build the installer, and the contract) and `README.md` for the person installing it (the 3 pairing steps).
- [ ] **Step 4: Commit** `feat(activity-tracker): tray app, first run and today sheet`.

### Task 12: The perf gate and the installer

**Files:**
- Create: `activity-tracker/scripts/perf.js`
- Modify: `activity-tracker/package.json` if the `build` section needs the icon path

**Interfaces:**
- Produces: `npm run perf` → spawns `electron .` with `TRACKER_PERF=1` (skips first run using a dummy key and a stub Reem URL that never resolves), waits 60 s to settle, then every 10 s for 10 minutes reads the whole process tree's CPU seconds and working set via PowerShell `Get-CimInstance Win32_Process` filtered by `ParentProcessId` chain; prints a table (time, cpu %, rss MB per process, total) and exits 1 if the average CPU over the window is ≥ 1% or any sample's total RSS ≥ 150 MB; prints `target 100 MB` beside the result.

- [ ] **Step 1: Write `perf.js`.**
- [ ] **Step 2: Run `npm run perf` on this laptop.** Record the printed averages in `activity-tracker/README.md` under "Measured". If RSS is over 150 MB, stop here and report (spec: come back before building further).
- [ ] **Step 3: Build the installer** `npm run dist` → `activity-tracker/dist/Activity Tracker Setup x.y.z.exe`; install it on this laptop (per-user), confirm it starts with Windows and the tray icon appears after sign-in; uninstall from Windows Settings afterwards if not wanted.
- [ ] **Step 4: Commit** `feat(activity-tracker): perf gate and installer`.

### Task 13: Tell Reem's docs about it

**Files:**
- Modify: `CLAUDE.md` (Reem's, under "aol-connector/ (not part of Reem)": one paragraph "activity-tracker/ (not part of Reem)" naming the folder, the door `/api/from-tracker`, the Settings page, and that its deploy is an installer not pm2)
- Modify: `README.md` (one line in the features list: Activity reports)

- [ ] **Step 1: Write the two paragraphs. Step 2: Commit** `docs: activity tracker in Reem's docs`.

---

## Self-review notes

- Spec coverage: tables, door, digest (today / no report / Late / Updated), timer and switch, Settings page with devices, titles switch, consent screen, no Quit, running gaps, midnight split, 30-day prune, perf gate, unsigned installer, CLAUDE.md: each has a task. "Away" from sleep as well as lock: Task 11 keeps `locked` true across `suspend`→`resume`. Nothing in the spec about the pet, voice or Arabic applies.
- Names used across tasks: `fromTracker`, `fromTrackerRoutes`, `trackerRoutes`, `startTracker`, `tick`, `collect`, `renderDigest`, `fmtSeconds`, `newDeviceKey`, `keyHash`, `dayEndOf`, `settings`, `trackerReach`; desktop: `SpanBook`, `summarise`, `splitAtMidnight`, `cleanTitle`, `dubaiDate`, `dubaiTime`, `openStore`, `shouldSend`, `yesterdayUnsent`, `hello`, `sendDay`, `PairingError`. Checked consistent.
- Proportion: the plan is tests, signatures and the contract; bodies are left to the implementer.
