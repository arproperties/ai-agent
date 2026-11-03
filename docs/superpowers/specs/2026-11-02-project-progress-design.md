# Projects: Progress — design

Date: 2026-11-02
Status: all four parts built 2026-11-03 (server/projectProgress.js, projectAreas.js, projectIssues.js), not deployed.
The JVC take-off and drawing-check issues are seeded only for a project named JVC; the steps template for every project.

## Why

Projects records what arrives on site, what goes out and who worked, but not how far the
work is. Nobody can ask "what's done in the basement?" or "what's next?" and get an answer
from Reem. Nothing about progress is recorded yet: everything starts at 0.

The morning's Claude artifact ("JVC School site tracker") showed what is needed: steps with
checklists, hold points, who does what, block quantities per room, quality checks, a daily
log and a programme. It was too complicated because it is 8 screens of forms. Here the same
content lives in Reem, and **chat is the way in**: people say what happened, a card comes
back, they tap Confirm. The screen only shows.

Progress goes **inside the existing Projects module**, answered by the project's own agent,
so site talk never mixes with other agents. Not a new module, not a new agent.

## Who does what

| Person | Can |
|---|---|
| Store keeper (on site) | send progress, tick checklist points, report a blocked step, record workmanship checks |
| Manager (office) | all of that, plus: sign off hold points, mark a hold-point step Done, edit steps and quantities, close issues |
| Master | everything, every project |

Nothing is saved from chat until someone taps Confirm on the card (as deliveries are now).

## The shape

```
Project (JVC School)
 └─ Floor (Basement, Ground, 1st, 2nd, 3rd, Roof)          ← already exists
     ├─ Stage: Concrete · Blockwork · MEP · Finishes        ← the whole-building view
     │   └─ Steps, in order                                 ← the detail
     │       ├─ status + %  + note
     │       ├─ checklist points (ticked one by one)
     │       ├─ hold point (needs a manager sign-off)
     │       ├─ who does it
     │       └─ planned weeks (from–to)
     ├─ Areas (rooms) with the material each needs          ← block take-off
     └─ Issues (questions for the consultant, problems)
```

### Steps and status

| Status | Means |
|---|---|
| Not started | nothing done |
| In progress | with a % (typed: "blockwork 40%") and an optional note |
| Done | finished, with the day. A step with a hold point is Done only after a manager signs it off |
| Blocked | cannot go on; reason required. Managers get a push |

The % is what the person says. The checklist is separate: points ticked show what is done
inside the step. If someone says Done while points are unticked, the card shows which ones.

### Basement: the starting template (from the artifact)

Each step: checklist · hold point · who · planned weeks.

1. **Approvals and setting out** (wk 1) — blockwork shop drawing approved; block sample + test
   certificate approved; walls marked on slab from grid lines; first block order placed.
   Hold: consultant checks the setting-out before the first course. Who: contractor + consultant.
2. **Blockwork** (wk 1–6) — dowels/ties fixed to columns; plant rooms first (pump, garbage,
   generator); stores, equipment store, lobbies; changing rooms and bottom-right stores;
   lintels, tie beams, packing under beams. Hold: first courses and lintels inspected in each
   room before closing. Who: masonry crew.
3. **MEP first fix** (wk 3–8) — conduits and back boxes; pipe sleeves through walls; ducts,
   sprinkler mains, cable trays; fire stopping at wall crossings. Hold: approved combined
   services drawing before each room. Who: MEP subcontractors.
4. **Plaster** (wk 5–9) — mesh over block-to-concrete joints; mesh over chases; plaster rooms
   (parking walls stay fair-face). Hold: MEP in walls inspected first. Who: plaster crew.
5. **Above-ceiling inspection** (wk 8) — all overhead MEP complete; sprinkler mains pressure
   tested; consultant sign-off per room. Hold: no ceiling closes before this. Who: consultant.
6. **Ceilings** (wk 8–10) — grid; boards room by room; access panels; cut-outs for lights,
   heads, detectors. Hold: matches the reflected ceiling plan. Who: ceiling contractor.
7. **MEP final fix** (wk 10–11) — lights; sprinkler heads; smoke detectors and sounders;
   diffusers; jet fans and panels. Who: all MEP crews together.
8. **Doors, floors and paint** (wk 9–12) — fire-rated doors and closers; floor/epoxy after
   ceilings; ramp anti-skid; paint; bay lines, numbers, signage. Hold: fire door labels and
   certificates on site. Who: joinery, flooring, painters.
9. **Testing and commissioning** (wk 11–12) — each system tested when done; fire alarm and
   sprinkler flow test; smoke extract / jet fan test; generator and pumps. Hold: signed test
   reports. Who: MEP + consultant.
10. **Inspections and handover** (wk 12–13) — Civil Defence; Trakhees; snag list closed;
    handover documents. Hold: both approvals in hand. Who: you + consultant.

Steps 1–2 sit under the **Blockwork** stage, 3/5/7/9 under **MEP**, 4/6/8/10 under
**Finishes**. Concrete is one step per floor (done or not). Other floors start with the same
template copied, and a manager edits it when that floor's concrete is nearly finished.

### Areas and quantities (the take-off)

Each floor has its rooms with the material each needs. Basement, from the artifact:

