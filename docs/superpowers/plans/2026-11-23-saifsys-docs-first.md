# saifsys documents first (plan, 2026-11-23)

Francis: "Every company document and contract should come from saifsys first. Other documents
can stay with the search we have now."

## What happens today

| Kind | In saifsys | In Reem today |
|---|---|---|
| Company docs (trade licence, Ejari, MOA, VAT…) | yes | Copied to the Shelf every 15 min and read in full (live since 2026-11-14). |
| Tenancy contracts (leases) | yes | Read live from saifsys by the lease tool (`server/leases.js`). Not on the Shelf. |
| Employee docs (passport, visa, labour contract) | yes | Only the details (number, dates), once a night. The files are not read. |
| Property docs (`re_documents`: unit, building, tenant papers) | yes | Not brought over at all. |
| Everything else (bills, quotes, drawings, letters, supplier contracts) | no | Shelf, uploaded by hand. |

The problem: one Shelf search mixes the saifsys copy with old copies people uploaded by hand.
The best word match wins, so an old hand-uploaded file can beat the saifsys one.

## Where the request needs a correction

- **Reem should not ask saifsys live for each question.** saifsys can only list documents; it
  cannot read inside them. Reem already copies them over every 15 minutes and reads them, which
  is faster and lets the chat answer from what a document says. So "saifsys first" means: in the
  search Reem already does, **the saifsys copy is always ranked and used first.**
- **Unrelated documents need nothing new.** Since it is one search, a question about a bill or a
  drawing simply finds no saifsys document and works as today. No extra saifsys call.
- **Two kinds are still missing** (employee files, property docs). Until they come over, Reem
  cannot put them first.

## The plan

### 1. saifsys copy first in every search
- In the Shelf search (`rank()` in `server/shelf.js`), the chat's automatic recall
  (`server/knowledge.js`) and the Shelf screen's search box: current saifsys documents first,
  then hand-uploaded files, then old issues last.
- Each result already says "from saifsys"; a hand-uploaded file gets "uploaded by Said on …" so
  the chat can say where it came from.

### 2. Hand-uploaded copies of a saifsys document step aside
- When a hand-uploaded file is the same document as a saifsys one (same company and type, e.g.
  a trade licence), it is marked **OLD - saifsys has the current one**, the way renewed issues
  are marked today. Nothing is deleted; it stays on the Shelf.

### 2b. Expired and renewed: the one that runs out last wins
- Same rule as today (`supersedeOlder` in `saifsysDocSync.js`, the company-docs sync in
  `saifsysCompanyDocs.js`): of two issues of the same document, the one with the later expiry is
  current and the other is OLD, whichever place it came from.
- Renewed in saifsys: within 15 minutes the new one is current, the expired one is OLD and its
  alerts stop. Already works for company documents; employee documents get it with step 4.
- Expired in saifsys but the new one uploaded only to Reem: the hand copy wins (later expiry), so
  "saifsys first" never answers from an expired document. Reem says: "saifsys still has the
  expired one - please upload the new one there."
- Two current ones that disagree on dates or numbers: saifsys wins, and Reem mentions it.

### 3. The chat's rule
- Company document, contract, employee paper or property paper: answer from saifsys. For a
  tenancy contract, use the lease tool first.
- If saifsys has nothing, look on the Shelf and say so: "Not in saifsys; found a copy Said
  uploaded on 3 Oct."
- If saifsys and a hand copy disagree (dates, numbers), use saifsys and mention the difference.
- Anything else: the Shelf search as today.

### 4. Employee files read in full, every 15 minutes
- The plan already written: `2026-11-16-saifsys-employee-docs.md`. No saifsys change needed.
- Still private: only the master and people with Document Renewals.

### 5. Property documents (`re_documents`)
- Copied over and read, the same way as company documents.
- Needs one new file on the saifsys side (a `property_docs` door), uploaded by Francis.
- Who sees them: the master and people with Real Estate or Lease renewals.

### 6. Tests
- A saifsys document beats a better-matching hand-uploaded one.
- A hand copy of a saifsys document is marked OLD; an unrelated hand file is untouched.
- An expired saifsys document loses to a newer hand-uploaded issue, and the reply says to update saifsys.
- Private employee files stay hidden from people without Document Renewals and from externals.

## Every place saifsys keeps a file (checked in the saifsys code, 2026-11-23)

The saifsys code has 593 tables, and about 70 of them hold an uploaded file. I could not count the
rows: this Mac cannot read the live saifsys database. The counts must be checked before each step.

### A. Real documents: brought over, read, current one first

