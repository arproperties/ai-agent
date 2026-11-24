import { Router } from 'express';
import multer from 'multer';
import { claude } from './ai.js';
import { billAs } from './billing.js';

// The store camera's item count, for saifsys (Operations -> Store Camera).
//
// saifsys sends a picture a store camera took and, for a check, the store's reference picture
// with its confirmed list; Claude counts the stored items in the picture by kind (against the
// reference, by the same names). Nothing is kept in Reem. Each count is billed to the person it is for.

const MODEL = 'claude-opus-5-5';
// "Ask how many" on one pin: a small cut-out, counted by the smallest model at low effort (a fraction of a cent).
const SMALL_MODEL = 'claude-haiku-5-5';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const PROMPT = 'Count everything kept in the store that can be moved, one kind per row, split by colour where it differs: '
  + 'the stock (e.g. White jerry cans, Pink jerry cans, White sacks, Gas cylinders, Cardboard boxes, Drums) and the '
  + 'equipment and cleaning items (e.g. Cleaning trolley, Mops, Brooms, Buckets, Trays, Basins, Dustpans, Spray bottles, '
  + 'Water bottles, Chairs, Ladders). List the stock first, then the equipment. Count carefully, item by item; one that '
  + 'is partly hidden counts if you can tell it is there. Leave out walls, doors, shelves, fixtures, pipes, cables, things '
  + 'fixed to the wall, rubbish and people. Give each kind a short plain name, starting with a capital letter. In note, say in one '
  + 'short sentence what you could not count well (too dark, hidden behind other items, cut off at the edge), or leave it empty. '
  + 'boxes: where each kind is in the picture (the picture being counted, not the reference), as boxes in percent of the '
  + 'picture (x0, y0 = top-left corner, x1, y1 = bottom-right corner, 0-100): one tight box per item, or one box round a '
  + 'group of the same kind standing together.';

const FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'note'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'count', 'boxes'],
          properties: {
            item: { type: 'string' },
            count: { type: 'integer' },
            boxes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['x0', 'y0', 'x1', 'y1'],
                properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
              },
            },
          },
        },
      },
      note: { type: 'string' },
    },
  },
};

const image = (buffer, mimetype) => ({ type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } });

/**
 * The stored items in one picture: { items: [{ item, count }], note }.
 * names: kinds to reuse, so two counts line up.
 * reference: { buffer, mimetype, items } - the store's reference picture and its confirmed list; the
 * picture is then counted against it, item by item, by the same names.
 */
