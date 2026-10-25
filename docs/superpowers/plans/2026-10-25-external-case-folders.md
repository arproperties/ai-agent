# Case Folders from the Inbox (external users) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external user says "pull the information from my inbox" in chat. A card offers to save every email of the case as PDFs into a named, renamable, shareable case folder on their Shelf, and the folder keeps itself up to date.

**Architecture:** A new server module `caseFolders.js` owns case folders, matching, proposals (cards), saving and refreshing. `caseMail.js` collects a case's emails from IMAP or Outlook (inbox and sent, no 25 cap). `casePdf.js` builds the one full case PDF with `replyDoc.renderPdf`. `caseShare.js` emails a case PDF or serves a public view-only link. Everything is reachable only by `isExternal(user)`: the routes 404 for everyone else, the chat kit is given to external users only, and the watcher only looks at external users' folders.

**Tech Stack:** Node/Express, Postgres (`db.prepare(...).get/all/run`), imapflow + mailparser, Microsoft Graph, pdf-lib via `server/replyDoc.js`, Anthropic via `ask()` in `server/ai.js`, React + Tailwind client, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-external-case-folders-design.md`

## Global Constraints

- External users only (`isExternal(user)`, `server/access.js:19`). Reem staff and master see no change and no new UI. Master never sees external case folders (same wall as PR #3).
- Default folder name pattern: `Case - [Case Number] - [Party A] vs [Party B]`. Tokens are exactly `[Case Number]`, `[Party A]`, `[Party B]`.
- Missing party shows as `Party A unknown` / `Party B unknown`.
- Card question text: **"Save all info as PDF into the Shelf?"** Choices: "One full case PDF (summary + all emails)" (ticked by default) and "A separate PDF per email" (unticked).
- Inbox and Sent both count. Match = subject or body, excluding quoted earlier text.
- With no case number: look at the last 30 days, at most 5 cards, most recent first.
- One full case PDF per folder, replaced in place on update (same document row), never duplicated.
- Deleting a case folder stops tracking. A "Stop updating" switch also exists.
- Share links never expire on their own; the user turns them off. Email share sends the full case PDF only.
- Tests use stub mailboxes and stub `ask` only. Never the real company mailbox (memory: real-company-mailbox).
- Work on a new branch from `main`. Nothing is pushed or deployed until Francis says so (memory: no-deploy-until-told, reem-main-via-pr).
- UI: no native `<select>`; use `Picker.jsx` / `Sheet.jsx` (memory: no-native-select).

## Review Focus

1. **A nearby number:** `Soutex E - 2057910` or `Soutex E - 20579` must NOT match `Soutex E - 205791`. Test in Task 1.
2. **Quoted case mention:** an email about another case that quotes an old Soutex email below `On … wrote:` / `-----Original Message-----` / `>` lines is not part of Soutex. Test in Task 1.
3. **Mailbox stops working** (password changed, Outlook token gone) during the watcher: the folder keeps its files, `last_error` is recorded, other users' folders still refresh, no crash. Test in Task 7.
4. **Double tap Save** on the card makes one folder, not two (status-change lock as in `inventory.decide`). Test in Task 5.
5. **Share link after Off, after folder delete, or with another document's id** returns 404. Test in Task 9.

---

### Task 0: Branch and Arabic PDFs

**Files:** none new. Brings in `server/replyDoc.js` and `server/fonts/` changes from `fix/arabic-pdf`.

- [ ] **Step 1:** Create a worktree from `main` on a new branch `feat/case-folders` (superpowers:using-git-worktrees). Check `git log origin/main -5` first, because another dev pushes to main (memory: private-agent-project).
- [ ] **Step 2:** `git merge fix/arabic-pdf` (commit `f7e6616`, PR #7) into `feat/case-folders`.
- [ ] **Step 3:** Run `node --test tests/reply-doc.test.js`. Expected: PASS, and `unsupportedScript('مرحبا')` is now false.
- [ ] **Step 4:** Commit the merge. The PR description must say it includes PR #7.

### Task 1: Matching and naming (pure functions)

**Files:**
- Create: `server/caseMatch.js`
- Test: `tests/case-match.test.js`

**Interfaces:**
- Produces:
  - `caseRegex(caseNumber: string): RegExp`. Built from the number's letter and digit runs, allowing `[\s\-–_/.]*` between runs. Case-insensitive. Not preceded by a letter or digit, not followed by a digit.
  - `caseKey(caseNumber: string): string`. Lowercase letters and digits only (`'soutexe205791'`). Used to store a case and compare cases.
  - `unquoted(text: string): string`. The body with quoted history removed: everything from the first `On … wrote:` line, `-----Original Message-----`, `________________________________`, or an Outlook `From: … Sent:` header block, plus every line starting with `>`.
  - `mentionsCase(mail: {subject, text}, caseNumber: string): boolean`. Regex hit in the subject, or in `unquoted(text)`.
  - `searchTerm(caseNumber: string): string`. The longest digit run (`'205791'`), handed to the mailbox's own search.
  - `folderName(pattern: string, {case_number, party_a, party_b}): string`. Replaces the three tokens. A missing party becomes `Party A unknown` / `Party B unknown`. Collapses whitespace, strips `\/:*?"<>|`, max 120 chars. An empty pattern falls back to `DEFAULT_PATTERN`.
  - `DEFAULT_PATTERN = 'Case - [Case Number] - [Party A] vs [Party B]'`

