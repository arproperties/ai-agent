# Legal cases ↔ saifsys leases (2026-10-28)

The boss wants Reem's Legal cases to know the lease behind each case, from saifsys, and to
help the lawyer decide: what is wrong, what to do next, what is missing.

## What gets built

1. **saifsys door, new module `legal`** (`saifsys/api/jarvis/v1/modules/legal.php`, read-only,
   uploaded by hand to saifsys; `legal` added to `JARVIS_MODULES`):
   - `leases&q=` — find a lease by tenant, building, unit or lease number (active, expired,
     terminated), for linking a case.
   - `lease&id=` — one lease's whole file for a lawyer: lease terms, tenant contacts, rent
     schedule with what is paid and overdue, cheques (bounced, escalated), payments,
     penalties, deposit, Ejari, violations, move-out notices, saifsys renewal, and saifsys's
     own legal cases / notices / hearings / costs / cheque escalations for that lease.
   - `at_risk` — leases that may need a case: bounced or escalated cheques not resolved,
     rent overdue past a number of days.
   ID numbers, bank details and documents never leave saifsys.

2. **Reem server**
   - `legal_case_leases` (new table): the case's linked lease and the last copy of its file,
     so the case still shows it when saifsys is away.
   - `legal_case_advice` (new table): each "Ask Reem" answer, kept with who asked and when.
   - `server/legalLease.js`: link / unlink / refresh a lease, search, at-risk list.
   - `server/legalChecks.js`: plain rules (no AI) on the case + lease, e.g. bounced cheque
     not on the case, Ejari missing or expired, no tenant contact, a renewal running in
     saifsys while we take action, case details not matching the lease, the cooling period
     overdue, case open with nothing owed, deposit that could cover the debt.
   - `server/legalAdvice.js`: "Ask Reem" — careful model reads the case, timeline, lease
     file and checks and answers: summary, what's wrong, next steps (with who / by when),
     options with for / against, documents missing, questions for the lawyer. Facts only;
     law to be confirmed by the lawyer.
   - `server/legalKit.js`: chat tools for people with the Legal module — list cases, read a
     case whole (with lease, checks and last advice), look up a lease, leases at risk.

3. **Screen** (`LegalCases.jsx`): link a lease when opening or editing a case (fills party,
   contacts, building, unit, contract); a Lease panel on the case; a "What needs attention"
   list; "Ask Reem" advice card; on the list, "Leases that may need a case" with Open case.

## Not done here
- Nothing deployed; the saifsys file must be uploaded by hand.
- No automatic pushes for at-risk leases (on-screen only for now).
- No writing back to saifsys.