export async function countPicture(buffer, mimetype, names = [], reference = null, small = false) {
  const hint = names.length ? `\nWhere they fit, use exactly these names, so this count lines up with an earlier one: ${names.join('; ')}.` : '';
  // Each item of the reference list, with the numbered red pins marking where it stands on the first picture.
  const listed = reference
    ? reference.items.map((i) => `${i.item} ${i.count}${i.marks?.length ? ` (red pin${i.marks.length > 1 ? 's' : ''} ${i.marks.join(', ')})` : ''}`).join('; ')
    : '';
  const intro = reference
    ? 'The FIRST picture is the store\'s reference, taken when it was set; numbered red pins on it mark where items stand. '
      + `Its confirmed count is: ${listed || 'not given'}. The SECOND picture is the store now. `
      + 'Count the SECOND picture only, using the reference to see what each item looks like and where it stood. '
      + 'Give every item of the reference list (0 when it is gone), and add any new kind you see.\n'
    : 'This is one picture from a store-room security camera.\n';
  const content = [
    ...(reference ? [image(reference.buffer, reference.mimetype)] : []),
    image(buffer, mimetype),
    { type: 'text', text: intro + PROMPT + hint },
  ];
  const msg = await claude.beta.messages.stream({
    model: small ? SMALL_MODEL : MODEL,
    max_tokens: small ? 2000 : 16000,
    // A declined picture is tried again on another model in the same call (the small model has no fallback).
    ...(small ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    output_config: { effort: small ? 'low' : 'high', format: FORMAT },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw bad('Claude would not count this picture', 422);
  if (msg.stop_reason === 'max_tokens') throw bad('The count was cut off. Try again.', 502);
  let out;
  try {
    out = JSON.parse(msg.content.find((b) => b.type === 'text')?.text || '');
  } catch {
    throw bad('The count could not be read. Try again.', 502);
  }
  // Each kind keeps where it is in the picture (boxes in %), for showing it on the picture.
  const pct = (v) => Math.round(Math.min(100, Math.max(0, Number(v) || 0)) * 10) / 10;
  const items = (Array.isArray(out.items) ? out.items : []).map((i) => ({
    ...cleanItems([i])[0],
    boxes: (Array.isArray(i?.boxes) ? i.boxes : []).slice(0, 40)
      .map((b) => [pct(b?.x0), pct(b?.y0), pct(b?.x1), pct(b?.y1)])
      .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0),
  })).filter((i) => i.item).slice(0, 40);
  return { items, note: String(out.note ?? '').trim().slice(0, 500) };
}

/** A list of { item, count }, trimmed: names up to 80 letters, whole counts of 0 or more, at most 40 kinds. */
function cleanItems(list) {
  return (Array.isArray(list) ? list : [])
    .map((i) => ({ item: String(i?.item ?? '').trim().slice(0, 80), count: Math.max(0, Math.round(Number(i?.count) || 0)) }))
    .filter((i) => i.item)
    .slice(0, 40);
}

const jsonQuery = (value) => {
  try {
    return JSON.parse(String(value || '[]'));
  } catch {
    return [];
  }
};

// ---------- comparing the store now with its reference picture ----------

const COMPARE_PROMPT = 'These are two pictures from the same fixed security camera in a store room. The FIRST is the '
  + 'reference, taken when the store was set; the SECOND is the store now. Say what changed in the stored goods: items '
  + 'missing or fewer, added or more, or moved. For each change say what it is, the kind of change, and where it is in '
  + 'the picture (for example "back right corner", "middle, beside the blue cart"); give a number when you can count it. '
  + 'Ignore changes of light and shadow, the date and time printed on the picture, people passing, and small shifts of '
  + 'cables, cloths or bags that do not change what is stored. If nothing that matters changed, give no changes. '
  + 'summary: one or two short sentences for the store keeper.';

const COMPARE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'changes'],
    properties: {
      summary: { type: 'string' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['what', 'change', 'where', 'detail'],
          properties: {
            what: { type: 'string' },
            change: { type: 'string', enum: ['missing', 'fewer', 'added', 'more', 'moved', 'other'] },
            where: { type: 'string' },
            detail: { type: 'string' },
          },
        },
      },
    },
  },
};