- [ ] **Step 1: Write the failing tests**

```js
test('the same case number written differently matches', () => {
  for (const s of ['Soutex E - 205791', 'soutex e-205791', 'SoutexE205791', 'Ref: SOUTEX E – 205791.'])
    assert.ok(mentionsCase({ subject: s, text: '' }, 'Soutex E - 205791'), s);
});
test('a nearby number does not match', () => {
  for (const s of ['Soutex E - 2057910', 'Soutex E - 20579', 'XSoutex E - 205791'])
    assert.equal(mentionsCase({ subject: s, text: '' }, 'Soutex E - 205791'), false, s);
});
test('a case mentioned only in quoted history does not count', () => {
  const text = 'About case Arkan B - 1100.\n\nOn Mon, 3 Oct 2026, Ali wrote:\n> Soutex E - 205791 hearing moved';
  assert.equal(mentionsCase({ subject: 'Re: hearing', text }, 'Soutex E - 205791'), false);
  assert.ok(mentionsCase({ subject: 'Re: hearing', text: 'Soutex E - 205791 hearing moved' }, 'Soutex E - 205791'));
  assert.equal(mentionsCase({ subject: '', text: 'x\n-----Original Message-----\nSoutex E - 205791' }, 'Soutex E - 205791'), false);
});
test('folder names follow the pattern', () => {
  const c = { case_number: 'Soutex E - 205791', party_a: 'Ahmed Ali', party_b: 'Gulf Trading LLC' };
  assert.equal(folderName(DEFAULT_PATTERN, c), 'Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC');
  assert.equal(folderName('[Party A] v [Party B] ([Case Number])', c), 'Ahmed Ali v Gulf Trading LLC (Soutex E - 205791)');
  assert.equal(folderName(DEFAULT_PATTERN, { ...c, party_b: '' }), 'Case - Soutex E - 205791 - Ahmed Ali vs Party B unknown');
  assert.equal(folderName('', c), folderName(DEFAULT_PATTERN, c));
  assert.equal(caseKey('Soutex E - 205791'), 'soutexe205791');
  assert.equal(searchTerm('Soutex E - 205791'), '205791');
});
```

- [ ] **Step 2:** Run `node --test tests/case-match.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `server/caseMatch.js` with the signatures above. No DB, no imports.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: case number matching and folder naming`.

### Task 2: Tables

**Files:**
- Modify: `server/db.js` (new DDL block next to `legal_cases`, ~line 2059)
- Modify: `tests/helpers/db.js` (add the new tables to `TABLES`)
- Test: `tests/schema.test.js` (extend)

