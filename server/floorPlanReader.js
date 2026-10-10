import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { bad } from './leasing.js';
import { fileBlock } from './documentReader.js';

// Reading a building's floor plans: a PDF or a picture of the drawings goes in, and what
// comes out is where every unit is on its floor, as floorPlans.js keeps it. Nothing is
// saved here: the reading is shown first, and kept only when somebody says to (savePlan).
//
// A reading takes a minute or two, longer than a request is held open, so it runs on its
// own: startReading gives a ticket at once and `reading` says how it is getting on. The
// tickets are kept in memory only; one lost to a restart is simply asked for again.

const MODEL = 'claude-opus-5-5'; // drawings are read off the page by eye and by their dimension lines: the strongest reader is worth it here
const KINDS = ['corridor', 'core', 'lobby', 'service', 'open'];
const SQFT = 10.7639;
const KEEP = 30 * 60_000; // how long a finished reading waits to be collected

const PROMPT = `These are the floor plans of one building. Read them and reply with one JSON object and nothing else.

Measure everything in metres, on the plan as it is drawn: x from the building's left edge, y from its bottom edge, so (0, 0) is the bottom-left corner of the building's outline. Use the dimension lines and the areas written on the plan; where a size is not written, work it out from those that are. If the plan is in feet, convert.

{
  "width": the building's outline, left to right,
  "depth": the building's outline, bottom to top,
  "storey": the floor-to-floor height, or 3 if it is not given,
  "floors": [ one for every floor that has a plan, lowest first:
    {
      "floor": "G" for the ground floor, "B" for a basement, otherwise its number as text ("1", "2"),
      "units": [ every space that is let on its own (an apartment, a shop, an office):
        { "unit_no": its number as printed, without the word "Unit" or "Shop" unless that is all it has ("101", "G01", "S1"),
          "type": what it is, as printed or in two words ("2-Bedroom", "Retail shop"),
          "area_sqm": its area if written, otherwise leave it out,
          "x": , "y": , "w": its width left to right, "d": its depth bottom to top }
      ],
      "commons": [ what is on the floor besides the units:
        { "kind": "corridor" | "core" (stairs and lifts) | "lobby" | "service" (plant, electrical, refuse, storage) | "open" (a balcony or terrace shared by the floor),
          "label": a short name ("Corridor", "Stairs & lifts"), "x": , "y": , "w": , "d": }
      ]
    }
  ]
}

Every unit and common area is one rectangle: for a room that is not a rectangle, give the rectangle that covers most of it. Rectangles on one floor must not overlap and must stay inside the outline. Do not give the rooms inside a unit. If these pages are not floor plans, reply {"floors": []}.`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const name = (v, max = 40) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const round = (n) => Math.round(n * 100) / 100;

/** A rectangle kept to the building's outline, or null when nothing of it is inside. */
function inside(r, width, depth) {
  const [x, y, w, d] = ['x', 'y', 'w', 'd'].map((f) => num(r?.[f]));
  if ([x, y, w, d].includes(null)) return null;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const out = { x: round(x0), y: round(y0), w: round(Math.min(width, x + w) - x0), d: round(Math.min(depth, y + d) - y0) };
  return out.w > 0 && out.d > 0 ? out : null;
}

/**
 * What is worth keeping of whatever came back: the outline, and on each floor the units and
 * common areas that have a place inside it. A unit number seen twice is kept the first time.
 * Throws when there is no plan in it.
 */