/** What changed between the reference picture and the picture now: { summary, changes: [{ what, change, where, detail }] }. */
export async function comparePictures(now, reference) {
  const msg = await claude.beta.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    // A declined picture is tried again on another model in the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: COMPARE_FORMAT },
    messages: [{ role: 'user', content: [image(reference.buffer, reference.mimetype), image(now.buffer, now.mimetype), { type: 'text', text: COMPARE_PROMPT }] }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw bad('Claude would not compare these pictures', 422);
  if (msg.stop_reason === 'max_tokens') throw bad('The comparison was cut off. Try again.', 502);
  let out;
  try {
    out = JSON.parse(msg.content.find((b) => b.type === 'text')?.text || '');
  } catch {
    throw bad('The comparison could not be read. Try again.', 502);
  }
  const text = (v, n) => String(v ?? '').trim().slice(0, n);
  return {
    summary: text(out.summary, 500),
    changes: (Array.isArray(out.changes) ? out.changes : []).slice(0, 30).map((c) => ({
      what: text(c?.what, 80), change: text(c?.change, 10), where: text(c?.where, 120), detail: text(c?.detail, 200),
    })).filter((c) => c.what),
  };
}

// ---------- the day's report, written from saifsys's log and pictures ----------

const REPORT_PROMPT = 'Write the daily security report of a store room for management, from the log and pictures below. '
  + 'The log lists the movements the camera saw, the alerts (movement, store changed, monitoring stopped) and the checks '
  + 'against the reference picture (how much of the picture changed and where). The pictures, when given, are the reference '
  + '(the store as set) and the last picture of the day.\n'
  + 'Style: brief, formal and factual, like a security log. Short phrases, no filler, no percentages of the picture, no '
  + 'mention of alerts, checks, pixels, software or how the system works.\n'
  + 'summary: one sentence giving the overall status of the store for the day.\n'
  + 'stock_handled: how many movements show stock being taken, brought in or moved (0 when none).\n'
  + 'stock: the count of everything kept in the store that can be moved, one row per kind: the stock (e.g. "White jerry '
  + 'cans", "White sacks", "Cardboard boxes") first, then the equipment and cleaning items (e.g. "Cleaning trolley", '
  + '"Mops", "Brooms", "Buckets", "Trays"); not fixtures, things fixed to the wall, rubbish or people. start = how many '
  + 'in the first picture of the day (the reference when there is none); end = how many in the last picture of the day '
  + '(the same as start when there is none). Count carefully, item by item, using the same name for the same kind in both '
  + 'pictures; count an item that is partly hidden if you can tell it is there. At most 25 kinds. Only for a kind whose '
  + 'count changed (start differs from end): start_boxes = where those items are in the first picture (the reference '
  + 'when there is no first picture) and end_boxes = where they are in the last picture, as boxes in percent of the '
  + 'picture (x0, y0 = top-left, x1, y1 = bottom-right, 0-100), one per item or one round a group; for an item that is '
  + 'gone, box the place where it stood. [] for both when the count did not change.\n'
  + 'closing: the store at the end of the day, at most 6 words, e.g. "Unchanged from reference", "2 jerry cans missing".\n'
  + 'rows: only these, oldest first: (1) "Start of day"; (2) one row for each movement in which the stock count changed '
  + '(something taken, brought in or moved); (3) "End of day". Leave out every movement, check and quiet time in which the '
  + 'stock did not change. time: "Start of day", "09:59" or "09:59-10:01", "End of day". what: on Start of day, what the '
  + 'store held at the start, from the first picture of the day (or the reference when there is none), in at most 30 words, '
  + 'e.g. "About 20 jerry cans along the right wall; 8 white sacks in the middle; cleaning trolley in the middle."; on a '
  + 'movement, who and what was taken, brought in or moved, and where, in at most 30 words, e.g. "Staff member in a blue '
  + 'uniform took one white jerry can from the right wall."; on End of day, the closing status in at most 20 words. '
  + 'picture: the key of the snapshot a movement row describes (e.g. "m3"), or "". stock: on Start of day, the counts '
  + '(e.g. "White jerry cans 14, White sacks 6"); on a movement, what changed (e.g. "White jerry cans 14 → 13"); on End '
  + 'of day, the changes over the day (e.g. "White jerry cans 14 → 13, Brooms 0 → 2"), or "No change". Report only what '
  + 'the log and pictures show.';

const REPORT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    $defs: {
      box: {
        type: 'object',
        additionalProperties: false,
        required: ['x0', 'y0', 'x1', 'y1'],
        properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
      },
    },
    required: ['summary', 'stock_handled', 'closing', 'stock', 'rows'],
    properties: {
      summary: { type: 'string' },
      stock: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'start', 'end', 'start_boxes', 'end_boxes'],
          properties: {
            item: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            start_boxes: { type: 'array', items: { $ref: '#/$defs/box' } },
            end_boxes: { type: 'array', items: { $ref: '#/$defs/box' } },
          },
        },
      },
      stock_handled: { type: 'integer' },
      closing: { type: 'string' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'what', 'stock', 'picture'],
          properties: { time: { type: 'string' }, what: { type: 'string' }, stock: { type: 'string' }, picture: { type: 'string' } },
        },
      },
    },
  },
};

/** Boxes from Claude ({ x0, y0, x1, y1 } in %) as [x0, y0, x1, y1], kept inside the picture. */
function boxList(list) {
  const pct = (v) => Math.round(Math.min(100, Math.max(0, Number(v) || 0)) * 10) / 10;
  return (Array.isArray(list) ? list : []).slice(0, 30)
    .map((b) => [pct(b?.x0), pct(b?.y0), pct(b?.x1), pct(b?.y1)])
    .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
}

