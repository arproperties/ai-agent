# Projects — design

Date: 2026-10-31
Status: simple version built (deliveries, material out, manpower, Projects screen); the rest is the long-term plan

## Why

The JVC school (basement + G+3) is being built floor by floor. Today nobody can say in one
place what arrived, what was rejected, what is left on site, who sends bad material, or
what to order next. Chats about it are spread over the Shelf and email, and an agent asked
about it guesses. A **Projects** module puts the whole job in one place, split into
**phases**, and gives each project its own **agent** that answers only from what was
recorded and helps decide what to buy and whether to accept a delivery.

General, not school-only: the next building is a new project, nothing else.

## Start here: the simple version (what gets built first)

The full design below is the long-term picture. First build only this, use it 2–3 weeks,
then add from the feedback.

- **Francisca** (store keeper, on site) records everything **in the normal chat**:
  - delivery: photo of note + material → card with 3–4 checks and qty → **Accept** (all pass)
    or **Send to Tauqeer** (any fails)
  - material out: "gave 900 blocks to GF" → card → **Confirm**
  - daily manpower: "8 masons, 15 helpers, 2 steel fixers" (optionally per subcontractor)
    → card → **Confirm**; a 5 pm reminder if none sent that day
- **Tauqeer** (manager, office staff, not on site) gets a push for each failed delivery and
  taps **Accept with note** or **Reject** (reject drafts the supplier email).
