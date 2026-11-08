# Reem's Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One browser inside Reem that works any website for the person, from the chat: it opens the site, logs in with the login they saved once, does the job step by step while they watch live, hands over for CAPTCHAs/OTPs/UAE Pass, and asks before anything that submits, pays, sends or deletes. The first two uses are the DLD Rental Index (for lease renewals, automatically) and the RDC portal (filing from a renewal's case pack).

**Architecture:** A headless Chromium (Playwright) on the Reem server, one per server, with a separate signed-in context per person (cookies kept encrypted between tasks). A chat kit (`browserKit`) gives the agent a few tools — open, look, act, log in, ask the person, confirm, download, note — and streams a live `browser` card to the chat. A pure guard decides which clicks need the person's OK. Known sites get **recipes**: fixed code for a job done often (DLD), so it runs without AI. Every switch lives in **Settings → Browser** in the app.

**Tech Stack:** Express 5 ESM, Postgres via `db.prepare`, `playwright` (Chromium), React 19 client, `node:test` against real Postgres, `server/secrets.js` `encrypt`/`decrypt`.

**Spec:** No separate spec. Agreed with Francis in chat on 2026-11-08; the decisions are in Global Constraints. Memories: `no-dld-api`, `switches-in-ui`, `chat-only-ux`, `non-technical-users`.

## Global Constraints

- **Switches in the app, never `.env`.** Every on/off and limit is a toggle in Settings → Browser (master), stored in `browser_settings`. No `.env` flag controls the browser.
- **Who gets it:** a Reem module `browser` ("Browser"), ticked per person on their People profile; `company: true`, so external users never get it. The master has it.
- **Never get around a CAPTCHA, OTP or UAE Pass.** The agent calls `browser_ask_person`, and the person does it in the live view.
- **Ask first:** any click the guard marks risky (submit, pay, send, delete, sign, confirm, apply, register, accept terms — English and Arabic — or any button on a page with card-number fields) needs the person's tap on a confirm card. This can't be switched off.
- **Passwords:** typed once in Settings → Browser → Logins, stored with `encrypt()`. They never reach the model, the chat, the logs or a screenshot sent to the model. They're only filled into a page whose host matches the saved login's host.
- **Sessions are per person.** One person's cookies are never used for another person.
- **One task at a time per person; at most 2 browsers open on the server.** Each closes after 5 minutes idle. A person's second task waits ("Reem is still busy with the browser for you").
- **Step cap:** at most `max_steps` (Settings, default **40**) actions per task, then the agent stops and says what it got done.
- **DLD:** only Saif Holding's own leases; at least **90 seconds** between searches; at most **30 a Dubai day**; a block (HTTP 403/429 or an "access denied" page) pauses DLD for **24 hours**; results stay in Reem. Never DLD's paid API, never contact DLD. Search by Ejari first; use the DEWA premise number only when it's 9 digits and no other due lease shares it. Residential only (Apartment, Villa, Hotel Apartment). The allowed increase is exactly 0/5/10/15/20, otherwise the page changed and nothing is saved.
- **Plain words on screen:** "Reem is using the browser", "Take over", "Stop", "Reem wants to press **Submit** on rdc.gov.ae — OK?", "DLD wants you to tick a box".

## Review Focus

1. **The agent clicks Submit/Pay by mistake** (a button labelled only with an icon, or "Next" that actually files). Expected: anything on a page with card fields, or after which the URL looks like a payment page, needs confirming; a click without a valid confirm token is refused. Pinned in Task 2 (guard tests) and Task 4 (a refused click).
2. **A password leaking into the model's view.** Expected: page snapshots show password fields as `[password field]` with no value, and the `browser_login` result says only "Logged in" or "Login didn't work". Pinned in Task 3.
3. **The site logs the person out mid-task** (session expired). Expected: the agent sees the login page, uses the saved login once, and asks the person if that fails — never loops. Pinned in Task 4 (one retry, then ask).
4. **Two people, or two chats, using the browser at once.** Expected: separate contexts, the second task of the same person waits. Pinned in Task 1.
5. **The server restarts mid-task.** Expected: open tasks become "stopped (Reem restarted)" and the card says so; DLD checks left `running` become `failed` and are retried. Pinned in Task 1 and Task 6.

---

## File Structure