| Area | Block | Needed | Weeks |
|---|---|---|---|
| Generator room | 200 mm | 680 | 1–2 |
| Pump room | 200 mm | 1,070 | 1–2 |
| Garbage + recycle room | 200 mm | 1,710 | 1–2 |
| Store, left | 200 mm | 1,050 | 2–3 |
| Store, right | 200 mm | 990 | 2–3 |
| Equipment store + lobby | 200 mm | 1,780 | 2–3 |
| Lift lobbies (3) | 200 mm | 390 | 4 |
| Changing rooms, outer walls | 200 mm | 1,230 | 4 |
| Changing rooms, WC cubicles | 100 mm | 940 | 4 |
| 2 stores, bottom right | 200 mm | 920 | 5 |

Totals for the basement: 9,820 × 200 mm, 940 × 100 mm, 121 bags cement, 16.6 m³ washed sand.
Pool area not counted.

What this adds:
- **Material given out** can name the area ("900 blocks to the pump room"), not only the floor.
- **Blockwork % per room** can be said in chat ("pump room walls done").
- The Stock tab gets **Needed** and **Still to order** columns (needed − delivered).
- The agent can warn: "Pump room needs 1,070; 400 on site; order now."

These quantities are an estimate from the drawings; a manager corrects them.

### Issues (questions for the consultant)

An open/closed list per project: what, floor/step it holds up, asked whom, when, answer.
Seeded from the drawing check of the Arch-TRK set, the ones that touch the basement first:

- Pool deck level: −2.50 or −3.00? Basement −4.10 or −4.50 (sheet 22)?
- Fire rating of garbage room and generator room doors (schedule says N/A).
- Car ramp: real slope 12.6%, no transition slopes.
- No accessible WC by the pool / changing rooms.

A blocked step can point at an issue; closing the issue tells the agent the step can go on.

### Workmanship checks (daily wall walk)

A card with the 9 blockwork checks from the artifact (mortar 1:4 measured; used within 2 h;
full 10 mm joints; level and plumb; joints staggered; ties every 2–3 courses; lintels over
openings; max ~1.5 m a day; cured 7 days). Pass/Fail each, for a floor/area. A Fail pushes
the managers. Delivery quality checks stay as they are (Reem already has blocks, cement,
sand…); the artifact's wording can replace the current check lists where it is clearer.

### Daily log

Manpower already exists. The day's progress updates and checks **are** the log of work done,
so there is no separate log form. The 5 pm manpower reminder also asks for "anything done or
blocked today?" when no progress was sent.

### Programme (planned weeks)

Each step has planned start/end weeks, counted from the project start day (2026-11-02 for
JVC; a manager can change it on the screen).
The agent and the screen mark a step **late** when its end week has passed and it is not
done. No Gantt chart: a "Week 4 of 13" line and late flags are enough.

## In chat (the project agent's tools)

Read:
- `project_progress` — floors, stages, steps, %, open points, blocked, late. Answers
  "what's next?", "what's late?", "how far is the basement?".
- `project_issues` — open and closed issues.

Cards (nothing saved until Confirm):
- `log_progress` — status / % / note for a step or area; ticks checklist points.
- `log_blocked` — a step blocked, with the reason, optionally linked to an issue.
- `sign_off` — manager only: a hold point signed (who signed, e.g. consultant name, the day).
- `log_inspection` — workmanship check results.
- `log_issue` / `close_issue`.

"What's next" = the first step not done in the current floor, its unticked points and hold
point, anything blocked and why, and materials short for the areas being worked.

The Arch-TRK drawings and the drawing-check notes go on this agent's Shelf, so it can check
work against them (an upload, not building).

## Screen

On the Projects screen, beside Stock / Waiting / Manpower / History:

- **Progress** — one card per floor: four stage bars (Concrete, Blockwork, MEP, Finishes)
  and a %. Tap a floor: its steps, each with status, %, points (x/y), hold point, who,
  weeks, late flag. Tap a step: its history.
- **Issues** — open first, then closed.
- **Stock** — gains Needed and Still to order.

Managers edit steps, points, areas and quantities on the screen; everyone else uses chat.

## Data (`db.js`, idempotent DDL; each table added to `TABLES` in `tests/helpers/db.js`)

- `project_steps` — project, floor, stage, position, name, who, hold_point, week_from,
  week_to, status, percent, note, signed_by, signed_at, updated_by/at.
- `project_step_points` — step, position, text, done, done_by/at.
- `project_step_updates` — every confirmed change (history, never deleted).
- `project_areas` — project, floor, name, item, needed, counted_in, week_from/to, percent.
- `project_issues` — project, floor, step, text, asked, status, answer, opened/closed by/at.
- `project_inspections` — project, floor, area, day, results (JSON pass/fail per check), by.
- `projects` gains `start_day` for the programme.
- `project_moves` gains `area` (optional).

## Build order (each part usable on its own)

1. **Steps:** steps, points, status, %, blocked, hold-point sign-off, history; basement
   template; chat tools; Progress tab.
2. **Areas and quantities:** take-off per area, area on material out, Needed / Still to order,
   "order now" warnings.
3. **Issues and workmanship checks**, seeded with the basement issues.
4. **Programme:** start day, planned weeks, late flags, the 5 pm "anything done?" nudge.

Use part 1 on the basement for a week before building part 2.

## Tests (real Postgres)

Who can confirm what (store keeper vs manager vs other project's people); a hold-point step
cannot be Done without sign-off; history kept on every change; still-to-order sums;
late flag by week.

## Decided (2026-11-02)

1. Only managers (and the master) sign off hold points; they note who from the consultant signed.
2. Week 1 starts 2026-11-02. A manager can change the start day on the screen; the weeks move with it.
3. The artifact's basement quantities are used as the start. Managers can edit every area and
   quantity on the screen (and add or remove areas).
4. Done ticks every open point of the step (2026-11-03).
