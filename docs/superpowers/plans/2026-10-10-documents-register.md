# Documents Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One register of every expiring document (company, building or unit), read by AI on upload, alerting from the day its renewal window opens until a renewed copy is filed.

**Architecture:** The existing `prop_documents` table gains a building or unit as owner, a renewal window and renewal details. `server/properties.js` serves a flat register beside the company cards it already serves. A new pure module reads an uploaded file with Claude and returns suggested fields. A new `document` rule joins the existing leasing alerts. The client gets a shared form and sheet, a Documents page, and a Documents tab on a building.

**Tech Stack:** Node 22 (ES modules), Express 5, Postgres (`pg`), `node:test`, `@anthropic-ai/sdk` through the existing `ask()` in `server/ai.js`, React + Vite + Tailwind, `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-10-10-documents-register-design.md`

## Global Constraints

- Work on branch `leasing-bookings`. Never push or merge into `main`. Do not deploy.
- Tests need `TEST_DATABASE_URL` pointing at a database whose name ends in `_test` (see `tests/helpers/db.js`). Run them locally when the Docker Postgres is up, otherwise in `/root/jarvis-dev` on the droplet. Never against production.
- Run one file with `npm test -- tests/<file>.test.js`. The whole suite is `npm test`; `tests/drawing.test.js` crashes on Windows and is unrelated.
- Renewal window: `renew_days`, integer 0–365, default **90**.
- `renew_by` is `remind` or `quotes`, default `remind`.
- `details` keys, exactly: `insurer`, `premium`, `sum_insured`, `deductible`, `cover`.
- A document has **exactly one** owner: `company_id`, `building_id` or `unit_id`.
- Document alert defaults: `document: { on: true, days: [60, 30, 7], every: 7 }`.
- Only the master adds, changes, removes or reads-with-AI (`requireMaster`); everyone signed in can list and open.
- The AI only suggests. Reading a file writes nothing and any failure returns `{}`.
- Never a browser `<select>`: use `client/src/components/Select.jsx`. Dates through `DateField.jsx` and `usDate`.
- Match the house style: comments say what a thing is for in plain words; commit messages are `feat: Leasing - …` sentences.

## Review Focus

Each line is pinned by a test in the task named.

1. The model returns a date in the wrong shape, or one that does not exist (`2026-02-31`): it is dropped, not saved. (Task 1)
2. The form sends empty strings for the owners it did not choose and for an emptied renewal window: they count as not given, not as `0`. (Task 2)
3. The same document name under two owners (a building's "Fire insurance" and a company's): two documents, two histories. (Task 2)
4. A document filed when it is already expired or already inside its window: the phones are told the same morning, not at the next rule day. (Task 3)
5. The renewed copy is deleted by mistake: the older copy decides again and its alert comes back. (Task 3)

---

### Task 1: The document reader

**Files:**
- Create: `server/documentReader.js`
- Test: `tests/document-reader.test.js`

**Interfaces:**
- Consumes: `ask(prompt, { content, maxTokens })` from `server/ai.js` (returns the reply as text), loaded lazily.
- Produces:
  - `cleanDetails(v) → object` — `v` is an object or its JSON; returns only the known keys, each a trimmed string. Throws a 400 error mentioning "details" when the JSON cannot be read.
  - `suggestion(reply) → object` — the model's reply turned into `{ title?, number?, issue_date?, expiry_date?, renew_by?, details? }`.
  - `readDocument(file, { ask }?) → Promise<object>` — `file` is a multer file `{ buffer, mimetype, originalname }`. Never throws.

- [ ] **Step 1: Write the failing test**

Create `tests/document-reader.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocument, suggestion, cleanDetails } from '../server/documentReader.js';

const pdf = { buffer: Buffer.from('%PDF-1.4'), originalname: 'policy.pdf', mimetype: 'application/pdf' };

test('what the model read becomes a suggestion: known fields, real dates, nothing else', () => {
  const reply = `Here it is:\n\`\`\`json\n${JSON.stringify({ title: ' Property insurance ', number: 4471, issue_date: '2026-01-09', expiry_date: '2027-01-08', renew_by: 'quotes',
    insurer: 'Orient', premium: 'USD 4,200', sum_insured: { amount: 1 }, owner: 'ACE' })}\n\`\`\``;
  assert.deepEqual(suggestion(reply), { title: 'Property insurance', number: '4471', issue_date: '2026-01-09', expiry_date: '2027-01-08', renew_by: 'quotes',
    details: { insurer: 'Orient', premium: 'USD 4,200' } });
  // A date written another way, a date that does not exist, and a way of renewing nobody offered.
  assert.deepEqual(suggestion('{"title":"Licence","expiry_date":"08/01/2027","issue_date":"2026-02-31","renew_by":"auction"}'), { title: 'Licence' });
  for (const junk of ['', 'I cannot read this.', '{broken', '[1,2]', 'null', undefined]) assert.deepEqual(suggestion(junk), {});
});

test('reading a file: a PDF or a photo is sent, anything else is not, and a failure is an empty form', async () => {
  const seen = [];
  const ask = async (prompt, opts) => { seen.push(opts.content); return '{"title":"Fire insurance","expiry_date":"2027-01-08"}'; };
  assert.deepEqual(await readDocument(pdf, { ask }), { title: 'Fire insurance', expiry_date: '2027-01-08' });
  assert.deepEqual([seen[0][0].type, seen[0][0].source.media_type, seen[0][1].type], ['document', 'application/pdf', 'text']);
  await readDocument({ ...pdf, mimetype: 'image/jpeg' }, { ask });
  assert.equal(seen[1][0].type, 'image');
  assert.deepEqual(await readDocument({ ...pdf, mimetype: 'application/msword' }, { ask }), {});
  assert.deepEqual(await readDocument(undefined, { ask }), {});
  assert.equal(seen.length, 2, 'a file that cannot be read is never sent');
  assert.deepEqual(await readDocument(pdf, { ask: async () => { throw new Error('overloaded'); } }), {});
});

test('the figures kept with a document: known names only, as short lines of text', () => {
  assert.deepEqual(cleanDetails('{"insurer":" Orient ","junk":"x"}'), { insurer: 'Orient' });
  assert.deepEqual(cleanDetails({ premium: 4200, cover: '', deductible: ['a'] }), { premium: '4200' });
  for (const none of ['', '{}', [1], null, undefined]) assert.deepEqual(cleanDetails(none), {});
  assert.throws(() => cleanDetails('{not json'), /details/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/document-reader.test.js`
Expected: FAIL with `Cannot find module '…/server/documentReader.js'`

- [ ] **Step 3: Write the implementation**

Create `server/documentReader.js`:

```js
// Reading a document as it is filed: the name, number, dates and figures on a policy, a
// licence or a certificate, suggested to whoever is filing it. Nothing is saved here and
// nothing is guessed: what cannot be seen is left out, and any failure gives back nothing,
// so the form is simply filled in by hand.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
// Loaded when first needed, so the checks below work where no model is set up.
const claudeAsk = (...args) => import('./ai.js').then((m) => m.ask(...args));

const DETAILS = ['insurer', 'premium', 'sum_insured', 'deductible', 'cover'];
const IMAGE = /^image\/(jpeg|png|gif|webp)$/;

const PROMPT = `This is a document a property company keeps on file (an insurance policy, a licence, a certificate, a contract). Read it and reply with one JSON object and nothing else, using only these keys and leaving out any you cannot see on the page:
"title": what the document is, in a few words (e.g. "Property insurance", "Trade License"), without the name of the company or the insurer
"number": its policy, licence or reference number
"issue_date": the date it starts or was issued, as YYYY-MM-DD
"expiry_date": the date it expires or the cover ends, as YYYY-MM-DD
"renew_by": "quotes" if it is bought from a choice of suppliers (insurance, a maintenance or service contract), otherwise "remind"
"insurer": the name of the insurer or supplier
"premium": the price for the period, with its currency
"sum_insured": the amount insured, with its currency
"deductible": the deductible or excess, with its currency
"cover": what is covered, in one short line
Never guess a date or a number.`;

const line = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 300) : '');

/** A real day written YYYY-MM-DD: 2026-02-31 is not one. */
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))).toISOString().slice(0, 10) === v;
}