/** The day's report: { summary, rows: [{ time, what }] }. log: saifsys's log in words; pictures: [{ buffer, mimetype }] (reference first). */
export async function writeReport(log, pictures) {
  const msg = await claude.beta.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: REPORT_FORMAT },
    messages: [{ role: 'user', content: [
      ...pictures.flatMap((p) => [{ type: 'text', text: `${p.key ? `[${p.key}] ` : ''}${p.label}:` }, image(p.buffer, p.mimetype)]),
      { type: 'text', text: `${REPORT_PROMPT}\n\n${log}` },
    ] }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw bad('Claude would not write this report', 422);
  if (msg.stop_reason === 'max_tokens') throw bad('The report was cut off. Try again.', 502);
  let out;
  try {
    out = JSON.parse(msg.content.find((b) => b.type === 'text')?.text || '');
  } catch {
    throw bad('The report could not be read. Try again.', 502);
  }
  return {
    summary: String(out.summary ?? '').trim().slice(0, 1000),
    stock_handled: Math.max(0, Math.round(Number(out.stock_handled) || 0)),
    stock: (Array.isArray(out.stock) ? out.stock : []).map((s) => ({
      item: String(s?.item ?? '').trim().slice(0, 80),
      start: Math.max(0, Math.round(Number(s?.start) || 0)),
      end: Math.max(0, Math.round(Number(s?.end) || 0)),
      start_boxes: boxList(s?.start_boxes),
      end_boxes: boxList(s?.end_boxes),
    })).filter((s) => s.item).slice(0, 25),
    closing: String(out.closing ?? '').trim().slice(0, 120),
    rows: (Array.isArray(out.rows) ? out.rows : [])
      .map((x) => ({
        time: String(x?.time ?? '').trim().slice(0, 20),
        what: String(x?.what ?? '').trim().slice(0, 600),
        stock: String(x?.stock ?? '').trim().slice(0, 200),
        picture: String(x?.picture ?? '').trim().slice(0, 4),
      }))
      .filter((x) => x.what).slice(0, 40),
  };
}

// ---------- one movement, described as it comes in ----------

const DESCRIBE_PROMPT = 'A store-room security camera saw movement. The labelled pictures are the snapshot of the movement '
  + 'and, when given, the reference picture of the store as set. Describe the snapshot in two or three short, formal '
  + 'sentences (at most 50 words): how many people and how they look (e.g. uniform colour), where they are in the store, '
  + 'what they are doing, and what they carry, take, bring or move. Say "No stock handled." when none is. If no person is '
  + 'visible, say what changed. If the picture is unclear, say so briefly. Report only what the pictures show.\n'
  + 'Answer as JSON: what = that description; short = the same in at most 8 words for a notification, e.g. "Staff '
  + 'member cleaning; no stock handled.", "Two people took a jerry can.", "No person visible.".';

const DESCRIBE_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['what', 'short'],
    properties: { what: { type: 'string' }, short: { type: 'string' } },
  },
};

/** What a movement snapshot shows: { what, short }. */
export async function describeMovement(snapshot, reference) {
  const content = [{ type: 'text', text: 'Movement snapshot:' }, image(snapshot.buffer, snapshot.mimetype)];
  if (reference) content.push({ type: 'text', text: 'Reference picture:' }, image(reference.buffer, reference.mimetype));
  content.push({ type: 'text', text: DESCRIBE_PROMPT });
  const msg = await claude.beta.messages.stream({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: DESCRIBE_FORMAT },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw bad('Claude would not describe this picture', 422);
  let out;
  try {
    out = JSON.parse(msg.content.find((b) => b.type === 'text')?.text || '');
  } catch {
    throw bad('The description could not be read. Try again.', 502);
  }
  const what = String(out.what ?? '').replace(/\s+/g, ' ').trim();
  if (!what) throw bad('No description came back. Try again.', 502);
  return { what: what.slice(0, 500), short: String(out.short ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) };
}

export const storeCameraRoutes = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 15 } });
// The report's movement snapshots: m1..m12.
const MOVE_FIELDS = Array.from({ length: 12 }, (_, i) => ({ name: `m${i + 1}`, maxCount: 1 }));
// ... and the first picture of the day, for "Start of day".
const IMAGE = /^image\/(jpeg|png|webp)$/;

// Only saifsys comes in here (the store camera pictures are its own).
storeCameraRoutes.use((req, res, next) => (req.fromSaifsys
  ? next() : res.status(403).json({ error: 'Store camera counts are asked for from saifsys' })));

// POST /compare   multipart: photo (the store now), reference (the store's reference picture)
storeCameraRoutes.post('/compare', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'reference', maxCount: 1 }]), (req, res, next) => {
  const photo = req.files?.photo?.[0];
  const ref = req.files?.reference?.[0];
  if (!photo || !ref) return res.status(400).json({ error: 'Both pictures are needed: the store now and its reference' });
  if (!IMAGE.test(photo.mimetype) || !IMAGE.test(ref.mimetype)) return res.status(400).json({ error: 'The pictures must be JPEG, PNG or WebP' });
  billAs({ userId: req.user?.id, job: 'store_camera', note: 'Store camera compare' },
    () => comparePictures({ buffer: photo.buffer, mimetype: photo.mimetype }, { buffer: ref.buffer, mimetype: ref.mimetype }))
    .then((r) => res.json(r))
    .catch(next);
});

