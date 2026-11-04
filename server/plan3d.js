import { readFileSync } from 'node:fs';
import { db } from './db.js';
import { claude } from './ai.js';
import { ADVISOR_MODEL, FAST_MODEL } from './config.js';
import { billAs } from './billing.js';
import { pdfPages } from './knowledge.js';

// A 3D view of a plan that is not CAD: a PDF drawing, or a photo or scan of one. It is for
// looking at, never for measuring, but its size must be right: Claude traces where the walls
// run, and the size comes from the dimensions written on the drawing, worked out into metres
// here (not by the model) and checked against the file's own text when it has one. The
// screen says where the size came from, and says so plainly when the drawing gives none.

const MODEL = ADVISOR_MODEL; // where walls run on a busy sheet needs a good eye
const MAX_FLOORS = 4; // a reading per plan page: enough for a villa or a small building
const MAX_PAGES_TO_PICK = 40;
const MAX_WALLS = 400;
const DEFAULT_STOREY_M = 3.2;

export const isPlanFile = (doc) => /\.pdf$/i.test(doc?.name || '') || /^image\/(jpeg|png|gif|webp)$/.test(doc?.mime || '');

// ---------- the size, from what is written on the drawing ----------

/**
 * A dimension as written on a drawing, in metres: "12000" (millimetres, as UAE drawings give
 * them), "12,000", "12.00", "12.00 m", "1200 cm", "40'-6\"". Null when it is not a length.
 */
export function dimensionMetres(text) {
  const t = String(text ?? '').trim().toLowerCase();
  const ft = t.match(/^(\d+)\s*['′]\s*-?\s*(\d+(?:\.\d+)?)?\s*(?:["″]|in)?$/);
  if (ft) return Math.round((Number(ft[1]) * 0.3048 + Number(ft[2] || 0) * 0.0254) * 1000) / 1000;
  const m = t.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = m[2] || (n >= 100 ? 'mm' : 'm'); // a building is not 100 m across; 100 and more is millimetres
  return Math.round((unit === 'mm' ? n / 1000 : unit === 'cm' ? n / 100 : n) * 1000) / 1000;
}

/** Whether a dimension the model read is really written in the file's text ("12000" as 12000, 12,000 or 12 000). */
export function inText(dim, text) {
  const want = String(dim ?? '').replace(/[,\s]/g, '').replace(/\s*(mm|cm|m)$/i, '');
  if (!/^\d+(\.\d+)?$/.test(want) || !text) return false;
  const flat = String(text).replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');
  return new RegExp(`(^|[^\\d.])${want.replace('.', '\\.')}(?![\\d])`).test(flat);
}

// ---------- the paid readings ----------

const PICK = {
  name: 'pick_plans',
  description: 'List the pages that are architectural floor plans, lowest floor first.',
  input_schema: {
    type: 'object',
    properties: {
      plans: {
        type: 'array',
        items: {
          type: 'object',
          properties: { page: { type: 'integer', description: 'Page number, 1 = first page' }, floor: { type: 'string', description: 'e.g. Ground floor, First floor, Typical floor, Roof' } },
          required: ['page', 'floor'],
        },
      },
    },
    required: ['plans'],
  },
};

const PICK_RULES = 'Pick only architectural floor plans: the layout of one floor seen from above, with its walls, rooms and doors. ' +
  'Not structural, foundation, electrical, plumbing, drainage, HVAC, ceiling, furniture, landscape or site plans, and not sections, elevations, details or schedules. ' +
  `One page per floor (if a floor is drawn twice, the plainest one), lowest floor first, at most ${MAX_FLOORS}. An empty list when there is none.`;

const pdfBlock = (buf) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });

/** Which pages of a set are floor plans: from their text when the file has some, from the pages themselves when it is a scan. */
async function pickPlanPages(buffer, pageTexts) {
  const withText = pageTexts.filter((t) => t.replace(/\s+/g, '').length > 30).length >= pageTexts.length / 2;
  const content = withText
    ? pageTexts.slice(0, MAX_PAGES_TO_PICK).map((t, i) => `--- Page ${i + 1} ---\n${t.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n')
    : [pdfBlock(await pdfPages(buffer, 0, Math.min(pageTexts.length, 20))), { type: 'text', text: 'These are the pages of a drawing set.' }];
  const res = await claude.messages.create({
    model: FAST_MODEL, // only sorting pages by what they are
    max_tokens: 800,
    system: `You sort the pages of a building drawing set. ${PICK_RULES} Call pick_plans once.${withText ? ' You are given the text found on each page (titles, room names, notes, dimensions).' : ''}`,
    tools: [PICK],
    tool_choice: { type: 'tool', name: 'pick_plans' },
    messages: [{ role: 'user', content: withText ? `The text on each page of a drawing set:\n${content}` : content }],
  });
  const plans = res.content.find((b) => b.type === 'tool_use')?.input?.plans || [];
  const seen = new Set();
  return plans.filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageTexts.length && !seen.has(p.page) && seen.add(p.page))
    .slice(0, MAX_FLOORS).map((p) => ({ page: p.page - 1, floor: String(p.floor || '').slice(0, 40) }));
}

const SIDE = {
  type: 'object',
  properties: {
    text: { type: ['string', 'null'], description: 'The overall dimension for the full outside size on this side, copied exactly as printed (e.g. "12000", "12.00", "40\'-6\\""). Null if none is printed.' },
    chain: { type: 'array', items: { type: 'string' }, description: 'If there is no overall dimension: every dimension of the chain that runs the full length of this side, as printed. Empty otherwise.' },
    estimate_m: { type: ['number', 'null'], description: 'Only when nothing is printed for this side: your estimate in metres (from a scale bar, a stated scale, or door widths of about 0.9 m).' },
  },
  required: ['text', 'chain', 'estimate_m'],
};

const TRACE = {
  name: 'record_plan',
  description: 'Record the walls of the floor plan and its overall dimensions.',
  input_schema: {
    type: 'object',
    properties: {
      is_floor_plan: { type: 'boolean', description: 'False if this is not an architectural floor plan of a building.' },
      floor: { type: 'string', description: 'Which floor, as titled (e.g. Ground floor).' },
      level_m: { type: ['number', 'null'], description: 'The finished floor level of this floor in metres if written (FFL +3.50 → 3.5), else null.' },
      storey_height_m: { type: ['number', 'null'], description: 'Floor-to-floor or floor-to-ceiling height if written on the sheet, else null.' },
      width: { ...SIDE, description: 'The outside width of the building, left to right as the sheet is drawn.' },
      depth: { ...SIDE, description: 'The outside depth of the building, top to bottom as the sheet is drawn.' },
      walls: {
        type: 'array',
        description: 'Every wall as a straight centre line, in the 0-1000 frame. A wall with a door or window opening is still one line, ignore the opening.',
        items: {
          type: 'object',
          properties: { x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' } },
          required: ['x1', 'y1', 'x2', 'y2'],
        },
      },
    },
    required: ['is_floor_plan', 'floor', 'level_m', 'storey_height_m', 'width', 'depth', 'walls'],
  },
};

const TRACE_RULES = `You trace the walls of an architectural floor plan so it can be shown in 3D. Call record_plan once.
Coordinates: a 0-1000 frame fitted to the building itself, not the sheet. x=0 is the outside face of the leftmost outer wall and x=1000 the outside face of the rightmost; y=0 is the outside face of the top outer wall and y=1000 the outside face of the bottom one. So the outer walls run along 0 and 1000, and every inner wall is placed by its share of the width and depth.
Place inner walls from the dimension chains where the plan gives them (a wall 4200 mm into a 12000 mm width is at x=350), otherwise by eye.
Trace only this building's walls: outer and inner walls and partitions. Not furniture, fixtures, hatching, dimension lines, grid lines, boundary or plot lines, landscaping, or a second plan drawn on the same sheet.
Sizes: copy dimensions exactly as printed, never convert or round them. Never make one up: if nothing is printed for a side, give null and your estimate.`;

async function traceCall(block) {
  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: TRACE_RULES,
    tools: [TRACE],
    // Sonnet 5.5 takes no forced tool; it is told to call it, and an answer without it fails below.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [block, { type: 'text', text: 'Trace this floor plan and record it with record_plan.' }] }],
  });
  return res.content.find((b) => b.type === 'tool_use')?.input || null;
}

// ---------- from the readings to the model the viewer draws ----------

/** One side's size in metres and where it came from: 'checked' (found in the file's text), 'read' (read off the picture), 'estimated'. */
export function sideSize(side, pageText) {
  if (side?.text) {
    const m = dimensionMetres(side.text);
    if (m) return { m, from: pageText && inText(side.text, pageText) ? 'checked' : 'read', shown: side.text };
  }
  const chain = (side?.chain || []).map(dimensionMetres);
  if (chain.length >= 2 && chain.every(Boolean)) {
    const ok = pageText && side.chain.every((c) => inText(c, pageText));
    return { m: Math.round(chain.reduce((a, b) => a + b, 0) * 1000) / 1000, from: ok ? 'checked' : 'read', shown: side.chain.join(' + ') };
  }
  const e = Number(side?.estimate_m);
  return e > 1 && e < 300 ? { m: e, from: 'estimated', shown: null } : null;
}

const clampFrame = (n) => Math.max(-20, Math.min(1020, Number(n)));

/**
 * The traced floors (lowest first) as the 3D view takes them: walls in metres around the
 * building's middle, plan y turned to run north (up the sheet), each floor at its level.
 * traced: [{ floor, plan: record_plan input, pageText }]
 */
export function buildModel(traced) {
  const floors = [];
  for (const t of traced) {
    const p = t.plan;
    if (!p?.is_floor_plan) continue;
    const W = sideSize(p.width, t.pageText), D = sideSize(p.depth, t.pageText);
    if (!W || !D) continue;
    const walls = [];
    for (const w of (p.walls || []).slice(0, MAX_WALLS)) {
      const [x1, y1, x2, y2] = [w.x1, w.y1, w.x2, w.y2].map(clampFrame);
      if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n)) || (x1 === x2 && y1 === y2)) continue;
      walls.push(x1 / 1000 * W.m, (1000 - y1) / 1000 * D.m, x2 / 1000 * W.m, (1000 - y2) / 1000 * D.m);
    }
    if (walls.length < 12) continue; // three walls at the least, or it is not a plan worth standing up
    floors.push({ name: String(p.floor || t.floor || `Floor ${floors.length + 1}`).slice(0, 40), level: Number.isFinite(p.level_m) ? p.level_m : null, storey: p.storey_height_m, W, D, walls });
  }
  if (!floors.length) return { error: 'No floor plan with its walls was found in this file, so there is nothing to show in 3D.' };

  // Floors at their written levels when every one gives a level; otherwise stacked in order.
  if (floors.every((f) => f.level != null) && new Set(floors.map((f) => f.level)).size === floors.length) floors.sort((a, b) => a.level - b.level);
  const written = floors.map((f) => Number(f.storey)).find((h) => h >= 2.4 && h <= 8);
  const rises = floors.slice(1).map((f, i) => (f.level != null && floors[i].level != null ? f.level - floors[i].level : null));
  const fromLevels = rises.length && rises.every((r) => r >= 2.4 && r <= 8);
  let base = 0;
  const out = floors.map((f, i) => {
    const height = fromLevels ? (rises[i] ?? rises[i - 1]) : written || DEFAULT_STOREY_M;
    const floor = { name: f.name, base: Math.round(base * 100) / 100, height: Math.round(height * 100) / 100, walls: f.walls };
    base += height;
    return floor;
  });
  // Around the middle of the lowest floor, as the viewer expects.
  const cx = floors[0].W.m / 2, cy = floors[0].D.m / 2;
  for (const f of out) f.walls = f.walls.map((n, i) => Math.round((n - (i % 2 ? cy : cx)) * 100) / 100);

  const say = (s) => (s.from === 'checked' ? `${s.shown}, written on the drawing` : s.from === 'read' ? `${s.shown}, read off the drawing` : 'estimated, no dimension on the drawing');
  const sizes = floors.map((f) => `${floors.length > 1 ? `${f.name}: ` : ''}${f.W.m.toFixed(2)} × ${f.D.m.toFixed(2)} m (${say(f.W)}; ${say(f.D)})`).join('. ');
  const guessed = floors.some((f) => f.W.from === 'estimated' || f.D.from === 'estimated');
  const note = [
    `Size ${sizes}.`,
    guessed ? 'Where the drawing gives no dimension the size is Reem\'s estimate and may be off.' : '',
    fromLevels ? 'Floor heights from the levels on the drawing.' : written ? `Floor height ${written} m, as written on the drawing.` : `Floor height ${DEFAULT_STOREY_M} m by default: the drawing does not give it.`,
    'Wall positions inside are traced by Reem from the drawing.',
  ].filter(Boolean).join(' ');
  return { floors: out, thickness: 0.2, note, checked: floors.every((f) => f.W.from === 'checked' && f.D.from === 'checked') };
}

// ---------- reading a file, once ----------

async function pageTextsOf(buffer) {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch {
    const mupdf = await import('mupdf');
    const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
    try { return Array.from({ length: doc.countPages() }, () => ''); } finally { doc.destroy(); }
  }
}

/** The file traced into floors. say(step) tells the screen how far it has got. */
export async function tracePlan(doc, say = () => {}, { trace = traceCall, pick = pickPlanPages } = {}) {
  const buffer = readFileSync(doc.path);
  if (!/\.pdf$/i.test(doc.name)) {
    say('Reading the plan…');
    const plan = await trace({ type: 'image', source: { type: 'base64', media_type: doc.mime, data: buffer.toString('base64') } });
    return buildModel([{ floor: '', plan, pageText: '' }]);
  }
  const texts = await pageTextsOf(buffer);
  let pages = [{ page: 0, floor: '' }];
  if (texts.length > 1) {
    say('Finding the floor plans…');
    pages = await pick(buffer, texts);
    if (!pages.length) return { error: 'No floor plan was found in this file, so there is nothing to show in 3D.' };
  }
  let done = 0;
  say(pages.length > 1 ? `Reading ${pages.length} floor plans…` : 'Reading the plan…');
  const traced = await Promise.all(pages.map(async ({ page, floor }) => {
    const plan = await trace(pdfBlock(await pdfPages(buffer, page, page + 1)));
    done++;
    if (pages.length > 1) say(`Read ${done} of ${pages.length} floor plans…`);
    return { floor, plan, pageText: texts[page] || '' };
  }));
  return buildModel(traced);
}

// One reading per file at a time, whoever asks; the screen asks again until it is done.
const jobs = new Map(); // document id → { step, error? }

/**
 * The 3D model of a PDF or picture plan the person may open (the caller has checked that):
 * the kept one, or { pending, step } while it is being read, or { error }.
 */
export async function planModel(user, doc) {
  const kept = await db.prepare('SELECT model FROM plan_models WHERE document_id = ? AND hash IS NOT DISTINCT FROM ?').get(doc.id, doc.hash ?? null);
  if (kept) return kept.model;
  const job = jobs.get(doc.id);
  if (job?.error) { jobs.delete(doc.id); return { error: job.error }; }
  if (job) return { pending: true, step: job.step };
  const entry = { step: 'Starting…' };
  jobs.set(doc.id, entry);
  billAs({ userId: user.id, job: '3d-plan' }, () => tracePlan(doc, (s) => { entry.step = s; }))
    .then(async (model) => {
      if (model.error) { entry.error = model.error; return; }
      await db.prepare(`INSERT INTO plan_models (document_id, hash, model) VALUES (?, ?, ?)
        ON CONFLICT (document_id) DO UPDATE SET hash = EXCLUDED.hash, model = EXCLUDED.model, created_at = extract(epoch from now())::bigint`)
        .run(doc.id, doc.hash ?? null, JSON.stringify(model));
      jobs.delete(doc.id);
    })
    .catch((e) => {
      console.error('[plan3d]', doc.id, e.message);
      entry.error = 'This drawing could not be read for 3D. Please try again.';
    });
  return { pending: true, step: entry.step };
}