| # | What | saifsys table | Expiry | In Reem today |
|---|---|---|---|---|
| A1 | Company docs: trade licence, MOA, Ejari, establishment card, POA | `hr_company_documents` (+ `_versions`) | yes | **Done** (2026-11-14) |
| A2 | Employee docs: passport, visa, EID, labour contract and card | `employee_documents` | yes | Details only (plan of 2026-11-16) |
| A3 | Employee certificates (skills, safety) | `employee_skills_certifications` | yes | No |
| A4 | Property papers: lease agreement, Ejari, tenant ID, passport and visa, NOC, municipality approval, insurance, building permit, utility | `re_documents` (+ `re_document_versions`) | yes | No |
| A5 | Signed tenancy contract and Ejari certificate (the files) | `re_leases` (`generated_contract_path`, `ejari_document_path`), `re_tenancy_contract_tenant_uploads`, `re_renewal_tenant_uploads` | lease end | Terms only, through the lease tool. The files are not read. |
| A6 | Title deeds | `re_title_deeds` | no | No |
| A7 | Affection and site plans, building floor plans | `re_affection_site_plans`, `re_building_floor_plans` | no | No |
| A8 | Vendor and supplier documents (their licences, insurance) | `re_vendor_documents`, `co_supplier_documents` | yes | No |
| A9 | Service and maintenance contracts, AMC certificates | `re_service_agreements`, `re_amc_contracts`, `re_amc_certificates`, `co_maintenance_contracts` | yes | No |
| A10 | Other rental contracts: shops, camps, bed spaces, ARS | `co_shop_rental_contracts`, `co_camp_management_contracts`, `re_bed_space_contracts`, `ars_rental_contracts` | yes | No |
| A11 | Construction project documents | `co_documents` | no | No |
| A12 | Loan and investment documents | `lt_loan_documents`, `lt_investment_documents`, `lt_repayment_files` | some | No (sensitive: master only?) |
| A13 | ARS guest passports and IDs | `ars_guest_attachments`, `ars_booking_documents` | yes | No (guests' personal data) |
| A14 | Client documents | `client_documents` | yes | No (purpose to check) |
| A15 | Legal issue files | `re_legal_issue_files` | no | No (Legal cases left Reem on 2026-11-13) |

### B. Not documents: left in saifsys (recommended)
Bills, receipts, vouchers, journal and VAT attachments, invoices, cheque photos, move-in/out and
maintenance photos, job and unit photos, stock pictures, attendance and fleet check pictures,
task and announcement attachments. These are proof attached to a transaction, and there are
thousands. Searching them as documents would bury the real ones. When the chat needs one, the
saifsys tools can fetch it from its record.

No vehicle papers (Mulkiya, insurance) are stored in saifsys: `fleet_vehicles` has no file. Tenants and
owners have ID numbers and dates on their record, but the files are in A4.

### How each new kind comes over
The same way as A1: one small saifsys door file per kind (uploaded by Francis), a Reem sync every
15 minutes, files read in full, the newest expiry current, the old one OLD, and Document Renewals
alerts where there is an expiry. Each kind gets its own link table (no flags on an existing one).

## Built (2026-11-23, branch feat/saifsys-docs-first, not deployed)
Steps 1-3 for company documents: `server/handCopies.js` + `rank()` in `server/shelf.js`, tests in
`tests/hand-copies.test.js`. Only the search's order and notes change; no file is changed.
Checked against live's 6,599 hand-uploaded files: 33 are matched as copies of a saifsys document,
all correct; doubtful ones (e.g. "ARS Vacation Homes Rental" vs "ARS Home Rentals") are left alone.
Not changed: the few pieces recall() hands the chat before it searches.

## Order
1. Steps 1-3 above: saifsys first, hand copies step aside, the chat's rule. No saifsys work.
2. A2 employee docs (no saifsys change), with A3.
3. A4 + A5: property papers and the signed lease and Ejari files.
4. A6-A11: title deeds, plans, vendor docs, contracts.
5. A12-A15 only if Francis wants them.

## Decided (Francis, 2026-11-23)
- Hand-uploaded copies of saifsys documents are marked OLD, not hidden.
- Every document in group A comes over, A12-A15 included.
- Who sees them: everyone inside the company; external users none. This opens employee documents
  (today private to the master and Document Renewals) to all internal users. Asked twice
  (per-group ticks were offered); Francis chose all public inside the company.
- Group B (bills, receipts, photos) stays in saifsys.

## Questions for Francis
1. Hand-uploaded copies of saifsys documents: mark them OLD (recommended), or hide them?
2. Who sees each group? Suggested: A4-A7 and A10 for the master, Real Estate and Lease renewals;
   A8, A9 and A11 for everyone inside the company; A2, A3, A12 and A13 for the master and Document
   Renewals only.
3. A12 (loans), A13 (guest passports), A14 (client documents), A15 (legal files): bring over or not?
4. Group B (bills, receipts, photos): leave in saifsys (recommended)?