- Each entry carries a floor label (Basement, GF, 1F…) — no phase handover yet.
- One small screen: **Stock** (what's on site, tap an item for its history), **Waiting**
  (Tauqeer's deliveries to decide), **Manpower** (date × trade table).
- Ask Reem anything about it; it answers from the records only. It can put manpower beside
  material out ("8 masons used 900 blocks today, ~110 each").

Left for later: purchasing, quotes, supplier scores, closing phases.

Manpower table: `project_manpower` (id, project_id, phase_id, day, trade, subcontractor,
count, by, at), one row per trade per day; a second report the same day replaces the first.

## Shape

```
Project (JVC School)
 └─ Phases, in order, added/renamed/reordered any time
     (Basement → Ground → 1st → 2nd → 3rd → Roof, or "GF blockwork", "1F slab"…)
     ├─ Materials   — deliveries in, usage out, stock on site
     ├─ Purchasing  — quotes, comparison, orders
     ├─ Quality     — check per delivery, verdict, supplier record
     ├─ Issues      — defects, rejects, delays (open / closed)
     └─ Notes       — decisions and lessons
```

One phase is **current**. Stock belongs to the project (it is one site), but every
movement is tagged with the phase it happened in, so "how many blocks did GF use" is a sum.

## The module

- `MODULES` entry: `{ key: 'projects', label: 'Projects', about: 'A building job split into phases: materials, purchasing, quality checks, issues and notes, with an agent that helps decide.', company: true }`.
- Screen routes behind `needsModule('projects')`; what a chat needs (the card actions) stays
  open, as with inventory proposals.
- Who: the master sees every project. Others see a project only when added to it
  (`project_members`: `user_id`, `role` = `manager` | `store`). Rule lives in `access.js`.
  - **Store keeper** (`store`): receives deliveries (photos, checklist, qty received),
    Accepts a delivery only when every check passes, issues material out to a team
    ("900 blocks to GF masons" → a `used` move), does the weekly stock count (the agent
    flags any gap between counted and recorded). Anything failing a check → **Send to
    manager** (push), never Reject or Accept-with-note herself.
  - **Manager**: decides failed deliveries (Accept with note / Reject), approves orders,
    closes phases.

## The agent ("same style as the others")

Built exactly like a case agent:

- An ordinary row in `agents` (persona, model = `auto`), bound to one project by a new
  `project_id` column, the way `case_key` binds a case agent. The router keeps follow-ups
  with it, and an agent bound to another project never reads this one's files.
- Its kit: `projectKit(user, { conversationId, agent, onCard })` in `server/projectKit.js`,
  same shape as `inventoryKit`: `{ definitions, status, run }`, included in `chat.js` for
  people who are members of a project (or the master).
- **Reads** answer only from the tables. If something was not recorded, the tool says so
  and the agent says "not recorded" — never a guess (the same rule `claims.js` enforces).
- **Writes** never happen from the chat. Every write tool makes a proposal row and a card;
  the tool result says "NOT saved yet — tell the user to check the card and tap …", as
  `add_inventory` does. The person taps, the route does it.

### Tools

| Tool | Does | Card |
|---|---|---|
| `project_status` | Current phase, stock, open issues, pending orders, what's low | — |
| `project_search` | Past deliveries, rejects, notes, any phase ("what went wrong with blocks in basement?") | — |
| `log_delivery` | From a photo of the delivery note + material: supplier, item, qty, date, matched to an order | **Delivery** — checklist + Accept / Accept with note / Reject |
| `log_usage` | "Used 900 blocks on GF walls" | **Usage** — Confirm |
| `compare_quotes` | Quotes (photo/PDF/typed) side by side with price, delivery days, past reject rate | **Quote comparison** — pick one → becomes an order card |
| `propose_order` | What to buy, how much, by when, from whom | **Order** — Approve / Change / Cancel |
| `raise_issue` | Defect, delay, reject | **Issue** — Add |
| `close_phase` | Handover: what carries over, what stays | **Close phase** — Confirm |

### How it helps decide

**Purchasing — when and how much.** Uses stock on site, the last 7 days' usage rate, each
supplier's usual delivery days, and the next phase's need (from the BOQ, Phase 3). Says:
"Order 3,000 blocks by Thursday: 4 days to deliver, stock lasts 6."

**Purchasing — from whom.** Score per quote = price + the cost of that supplier's past
breakage/rejects on this quantity + delivery days. Shows the reason in one line: "B, because
A's 8% breakage costs ≈ AED 1,000 more on this order." A supplier with no history is marked
"no history", not scored as good.

**Price watch.** Each order keeps its unit price; a new quote 10%+ above the last one is flagged.

**Quality — per delivery.** A checklist per material type (kept as data, editable by a manager):

- Blocks: size, broken count, approval/strength certificate, curing date
- Cement: manufacture date ≤ 3 months, no lumps, bags intact
- Steel: mill certificate, diameter, no heavy rust
- Sand: clean, no clay
- Anything else: a free checklist the manager writes once

Verdict suggested from the answers and photos: **Accept** / **Accept with note** (e.g. 5%
broken → ask credit) / **Reject** (fails a key check). Reject drafts the supplier email
through the existing mailbox draft flow, photos attached. The agent says plainly that a
photo cannot prove strength — it asks for the certificate or lab result.

**Supplier record.** Every delivery's verdict counts toward that supplier's reject rate,
shown in comparisons and on a Suppliers list.

### Closing a phase (carry-over, uncluttered)

`close_phase` builds the handover; the manager confirms one screen:

| Item | Rule |
|---|---|
| Stock on site | carries (it is the project's anyway) |
| Open issues, pending orders | carry, moved to the new phase |
| Closed issues, past deliveries, photos | stay in the old phase |
| Supplier problems, lessons | carry as short notes |
| Unclear (e.g. an open note) | agent asks: Carry / Drop |

The agent writes a **handover note** (done / left / watch) saved on the old phase and
shown at the top of the new one. Nothing is deleted; `project_search` still finds it all.

## Data (in `db.js`, idempotent DDL; each table added to `TABLES` in `tests/helpers/db.js`)

- `projects` (id, name, site, created_by, created_at)
- `project_members` (project_id, user_id, role)
- `project_phases` (id, project_id, name, position, status `open|current|closed`, handover, closed_at)
- `project_items` (id, project_id, name, counted_in, checklist jsonb) — the material list
- `project_suppliers` (id, project_id, name, email, phone)
- `project_counts` (id, project_id, item_id, counted, recorded, by, at) — the store keeper's stock counts
- `project_moves` (id, project_id, phase_id, item_id, kind `in|used|returned|adjust`, qty, supplier_id, order_id, verdict, notes, photo_docs, by, at) — stock = sum
- `project_checks` (move_id, answers jsonb, verdict, reason)
- `project_quotes` (id, project_id, supplier_id, item_id, unit_price, delivery_days, doc_id, at)
- `project_orders` (id, project_id, phase_id, item_id, supplier_id, qty, unit_price, due, status `proposed|approved|delivered|cancelled`)
- `project_issues` (id, project_id, phase_id, title, status, notes)
- `project_notes` (id, project_id, phase_id, body, kind `note|lesson`)
- `project_proposals` (id, user_id, conversation_id, kind, payload jsonb, status) — the cards
- `agents.project_id` column

Photos and delivery notes are ordinary Shelf documents (`documents`), linked by id.

## Screens (client)

- `Projects.jsx` — list of projects.
- `Project.jsx` — phase strip on top (current highlighted); tabs Materials · Purchasing ·
  Quality · Issues · Notes; Stock box always visible.
- Cards in chat: `DeliveryCard`, `UsageCard`, `QuoteCard`, `OrderCard`, `IssueCard`,
  `ClosePhaseCard`, same look as the inventory Add card.
- Settings menu row for the module.

## Reminders

A daily timer (`startProjects()`, run under `billAs({ userId, job: 'projects' })`) pushes the
manager: yesterday's deliveries and rejects, and anything that runs out within its supplier's
delivery days + 2. Off locally unless `PROJECTS_PUSH=on`.

## Build order

1. **Phase 1 — Project, phases, deliveries, quality, stock.** Tables, module, screens
   (list, project, phases, Materials, Quality), `projectKit` with `project_status`,
   `project_search`, `log_delivery` + Delivery card, project agent binding. Reject email draft.
2. **Phase 2 — Usage, issues, notes, close phase.** `log_usage`, `raise_issue`,
   `close_phase` with the handover note and carry-over screen; low-stock warnings + daily push.
3. **Phase 3 — Purchasing.** Suppliers, quotes, `compare_quotes`, `propose_order`, price
   watch, supplier reject rate, BOQ upload → need per phase.

Each phase ships on its own and is useful alone.

## Tests (real Postgres, as the rest)

- A non-member cannot see or search a project; the master can; an external person never.
- An agent bound to project A reads nothing of project B.
- Stock = sum of moves; a rejected delivery adds nothing.
- Closing a phase moves only open issues and pending orders; closed ones stay.
- Every write tool returns a proposal, writes nothing until the card is tapped.

## Needed from Francis

1. The material list (or BOQ) for the school.
2. Suppliers' names (and emails for reject letters).
3. Who is on site (site members) and who decides (managers). On site at the JVC school:
   **Francisca** (Reem user #23, staff, not external) — store keeper. **Tauqeer** (Reem user #2, staff, not external) — manager.
4. Today's rough stock on site, to open the project with.
