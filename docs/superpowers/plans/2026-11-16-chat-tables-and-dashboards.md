# Chat tables: fix the colours, then add dashboards (plan, not built)

Date: 2026-11-16. Trigger: the RDC Specialist's "chart for each case number" answer.

## What went wrong in that answer

1. **The rows don't match the colour key.** `client/src/lib/markRows.jsx` lays each colour over the
   dark background at 22%. On dark, yellow (🟡) comes out brown and orange (🟠) comes out red.
   So the key says "🟠 Won, next step open", but case 21791 looks red, and red reads as "bad".
   The dot is also taken out of the row, so nothing in the row lines up with the key.
2. **A chart was asked for and a table came back.** The prompt in `server/chat.js` (~line 140)
   only knows about tables and PDFs, so "chart" becomes a table.
3. **The same words twice.** "Not filed" appears under both Stage and Status. Nothing tells the
   model that every column must add something.
4. **The agent's name is wrong.** It shows as "RDC Specialist — Agent System Prompt". It looks
   like the document title was saved as the name. This is a data fix on the agent, not code.

## Part 1: small fixes (about half a day)

- `markRows.jsx`: keep a small coloured dot at the start of the row, and use stronger colours
  that stay true on dark (yellow stays yellow, orange stays orange). Check the light theme too.
- `chat.js` prompt: never give a colour two meanings; red only for bad/urgent, green for good;
  no column that repeats another; when the user says "chart", give a chart (Part 2).
- Rename the agent to "RDC Specialist" (Agents screen, or one SQL update on live).

## Part 2: dashboards in chat (2–3 days)

The same approach as drawings: the model writes a fenced block with
language `dashboard` holding JSON, and the app draws it. No outside service.

```json
{ "title": "RDC cases — Madar Al Wadi", "asOf": "2026-11-16",
  "tiles": [{ "label": "Rooms in cases", "value": 24 }, { "label": "Rooms not filed", "value": 71 }],
  "charts": [{ "type": "bar", "title": "Rooms per case", "x": "case", "y": "rooms", "colorBy": "status" }],
  "legend": [{ "key": "hearing", "color": "yellow", "label": "Hearing today" }],
  "rows": [{ "case": "23323/2026", "tenant": "Isnaad", "rooms": 5, "status": "hearing" }] }
```

- Client: a new `DashboardCard.jsx` draws the number tiles, bar/pie/stacked-bar charts (plain
  SVG, no chart library), and the table below. The legend is generated from the data, so it
  can't drift from the colours.
- Server: add the block format to the chat prompt next to `drawing`; the PDF button prints the
  dashboard (tiles + chart + table) through the existing PDF code in `server/replyDoc.js`.
- Kept the way chats are: it's a snapshot of one answer. Saving dashboards that refresh by
  themselves from saifsys or emails would be a separate feature later, with its own table.

## Open questions for Francis

- ~~Snapshot or saved dashboards?~~ Decided 2026-11-16: a one-off dashboard in the chat is enough.
  No saved or self-updating dashboards.
- Which charts first: bar + number tiles, or pie / timeline too?