// POST /describe   multipart: photo (the movement snapshot), reference (optional)
storeCameraRoutes.post('/describe', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'reference', maxCount: 1 }]), (req, res, next) => {
  const photo = req.files?.photo?.[0];
  const ref = req.files?.reference?.[0];
  if (!photo) return res.status(400).json({ error: 'No picture came through' });
  if (!IMAGE.test(photo.mimetype) || (ref && !IMAGE.test(ref.mimetype))) return res.status(400).json({ error: 'The pictures must be JPEG, PNG or WebP' });
  billAs({ userId: req.user?.id, job: 'store_camera', note: 'Store camera movement' },
    () => describeMovement({ buffer: photo.buffer, mimetype: photo.mimetype }, ref ? { buffer: ref.buffer, mimetype: ref.mimetype } : null))
    .then((r) => res.json(r))
    .catch(next);
});

// POST /report   multipart: log (the day's log in words), reference and photo (optional pictures)
storeCameraRoutes.post('/report', upload.fields([{ name: 'reference', maxCount: 1 }, { name: 'first', maxCount: 1 }, { name: 'photo', maxCount: 1 }, ...MOVE_FIELDS]), (req, res, next) => {
  const log = String(req.body?.log ?? '').trim().slice(0, 20000);
  if (!log) return res.status(400).json({ error: 'The day\'s log did not come through' });
  let labels = {};
  try {
    labels = JSON.parse(String(req.body?.labels || '{}')) || {};
  } catch { /* no labels */ }
  const pictures = [
    ['reference', 'Reference picture (the store as set)'],
    ['first', String(labels.first ?? 'First picture of the day').slice(0, 60)],
    ['photo', 'Last picture of the day'],
    ...MOVE_FIELDS.map((f) => [f.name, String(labels[f.name] ?? 'Movement').slice(0, 60)]),
  ].map(([k, label]) => ({ file: req.files?.[k]?.[0], label, key: /^m\d+$/.test(k) ? k : '' })).filter((p) => p.file);
  if (pictures.some((p) => !IMAGE.test(p.file.mimetype))) return res.status(400).json({ error: 'The pictures must be JPEG, PNG or WebP' });
  billAs({ userId: req.user?.id, job: 'store_camera', note: 'Store camera report' },
    () => writeReport(log, pictures.map((p) => ({ buffer: p.file.buffer, mimetype: p.file.mimetype, label: p.label, key: p.key }))))
    .then((r) => res.json(r))
    .catch(next);
});

// POST /count?names=["Jerry can"]&reference_items=[{"item":"Jerry can","count":30}]&model=small (optional)
//   multipart: photo (the picture now), reference (optional: the store's reference picture)
storeCameraRoutes.post('/count', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'reference', maxCount: 1 }]), (req, res, next) => {
  const photo = req.files?.photo?.[0];
  const ref = req.files?.reference?.[0];
  if (!photo) return res.status(400).json({ error: 'No picture came through' });
  if (!IMAGE.test(photo.mimetype) || (ref && !IMAGE.test(ref.mimetype))) return res.status(400).json({ error: 'The pictures must be JPEG, PNG or WebP' });
  const q = jsonQuery(req.query.names);
  const names = (Array.isArray(q) ? q : []).map((n) => String(n).trim().slice(0, 80)).filter(Boolean).slice(0, 40);
  // The reference list keeps each item's pin numbers (marks), whole numbers 1-200.
  const rawRef = jsonQuery(req.query.reference_items);
  const refItems = (Array.isArray(rawRef) ? rawRef : [])
    .map((i) => ({
      ...cleanItems([i])[0],
      marks: (Array.isArray(i?.marks) ? i.marks : []).map(Number).filter((m) => Number.isInteger(m) && m > 0 && m <= 200).slice(0, 40),
    }))
    .filter((i) => i.item)
    .slice(0, 40);
  const reference = ref ? { buffer: ref.buffer, mimetype: ref.mimetype, items: refItems } : null;
  billAs({ userId: req.user?.id, job: 'store_camera', note: reference ? 'Store camera check' : 'Store camera count' },
    () => countPicture(photo.buffer, photo.mimetype, names, reference, req.query.model === 'small'))
    .then((r) => res.json(r))
    .catch(next);
});