**Interfaces:**
- Produces these tables:
  - `case_settings(user_id INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE, pattern TEXT)`
  - `case_folders(id SERIAL PK, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE, name TEXT NOT NULL, case_number TEXT NOT NULL, case_key TEXT NOT NULL, party_a TEXT, party_b TEXT, full_pdf BOOLEAN NOT NULL DEFAULT true, per_email BOOLEAN NOT NULL DEFAULT false, tracking BOOLEAN NOT NULL DEFAULT true, summary_doc_id INT REFERENCES documents ON DELETE SET NULL, share_token TEXT UNIQUE, share_on BOOLEAN NOT NULL DEFAULT false, last_checked_at BIGINT, last_error TEXT, new_count INT NOT NULL DEFAULT 0, updated_at BIGINT, created_at BIGINT DEFAULT NOW, UNIQUE(user_id, case_key))`
  - `case_emails(id SERIAL PK, folder_id INT NOT NULL REFERENCES case_folders ON DELETE CASCADE, mail_key TEXT NOT NULL, message_id TEXT, at BIGINT, sender TEXT, subject TEXT, body TEXT, doc_id INT REFERENCES documents ON DELETE SET NULL, UNIQUE(folder_id, mail_key))`. Keep `body` so the PDF can be rebuilt without re-reading the mailbox.
  - `case_proposals(id SERIAL PK, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE, conversation_id INT REFERENCES conversations ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'pending', case_number TEXT NOT NULL, party_a TEXT, party_b TEXT, name TEXT NOT NULL, emails JSONB NOT NULL, folder_id INT REFERENCES case_folders ON DELETE SET NULL, decided_at BIGINT, created_at BIGINT DEFAULT NOW)`. `emails` = `[{mail_key, at, sender, subject}]`.
  - `documents.case_folder_id INT REFERENCES case_folders ON DELETE SET NULL` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`)

- [ ] **Step 1:** Add a test to `tests/schema.test.js`: inserting two `case_folders` rows with the same `(user_id, case_key)` throws; deleting a folder removes its `case_emails`.
- [ ] **Step 2:** Run it. Expected: FAIL, relation does not exist.
- [ ] **Step 3:** Add the DDL in the style of the surrounding blocks, and add the four tables to `TABLES` in `tests/helpers/db.js`.
- [ ] **Step 4:** Run `node --test tests/schema.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: case folder tables`.

### Task 3: Collecting a case's emails from the mailbox

**Files:**
- Modify: `server/imap.js` (new export, next to `recentInbox`)
- Modify: `server/outlook.js` (new export)
- Create: `server/caseMail.js`
- Test: `tests/case-mail.test.js`

**Interfaces:**
- Produces:
  - `imapMatching(userId, { term: string, since?: Date, limit = 500 }): Promise<Mail[]>` in `imap.js`. IMAP `text: term` over INBOX and the sent folder (`sentPath`), with `since` when given. Full parse with `simpleParser`. No 25 cap.
  - `outlookMatching(userId, { term, since?, limit = 500 }): Promise<Mail[]>` in `outlook.js`. `$search` over inbox and sentitems, following `@odata.nextLink`. Body as text, plus non-inline attachments.
  - `Mail = { key: string, messageId: string|null, at: Date, from: string, to: string, subject: string, text: string, attachments: [{name, mimetype, buffer}] }`. `key` is the existing id format: IMAP `path:uid`, Outlook message id.
  - `caseMailbox(userId): Promise<null | { kind: 'imap'|'outlook', address: string, canSend: boolean, matching: (opts) => Promise<Mail[]>, recent: (since: Date) => Promise<Mail[]> }>` in `caseMail.js`. IMAP first, then Outlook, as in `connectedMailbox` (`email.js:282`). `canSend` = IMAP `can_write && smtp_host`; Outlook = false.
  - `collectCase(box, caseNumber, { since } = {}): Promise<Mail[]>` in `caseMail.js`. Calls `box.matching({ term: searchTerm(caseNumber), since })`, keeps only `mentionsCase`, de-duplicates by `messageId` (the same email can sit in Inbox and Sent), sorts oldest first.
- Consumes: `searchTerm`, `mentionsCase` from Task 1.

- [ ] **Step 1: Write the failing tests** against a stub `box` (no real mailbox):

```js
test('collectCase keeps only the real case, oldest first, once', async () => {
  const box = stubBox([
    mail({ key: 'INBOX:3', at: '2026-10-03', subject: 'Soutex E - 205791 hearing', messageId: '<a>' }),
    mail({ key: 'Sent:9', at: '2026-10-04', subject: 'Re: Soutex E-205791', messageId: '<b>' }),
    mail({ key: 'INBOX:4', at: '2026-10-05', subject: 'Soutex E - 2057910', messageId: '<c>' }),
    mail({ key: 'All:3', at: '2026-10-03', subject: 'Soutex E - 205791 hearing', messageId: '<a>' }),
  ]);
  const got = await collectCase(box, 'Soutex E - 205791');
  assert.deepEqual(got.map((m) => m.key), ['INBOX:3', 'Sent:9']);
  assert.equal(box.calls[0].term, '205791');
});
```

- [ ] **Step 2:** Run `node --test tests/case-mail.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `collectCase` and `caseMailbox` in `caseMail.js`, then `imapMatching` and `outlookMatching`. The last two follow `searchEmail` / `recentInbox` in each file, and they have no unit test here, the same as the existing mailbox readers.
- [ ] **Step 4:** Run it again. Expected: PASS. Also run `node --test tests/email-tools.test.js`. Expected: still PASS.
- [ ] **Step 5:** Commit `feat: collect every email of a case from inbox and sent`.