export function proposal(reply) {
  let o;
  try { o = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { o = null; }
  const width = num(o?.width);
  const depth = num(o?.depth);
  const seen = new Set();
  const floors = (Array.isArray(o?.floors) ? o.floors : []).map((f) => {
    const floor = /^(g|ground|ground floor)$/i.test(name(f?.floor)) ? 'G' : name(f?.floor, 12).replace(/^floor\s+/i, '');
    const units = (Array.isArray(f?.units) ? f.units : []).map((u) => {
      const unit_no = name(u?.unit_no).replace(/^unit\s+/i, '');
      const rect = inside(u, width, depth);
      if (!unit_no || !rect || seen.has(unit_no.toLowerCase())) return null;
      seen.add(unit_no.toLowerCase());
      const area = num(u.area_sqm);
      return { unit_no, type: name(u.type), ...(area > 0 ? { size_sqft: Math.round(area * SQFT) } : {}), ...rect };
    }).filter(Boolean);
    const commons = (Array.isArray(f?.commons) ? f.commons : []).map((c) => {
      const rect = KINDS.includes(c?.kind) && inside(c, width, depth);
      return rect ? { kind: c.kind, label: name(c.label), ...rect } : null;
    }).filter(Boolean);
    return floor && units.length ? { floor, units, commons } : null;
  }).filter(Boolean);
  if (!(width > 0) || !(depth > 0) || !floors.length) throw bad('No floor plan could be read from this file. Try a clearer copy, with the unit numbers and the dimensions showing.', 422);
  return { width: round(width), depth: round(depth), storey: num(o.storey) > 0 ? round(num(o.storey)) : 3, floors };
}

async function claudeRead(block) {
  const { claude } = await import('./ai.js');
  // Streamed, because a careful reading runs past the time a plain request is allowed. Should
  // the model decline the file, the API's own fallback model reads it in the same call.
  const message = await claude.beta.messages.stream({
    model: MODEL, max_tokens: 32000, output_config: { effort: 'high' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
  }).finalMessage();
  if (message.stop_reason === 'refusal') throw bad('This file could not be read.', 422);
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** The plan in an uploaded file. Throws, in words that can be shown, when it has none or is not a PDF or a picture. */
export async function readPlan(file, { read = claudeRead } = {}) {
  const block = file && fileBlock(file);
  if (!block) throw bad('Upload the floor plan as a PDF or a picture.');
  return proposal(await read(block));
}

/**
 * The reading set against the building: the body savePlan takes, with what it would mean.
 *   add: the units on the plan the building does not have yet, to be made with it.
 *   floors: the unit numbers floor by floor, lowest first, to show the reading before it is kept.
 *   unplaced: the building's units the plan does not show; until every unit has a place, it is drawn the plain way.
 */
export async function against(buildingId, plan) {
  const mine = await db.prepare('SELECT unit_no FROM prop_units WHERE building_id = ?').all(Number(buildingId));
  const have = new Map(mine.map((u) => [u.unit_no.toLowerCase(), u.unit_no]));
  const units = {};
  const add = [];
  const commons = {};
  for (const f of plan.floors) {
    commons[f.floor] = f.commons;
    for (const { unit_no, type, size_sqft, ...rect } of f.units) {
      const known = have.get(unit_no.toLowerCase());
      units[known || unit_no] = rect;
      if (!known) add.push({ unit_no, floor: f.floor, type, size_sqft });
    }
  }
  const placed = new Set(Object.keys(units).map((n) => n.toLowerCase()));
  return { width: plan.width, depth: plan.depth, storey: plan.storey, commons, units, add,
    floors: plan.floors.map((f) => ({ floor: f.floor, units: f.units.map((u) => have.get(u.unit_no.toLowerCase()) || u.unit_no) })),
    unplaced: mine.map((u) => u.unit_no).filter((n) => !placed.has(n.toLowerCase())) };
}

// ---------- the readings under way ----------

const jobs = new Map();

/** Begin reading a file for a building; the ticket to ask after it with. */
export async function startReading(buildingId, file, opts) {
  if (!(file && fileBlock(file))) throw bad('Upload the floor plan as a PDF or a picture.');
  if (!(await db.prepare('SELECT 1 FROM prop_buildings WHERE id = ?').get(Number(buildingId)))) throw bad('Not found', 404);
  for (const [id, j] of jobs) if (j.done && Date.now() - j.done > KEEP) jobs.delete(id);
  const id = randomUUID();
  const job = { status: 'reading' };
  jobs.set(id, job);
  readPlan(file, opts).then((plan) => against(buildingId, plan))
    .then((plan) => Object.assign(job, { status: 'done', plan }))
    .catch((e) => {
      if (!e.status) console.error('[floor-plan]', e.message);
      Object.assign(job, { status: 'failed', error: e.status ? e.message : 'The floor plan could not be read just now. Try again in a minute.' });
    })
    .finally(() => { job.done = Date.now(); });
  return { id };
}

/** How a reading is getting on: { status: 'reading' | 'done' | 'failed', plan, error }. */
export function reading(id) {
  const job = jobs.get(id);
  if (!job) throw bad('That reading is no longer here. Upload the floor plan again.', 404);
  const { done, ...rest } = job;
  return rest;
}
