# saifsys company documents on the Shelf — plan (2026-11-14)

## The problem

Staff upload and renew company papers (trade licence, MOA, Ejari, establishment card, VAT and
corporate tax certificates, power of attorney) in **saifsys → HR → Company Documents**. Reem never
sees them. When someone asks Reem, it answers from whatever copy was uploaded to the Shelf by hand,
which is often an old one.

Reading the code turned up two separate causes:

1. **Nothing brings saifsys's company documents across.** The nightly sync
   (`server/saifsysDocSync.js`) copies only *employee* documents (`hr_docs`), and only once a
   night. The saifsys door `api/jarvis/v1` has no module for company documents.
2. **Even on the Shelf, the chat does not prefer the new copy.** `superseded_by` (old → new) is
   used by Document Renewals and alerts, but not by chat: `recall()` and `search_files`
   (`server/knowledge.js`, `server/shelf.js`) rank old and new files the same way. They also
   never say which file is current or give its dates. Also, saifsys employee documents are
   copied as **details only**: nothing reads what is written in them, so the chat cannot answer
   from their contents.

The plan fixes both causes, starting with company documents.

## How saifsys keeps company documents (from reading the saifsys repo)

- `hr_company_documents`: **one live row per document**. Columns: `company_id`, `doc_type`,
  `title`, `doc_number`, `issuing_authority`, `issue_date`, `expiry_date`, `file_path`,
  `file_name`, `mime_type`, `notes`, `updated_at`.
- `hr_company_document_versions`: earlier issues. When a document is **renewed**, the old details
  and file are copied here (`version_no` 1, 2, …) and the live row is updated in place.
- **Edit and save** with a new file overwrites the live row, and no history is kept. **Delete** is
  a hard delete, so the row and its versions go.
- Staff sometimes add a new issue as a **separate row** instead of renewing. saifsys's own screen
  then shows the row with the latest expiry date (`hr/company_documents.php:524-536`), and the
  sync has to apply the same rule.
- Files: `uploads/company_docs/<company_id>/…`, pdf/jpg/png, at most 10 MB.
- Companies: `companies` (`id`, `name`, `code`, `is_active`).

## The plan

### Step 1: saifsys side, a new read-only module `company_docs`

New file `api/jarvis/v1/modules/company_docs.php` and its helper
`includes/jarvis_company_docs.php`, copied from `hr_docs.php` / `jarvis_hr_docs.php`. Add
`company_docs` to `JARVIS_MODULES` in `index.php`. It only reads; nothing is written to saifsys.

- `documents` (paged by id, `after_id`, `limit` up to 500) returns each live row:
  `{ id, company_id, company_name, company_code, type, title, number, authority, issued_at,
  expires_at, notes, has_file, file_name, updated_at, versions: [{ version_id, version_no,
  number, issued_at, expires_at, has_file, file_name, archived_at }] }`.
- `document_file` with `id`, or `id` + `version`, streams the file. It only serves files inside
  `uploads/company_docs`.
- Add a test beside `tests/jarvis_hr_docs_test.php`.
- **You upload these 3 files to the saifsys server** (same as for Buildings).

### Step 2: Reem side, a new sync `server/saifsysCompanyDocs.js`

This is a separate file and table, not a flag on the employee sync (saifsys ids from the two tables
would clash).

**New table** `saifsys_company_doc_links` (added to `TABLES` in `tests/helpers/db.js`):
`saifsys_id`, `version_no` (NULL = the live one), `document_id`, `changed_at`, `file_hash`,
`synced_at`. Unique on `(saifsys_id, version_no)`.

**What a copied file looks like on the Shelf**
- It is owned by the master and filed under the **Company Documents** category. Its type is mapped
  from saifsys's (`trade_license` → Trade Licence, `establishment_card` → Establishment Card,
  `ejari` → Tenancy Contract (Ejari), and so on). Missing types (MOA, Power of Attorney,
  VAT Certificate, Corporate Tax Certificate) are added to that category once at start-up, as
  rows, never as code.
- `subject` = the company name. Number, authority, issue and expiry dates go in the summary. The
  expiry counts as confirmed, because a person typed it into saifsys.