### Task 4: The full case PDF

**Files:**
- Create: `server/casePdf.js`
- Test: `tests/case-pdf.test.js`

**Interfaces:**
- Consumes: `renderPdf`, `pdfName` from `server/replyDoc.js`. `ask` from `server/ai.js` (injected).
- Produces:
  - `summarizeCase(folder, emails, { ask }): Promise<string>`. Markdown with exactly these sections: `## Parties`, `## What has happened` (dated bullets), `## Latest position`, `## Pending / awaiting reply`. Uses the AI over the emails oldest first, each body cut to 4,000 chars, `maxTokens: 2000`. If the AI throws, returns a plain `## Emails` list of dates and subjects, so the PDF still gets made.
  - `caseMarkdown(folder, emails, summary): string`. `# {folder.name}`, a line `Case {case_number} · {party_a} vs {party_b} · {n} emails · updated {date}`, the summary, then `## All emails`. For each email oldest first: `### {date} · {subject}`, a `From/To` line, then the body.
  - `emailMarkdown(email): string`. One email alone, for the per-email PDF.
  - `buildCasePdf(folder, emails, { ask }): Promise<{ bytes: Buffer, name: string, markdown: string }>`. `name = pdfName(folder.name)`.

- [ ] **Step 1: Write the failing tests** with a stub `ask`:

```js
test('the case PDF has the summary first and every email after, oldest first', async () => {
  const ask = async () => '## Parties\nA vs B\n## What has happened\n- 3 Oct filed\n## Latest position\nHearing set\n## Pending / awaiting reply\nNone';
  const md = caseMarkdown(folder, [e2, e1].sort(byAt), await summarizeCase(folder, [e1, e2], { ask }));
  assert.ok(md.indexOf('## Parties') < md.indexOf('## All emails'));
  assert.ok(md.indexOf(e1.subject) < md.indexOf(e2.subject));
});
test('the PDF is still made when the AI fails', async () => {
  const { bytes } = await buildCasePdf(folder, [e1], { ask: async () => { throw new Error('down'); } });
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});
test('Arabic email text makes a PDF', async () => {
  const { bytes } = await buildCasePdf(folder, [{ ...e1, body: 'تم تأجيل الجلسة' }], { ask: async () => '## Parties\nأ' });
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});
```

- [ ] **Step 2:** Run `node --test tests/case-pdf.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. The summary prompt says: write from the emails only, never invent dates or parties, English headings, keep the parties' names as written.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: one full case PDF, summary then every email`.

### Task 5: Proposals, saving and refreshing (the core)

**Files:**
- Create: `server/caseFolders.js`
- Test: `tests/case-folders.test.js`