/** The figures kept with a document: a few known names, each a short line of text. Given as an object or as its JSON. */
export function cleanDetails(v) {
  let o = v;
  if (typeof v === 'string') {
    try { o = JSON.parse(v || '{}'); } catch { throw bad('The details of the document could not be read.'); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  return Object.fromEntries(DETAILS.map((k) => [k, line(o[k])]).filter(([, x]) => x));
}

/** What is worth suggesting out of whatever came back: the known fields, and only dates that are dates. */
export function suggestion(reply) {
  let o;
  try { o = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const f of ['title', 'number']) if (line(o[f])) out[f] = line(o[f]);
  for (const f of ['issue_date', 'expiry_date']) if (isDate(o[f])) out[f] = o[f];
  if (o.renew_by === 'quotes' || o.renew_by === 'remind') out.renew_by = o.renew_by;
  const details = cleanDetails(o);
  if (Object.keys(details).length) out.details = details;
  return out;
}

/** The file as Claude takes it: a PDF as a document, a photo as a picture. Nothing for any other kind. */
function block(file) {
  const data = file.buffer.toString('base64');
  if (file.mimetype === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  if (IMAGE.test(file.mimetype)) return { type: 'image', source: { type: 'base64', media_type: file.mimetype, data } };
  return null;
}

/** What an uploaded file says about itself, to fill the form with. {} when it cannot be read, for any reason. */
export async function readDocument(file, { ask = claudeAsk } = {}) {
  const b = file && block(file);
  if (!b) return {};
  try {
    return suggestion(await ask(null, { maxTokens: 600, content: [b, { type: 'text', text: PROMPT }] }));
  } catch (e) {
    console.error('[document-reader]', e.message);
    return {};
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/document-reader.test.js`
Expected: PASS, 3 tests (one `[document-reader] overloaded` line on stderr is the failure case being logged)

- [ ] **Step 5: Commit**

```bash
git add server/documentReader.js tests/document-reader.test.js
git commit -m "feat: Leasing - a document is read as it is filed: its name, number, dates and figures are suggested from the file, and nothing is guessed or saved"
```

---

### Task 2: A document belongs to a company, a building or a unit, and the register lists them all

**Files:**
- Modify: `server/db.js` (straight after the `prop_documents` block that ends with `CREATE INDEX IF NOT EXISTS idx_prop_documents …`, around line 1068)
- Modify: `server/properties.js` (`remove()` around line 114; the whole `// ---------- company documents ----------` section, lines 265–369; the routes around line 388)
- Modify: `tests/properties.test.js:76-79`
- Test: `tests/documents.test.js`

**Interfaces:**
- Consumes: `cleanDetails`, `readDocument` from `server/documentReader.js` (Task 1).
- Produces, all exported from `server/properties.js`:
  - `docStatus(doc, today) → 'on_file' | 'valid' | 'due' | 'expired'` — uses `doc.renew_days`, 90 when absent.
  - `addDocument(body, file, by) → doc` — owner in `body` as `company_id`, `building_id` or `unit_id`.
  - `addDoc(companyId, body, file, by) → doc` — unchanged signature, for a company.
  - `register({ company_id, building_id, status }?, today?) → row[]` — each row is a document plus `owner` (`'company' | 'building' | 'unit'`), `where` (text), `company`, `building`, `unit_no`, `in_company`, `in_building`, `status`, `days_left` (number, or null with no expiry), `count`.
  - `docHistory(id, today?) → doc[]` — newest first.
  - `places() → { companies: [{ id, name }], buildings: [{ id, name, company_id }], units: [{ id, unit_no, building_id }] }`
  - A sent document now also has `building_id`, `unit_id`, `renew_days`, `renew_by`, `details` (an object) and `status`.
  - Routes: `GET /api/properties/documents` → `{ documents, master }`; `GET /api/properties/documents/:id/history`; `POST /api/properties/documents`; `POST /api/properties/documents/read`; `GET /api/properties/places`.

- [ ] **Step 1: Write the failing test**

Create `tests/documents.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { reset, closeDb, db } from './helpers/db.js';
import { create, remove, docStatus, addDoc, addDocument, updateDoc, register, docHistory, places } from '../server/properties.js';

test.after(() => closeDb());

const AT = '2026-10-10';

async function tower() {
  await reset();
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  return { c, b, u };
}

test('a document is due once inside its own renewal window, three months unless it says otherwise', () => {
  assert.equal(docStatus({ expiry_date: null }, AT), 'on_file');
  assert.equal(docStatus({ expiry_date: '2027-01-08' }, AT), 'due', '90 days left');
  assert.equal(docStatus({ expiry_date: '2027-01-09' }, AT), 'valid', '91 days left');
  assert.equal(docStatus({ expiry_date: '2027-01-08', renew_days: 30 }, AT), 'valid');
  assert.equal(docStatus({ expiry_date: AT, renew_days: 0 }, AT), 'due', 'the day itself');
  assert.equal(docStatus({ expiry_date: '2026-10-09' }, AT), 'expired');
});

test('a document belongs to one company, one building or one unit, and the register lists them all', async () => {
  const { c, b, u } = await tower();

  const policy = await addDocument({ building_id: b.id, title: ' Fire insurance ', expiry_date: '2027-01-08', renew_by: 'quotes',
    details: JSON.stringify({ insurer: 'Orient', premium: 'USD 4,200', junk: 'x' }) });
  assert.deepEqual([policy.title, policy.building_id, policy.company_id, policy.renew_days, policy.renew_by, policy.details],
    ['Fire insurance', b.id, null, 90, 'quotes', { insurer: 'Orient', premium: 'USD 4,200' }]);
  // As a form sends it: text for the id, and empty text for the owners not chosen.
  const pest = await addDocument({ unit_id: String(u.id), company_id: '', building_id: '', title: 'Pest control', renew_days: '30' });
  assert.deepEqual([pest.unit_id, pest.renew_days], [u.id, 30]);
  await addDoc(c.id, { title: 'Trade License', expiry_date: '2026-09-01' });

  await assert.rejects(addDocument({ title: 'X' }), /one company, one building or one unit/);
  await assert.rejects(addDocument({ title: 'X', company_id: c.id, building_id: b.id }), /one company, one building or one unit/);
  await assert.rejects(addDocument({ title: 'X', building_id: 999 }), /Not found/);
  await assert.rejects(addDocument({ building_id: b.id }), /Give the document a name/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_days: 400 }), /0 to 365/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_days: '1.5' }), /0 to 365/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', renew_by: 'magic' }), /a reminder or by quotes/);
  await assert.rejects(addDocument({ building_id: b.id, title: 'X', details: '{not json' }), /details/);
  await assert.rejects(db.prepare('INSERT INTO prop_documents (title) VALUES (?)').run('Nobody'), /prop_documents_one_owner/);

  assert.deepEqual((await register({}, AT)).map((d) => [d.title, d.owner, d.where, d.status, d.days_left, d.count]), [
    ['Trade License', 'company', 'ACE', 'expired', -39, 1],
    ['Fire insurance', 'building', 'Tower', 'due', 90, 1],
    ['Pest control', 'unit', 'Unit 101, Tower', 'on_file', null, 1],
  ]);
  assert.deepEqual((await register({ building_id: b.id }, AT)).map((d) => d.title), ['Fire insurance', 'Pest control'], "a building's own and its units', not its company's");
  assert.deepEqual((await register({ company_id: c.id, status: 'expired' }, AT)).map((d) => d.title), ['Trade License']);
  assert.equal((await register({ company_id: c.id + 1 }, AT)).length, 0);
  assert.equal((await register({}, '2026-10-09'))[1].status, 'valid', 'the day before its window opens');

  // The same name again under the same owner is its renewal; under another owner it is another document.
  const renewed = await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  const [row] = await register({ building_id: b.id }, AT);
  assert.deepEqual([row.id, row.count, row.status], [renewed.id, 2, 'valid']);
  await addDoc(c.id, { title: 'Fire insurance' });
  assert.deepEqual((await docHistory(policy.id, AT)).map((d) => d.id), [renewed.id, policy.id]);
  assert.equal((await register({}, AT)).filter((d) => d.title.toLowerCase() === 'fire insurance').length, 2);
  await assert.rejects(docHistory(999), /Not found/);

  const edited = await updateDoc(renewed.id, { renew_days: '120', renew_by: 'remind', details: { cover: 'The building' } });
  assert.deepEqual([edited.renew_days, edited.renew_by, edited.details, edited.building_id], [120, 'remind', { cover: 'The building' }, b.id]);
  assert.equal((await updateDoc(renewed.id, { renew_days: '', notes: 'checked' })).renew_days, 120, 'an emptied window is left as it was');

  assert.deepEqual(await places(), { companies: [{ id: c.id, name: 'ACE' }], buildings: [{ id: b.id, name: 'Tower', company_id: c.id }], units: [{ id: u.id, unit_no: '101', building_id: b.id }] });
});

test("a building's and a unit's documents, and their files, go with them", async () => {
  const { b, u } = await tower();
  const pdf = { buffer: Buffer.from('%PDF'), originalname: 'policy.pdf', mimetype: 'application/pdf' };
  const one = await addDocument({ building_id: b.id, title: 'Insurance' }, pdf);
  const two = await addDocument({ unit_id: u.id, title: 'Gas certificate' }, pdf);
  const path = async (id) => (await db.prepare('SELECT file_path FROM prop_documents WHERE id = ?').get(id)).file_path;
  const [p1, p2] = [await path(one.id), await path(two.id)];
  assert.deepEqual([one.has_file, existsSync(p1), existsSync(p2)], [true, true, true]);

  await remove('unit', u.id);
  assert.deepEqual([existsSync(p1), existsSync(p2)], [true, false]);
  await remove('building', b.id);
  assert.equal(existsSync(p1), false);
  assert.equal((await register()).length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/documents.test.js`
Expected: FAIL — `The requested module '../server/properties.js' does not provide an export named 'addDocument'`

- [ ] **Step 3: Add the columns**

In `server/db.js`, directly after the `await db.exec(…)` that creates `prop_documents` and `idx_prop_documents`, add:

```js
// A document can belong to a building or a unit instead (an insurance policy, a
// certificate): exactly one of the three owns it.
//   renew_days: how long before it expires its renewal window opens (the rule is three months).
//   renew_by: 'remind' (one issuer: it is tracked) or 'quotes' (it is shopped around for).
//   details: the figures read from it, as JSON (insurer, premium, sum_insured, deductible, cover).
await db.exec(`
  ALTER TABLE prop_documents ALTER COLUMN company_id DROP NOT NULL;
  ALTER TABLE prop_documents ADD COLUMN IF NOT EXISTS building_id INTEGER REFERENCES prop_buildings(id) ON DELETE CASCADE;
  ALTER TABLE prop_documents ADD COLUMN IF NOT EXISTS unit_id INTEGER REFERENCES prop_units(id) ON DELETE CASCADE;
  ALTER TABLE prop_documents ADD COLUMN IF NOT EXISTS renew_days INTEGER NOT NULL DEFAULT 90;
  ALTER TABLE prop_documents ADD COLUMN IF NOT EXISTS renew_by TEXT NOT NULL DEFAULT 'remind';
  ALTER TABLE prop_documents ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE prop_documents DROP CONSTRAINT IF EXISTS prop_documents_one_owner;
  ALTER TABLE prop_documents ADD CONSTRAINT prop_documents_one_owner CHECK (num_nonnulls(company_id, building_id, unit_id) = 1);
  CREATE INDEX IF NOT EXISTS idx_prop_documents_building ON prop_documents(building_id);
  CREATE INDEX IF NOT EXISTS idx_prop_documents_unit ON prop_documents(unit_id);
`);
```

- [ ] **Step 4: Make the documents owner-aware**

In `server/properties.js`:

(a) Add to the imports at the top:

```js
import { cleanDetails, readDocument } from './documentReader.js';
```

(b) In `remove()`, replace the `const files = kind === 'company' ? … : [];` statement (the comment above it and the whole ternary) with:

```js
  // Its documents go with it: their rows cascade, their files are removed here. So do a
  // unit's photos, and those of its inspections.
  const files = (await db.prepare(`SELECT file_path FROM prop_documents WHERE ${OWNER[kind][0]} = ? AND file_path IS NOT NULL`).all(Number(id))).map((d) => d.file_path);
  if (kind === 'unit') {
    files.push(...(await db.prepare(`SELECT file_path FROM prop_unit_photos WHERE unit_id = ?
      UNION ALL SELECT p.file_path FROM prop_inspection_photos p JOIN prop_inspections i ON i.id = p.inspection_id WHERE i.unit_id = ?`).all(Number(id), Number(id))).map((p) => p.file_path));
  }
```

(c) Replace everything from the line `// ---------- company documents ----------` down to the end of `removeDoc()` (just above `// ---------- routes ----------`) with:

```js
// ---------- documents ----------
//
// A document belongs to one company, one building or one unit: a licence, an insurance
// policy, a certificate. It is named freely, and the same name again under the same owner
// is its renewal. Each has a renewal window (renew_days before it expires) inside which
// it is due.

const DOC_DIR = `${DATA_DIR}/properties`;
const RENEW = 90; // days before expiry a document is due, unless it says otherwise
const RENEW_BY = ['remind', 'quotes']; // tracked until it is renewed, or shopped around for
const OWNER = { company: ['company_id', 'prop_companies'], building: ['building_id', 'prop_buildings'], unit: ['unit_id', 'prop_units'] };
const DOC_COLS = `id, company_id, building_id, unit_id, title, number, notes, file_name, file_mime, uploaded_by, created_at, renew_days, renew_by, details,
  (file_path IS NOT NULL) AS has_file,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date`;
// Newest first within a name: the one that expires last, then the one added last.
const NEWEST = 'expiry_date DESC NULLS LAST, id DESC';

const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;

/** valid | due (inside its renewal window) | expired | on_file (no expiry) for one document, as of `today` (YYYY-MM-DD). */
export function docStatus(doc, today) {
  if (!doc.expiry_date) return 'on_file';
  const left = day(doc.expiry_date) - day(today);
  return left < 0 ? 'expired' : left <= (doc.renew_days ?? RENEW) ? 'due' : 'valid';
}

const key = (title) => title.trim().toLowerCase();
/** A row as it is sent: without where its file is kept, its details read back from their JSON, and its status as of `today`. */
const view = ({ file_path, ...d }, today = todayHere()) => ({ ...d, details: JSON.parse(d.details || '{}'), status: docStatus(d, today) });

/**
 * Each company with its documents grouped by name ("Trade License" twice is one licence,
 * renewed): the newest of each name decides its status, and the card counts those.
 */
export async function docBoard(today = todayHere()) {
  const companies = await listCompanies();
  const docs = await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id IS NOT NULL ORDER BY lower(title), ${NEWEST}`).all();
  return companies.map((c) => {
    const groups = new Map();
    for (const d of docs) {
      if (d.company_id !== c.id) continue;
      const g = groups.get(key(d.title));
      if (g) g.count += 1;
      else groups.set(key(d.title), { title: d.title, count: 1, doc: view(d, today) });
    }
    const list = [...groups.values()].map((g) => ({ ...g, status: g.doc.status }));
    return { ...c, docs: list, expired: list.filter((g) => g.status === 'expired').length, due: list.filter((g) => g.status === 'due').length };
  });
}

/** Every document of one company, or only those under one name (its renewals). */
export async function companyDocs(companyId, title, today = todayHere()) {
  const rows = title
    ? await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? AND lower(title) = ? ORDER BY ${NEWEST}`).all(Number(companyId), key(title))
    : await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? ORDER BY lower(title), ${NEWEST}`).all(Number(companyId));
  return rows.map((d) => view(d, today));
}

/**
 * The register: every document of every company, building and unit, one row a name an owner
 * (its newest copy; `count` is how many copies that name has), the most pressing first. Each
 * says whose it is (`owner`, and `where` in words) and how long it has (`days_left`).
 * Narrowed to a building, a company's own documents are left out.
 */
export async function register({ company_id, building_id, status } = {}, today = todayHere()) {
  const rows = await db.prepare(`SELECT d.*, u.unit_no, bl.id AS in_building, bl.name AS building, c.id AS in_company, c.name AS company
    FROM (SELECT ${DOC_COLS} FROM prop_documents) d
    LEFT JOIN prop_units u ON u.id = d.unit_id
    LEFT JOIN prop_buildings bl ON bl.id = coalesce(d.building_id, u.building_id)
    JOIN prop_companies c ON c.id = coalesce(d.company_id, bl.company_id)
    ORDER BY lower(d.title), d.expiry_date DESC NULLS LAST, d.id DESC`).all();
  const groups = new Map(); // an owner and a name → its newest copy
  for (const d of rows) {
    const owner = d.unit_id ? 'unit' : d.building_id ? 'building' : 'company';
    const k = `${owner}:${d[OWNER[owner][0]]}:${key(d.title)}`;
    const g = groups.get(k);
    if (g) g.count += 1;
    else {
      groups.set(k, { ...view(d, today), owner, count: 1, days_left: d.expiry_date ? day(d.expiry_date) - day(today) : null,
        where: owner === 'unit' ? `Unit ${d.unit_no}, ${d.building}` : owner === 'building' ? d.building : d.company });
    }
  }
  const rank = { expired: 0, due: 1, valid: 2, on_file: 3 };
  return [...groups.values()]
    .filter((d) => (!Number(company_id) || d.in_company === Number(company_id)) && (!Number(building_id) || d.in_building === Number(building_id)) && (!status || d.status === status))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.days_left - b.days_left || a.title.localeCompare(b.title));
}

/** Every company, building and unit by name: what a document can be filed under. */
export const places = async () => ({
  companies: await db.prepare('SELECT id, name FROM prop_companies ORDER BY name').all(),
  buildings: await db.prepare('SELECT id, name, company_id FROM prop_buildings ORDER BY name').all(),
  units: await db.prepare(`SELECT id, unit_no, building_id FROM prop_units
    ORDER BY NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(),
});

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(day(v));
function docFields(body = {}) {
  const out = {};
  for (const f of ['title', 'number', 'notes']) if (f in body) out[f] = String(body[f] ?? '').trim().slice(0, 300) || null;
  for (const f of ['issue_date', 'expiry_date']) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (v && !isDate(v)) throw bad(`${f === 'issue_date' ? 'Issue' : 'Expiry'} date is not a date.`);
    out[f] = v || null;
  }
  if ('title' in out && !out.title) throw bad('Give the document a name.');
  // A form sends an emptied box as empty text: that is the window left as it was, not no window.
  if ('renew_days' in body && String(body.renew_days ?? '').trim() !== '') {
    const n = Number(body.renew_days);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw bad('The renewal window is a whole number of days from 0 to 365.');
    out.renew_days = n;
  }
  if ('renew_by' in body) {
    if (!RENEW_BY.includes(body.renew_by)) throw bad('A document is renewed by a reminder or by quotes.');
    out.renew_by = body.renew_by;
  }
  if ('details' in body) out.details = JSON.stringify(cleanDetails(body.details));
  return out;
}

/** The one thing a document is filed under, from company_id, building_id or unit_id: exactly one of them. */
async function ownerOf(body = {}) {
  const given = Object.values(OWNER).filter(([col]) => Number(body[col]) > 0);
  if (given.length !== 1) throw bad('A document belongs to one company, one building or one unit.');
  const [[col, table]] = given;
  if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(body[col])))) throw bad('Not found', 404);
  return { [col]: Number(body[col]) };
}

const getDoc = async (id) => {
  const d = await db.prepare(`SELECT ${DOC_COLS}, file_path FROM prop_documents WHERE id = ?`).get(Number(id));
  if (!d) throw bad('Not found', 404);
  return d;
};

/** Every copy under one document's name and owner (the current one and its renewals), newest first. */
export async function docHistory(id, today = todayHere()) {
  const d = await getDoc(id);
  const [col] = Object.values(OWNER).find(([c]) => d[c] != null);
  return (await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE ${col} = ? AND lower(title) = ? ORDER BY ${NEWEST}`).all(d[col], key(d.title))).map((r) => view(r, today));
}

/** Keep an uploaded file on disk; gives the columns to store for it (nothing when no file came). */
export function saveFile(file, dir = DOC_DIR) {
  if (!file) return {};
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${Date.now()}-${randomBytes(6).toString('hex')}`;
  writeFileSync(path, file.buffer);
  return { file_path: path, file_name: file.originalname.slice(0, 200), file_mime: file.mimetype };
}

/** File a document under the company, building or unit named in `body`. */
export async function addDocument(body = {}, file, by) {
  const fields = docFields({ title: '', ...body });
  const row = { ...fields, ...(await ownerOf(body)), ...saveFile(file), uploaded_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO prop_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  return view(await getDoc(id));
}

/** File a document under a company. */
export const addDoc = (companyId, body, file, by) => addDocument({ ...body, company_id: companyId, building_id: null, unit_id: null }, file, by);

/** Change a document's details, and replace its file when a new one is sent. Whose it is stays. */
export async function updateDoc(id, body, file) {
  const old = await getDoc(id);
  const row = { ...docFields(body), ...saveFile(file) };
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE prop_documents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), old.id);
  if (file && old.file_path) rmSync(old.file_path, { force: true });
  return view(await getDoc(id));
}

export async function removeDoc(id) {
  const d = await getDoc(id);
  await db.prepare('DELETE FROM prop_documents WHERE id = ?').run(d.id);
  if (d.file_path) rmSync(d.file_path, { force: true });
  return { ok: true };
}
```

(d) In the routes, directly after the line `propertyRoutes.get('/docs/:id/file', …);`, add:

```js
// The register: every document, whoever it belongs to. Reading a file only suggests; nothing is kept by it.
propertyRoutes.get('/documents', wrap(async (req, res) => res.json({ documents: await register(req.query), master: req.user.role === 'master' })));
propertyRoutes.get('/documents/:id/history', wrap(async (req, res) => res.json(await docHistory(req.params.id))));
propertyRoutes.post('/documents', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await addDocument(req.body, req.file, req.user.id))));
propertyRoutes.post('/documents/read', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await readDocument(req.file))));
propertyRoutes.get('/places', wrap(async (req, res) => res.json(await places())));
```

- [ ] **Step 5: Bring the old status test in line with the window**

In `tests/properties.test.js`, replace lines 76–79 (the four `docStatus` assertions) with:

```js
  assert.equal(docStatus({ expiry_date: null }, '2026-10-02'), 'on_file');
  assert.equal(docStatus({ expiry_date: '2026-10-01' }, '2026-10-02'), 'expired');
  assert.equal(docStatus({ expiry_date: '2026-12-31' }, '2026-10-02'), 'due');
  assert.equal(docStatus({ expiry_date: '2027-01-01' }, '2026-10-02'), 'valid');
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/documents.test.js tests/properties.test.js tests/inspections.test.js`
Expected: PASS — the 3 new tests, and every existing properties and inspections test (the company-documents test still sees `card.due === 1` and the company's documents going with it)

- [ ] **Step 7: Commit**

```bash
git add server/db.js server/properties.js tests/documents.test.js tests/properties.test.js
git commit -m "feat: Leasing - a document belongs to a company, a building or a unit, with its own renewal window (three months unless it says otherwise), and one register lists them all, the most pressing first"
```

---

### Task 3: Document alerts

**Files:**
- Modify: `server/leasingAlerts.js` (imports; `DEFAULTS` and `RULES` near the top; `saveSettings`; `openAlerts`; `listAlerts`; `runAlerts`)
- Test: `tests/document-alerts.test.js`

**Interfaces:**
- Consumes: `register(q, today)` from `server/properties.js` (Task 2) — rows with `id`, `title`, `where`, `expiry_date`, `renew_days`, `days_left`, `building`, `in_building`, `company`, `unit_no`.
- Produces:
  - Setting `document: { on, days: number[] (largest first), every: number }` in `getSettings()` / `saveSettings()`.
  - Alerts with `rule: 'document'`, `key: 'document:<doc id>'`, `open: 'documents'`, `document_id`, `level`, `title`, `detail`, `days`, `fires`, `staff`, `owner: null`.
  - `openAlerts(s, cfg, q = {})` — the third argument is the company / building filter.
  - `'document'` in `RULES`, so `GET /api/leasing/alerts/count` returns `rules.document`.

- [ ] **Step 1: Write the failing test**

Create `tests/document-alerts.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, setBuildingStaff, addDocument, addDoc, updateDoc, removeDoc } from '../server/properties.js';
import { listAlerts, runAlerts, saveSettings, getSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

// Tower's fire insurance expires on 2027-01-08: 90 days after 2026-10-10, the day its window opens.
async function tower() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await setBuildingStaff(b.id, [staff]);
  const policy = await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2027-01-08' });
  return { master, staff, c, b, u, policy };
}
const docs = async (day, q = {}) => (await listAlerts(q, day)).filter((a) => a.rule === 'document');

test('a document is on the alerts from the day its renewal window opens until a renewed copy is filed', async () => {
  const { c, b, policy } = await tower();
  assert.deepEqual(await docs('2026-10-09'), []);
  const [open] = await docs('2026-10-10');
  assert.deepEqual([open.key, open.level, open.fires, open.title, open.detail, open.open, open.document_id],
    [`document:${policy.id}`, 'info', true, 'Fire insurance expires in 90 days', 'Tower · 01/08/2027', 'documents', policy.id]);

  const at = async (day) => { const [a] = await docs(day); return [a.level, a.fires, a.title]; };
  assert.deepEqual(await at('2026-10-11'), ['info', false, 'Fire insurance expires in 89 days']);
  assert.deepEqual(await at('2026-11-09'), ['info', true, 'Fire insurance expires in 60 days']);
  assert.deepEqual(await at('2026-12-09'), ['warn', true, 'Fire insurance expires in 30 days']);
  assert.deepEqual(await at('2027-01-01'), ['warn', true, 'Fire insurance expires in 7 days']);
  assert.deepEqual(await at('2027-01-07'), ['warn', false, 'Fire insurance expires in 1 day']);
  assert.deepEqual(await at('2027-01-08'), ['bad', true, 'Fire insurance expires today']);
  assert.deepEqual(await at('2027-01-10'), ['bad', false, 'Fire insurance has expired']);
  assert.deepEqual(await at('2027-01-15'), ['bad', true, 'Fire insurance has expired']);

  assert.equal((await docs('2026-10-10', { company_id: c.id })).length, 1);
  assert.equal((await docs('2026-10-10', { building_id: b.id + 1 })).length, 0);

  // Its own window: thirty days, so nothing until then, and that day it buzzes.
  await updateDoc(policy.id, { renew_days: 30 });
  assert.deepEqual(await docs('2026-10-10'), []);
  assert.deepEqual(await at('2026-12-09'), ['warn', true, 'Fire insurance expires in 30 days']);

  // The renewed copy closes it; taken away again, the old copy decides once more.
  const renewed = await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  assert.deepEqual(await docs('2027-01-15'), []);
  await removeDoc(renewed.id);
  assert.equal((await docs('2027-01-15'))[0].key, `document:${policy.id}`);

  // The master's rule: its days, and whether it is on at all.
  assert.deepEqual((await getSettings()).document, { on: true, days: [60, 30, 7], every: 7 });
  await assert.rejects(saveSettings({ document: { days: '' } }), /between one and eight/);
  assert.deepEqual((await saveSettings({ document: { days: '14, 45', every: 3 } })).document, { on: true, days: [45, 14], every: 3 });
  assert.deepEqual(await at('2027-01-11'), ['bad', true, 'Fire insurance has expired']);
  await saveSettings({ document: { on: false } });
  assert.deepEqual(await docs('2027-01-15'), []);
});

test("who is told about a document: the building's staff and the master, once a day, and at once when nobody has been", async () => {
  const { master, staff, c, u } = await tower();
  const byUser = (sent) => sent.sort((x, y) => x.user_id - y.user_id);
  assert.deepEqual(await runAlerts('2026-10-10', 23), [], 'nothing goes out in the quiet hours');
  const note = { title: 'Fire insurance expires in 90 days', body: 'Tower · 01/08/2027' };
  assert.deepEqual(byUser(await runAlerts('2026-10-10', 9)), [{ user_id: master, ...note }, { user_id: staff, ...note }]);
  assert.deepEqual(await runAlerts('2026-10-10', 10), [], 'the same day again sends nothing');
  assert.deepEqual(await runAlerts('2026-10-11', 9), [], 'and nothing more until one of its days');

  // Filed when already expired, or already inside the window: nobody has been told, so it goes that morning.
  // A company's document is the master's alone; a unit's goes to its building's staff too.
  await addDoc(c.id, { title: 'Trade License', expiry_date: '2026-10-25' });
  await addDocument({ unit_id: u.id, title: 'Gas certificate', expiry_date: '2026-10-01' });
  assert.deepEqual(byUser(await runAlerts('2026-10-12', 9)), [
    { user_id: master, title: 'Gas certificate has expired', body: 'Unit 101, Tower · 10/01/2026 — and 1 more' },
    { user_id: staff, title: 'Gas certificate has expired', body: 'Unit 101, Tower · 10/01/2026' },
  ]);
  assert.deepEqual(await runAlerts('2026-10-13', 9), [], 'told once, they wait for its next day');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/document-alerts.test.js`
Expected: FAIL — the first test at `assert.deepEqual([open.key, …` with `Cannot read properties of undefined (reading 'key')` (there is no document rule yet)

- [ ] **Step 3: Add the rule**

In `server/leasingAlerts.js`:

(a) Add to the imports:

```js
import { register } from './properties.js';
```

(b) In `DEFAULTS`, after the `eid:` line, add:

```js
  document: { on: true, days: [60, 30, 7], every: 7 },   // a document inside its renewal window: more days before it expires, then every so many after
```

(c) Change `RULES` to:

```js
export const RULES = ['overdue', 'due', 'upcoming', 'ending', 'contract', 'eid', 'document'];
```

(d) In `saveSettings`, inside `const next = { … }`, after the `eid:` line, add:

```js
    document: { on: on('document'), days: pick('document', 'days', (v) => dayList(v, 'Days before a document expires')), every: pick('document', 'every', (v) => Math.max(1, whole(v, 90, 'Repeat every'))) },
```

(e) Change the signature of `openAlerts` and its doc comment's last lines:

```js
 *   pay | docs | booking | tenants | documents), `owner` (who made the booking), and `fires`:
 *   whether today is one of the days this rule buzzes a phone. `q` is the company or building
 *   the list is narrowed to, for what is not found through a booking.
 */
export async function openAlerts(s, cfg, q = {}) {
```

(f) In `openAlerts`, after the closing brace of the `if (cfg.eid.on) { … }` block and before `const rank = …`, add:

```js
  // A document, from the day its own renewal window opens until a renewed copy is filed.
  // It belongs to no lease, so it is told to its building's staff (a company's, to the master alone).
  if (cfg.document.on) {
    for (const d of await register({ company_id: q.company_id, building_id: q.building_id }, s.today)) {
      const left = d.days_left;
      if (left == null || left > d.renew_days) continue;
      out.push({ rule: 'document', key: `document:${d.id}`, document_id: d.id, open: 'documents', days: left,
        level: left <= 0 ? 'bad' : left <= 30 ? 'warn' : 'info',
        building: d.building, building_id: d.in_building, company: d.company, unit_no: d.unit_no, owner: null, staff: s.staffOf.get(d.in_building) || [],
        title: left < 0 ? `${d.title} has expired` : `${d.title} expires ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}`,
        detail: `${d.where} · ${usDate(d.expiry_date)}`,
        fires: left === d.renew_days || left === 0 || (left > 0 && cfg.document.days.includes(left)) || (left < 0 && -left % cfg.document.every === 0) });
    }
  }
```

(g) Change `listAlerts` to pass the filter on:

```js
export async function listAlerts(q = {}, today = todayHere()) {
  return openAlerts(await snapshot(q, today), await getSettings(), q);
}
```

(h) In `runAlerts`, replace the comment above `const told = …` and the `const goes = …` line:

```js
  // Rent that is overdue, or a document inside its window, that this person has never been
  // told about goes out now, whatever day it is on: a tenancy brought in already late, a
  // document filed when it was already due, or one whose day to buzz fell while the server
  // was down. After that it keeps to the rule's days.
```

```js
      const goes = a.fires || ((a.rule === 'overdue' || a.rule === 'document') && !(await told(userId, a.key)));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/document-alerts.test.js tests/leasing-reports.test.js tests/leasing-money.test.js tests/leasing.test.js`
Expected: PASS — the 2 new tests, and the existing alert tests unchanged (they file no documents, so no `document` alert appears in their lists)

- [ ] **Step 5: Commit**

```bash
git add server/leasingAlerts.js tests/document-alerts.test.js
git commit -m "feat: Leasing - a document is on the alerts from the day its renewal window opens, buzzes its building's staff and the master on its days and after it expires, and is closed by filing the renewed copy"
```

---

### Task 4: The shared form and sheet, and company documents on them

**Files:**
- Create: `client/src/components/DocumentForm.jsx`
- Create: `client/src/components/DocumentSheet.jsx`
- Modify: `client/src/components/CompanyDocs.jsx` (remove its own `DocForm`, `DocSheet`, `DOT`, `CHIP`, `daysLeft`, `chipText`; use the shared ones)

**Interfaces:**
- Consumes: `POST /api/properties/documents/read`, `POST /api/properties/documents`, `PUT /api/properties/docs/:id`, `DELETE /api/properties/docs/:id`, `GET /api/properties/documents/:id/history`, `GET /api/properties/docs/:id/file` (Task 2).
- Produces:
  - `DocumentForm` (default export), props `{ owner, preset, places, start, from, onDone, onCancel }`. `owner` is `{ company_id } | { building_id } | { unit_id }` when it is already known; otherwise the form shows a picker built from `places` and starting at `preset` (`{ kind, company_id, building_id, unit_id }`). `start` is a document being edited; `from` is the copy a renewal follows.
  - `DETAILS` (named export of `DocumentForm.jsx`): `[[key, label], …]`.
  - `DocumentSheet` (default export), props `{ doc, owner, preset, places, label, master, onClose, onChanged }`. `doc` is any copy of the document to open, or null for a new one.
  - `DOT`, `CHIP`, `chipText(doc)` (named exports of `DocumentSheet.jsx`).

- [ ] **Step 1: Write the form**

Create `client/src/components/DocumentForm.jsx`:

```jsx
import { useRef, useState } from 'react';
import { Loader2, Paperclip, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import DateField from './DateField';
import Select from './Select';

// The form a document is filed with, whoever it belongs to: a company, a building or a unit.
// Choosing the file sends it to be read (server/documentReader.js), and what comes back fills
// the boxes still empty, outlined until somebody touches them: a suggestion, checked by a
// person before it is saved. A copy under a name already there is that document's renewal.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const SEGMENT = 'flex gap-1 rounded-full border border-stroke p-0.5 text-sm';
const KINDS = [['company', 'Company'], ['building', 'Building'], ['unit', 'Unit']];
const BY = [['remind', 'Just remind me'], ['quotes', 'Get quotes']];
export const DETAILS = [['insurer', 'Insurer or supplier'], ['premium', 'Premium / price'], ['sum_insured', 'Sum insured'], ['deductible', 'Deductible'], ['cover', 'What is covered']];
const BLANK = Object.fromEntries(DETAILS.map(([k]) => [k, '']));
const seg = (on) => `flex-1 rounded-full px-3 py-1.5 ${on ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`;

/** Whose document it is: a company, one of its buildings, or one of that building's units. */
function Owner({ places, at, onAt }) {
  const buildings = places.buildings.filter((b) => String(b.company_id) === String(at.company_id));
  const units = places.units.filter((u) => String(u.building_id) === String(at.building_id));
  // Choosing higher up clears what was chosen under it.
  const pick = (f) => (e) => onAt({ ...at, [f]: e.target.value, ...(f === 'company_id' ? { building_id: '', unit_id: '' } : f === 'building_id' ? { unit_id: '' } : {}) });
  return (
    <div className="space-y-2">
      <div className={SEGMENT}>
        {KINDS.map(([k, l]) => <button key={k} type="button" onClick={() => onAt({ ...at, kind: k })} aria-pressed={at.kind === k} className={seg(at.kind === k)}>{l}</button>)}
      </div>
      <Select value={at.company_id} onChange={pick('company_id')} options={places.companies.map((c) => [c.id, c.name])} placeholder="Company *" aria-label="Company" className={FIELD} />
      {at.kind !== 'company' && <Select value={at.building_id} onChange={pick('building_id')} options={buildings.map((b) => [b.id, b.name])} placeholder="Building *" aria-label="Building" disabled={!at.company_id} className={FIELD} />}
      {at.kind === 'unit' && <Select value={at.unit_id} onChange={pick('unit_id')} options={units.map((u) => [u.id, `Unit ${u.unit_no}`])} placeholder="Unit *" aria-label="Unit" disabled={!at.building_id} className={FIELD} />}
    </div>
  );
}

export default function DocumentForm({ owner, preset, places, start, from, onDone, onCancel }) {
  const seed = start || from; // an edit starts from the document itself; a renewal from the copy it follows
  const [v, setV] = useState({ title: seed?.title || '', number: start?.number || '', issue_date: start?.issue_date || '', expiry_date: start?.expiry_date || '', notes: start?.notes || '',
    renew_days: seed?.renew_days ?? 90, renew_by: seed?.renew_by || 'remind' });
  const [details, setDetails] = useState({ ...BLANK, ...start?.details });
  const [at, setAt] = useState({ kind: 'building', company_id: '', building_id: '', unit_id: '', ...preset });
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [suggested, setSuggested] = useState([]); // the boxes filled in from the file and not yet touched
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is in the boxes right now, for when the reading comes back: it may not overwrite what was typed meanwhile.
  const live = useRef();
  live.current = { v, details };

  const touch = (f) => setSuggested((s) => s.filter((x) => x !== f));
  const set = (f) => (e) => { touch(f); setV({ ...v, [f]: e.target.value }); };
  const setDetail = (f) => (e) => { touch(f); setDetails({ ...details, [f]: e.target.value }); };
  const look = (f) => `${FIELD} ${suggested.includes(f) ? 'border-p3/70' : ''}`;

  // A new document's file is read while the form is filled in. Only boxes still empty take what was read.
  const choose = async (picked) => {
    setFile(picked);
    if (!picked || start) return;
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', picked);
      const got = await api.upload('/properties/documents/read', form);
      const now = live.current;
      const filled = [];
      const nextV = { ...now.v };
      for (const f of ['title', 'number', 'issue_date', 'expiry_date']) if (got[f] && !now.v[f]) { nextV[f] = got[f]; filled.push(f); }
      if (got.renew_by && !from) nextV.renew_by = got.renew_by;
      const nextD = { ...now.details };
      for (const [f] of DETAILS) if (got.details?.[f] && !now.details[f]) { nextD[f] = got.details[f]; filled.push(f); }
      setV(nextV); setDetails(nextD); setSuggested(filled);
    } catch { /* not read: the form is filled in by hand */ }
    setReading(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const own = owner || { [`${at.kind}_id`]: at[`${at.kind}_id`] };
    if (!start && !Object.values(own)[0]) { setError(`Choose the ${at.kind} this document belongs to.`); return; }
    setBusy(true);
    setError('');
    const form = new FormData();
    for (const [k, x] of Object.entries(v)) form.append(k, x);
    form.append('details', JSON.stringify(v.renew_by === 'quotes' ? details : {}));
    if (!start) for (const [k, x] of Object.entries(own)) form.append(k, x);
    if (file) form.append('file', file);
    try {
      if (start) await api.uploadPut(`/properties/docs/${start.id}`, form);
      else await api.upload('/properties/documents', form);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      {!owner && !start && places && <Owner places={places} at={at} onAt={setAt} />}
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute hover:bg-white/5">
        {reading ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
        <span className="truncate">{reading ? 'Reading the file…' : file ? file.name : start?.has_file ? `Replace file (${start.file_name})` : 'Attach the file (PDF or photo): it is read for you'}</span>
        <input type="file" accept="application/pdf,image/*,.doc,.docx" className="hidden" onChange={(e) => choose(e.target.files?.[0] || null)} />
      </label>
      {suggested.length > 0 && <p className="flex items-center gap-1.5 px-1 text-xs text-p3"><Sparkles size={13} /> Filled in from the file. Check the outlined boxes before you save.</p>}
      <input value={v.title} onChange={set('title')} required placeholder="Document name, e.g. Fire insurance *" className={look('title')} />
      <input value={v.number} onChange={set('number')} placeholder="Number / reference" className={look('number')} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-mute">Issue date<DateField value={v.issue_date} onChange={set('issue_date')} className={look('issue_date')} wrap="mt-1" /></label>
        <label className="text-xs text-mute">Expiry date<DateField value={v.expiry_date} onChange={set('expiry_date')} className={look('expiry_date')} wrap="mt-1" /></label>
      </div>
      <p className="px-1 text-xs text-mute">Leave expiry empty for documents that do not expire (e.g. MOA).</p>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm">
        <span className="text-txt/80">Start renewing</span>
        <span className="flex items-center gap-2">
          <input value={v.renew_days} inputMode="numeric" aria-label="Days before it expires to start renewing"
            onChange={(e) => setV({ ...v, renew_days: e.target.value.replace(/\D/g, '').slice(0, 3) })}
            className="glass w-16 rounded-xl px-3 py-2 text-right tabular-nums outline-none focus:border-p1/70" />
          <span className="text-mute">days before it expires</span>
        </span>
      </div>
      <div className={SEGMENT}>
        {BY.map(([k, l]) => <button key={k} type="button" onClick={() => setV({ ...v, renew_by: k })} aria-pressed={v.renew_by === k} className={seg(v.renew_by === k)}>{l}</button>)}
      </div>
      {v.renew_by === 'quotes' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {DETAILS.map(([k, l]) => <input key={k} value={details[k]} onChange={setDetail(k)} placeholder={l} aria-label={l} className={`${look(k)} ${k === 'cover' ? 'sm:col-span-2' : ''}`} />)}
        </div>
      )}
      <textarea value={v.notes} onChange={set('notes')} rows={2} placeholder="Notes" className={`${FIELD} resize-none`} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={busy || reading} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Write the sheet**

Create `client/src/components/DocumentSheet.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { FileText, Loader2, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Sheet from './Sheet';
import DocumentForm, { DETAILS } from './DocumentForm';

// One document, whoever it belongs to: its current copy and the renewals under it. Open
// the file, edit, delete, or add the renewed copy. With no document it is a new one.
// Each copy has a status: valid, due (inside its renewal window), expired, or on file.

export const DOT = { valid: 'bg-ok', due: 'bg-warn', expired: 'bg-bad', on_file: 'bg-mute' };
export const CHIP = { valid: 'bg-ok/10 text-ok', due: 'bg-warn/10 text-warn', expired: 'bg-bad/10 text-bad', on_file: 'bg-white/10 text-txt/80' };

const daysLeft = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);

export function chipText(doc) {
  if (doc.status === 'on_file') return 'On file';
  if (doc.status === 'expired') return `Expired ${fmt(doc.expiry_date)}`;
  if (doc.status === 'due') { const n = daysLeft(doc.expiry_date); return n === 0 ? 'Expires today' : `${n} day${n === 1 ? '' : 's'} left`; }
  return `Until ${fmt(doc.expiry_date)}`;
}

export default function DocumentSheet({ doc, owner, preset, places, label, master, onClose, onChanged }) {
  const [anchor, setAnchor] = useState(doc?.id || null); // any copy of it: its history is read by one
  const [docs, setDocs] = useState(doc ? null : []);
  const [editing, setEditing] = useState(doc ? null : 'new');
  const [error, setError] = useState('');
  const load = (id = anchor) => id && api.get(`/properties/documents/${id}/history`).then(setDocs).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const done = () => { onChanged(); if (!anchor) return onClose(); setEditing(null); load(); };
  const remove = async (d) => {
    if (!confirm(`Delete ${d.title}${d.number ? ` ${d.number}` : ''}?`)) return;
    try {
      await api.del(`/properties/docs/${d.id}`);
      onChanged();
      const rest = docs.filter((x) => x.id !== d.id);
      if (!rest.length) { onClose(); return; }
      setAnchor(rest[0].id);
      load(rest[0].id);
    } catch (e) { setError(e.message); }
  };
  // A renewal is filed where the document already is.
  const current = docs?.[0];
  const own = owner || (current && (current.unit_id ? { unit_id: current.unit_id } : current.building_id ? { building_id: current.building_id } : { company_id: current.company_id }));

  return (
    <Sheet title={[current?.title || doc?.title || 'New document', label].filter(Boolean).join(' · ')} icon={<FileText size={18} className="text-mute" />} onClose={onClose}>
      <div className="space-y-2.5">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!docs ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : docs.map((d, i) => (editing === d.id
          ? <DocumentForm key={d.id} owner={own} start={d} onDone={done} onCancel={() => setEditing(null)} />
          : (
            <div key={d.id} className="rounded-2xl border border-stroke px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{d.title}{d.number && <span className="text-mute"> · {d.number}</span>}
                    {i === 0 && docs.length > 1 && <span className="ml-2 rounded-full bg-p1/20 px-2 py-0.5 text-[11px] text-p1">current</span>}</p>
                  <p className="mt-0.5 text-xs text-mute">
                    {[d.issue_date && `Issued ${fmt(d.issue_date)}`, d.expiry_date ? `Expires ${fmt(d.expiry_date)}` : 'No expiry',
                      i === 0 && d.expiry_date && `Renewal starts ${d.renew_days} days before`].filter(Boolean).join(' · ')}
                  </p>
                  <span className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs ${CHIP[d.status]}`}>{chipText(d)}</span>
                  {DETAILS.some(([k]) => d.details?.[k]) && (
                    <dl className="mt-2 space-y-0.5 text-sm">
                      {DETAILS.filter(([k]) => d.details[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{d.details[k]}</dd></div>)}
                    </dl>
                  )}
                  {d.notes && <p className="mt-1.5 whitespace-pre-wrap text-sm text-txt/80">{d.notes}</p>}
                  {d.has_file && <a href={`/api/properties/docs/${d.id}/file`} target="_blank" rel="noreferrer"
                    className="mt-1.5 flex items-center gap-1.5 text-sm text-p3 hover:underline"><Paperclip size={14} /> {d.file_name}</a>}
                </div>
                {master && <>
                  <button onClick={() => setEditing(d.id)} aria-label="Edit" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
                  <button onClick={() => remove(d)} aria-label="Delete" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
                </>}
              </div>
            </div>
          )))}
        {master && (editing === 'new'
          ? <DocumentForm owner={own} preset={preset} places={places} from={current} onDone={done} onCancel={() => (anchor ? setEditing(null) : onClose())} />
          : (
            <button onClick={() => setEditing('new')}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
              <Plus size={16} /> Add a renewal
            </button>
          ))}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 3: Put the company cards on the shared form and sheet**

In `client/src/components/CompanyDocs.jsx`:

(a) Replace the imports and the header comment (lines 1–12) with:

```jsx
import { useEffect, useState } from 'react';
import { Building2, DoorOpen, Loader2, ChevronRight, ChevronDown, Plus, Search } from 'lucide-react';
import { photoUrl } from './PropertyPhoto';
import { api } from '../lib/api';
import { usDate as fmt, usPhone, usAddress } from '../lib/usFormat';
import DocumentSheet, { DOT, CHIP, chipText } from './DocumentSheet';

// The Properties home: one card per company, with its details, its documents (each with
// its status: valid, due inside its renewal window, expired, or on file with no expiry) and
// its buildings. Documents are named freely; adding one under a name already there is its
// renewal. The form and the sheet are the ones every document uses (DocumentSheet.jsx);
// the server is the documents part of server/properties.js.
```

(b) Delete the constants `DOT`, `CHIP`, `daysLeft`, the function `chipText`, and the components `DocForm` and `DocSheet` (everything between the `FIELD` constant's line and the line `const TABS = […]`, keeping `FIELD` and `initials`). After this the file's top-level declarations, in order, are: `FIELD`, `initials`, `TABS`, `Card`, `CompanyDocs`.

(c) In `Card`, the row's button currently calls `onDoc(c, g.title)`. Change it to hand over the copy itself:

```jsx
                  <button onClick={() => onDoc(c, g.doc)} className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs ${CHIP[g.status]} hover:brightness-125`}>
```

(The "Add document" button's `onDoc(c, null)` stays as it is.)

(d) In `CompanyDocs`, change the `open` state's comment, the `Card`'s `onDoc`, and the sheet at the bottom:

```jsx
  const [open, setOpen] = useState(null); // { company, doc } - no doc for a new document
```

```jsx
          <Card key={c.id} c={c} master={master} onOpen={() => onOpen(c)} onDoc={(company, doc) => setOpen({ company, doc })} />
```

```jsx
      {open && <DocumentSheet doc={open.doc} owner={{ company_id: open.company.id }} label={open.company.name} master={master} onClose={() => setOpen(null)} onChanged={load} />}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `npm run build`
Expected: the Vite build finishes with no errors (no "is not defined", no unresolved import)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DocumentForm.jsx client/src/components/DocumentSheet.jsx client/src/components/CompanyDocs.jsx
git commit -m "feat: Leasing - one form and one sheet for every document: the file is read and fills the empty boxes for a person to check, with the renewal window, how it is renewed and its figures; company documents use them"
```

---

### Task 5: The Documents page, a building's Documents tab, and the alerts' new kind

**Files:**
- Create: `client/src/components/Documents.jsx`
- Modify: `client/src/components/Leasing.jsx` (imports near line 18; `LeasingPage` near lines 995–1067)
- Modify: `client/src/components/Sidebar.jsx` (the `lucide-react` import on line 2; the `places` list near line 57)
- Modify: `client/src/components/LeasingAlerts.jsx` (the `lucide-react` import; `ALERT_KINDS`, `RULE`, `DOES`, `TINT`; the `cards` list in `Rules`)
- Modify: `client/src/components/Properties.jsx` (imports; `BUILDING_TABS` near line 370; the building page near line 497)

**Interfaces:**
- Consumes: `GET /api/properties/documents` → `{ documents, master }`, `GET /api/properties/places` (Task 2); alerts with `open: 'documents'` and `document_id`, `rules.document` from `GET /api/leasing/alerts/count`, the `document` setting (Task 3); `DocumentSheet`, `DOT`, `CHIP`, `chipText` (Task 4).
- Produces: `Documents` (default export), props `{ openId, building }`. `openId` is a document id to open on arrival; `building` is `{ id, company_id }` to show only that building's documents and file new ones under it.

- [ ] **Step 1: Write the page**

Create `client/src/components/Documents.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import Select from './Select';
import DocumentSheet, { DOT, CHIP, chipText } from './DocumentSheet';

// The documents register: every document of every company, building and unit in one list,
// the most pressing first (expired, then due inside its renewal window, then the rest). A
// row opens the document: its file, its details and the renewals under it. The server is the
// documents part of server/properties.js. Given a building, it is that building's list.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const STATUS = [['', 'Any status'], ['expired', 'Expired'], ['due', 'Due for renewal'], ['valid', 'Valid'], ['on_file', 'On file']];

export default function Documents({ openId, building }) {
  const [d, setD] = useState(null); // { documents, master }
  const [places, setPlaces] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ company: '', building: '', status: '' });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // a row of the list, or 'new'
  const load = () => api.get('/properties/documents').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); api.get('/properties/places').then(setPlaces).catch(() => {}); }, []);
  // Arriving from an alert: the document it is about opens once the list is here, and only that once.
  const arrived = useRef(false);
  useEffect(() => {
    const row = openId && d?.documents.find((x) => x.id === openId);
    if (row && !arrived.current) { arrived.current = true; setOpen(row); }
  }, [openId, d]);

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!d) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const mine = building ? d.documents.filter((x) => x.in_building === building.id) : d.documents;
  // Every word typed must appear in the document's name, number or where it belongs.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = mine.filter((x) => (!f.company || String(x.in_company) === String(f.company)) && (!f.building || String(x.in_building) === String(f.building))
    && (!f.status || x.status === f.status) && words.every((w) => [x.title, x.number, x.where, x.company].join(' ').toLowerCase().includes(w)));
  const buildings = places ? places.buildings.filter((b) => !f.company || String(b.company_id) === String(f.company)) : [];
  const counts = { expired: mine.filter((x) => x.status === 'expired').length, due: mine.filter((x) => x.status === 'due').length };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {counts.expired > 0 && <span className="rounded-full bg-bad/15 px-2.5 py-1 text-xs text-bad">{counts.expired} expired</span>}
        {counts.due > 0 && <span className="rounded-full bg-warn/15 px-2.5 py-1 text-xs text-warn">{counts.due} due for renewal</span>}
        {d.master && (
          <button onClick={() => setOpen('new')} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white">
            <Plus size={16} /> Add document
          </button>
        )}
      </div>

      {mine.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, number or place" className={`${FIELD} pl-10`} />
          </label>
          {!building && places && <>
            <Select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value, building: '' })} options={[['', 'All companies'], ...places.companies.map((c) => [c.id, c.name])]} aria-label="Company" className={FIELD} />
            <Select value={f.building} onChange={(e) => setF({ ...f, building: e.target.value })} options={[['', 'All buildings'], ...buildings.map((b) => [b.id, b.name])]} aria-label="Building" className={FIELD} />
          </>}
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={STATUS} aria-label="Status" className={FIELD} />
        </div>
      )}

      <div className="rounded-2xl border border-stroke">
        {shown.length === 0 ? <p className="px-4 py-6 text-center text-sm text-mute">{mine.length ? 'No document matches.' : 'No documents yet.'}</p> : (
          <div className="divide-y divide-stroke/60">
            {shown.map((x) => (
              <button key={x.id} onClick={() => setOpen(x)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04]">
                <span className={`size-2 shrink-0 rounded-full ${DOT[x.status]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{x.title}{x.count > 1 && <span className="ml-1.5 rounded-full bg-white/15 px-1.5 text-[10px]">×{x.count}</span>}</span>
                  <span className="block truncate text-xs text-mute">{[x.where, x.owner !== 'company' && x.company, x.number].filter(Boolean).join(' · ')}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${CHIP[x.status]}`}>{chipText(x)}</span>
                <ChevronRight size={16} className="shrink-0 text-mute" />
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <DocumentSheet doc={open === 'new' ? null : open} label={open === 'new' ? '' : open.where} places={places} master={d.master}
          preset={building && { kind: 'building', company_id: building.company_id, building_id: building.id }}
          onClose={() => setOpen(null)} onChanged={load} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Open it from Leasing, and from an alert**

In `client/src/components/Leasing.jsx`:

(a) After the line `import LeasingAlerts from './LeasingAlerts';` add:

```jsx
import Documents from './Documents';
```

(b) In `LeasingPage`, after the line `const [fresh, setFresh] = useState(null); …` add:

```jsx
  const [docOpen, setDocOpen] = useState(null); // the document an alert was about, opened on the Documents page
```

(c) Replace the `// An alert opens the screen that deals with it.` comment and the `const openAlert = …` line with:

```jsx
  // An alert opens the screen that deals with it.
  const openAlert = (a) => {
    if (a.open === 'documents') { setDocOpen(a.document_id); setTab('documents'); return; }
    if (a.open === 'tenants') { setTab('tenants'); return; }
    openBooking(a.booking_id, { pay: 'payOf', docs: 'docsOf' }[a.open]);
  };
```

(d) After the line that starts `if (tab === 'alerts') return <Page title="Alerts" …` add:

```jsx
  if (tab === 'documents') return <Page title="Documents" onBack={onBack}><Documents key={key} openId={docOpen} /></Page>;
```

(e) Update the comment above `BOOKING_TABS` so the list of pages reads `…Calendar, Tenants, Reports, Alerts and Documents.`

- [ ] **Step 3: Give it a row in the sidebar**

In `client/src/components/Sidebar.jsx`:

(a) Add `FileClock` to the `lucide-react` import on line 2 (keep the list alphabetical: after `Eye`).

(b) In `places`, after the `Alerts` entry (the object whose `label` is `'Alerts'`), add:

```jsx
    { Ico: FileClock, color: 'from-lime-400 to-green-600 shadow-green-500/30', label: 'Documents', hint: alerts.rules.document ? `${alerts.rules.document} to renew` : 'Policies, licences and certificates, with their expiry',
      here: leasingOpen && leasingTab === 'documents', onClick: () => onLeasing('documents'), badge: alerts.rules.document },
```

- [ ] **Step 4: Teach the Alerts screen the new kind**

In `client/src/components/LeasingAlerts.jsx`:

(a) Add `FileClock` to the `lucide-react` import (after `CreditCard`).

(b) In `ALERT_KINDS`, after the `['eid', …]` entry, add:

```jsx
  ['document', 'Documents', FileClock, 'slate', 'Documents to renew'],
```

(c) In `RULE`, add `document: ['Documents', FileClock]` after the `eid` entry:

```jsx
const RULE = {
  overdue: ['Overdue', TriangleAlert], due: ['Due today', Banknote], upcoming: ['Coming up', CalendarClock],
  ending: ['Leases ending', CalendarDays], contract: ['No contract', FileWarning], eid: ['ID expiry', CreditCard], document: ['Documents', FileClock],
};
```

(d) Change `DOES` to:

```jsx
const DOES = { pay: 'Record payment', docs: 'Add the contract', booking: 'Open lease', tenants: 'Open tenants', documents: 'Open document' };
```

(e) In `TINT`, add `document: 'from-lime-400 to-green-600',` on the line after the one holding `eid:`.

(f) In `Rules`, in the `cards` list, after the `['eid', 'ID expiring', …]` card, add:

```jsx
    ['document', 'Documents to renew', FileClock, 'A policy, licence or certificate is inside its renewal window or has expired. Each document sets how long before expiry its own window opens (three months unless changed); the day it opens always notifies.', [
      ['Notify again this long before it expires', days('document', 'days', 'Days before a document expires', true)],
      ['After it expires, again every', num('document', 'every', 'Repeat every', 90, 'days', 1)],
    ]],
```

(g) Update the header comment's list of kinds to end `…bookings with no contract, tenant IDs expiring, documents to renew.`

- [ ] **Step 5: Give a building its Documents tab**

In `client/src/components/Properties.jsx`:

(a) After the line `import CompanyDocs from './CompanyDocs';` add:

```jsx
import Documents from './Documents';
```

(b) Change `BUILDING_TABS` to:

```jsx
const BUILDING_TABS = [['units', 'Units'], ['services', 'Services'], ['docs', 'Documents']];
```

(c) On the building page, after the line `{tab === 'services' && <BuildingServices building={data} master={master} />}` add:

```jsx
      {tab === 'docs' && <Documents building={{ id: data.id, company_id: data.company_id }} />}
```

- [ ] **Step 6: Build to verify it compiles**

Run: `npm run build`
Expected: the Vite build finishes with no errors

- [ ] **Step 7: Check it in the browser**

Run `npm run dev`, sign in as the master at `http://localhost:5173`, and confirm each of these:

1. The sidebar has **Documents**. It opens an empty register with **Add document**.
2. Add document → choose Building → pick a company and a building → attach a real policy PDF. "Reading the file…" shows, then the name, number and dates fill in, outlined, with the "Filled in from the file" line. Save.
3. The row shows on the register with its status chip. Opening it shows the copy, its file link, and **Add a renewal** (which has no owner picker and keeps the name).
4. Filter by company, building and status with the themed dropdowns (no browser `<select>` anywhere).
5. Properties → a company card → Documents tab → a document still opens, edits and renews. Properties → a building → **Documents** tab lists that building's documents, and Add document starts on that building.
6. Set a document's expiry to under 90 days away: it appears under Alerts as "… expires in N days", the Documents row in the sidebar gets a badge, and tapping the alert opens that document.
7. Alerts → Alert rules has the **Documents to renew** card; change its days and save.

Expected: all seven behave as described. Report any that do not rather than marking the step done.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: every test passes except `tests/drawing.test.js` on Windows (an existing, unrelated crash)

- [ ] **Step 9: Commit**

```bash
git add client/src/components/Documents.jsx client/src/components/Leasing.jsx client/src/components/Sidebar.jsx client/src/components/LeasingAlerts.jsx client/src/components/Properties.jsx
git commit -m "feat: Leasing - Documents: one page for every policy, licence and certificate, soonest to expire first; a building has its own Documents tab; an alert opens the document it is about, and the master sets the days it buzzes on"
```