- **Unlike employee documents, the live file is fetched and read at once** (the same reading as an
  upload: text → chunks → embeddings). That way Reem can answer "what activities are on our trade
  licence" from the document itself, not only from its name.
- Old versions are marked **superseded by** the live one. Their file is fetched too, so they open
  like any file, but it is not read. Only their details are searchable.

**Each run**
1. Page through `company_docs/documents`.
2. New document → add it to the Shelf, fetch the file, read it.
3. `updated_at` changed:
   - **Renewed** (saifsys has a new version number): the Reem copy we already have *becomes* that
     version. It keeps its file and reading and is marked old. Then the new live file is added and
     read. Nothing is fetched twice.
   - **Edited with a new file** (no new version, different file hash): the file is replaced and
     read again, and its old chunks are dropped.
   - **Only details changed**: the summary and dates are updated. A date someone corrected in Reem
     is kept, as the employee sync does.
4. Same company and same type in several live rows → the one with the latest expiry is current,
   and the others are marked old (saifsys's own rule).
5. **Deleted in saifsys** → hidden from the chat and the Shelf (status `removed`), not deleted. This
   only happens after a run that read every page without an error, so saifsys being down never
   hides anything.
6. **Hand-uploaded copies on the Shelf**: if a Company Documents file with the same company name
   and type has an earlier expiry than saifsys's, it is marked old. This only applies on an exact
   match of the name (case and spaces ignored). Files that do not match are left alone.

**How often**
- **Every 15 minutes.** The list is small, and files are fetched only when they change.
- **Sync now** button for the master (Document Renewals screen, beside the employee one).
- Run under `billAs({ userId: master, job: 'saifsys-company-docs' })` so the reading cost is
  recorded.
- Later, if 15 minutes is too slow: saifsys pings `/api/from-saifsys/company-docs` after an upload,
  using the inbound door that already exists, and Reem syncs that one document at once.

### Step 3: the chat prefers the current copy (fixes old answers for every file, not only saifsys)

- `recall()` (`knowledge.js`): chunks of a **superseded** file are left out of the automatic
  `<knowledge>`.
- `search_files` (`shelf.js`):
  - Current files come first.
  - Each line says its type, company or employee, issue date, expiry date and "from saifsys".
  - An old file is labelled **"OLD – replaced by #N"**.
  - Old files are still found when the person asks for the old one ("last year's trade licence").
- Shelf screen (client): an **OLD** badge on superseded files and a **from saifsys** tag. Nothing
  shows this today.
- Tool description: "When there are an old and a current copy, answer from the current one, and
  say so if they asked about an old one."

### Step 4: tests (`tests/saifsys-company-docs.test.js`, real Postgres, fake saifsys)

The tests cover:
- add
- renew (the old copy becomes a version, and the new one is current)
- edit with a new file (it is read again)
- details-only change
- two live rows of one type
- delete after a clean run, and no delete after a failed page
- a hand-uploaded copy marked old
- the scoping of who can see the files
- search and recall leaving out or labelling old files

### Step 5: first run on live

`pg_dump` first, then deploy. The first run brings across every company's documents and their
history. Check a few against saifsys's screen: Reem's current one must be the one saifsys shows.

## After this (not part of this plan)

1. Employee documents: also read their contents (today it is details only) and sync every 15
   minutes instead of nightly.
2. Property documents (`re_documents`: lease, tenant, unit and building papers) in the same way.

## Decided (Francis, 2026-11-14)

1. **The master and every internal user** see company documents. The copies are saved with
   `shared = true`. External users never reach shared files: they have only private agents, so
   their scope is their own files (`ownFilesOnly`, `access.js`). A test must prove this.
2. **Yes**, they appear in Document Renewals with expiry alerts.

## What the Shelf looks like afterwards

- A **Company Documents** folder holds one current file per document, named
  "Trade Licence – <company>", with its number and dates. It is read-only in Reem, because saifsys
  is where it is changed.
- Old versions sit under their current file, labelled OLD, and can still be opened.
- Staff can keep uploading to the Shelf as now. Their own files are untouched. A hand-uploaded
  company paper only gets marked OLD when saifsys has a newer one of the same company and type.