**Interfaces:**
- Consumes: Tasks 1–4. `saveUpload` from `server/files.js`. `isExternal` from `server/access.js`.
- Produces (all take `deps = { mailbox = caseMailbox, ask }` last, so tests inject stubs):
  - `getPattern(userId): Promise<string>` and `setPattern(userId, pattern): Promise<string>`. An empty pattern resets to `DEFAULT_PATTERN`. A pattern without `[Case Number]` is refused with 400 "The pattern needs [Case Number]".
  - `identify(mails: Mail[], { ask }): Promise<{ case_number, party_a, party_b }>`. The AI reads the **oldest** mail (subject + first 6,000 chars of body) and returns JSON. Parties are given in the order the email writes them.
  - `discover(userId, deps): Promise<{ case_number, party_a, party_b, first }[]>`. `box.recent(30 days ago)`. The AI lists case references, as JSON, at most 5, newest first.
  - `propose(user, { case_number? }, { conversationId }, deps): Promise<Card[]>`.
    - With a number: `collectCase`, then `identify` for the parties, then one card.
    - Without a number: `discover`, then one card per case.
    - A case the user already has a folder for (same `case_key`) is not carded: it is refreshed instead (`refresh`), and returned as `{ refreshed: folderSummary }`.
    - Throws 400 "Connect your mailbox first" when there is no mailbox, and 404 "No emails mention {number}" when nothing matches.
  - `Card = { id, status, case_number, party_a, party_b, name, emails: [{mail_key, at, sender, subject}], count, from, to, question: 'Save all info as PDF into the Shelf?' }`
  - `getCard(user, id)` and `cardsFor(user, conversationId): Promise<Card[]>`
  - `decide(user, id, { save: boolean, name?, full_pdf = true, per_email = false, exclude: string[] = [] }, deps): Promise<Card & { folder_id? }>`
    - The status change from pending is the lock: a second tap gets 409.
    - Save creates the `case_folders` row (with `name` from the card, or the edited name), stores the kept emails in `case_emails`, saves the case PDF (`documents.case_folder_id` set, `summary_doc_id` set) and, if `per_email`, one PDF per email (`case_emails.doc_id`). Original attachments are saved too, `case_folder_id` set, with the same dedup as `saveUpload`.
    - Unticked emails (`exclude`) are stored nowhere.
    - At least one of `full_pdf` / `per_email` is required, else 400.
  - `refresh(user, folderId, deps): Promise<{ added: number }>`
    - `collectCase(box, case_number, { since: last_checked_at - 1 day })`, minus keys already in `case_emails`.
    - New emails are inserted, `new_count += added`, and the per-email PDFs and attachments for them are saved.
    - If anything was added, the case PDF is rebuilt and **written over the same document row**: same `id`, new `path` bytes, `size`, `hash`, re-indexed.
    - Sets `last_checked_at`; on error, sets `last_error` and rethrows.
    - Does nothing when `tracking` is false.
  - `replaceFile(doc, { buffer, text }): Promise<void>`. Overwrites the file at `doc.path`, updates `size` and `hash`, and re-indexes its chunks. It must not reclassify: title, folder and `case_folder_id` stay. If `processDocument` cannot skip classification, add a `{ classify: false }` option to it in `files.js`.
  - Every function returns null / 404 for a non-external user.

- [ ] **Step 1: Write the failing tests**, using a stub mailbox built from `mail()` records and a stub `ask` that returns fixed JSON:

