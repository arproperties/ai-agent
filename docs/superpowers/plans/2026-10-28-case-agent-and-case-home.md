# Case agent and Case Home — plan (2026-10-28)

## The problem

Work on one case is spread over many chats, and its files over many places:
- each new chat about a case starts from zero; what was decided earlier is not carried over;
- the Case files panel only finds files in the case folder or with the number in their name,
  so `scan_001.pdf` uploaded in a case chat is lost to the case;
- the router may hand a case chat to another agent;
- tapping an agent shows Persona and Shelf, which say nothing about the cases.

## Decisions (Francis, 2026-10-28)

- Every chat that has a primary case goes to the case agent (Soutex Case Attorney) and stays
  there. Other chats route as today. `@Name` still overrides.
- Tapping an agent opens a **Cases** tab first: the cases discussed with it. Persona and Shelf
  stay behind it, renamed **About** and **Agent files**.
- The case brief is **suggested** by the agent and **approved** by the person, never written
  on its own.
- Existing case chats are gone back over once to tag their files and draft their briefs.

## Part A — now

### A1. Mark the case agent
- `agents.handles_cases BOOLEAN NOT NULL DEFAULT false` (db.js). One agent per owner may have it.
- Master's Persona tab: a "Handles case chats" switch, like Private agent.
- Turn it on for Soutex Case Attorney on live after deploy.

### A2. Case chats always go to it
- `chat.js` routes (line ~491) before it works out the primary case (line ~560). Move
  `focusTurn` above `pickAgent`, so a turn that sets the case is routed with it.
- `router.js pickAgent`: new `caseAgent` input. Order: `@Name` → chat has a primary case and the
  person can reach the case agent → case agent → the rest as today.
- Only when the person can reach that agent (`chatAgents` in access.js); otherwise unchanged.
- Tests: a case chat is never re-routed; `@Name` still wins; a person without the agent is
  unaffected; a chat with no case routes as before.

### A3. Cases tab on the agent sheet
- Route `GET /api/agents/:id/cases` (behind `case_focus`): the caller's own conversations with
  this agent that have a primary case, grouped by case key. Per case: number, parties, chats
  (title, last message date), file count (`caseFiles`), next legal date (`case_deadlines`),
  time (`case_time`).
- Only the caller's own chats, never another person's.
- `AgentSheet.jsx`: tabs `Cases | About | Agent files`, Cases first and default. Each case opens
  to its chats; tapping one opens that chat. "New chat on this case" starts a chat with the
  case number as the first message.
- Shown only for an agent with `handles_cases`; other agents keep About / Agent files.
- Test: user A never sees user B's cases on the same shared agent.

## Part B — next

### B1. Files stay with the case
- `documents.case_key TEXT` set when a file is uploaded into a chat with a primary case
  (`files.js`), and filled for every file already in a case chat (one-off backfill script).
- `caseFiles` also returns files whose `case_key` matches.

### B2. Case brief, suggested and approved
- `case_briefs (user_id, case_key, body, updated_at)` and `case_brief_suggestions`.
- After a case chat goes quiet, the fast model drafts changes to the brief (facts, parties,
  decisions, deadlines, open questions) from that chat. Shown as a card / on the case: Approve,
  Edit, Dismiss. Run under `billAs`.
- Backfill: draft one brief per existing case from its chats, waiting for approval.

### B3. New chats start from the brief
- The approved brief goes into the `<primary_case>` block in `primaryCaseBlock`.

### B4. Case Home
- The Cases tab entry grows into a full page: brief, chats, files, dates, time.

## Order

A1 → A2 → A3 (one PR), then B1 → B2 → B3 → B4.
New tables go into `TABLES` in `tests/helpers/db.js`.