- `server/browser/engine.js` — Chromium, per-person contexts, cookies saved and loaded encrypted, tasks, live frames, take-over input, idle close, boot recovery.
- `server/browser/snapshot.js` — the page as the model sees it: numbered clickable/typeable elements and visible text, capped at about 4,000 tokens, passwords hidden.
- `server/browser/guard.js` — pure: does this action need the person's OK?
- `server/browser/logins.js` — saved logins (encrypted), filling them into a page.
- `server/browser/settings.js` — `browser_settings` read/write.
- `server/browser/kit.js` — `browserKit(user, ctx)` for chat.
- `server/browser/routes.js` — `browserRoutes`: live frames, take-over, stop, confirm, logins, settings.
- `server/browser/recipes/dld.js` — the DLD Rental Index recipe and its queue (`dld_checks`).
- `server/browser/recipes/dldParse.js` — pure: DLD's result → `{ pct, averageRent }`.
- Modify: `server/db.js` (tables), `server/modules.js` (the `browser` module), `server/chat.js` (include the kit), `server/index.js` (routes, `startBrowser()`), `server/leaseRenewals.js` (`indexRent()`, `RENT_SOURCES`, `card()`, the renewal settings' DLD switch), `server/shelf` upload path used by downloads.
- Client: `client/src/components/BrowserCard.jsx` (live view in chat), `client/src/components/BrowserSettings.jsx` (Settings → Browser), `client/src/components/DldCheck.jsx` (Start screen), edits in `Chat.jsx`, `lib/petChat.js` (`CARDS`), `LeaseRenewals.jsx`, and the settings menu.
- Tests: `tests/browserGuard.test.js`, `tests/browserSnapshot.test.js`, `tests/browserEngine.test.js`, `tests/browserLogins.test.js`, `tests/browserKit.test.js`, `tests/dldParse.test.js`, `tests/dld.test.js`, additions to `tests/leaseRenewals.test.js`; fixtures in `tests/fixtures/browser/` (small local HTML pages) and `tests/fixtures/dld/`. New tables go in `TABLES` in `tests/helpers/db.js`. Tests that need Chromium skip with a clear message when `chromium.executablePath()` doesn't exist.

**Tables (all in `server/db.js`):**

```sql
CREATE TABLE IF NOT EXISTS browser_settings (id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{}');
  -- data: { enabled: false, max_steps: 40, dld_auto: true }  (enabled starts OFF; the master turns it on)
CREATE TABLE IF NOT EXISTS browser_logins (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, host TEXT NOT NULL, username TEXT NOT NULL, secret TEXT NOT NULL,   -- secret = encrypt(password)
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint, UNIQUE (user_id, host, username));
CREATE TABLE IF NOT EXISTS browser_sessions (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, updated_at BIGINT NOT NULL);
  -- state = encrypt(JSON of Playwright storageState): the person stays signed in between tasks
CREATE TABLE IF NOT EXISTS browser_tasks (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id INTEGER,
  status TEXT NOT NULL,          -- working | waiting_person | waiting_ok | done | stopped
  goal TEXT, url TEXT, steps INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint, updated_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint);
CREATE TABLE IF NOT EXISTS browser_site_notes (host TEXT PRIMARY KEY, notes TEXT NOT NULL, updated_at BIGINT NOT NULL);
  -- what Reem learned about how a site works, shown to the agent next time it opens that host
CREATE TABLE IF NOT EXISTS dld_checks ( ... as in Task 6 ... );
ALTER TABLE lease_renewals ADD COLUMN IF NOT EXISTS dld_check_id INTEGER;
```

---

### Task 1: The engine

**Files:** Create `server/browser/engine.js`, `server/browser/settings.js`; modify `server/db.js`, `package.json` (`playwright`), `tests/helpers/db.js`. Test: `tests/browserEngine.test.js`.

**Interfaces — Produces:**
- `getSettings() -> { enabled, max_steps, dld_auto }`; `setSettings(master, patch)`.
- `openTask(user, { conversationId, goal }) -> task` — throws 409 "Reem is still busy with the browser for you" if the person has a `working`/`waiting_*` task; throws 403 "The browser is switched off in Settings" when `enabled` is false.
- `pageOf(taskId) -> Playwright Page` (the task's one tab; a popup a site opens replaces it).
- `frame(taskId) -> { jpeg: Buffer, at } | null` — refreshed after every action and every 1s while `waiting_person`.
- `personInput(taskId, user, { kind: 'click'|'type'|'key', x?, y?, text?, key? })` — the person's take-over; only the task's owner.
- `endTask(taskId, status, note?)` — saves the cookies (`browser_sessions`, encrypted), closes the context.
- `recoverAtBoot()` — open tasks → `stopped`, note "Reem restarted".
- `useForTests(over)` — swaps `D = { launch: () => chromium.launch(), now }`.
- Viewport 1300×1800; contexts close after 5 minutes without an action; at most 2 contexts at once (a third person waits in a queue with "Waiting for the browser…").

- [ ] **Step 1: Failing tests** — `'one task per person; a second waits with a 409'`, `'two people get separate contexts and separate cookies'` (serve `tests/fixtures/browser/cookie.html` from a local `http.createServer`, set a cookie as A, B doesn't see it), `'cookies are kept between tasks, encrypted'` (the `browser_sessions.state` doesn't contain the cookie value in plain text), `'switched off in Settings → 403'`, `'restart marks open tasks stopped'`, `'only the owner can take over'`.
- [ ] **Step 2:** `npm test -- tests/browserEngine.test.js` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit: `feat(browser): a browser on the server, one signed-in context per person`.

### Task 2: The guard

**Files:** Create `server/browser/guard.js`. Test: `tests/browserGuard.test.js` (pure).

**Interfaces — Produces:** `needsOk({ label: string, role: string, pageHasCardFields: boolean, url: string, isFormSubmit: boolean }) -> { ok: false, why: string } | { ok: true }`.

- [ ] **Step 1: Failing tests**

```js
for (const label of ['Submit', 'Pay now', 'Confirm', 'Send', 'Delete', 'Sign', 'Apply', 'Register', 'I agree', 'Accept', 'إرسال', 'تأكيد', 'دفع', 'سداد', 'حذف', 'تقديم'])
  test(`"${label}" needs the person's OK`, () => assert.equal(needsOk({ label, role: 'button', pageHasCardFields: false, url: 'https://x.ae/a', isFormSubmit: false }).ok, false));
for (const label of ['Search', 'Calculate', 'Next page', 'Login', 'Log in', 'Show results', 'بحث'])
  test(`"${label}" doesn't`, () => assert.equal(needsOk({ label, role: 'button', pageHasCardFields: false, url: 'https://x.ae/a', isFormSubmit: true }).ok, true));
test('any button on a page with card fields needs OK', () => assert.equal(needsOk({ label: 'Continue', role: 'button', pageHasCardFields: true, url: 'https://x.ae', isFormSubmit: false }).ok, false));
test('a payment page needs OK', () => assert.equal(needsOk({ label: 'Continue', role: 'button', pageHasCardFields: false, url: 'https://pay.example.com/checkout', isFormSubmit: false }).ok, false));
test('an unlabelled submit button needs OK', () => assert.equal(needsOk({ label: '', role: 'button', pageHasCardFields: false, url: 'https://x.ae', isFormSubmit: true }).ok, false));
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (word lists; `Log in`/`Login`/`Search`/`Calculate` are allow-listed before the risky words; payment URL = `/pay|checkout|payment|ngenius|telr|ziina|stripe|paypal/i`). **Step 4:** → PASS.
- [ ] **Step 5:** Commit: `feat(browser): the clicks that need the person's OK`.

### Task 3: What the model sees, and saved logins

**Files:** Create `server/browser/snapshot.js`, `server/browser/logins.js`. Tests: `tests/browserSnapshot.test.js`, `tests/browserLogins.test.js`; fixtures `tests/fixtures/browser/form.html`, `login.html`, `pay.html`.

**Interfaces — Produces:**
- `snapshot(page) -> { url, title, text: string, refs: Map<number, ElementHandle>, hasCardFields: boolean }` — `text` is one line per visible element, `[12] button "Calculate"`, `[13] select "Property Type" = Apartment (Apartment|Villa|Hotel Apartment)`, `[14] [password field]`, then the page's visible text, capped at 16,000 characters (the end is cut, with "…page continues, scroll to see more").
- `listLogins(user) -> [{ id, label, host, username }]` (never the password); `saveLogin(user, { label, url, username, password })` (host from the URL, lowercased, `www.` removed); `removeLogin(user, id)`.
- `fillLogin(user, page, loginId) -> 'filled' | 'wrong_site' | 'no_fields'` — only when the page's host is the login's host or a subdomain of it; types into the username and password fields; never returns or logs the password.

- [ ] **Step 1: Failing tests** — `'snapshot numbers the buttons, fields and selects of form.html'`, `'a password field shows no value'`, `'card fields are noticed on pay.html'`, `'long pages are cut with the scroll hint'`, `'a login fills only on its own site'` (`wrong_site` on another host), `'listLogins never returns the password; the stored secret isn't the password in plain text'`, `'another person can't use or see my login'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit: `feat(browser): the page as Reem reads it, and logins saved once`.

### Task 4: The chat kit

**Files:** Create `server/browser/kit.js`; modify `server/chat.js` (add `browserKit` to `kits` when the person has the `browser` module and Settings has `enabled`), `server/modules.js` (`{ key: 'browser', label: 'Browser', about: 'Reem opens websites and does the job for them — logs in with their saved login, fills forms, downloads — while they watch, and asks before anything is submitted, paid, sent or deleted.', company: true }`). Test: `tests/browserKit.test.js`.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `browserKit(user, { conversationId, onCard }) -> { definitions, status, run(block) }` with these tools (each returns the fresh `snapshot().text` unless noted):
  - `browser_open({ url, goal })` — starts the task (or reuses the person's open one); sends `onCard({ type: 'browser', taskId, url, status })`. Adds `browser_site_notes` for that host and the person's saved logins for it (label + username only) to the result.
  - `browser_look()` — the snapshot again.
  - `browser_act({ ref, do: 'click'|'type'|'choose'|'key'|'scroll'|'upload', value? })` — `click` runs `needsOk` first; risky → returns "Needs the person's OK: call browser_confirm" and does nothing. `upload` takes a Shelf document id the person can open (same access check as the Shelf) and attaches that file to the file input.
  - `browser_confirm({ ref, what })` — sends a confirm card ("Reem wants to press **Submit** on rdc.gov.ae — OK?"), sets the task to `waiting_ok`, and returns only after the person taps OK (then clicks) or No (then returns "The person said no"). Times out after 10 minutes → "No answer".
  - `browser_login({ loginId })` — `fillLogin`, then presses the page's login button (allow-listed in the guard). Returns "Logged in" / "Login didn't work" — never the password.
  - `browser_ask_person({ why })` — `waiting_person`, card says why ("DLD wants you to tick a box", "Approve the UAE Pass request on your phone"), push to the person; returns when they tap **Done** in the card (or after 10 minutes, "No answer").
  - `browser_download({ ref, name })` — clicks, catches the download, files it on the person's Shelf, and returns the Shelf link.
  - `browser_note({ text })` — saves or extends what was learned about this site (≤ 2,000 characters per host).
  - `browser_done({ summary })` — `endTask(done)`.
- Every tool counts a step; at `max_steps` the next call returns "Step limit reached: tell the person what's done and stop".
- Kit `status` line for the system prompt: what's open, plus the rules (never get around CAPTCHAs, OTPs or UAE Pass; ask the person for them; always confirm risky clicks; say plainly what you did).

- [ ] **Step 1: Failing tests** (local fixture pages, a fake `onCard`) — `'Submit isn't clicked without browser_confirm'`, `'confirm OK clicks it; No doesn't'`, `'login result never contains the password'`, `'the step limit stops the task'`, `'upload refuses a Shelf file the person can't open'`, `'a session that expired: one login retry, then ask the person'`, `'without the browser module or with Settings off, no browser tools in the chat'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** → PASS; full `npm test` → only what already fails on `main`.
- [ ] **Step 5:** Commit: `feat(browser): Reem uses websites from the chat`.

### Task 5: Live view in the chat, and Settings → Browser

**Files:** Create `server/browser/routes.js`, `client/src/components/BrowserCard.jsx`, `client/src/components/BrowserSettings.jsx`; modify `server/index.js` (mount `/api/browser` after `requireUser`; `recoverAtBoot()` in `app.listen`), `client/src/components/Chat.jsx` (the `browser` event, like `arsBooking`), `client/src/lib/petChat.js` (`CARDS` gets `'browser'`), the settings menu.

**Interfaces — Produces (all behind `needsModule('browser')`):**
- `GET /api/browser/tasks/:id` → `{ status, url, steps, note, ask? }`; `GET /api/browser/tasks/:id/frame.jpg`; `POST /api/browser/tasks/:id/input` (take-over); `POST /api/browser/tasks/:id/answer` `{ ok: boolean }` (confirm cards) and `{ done: true }` (ask-person cards); `POST /api/browser/tasks/:id/stop`.
- `GET/POST/DELETE /api/browser/logins` (own only).
- `GET /api/browser/settings` (everyone with the module, read) and `PUT /api/browser/settings` (master only): `{ enabled, max_steps, dld_auto }`.

**BrowserCard:** a small browser window in the chat message (`frame.jpg?t=` refreshed every second while working), the step line, the URL; **Take over** (taps and typing go to the page), **Stop**; a confirm card shows the yellow question with **OK** / **No**; an ask card shows the why with **Done**. Collapses to one line ("Used rdc.gov.ae · 14 steps · done") when finished.

**Settings → Browser:** master sees the **Browser on/off** toggle, **Steps per task** (20/40/60), and **Check DLD for renewals by itself** (`dld_auto`). Everyone with the module sees **My logins**: Add (site link, username, password), list (site, username), Remove.

- [ ] **Step 1:** Route tests in `tests/browserKit.test.js`: `'only the master changes the settings'`, `'a person sees only their own logins and tasks'`, `'input from someone else's account is refused'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement server and client. **Step 4:** → PASS; `npm run build` → OK.
- [ ] **Step 5:** By hand, `npm run dev`: turn the browser on in Settings; in chat, "open dubailand.gov.ae rental index and tell me which fields it asks" → live card, a sensible answer; "press Calculate" on an empty form → no confirm (Calculate is safe). Check it at phone width: the window fits and taps land.
- [ ] **Step 6:** Commit: `feat(browser): watch Reem work a website live, and its settings`.

### Task 6: DLD recipe for lease renewals

The same engine, but a fixed path (no AI, no cost per step), because it's done for every renewal.

**Files:** Create `server/browser/recipes/dld.js`, `server/browser/recipes/dldParse.js`, `scripts/dld-probe.mjs`, `client/src/components/DldCheck.jsx`; modify `server/leaseRenewals.js`, `client/src/components/LeaseRenewals.jsx` (`StartSheet` Step 1, about line 343). Tests: `tests/dldParse.test.js`, `tests/dld.test.js`, `tests/leaseRenewals.test.js`; fixtures `tests/fixtures/dld/`.

**Find out first (needs one real Ejari number, at the office):** `scripts/dld-probe.mjs <ejari> <dd/mm/yyyy> <Apartment|Villa> <rent> [--headed]` fills the Residential form **by clicking like a person** (the selects are jQuery "chosen" widgets: click `#propertyType_chosen`, then the option text; setting `.value` does not stick — tried 2026-11-08), "Search Index by" = Ejari Contract Number, `#ejariContractNumberRI`, `#annualRent`, then `#resdential-submit`. It logs `CaptchaProxy/*` POSTs and the result text, and saves `result.png`. Save the real result and a made-up-number result (`not-found`) to `tests/fixtures/dld/`, **with names, the Ejari number and the address replaced by placeholders (the repo is public)**.

**dld_checks:**

```sql
CREATE TABLE IF NOT EXISTS dld_checks (
  id SERIAL PRIMARY KEY, lease_id INTEGER NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | running | captcha | done | not_found | unsupported | failed | blocked
  search_by TEXT, search_number TEXT, pct NUMERIC, average_rent NUMERIC, result_text TEXT,
  picture TEXT,                    -- path under data/dld/
  error TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint, updated_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint);
CREATE INDEX IF NOT EXISTS dld_checks_lease ON dld_checks (lease_id, end_date, id DESC);
```

**Interfaces — Produces:**
- `parseResult(textOrJson) -> { pct: 0|5|10|15|20, averageRent: number|null }`; throws `.code` `'not_found'` / `'changed'`.
- `searchFor(lease, dueLeases) -> { by: 'ejari'|'premises', number } | { unsupported: 'type'|'no_number' }`; `propertyTypeOf(unitType) -> 'Apartment'|'Villa'|'Hotel Apartment'|null`.
- `requestCheck(lease, { userId }) -> row` (returns the queued/running row if one exists); `latestIndex(leaseId, endDate) -> { pct, averageRent, checkId, at } | null`; `runNext()`; `recoverAtBoot()`; `startDldChecks()` (every 2 min `runNext()`; every 10 min, when Settings `enabled` and `dld_auto` are on, queue **one** due lease with no renewal and no check — or only a `not_found`/`failed` one older than 7 days — soonest end first).
- It runs on the engine as the person who asked (background checks as the master) through `openTask`/`endTask`, so its live view is the same `BrowserCard` frame route. A CAPTCHA → status `captcha` and a push "DLD wants you to tick a box", the person ticks it in the live view; 5 minutes without → `failed` "Nobody ticked DLD's box".
- Routes in `server/browser/routes.js`: `POST /api/browser/dld` `{ lease_id }` (lease must be in `dueLeases()` and the person needs `renewals`), `GET /api/browser/dld/lease/:leaseId`, `GET /api/browser/dld/:id/picture`.
- `leaseRenewals.js`: `RENT_SOURCES.dld_api` → `dld: 'RERA index rent (checked on DLD by Reem)'`; `indexRent(lease)` answers from `latestIndex` as `{ rent: indexRentFrom(annual_rent, pct), pct, checkId }`; `prepare()` sets `source = { kind: 'dld', pct, checkId }`; `card()` gains `dld: { id, status, pct, averageRent, at } | null`; Start with `dld_check_id` saves it on the renewal and adds the timeline line `RERA checked on DLD by Reem: +5% allowed`.
- `DldCheck` on Start: a `done` check → "DLD allows **+5%** · average rent AED 62,000 · checked 8 Nov", **See DLD's page**, and the % pill is picked by itself; none → it starts one and shows the live window; `not_found`/`unsupported`/`failed`/`blocked` → "DLD couldn't find this lease — pick the % yourself", and the pills work as today.

- [ ] **Step 1:** Run the probe with the real Ejari number; save the fixtures.
- [ ] **Step 2: Failing tests** — parser: the real fixture's % and average rent; `not_found`; `'Allowed increase: 7%'` → `changed`; `''` → `changed`. Recipe (fake engine): Ejari first; a premise number shared by two leases isn't used; 9 digits only; Shop/Office → `unsupported`; two requests → one check; 90 s and 30-a-day pace; blocked → 24 h pause; page changed → `failed`, no index; CAPTCHA timeout → `failed` and the queue moves on; restart → `failed`; Settings `dld_auto` off → no background checks but a person's Start still checks; browser `enabled` off → no checks at all. Renewals: `action: 'index'` with a `done` check → `source.kind === 'dld'`; without one → the person's % as before; Start keeps `dld_check_id` and writes the timeline line.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** → PASS; full suite as before.
- [ ] **Step 6:** By hand: Start on the real lease → watch it live → the % is picked; **See DLD's page** opens the picture.
- [ ] **Step 7:** Commit: `feat(renewals): Reem checks the RERA index on DLD by itself`.

### Task 7: RDC portal through the chat

No RDC-only code: this task proves the general browser does it, and saves what it learns as site notes.

- [ ] **Step 1:** Francis adds his RDC login in Settings → Browser → My logins.
- [ ] **Step 2:** In a chat, on a real renewal dispute: "Open RDC and get the case ready for [building unit] using the renewal's case pack. Don't submit." The case pack PDF must be on the Shelf (add a **Save to Shelf** next to the existing RDC case pack button in `LeaseRenewals.jsx` if it isn't there, so `browser_act upload` can take it).
- [ ] **Step 3:** Expected: it logs in (or asks Francis to approve UAE Pass on his phone), fills the forms, uploads the pack, and stops at Submit/Pay with a confirm card. Francis presses **No** for this test.
- [ ] **Step 4:** Check `browser_site_notes` for the RDC host has sensible notes; the second run should take fewer steps.
- [ ] **Step 5:** Write down anything that failed as a fix task; commit any fixes: `fix(browser): what RDC taught us`.

### Task 8: Ship it

- [ ] **Step 1:** `git fetch && git merge origin/main`; compare live with what's being shipped (CLAUDE.md → Commands).
- [ ] **Step 2:** On `reem-live`: `pg_dump` the live DB.
- [ ] **Step 3:** Ship `server scripts package.json package-lock.json client/dist`; `npm ci --omit=dev`; once, as the pm2 user: `npx playwright install --with-deps chromium`.
- [ ] **Step 4:** On the server: `node scripts/dld-probe.mjs <ejari> <end> Apartment <rent>` → same % as at the office (Chromium runs there and DLD doesn't block the server).
- [ ] **Step 5:** `pm2 restart jarvis --update-env`. The browser starts **off**: Francis turns it on in Settings → Browser and ticks the Browser module for whoever should have it.
- [ ] **Step 6:** Next morning: `SELECT status, count(*) FROM dld_checks GROUP BY 1` — mostly `done`, nothing `blocked`; `SELECT status, count(*) FROM browser_tasks GROUP BY 1`.

---

## Later (not in this plan)

- A "recipe" for any other job done every day, the way DLD has one (no AI, no cost per step), once the chat version has shown the steps.
- Asking "check RERA for the renewals due this month" in chat, run as DLD recipes in a row.