```js
test('a named case becomes one card with its parties from the first email', async () => {
  const [card] = await propose(jeff, { case_number: 'soutex e-205791' }, { conversationId: conv }, deps);
  assert.equal(card.name, 'Case - Soutex E - 205791 - Ahmed Ali vs Gulf Trading LLC');
  assert.equal(card.count, 2);
  assert.equal(card.question, 'Save all info as PDF into the Shelf?');
});
test('nothing is saved until Save, and Save twice makes one folder', async () => {
  const [card] = await propose(jeff, { case_number: 'Soutex E - 205791' }, { conversationId: conv }, deps);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_folders').get()).n, 0);
  await decide(jeff, card.id, { save: true }, deps);
  await assert.rejects(decide(jeff, card.id, { save: true }, deps), { status: 409 });
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM case_folders').get()).n, 1);
});
test('the edited name and unticked emails are respected', async () => { /* name 'Soutex – urgent', exclude [second key] → folder.name, case_emails count 1 */ });
test('per-email PDFs are made only when ticked', async () => { /* per_email true → documents with case_folder_id = 1 + n */ });
test('a new email updates the same case PDF, not a copy', async () => {
  /* save; add a new matching mail to the stub; refresh → added 1; summary_doc_id unchanged; documents count with case_folder_id +0 for the PDF; new_count 1 */
});
test('pulling the same case again refreshes it instead of a second card', async () => { /* second propose → [{ refreshed }], case_folders count 1 */ });
test('no number given: up to 5 cards from the last 30 days', async () => { /* stub discover returns 7 → 5 cards */ });
test('a stopped folder is not refreshed', async () => { /* tracking false → refresh added 0, mailbox not called */ });
test('the name pattern is per user and needs the case number', async () => { /* setPattern('[Party A] v [Party B]') rejects 400; setPattern('') → DEFAULT_PATTERN */ });
test('someone who is not external gets nothing', async () => { /* staff user: propose throws 404 / returns null; cardsFor [] */ });
```

  The `jeff` fixture sets `users.external = true` (see `tests/external-user.test.js`, `setExternal`).
- [ ] **Step 2:** Run `node --test tests/case-folders.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `server/caseFolders.js`. Copy the shape of `server/inventory.js` (`propose` / `getProposal` / `decide`, `bad()`, `NOW`).
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: case folders - cards, save, refresh in place`.

### Task 6: Chat tool and the card

**Files:**
- Modify: `server/caseFolders.js` (add the kit)
- Modify: `server/chat.js:510-518` (add the kit for external users only)
- Create: `client/src/components/CaseCard.jsx`
- Modify: `client/src/components/Chat.jsx` (state, reload at line ~96, event at ~190, render at ~431)
- Test: `tests/case-folders.test.js` (kit tests)

**Interfaces:**
- Produces:
  - `caseKit(user, { conversationId, onCard }, deps)`. Same shape as `inventoryKit` (`definitions`, `status`, `run`). Empty `definitions` when not external. Two tools:
    - `pull_case`, input `{ case_number?: string }`. Description: use when the user asks to pull, collect or organise emails about a case from their inbox; the case number is optional.
    - `update_case`, input `{ case_number: string }`. Refreshes an existing folder now.
    - The `pull_case` result text ends with: "NOT saved yet - tell the user in one short line to check the card and tap Save. Never say it is saved."
  - The card event name is `caseFolder`. `onCard(card)` → `send('caseFolder', card)`.
  - Routes in Task 8 serve `GET /api/cases/proposals?conversation=`, `POST /api/cases/proposals/:id/save` (body `{ name, full_pdf, per_email, exclude }`) and `POST /api/cases/proposals/:id/cancel`.
- CaseCard UI:
  - The folder name in an editable text field.
  - "{count} emails · {from} – {to}".
  - The email list (date · sender · subject), each with a tick, all ticked.
  - The question line, then the two tick-boxes from Global Constraints.
  - Save / Cancel buttons, with the same `STATE` styling as `InventoryCard`. After Save: "Saved to your Shelf" and a link that opens the folder.

- [ ] **Step 1:** Write the failing kit tests: `(await caseKit(staff, {})).definitions` is `[]`; for jeff it has `pull_case` and `update_case`; running `pull_case` calls `onCard` once with the card.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the kit. In `chat.js`, push `await caseKit(user, { conversationId: convId, onCard: (c) => send('caseFolder', c) })` only `if (external)`. Add `CaseCard.jsx` and wire `Chat.jsx` the same way as `stock` / `InventoryCard`.
- [ ] **Step 4:** Run `node --test tests/case-folders.test.js tests/external-user.test.js`. Expected: PASS. Run `npm --prefix client run build`. Expected: build succeeds.
- [ ] **Step 5:** Commit `feat: pull a case from chat, confirm on a card`.

### Task 7: The watcher

**Files:**
- Modify: `server/caseFolders.js` (add `lookAll`, `startCaseFolders`)
- Modify: `server/index.js` (import, and call `startCaseFolders()` beside `startMailRouting()` at line ~469)
- Test: `tests/case-folders.test.js`

**Interfaces:**
- Produces:
  - `lookAll(deps): Promise<{ checked: number, failed: number }>`. Every `case_folders` row with `tracking` true whose owner is `users.external`. Calls `refresh` for each and catches each error separately.
  - `startCaseFolders()`. `setInterval(tick, EVERY)` with `EVERY = 5 * 60_000`, plus a first look after 60 s and a `busy` guard. Same shape as `startMailRouting`.

- [ ] **Step 1:** Write the failing tests:
  - A folder whose mailbox throws "AUTHENTICATIONFAILED" gets `last_error` set, keeps its files, and another user's folder in the same `lookAll` still gets its new email (`failed: 1, checked: 2`).
  - A staff user's folder row, inserted by hand, is never looked at.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: case folders update themselves when new mail comes`.

### Task 8: Folder routes and the Shelf screen

**Files:**
- Modify: `server/caseFolders.js` (add `caseRoutes`)
- Modify: `server/access.js` (add `'cases'` to `EXTERNAL_OPEN`)
- Modify: `server/index.js` (`app.use('/api/cases', caseRoutes)`)
- Modify: `server/files.js` (`docOut` includes `case_folder_id`)
- Create: `client/src/components/CaseFolders.jsx`
- Modify: `client/src/components/Knowledge.jsx` (`FilesPage`: when `me.external`, show a "Case folders" group first, and hide documents with a `case_folder_id` from the normal grid)
- Test: `tests/case-folders.test.js` (route tests with `express` + `supertest`-style requests, as in `tests/email-routes.test.js`)

**Interfaces:**
- Produces routes. Each one first checks `if (!isExternal(req.user)) return 404`:
  - `GET /api/cases` → `[{ id, name, case_number, party_a, party_b, tracking, share_on, new_count, last_checked_at, last_error, email_count, files: docOut[] }]`
  - `GET /api/cases/settings` → `{ pattern }`; `PUT /api/cases/settings` with `{ pattern }`
  - `PATCH /api/cases/:id` with `{ name?, tracking? }`. Rename only changes `name`; the case is tracked by `case_key`. Opening a folder sets `new_count = 0` (`POST /api/cases/:id/seen`).
  - `POST /api/cases/:id/update` → `refresh`
  - `DELETE /api/cases/:id`. Deletes every document with that `case_folder_id` through `deleteDocument`, then the folder row (its `case_emails` go with it).
  - The proposal routes from Task 6.
- CaseFolders UI:
  - A list of folders, each showing its name, "{n} emails · updated {time}" and a "{new_count} new" badge.
  - Opening a folder shows its files (reuse `FileCard`) and these actions: Rename, Update now, a "Keep updating" switch (same switch style as Admin modules), Share (Task 9), Delete (with a confirm sheet).
  - A "Name pattern" button opens a `Sheet` with a text field and the three tokens as tap-to-insert chips.

- [ ] **Step 1:** Write the failing route tests:
  - A staff user and the master get 404 on `GET /api/cases`.
  - jeff renames a folder, and the next `refresh` still finds new mail.
  - Deleting a folder removes its documents and files on disk.
  - `PATCH` on another external user's folder returns 404.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the routes, then the UI.
- [ ] **Step 4:** Run `node --test tests/case-folders.test.js tests/external-user.test.js tests/shelf.test.js`. Expected: PASS. Run `npm --prefix client run build`. Expected: build succeeds.
- [ ] **Step 5:** Commit `feat: case folders on the Shelf - rename, pattern, stop, delete`.

### Task 9: Sharing by email and by link

**Files:**
- Create: `server/caseShare.js`
- Modify: `server/mailer.js` (add `sendMail`)
- Modify: `server/index.js` (mount `publicCaseRoutes` at `/api/case-share` **before** `app.use('/api', requireUser)`, line ~67; mount `caseShareRoutes` under `/api/cases`)
- Create: `client/src/components/CaseShareSheet.jsx`
- Test: `tests/case-share.test.js`

**Interfaces:**
- Produces:
  - `sendMail({ to, cc, subject, text, replyTo, attachments })` in `mailer.js`. Uses the existing `transport`. When no SMTP is set, throws 400 "Outgoing mail is not set up".
  - `POST /api/cases/:id/email` with `{ to, cc, subject, body }` sends the full case PDF as an attachment.
    - If the user's mailbox `canSend`: `createDraft`, then `decideDraft(…, true)`, then `kick()`, exactly as in `meetingShare.js:104-120`.
    - Otherwise: `sendMail` with `replyTo` set to the user's own address.
    - Defaults: subject `folder.name`; body = the summary's "Latest position" section as plain text.
    - Returns `{ via: 'mailbox' | 'app' }`.
  - `POST /api/cases/:id/link` with `{ on: boolean }` → `{ url, on }`.
    - The first `on` makes `share_token = randomBytes(24).toString('base64url')`. Turning it off keeps the token; turning it on again reuses it.
    - `url = ${APP_URL}/api/case-share/${token}`.
  - Public, no login:
    - `GET /api/case-share/:token` → a small self-contained HTML page showing the folder name, its files (name, date, size) and download links.
    - `GET /api/case-share/:token/files/:docId` → the file. 404 unless `share_on` is true and the document's `case_folder_id` is that folder.
    - Headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
  - CaseShareSheet: two tabs.
    - "Email": To, Cc and a message field, then Send.
    - "Link": an On/Off switch, the link with a Copy button, and the line "Anyone with this link can open these files."

- [ ] **Step 1: Write the failing tests:**

```js
test('a link shows only its own folder, and stops when turned off', async () => {
  const { url } = await post(jeff, `/api/cases/${f.id}/link`, { on: true });
  assert.equal((await get(null, pathOf(url))).status, 200);
  assert.equal((await get(null, `${pathOf(url)}/files/${otherDoc.id}`)).status, 404);
  await post(jeff, `/api/cases/${f.id}/link`, { on: false });
  assert.equal((await get(null, pathOf(url))).status, 404);
});
test('a link to a deleted folder is gone', async () => { /* delete folder → 404 */ });
test('email goes from the mailbox when it can send, else from the app with reply-to', async () => {
  /* stub draft creation / sendMail; imap can_write → via 'mailbox', draft has the PDF attachment; no imap → via 'app', replyTo = jeff address */
});
test('a staff user cannot share', async () => { /* 404 on both routes */ });
```

- [ ] **Step 2:** Run `node --test tests/case-share.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the server side, then `CaseShareSheet.jsx`, and wire it to the Share button from Task 8.
- [ ] **Step 4:** Run it again. Expected: PASS. Run `npm --prefix client run build`. Expected: build succeeds.
- [ ] **Step 5:** Commit `feat: share a case folder by email or link`.

### Task 10: Whole check, locally

- [ ] **Step 1:** Run the full suite (`npm test` with `TEST_DATABASE_URL`, as in memory jarvis-test-workflow). Expected: no new failures compared with `main`. Write down the known existing failures by name.
- [ ] **Step 2:** On the local app, with a **stub or test mailbox only**, never the real company mailbox:
  1. Make a test user external.
  2. Say "pull the information from my inbox" and check the card appears.
  3. Edit the name, untick one email, and Save. Check the folder is on the Shelf.
  4. Open the PDF and check the summary comes first.
  5. Send a new matching email to the test mailbox, then "Update now". Check it's the same PDF, with "1 new".
  6. Rename the folder, turn on the link, and open it in a private window.
  7. Turn the link off and check the page is a 404.
  8. Log in as a staff user and check nothing has changed.
- [ ] **Step 3:** Use superpowers:requesting-code-review on the branch, then superpowers:finishing-a-development-branch. Push or open a PR only when Francis says so.
