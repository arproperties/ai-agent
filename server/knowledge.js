import mammoth from 'mammoth';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, tx } from './db.js';
import { ask, claude, embed, transcribe } from './ai.js';
import { CAREFUL_MODEL } from './config.js';
import { isMaster } from './access.js';
import { EMBED_MODEL } from './config.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp'];
export const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', '3gp'];
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log', 'js', 'ts', 'py', 'sql', 'tsv'];

// ---------- extraction ----------
// onProgress(label): a line to show while a long PDF is read page by page.
export async function extractText({ buffer, mimetype, originalname }, { onProgress } = {}) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const { text, pages, readPages } = await pdfTextLayer(buffer);
    return readPages ? readPdfPages(buffer, pages, { name: originalname, onProgress }) : text;
  }
  if (ext === 'docx') return (await mammoth.extractRawText({ buffer })).value;
  if (mimetype.startsWith('text/') || TEXT_EXT.includes(ext)) return buffer.toString('utf8');
  throw new Error(`Unsupported file type: ${originalname}`);
}

/**
 * A PDF's own text and page count, and whether Claude has to read its pages instead: a scan
 * is page images with little or no text layer, and a court PDF carries one that reads out
 * jumbled. Local and free - nothing is sent anywhere to decide.
 */
export async function pdfTextLayer(buffer) {
  const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await pdfText(pdf, { mergePages: true });
  const scanned = text.replace(/\s+/g, '').length < 40 * pdf.numPages;
  const scrambled = !scanned && scrambledArabic(text);
  return { text, pages: pdf.numPages, readPages: scanned || scrambled, why: scanned ? 'scanned' : scrambled ? 'court Arabic' : null };
}

/**
 * Arabic stored as display shapes in visual order, the way Dubai Courts and other court
 * systems write their PDFs. The text layer is there, but read out it comes back with the
 * letters reversed and split apart, and an agent working from it misreads names, figures
 * and orders. Ordinary Arabic text uses the base letters; these use the presentation forms.
 */
export function scrambledArabic(text) {
  const forms = (text.match(/[\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return forms >= 100 && forms >= 0.3 * (forms + arabic);
}

// Every page read is sent to Claude as a picture, so pages are what cost. They go a few at a
// time: a dense Arabic court page is a couple of thousand words of transcription, and one call
// for the whole document ran out of room and dropped its last pages without a word. The
// first few are read first: a drawing set is recognised there and the rest is never sent.
export const FIRST_LOOK = 4;
const PAGES_PER_READ = 4;
const MAX_PAGES = 100;
const DRAWING_SET = 'DRAWING SET';
const TRANSCRIBE = 'Transcribe all text in these pages exactly and completely, keeping Arabic and English as written, in reading order. ' +
  'Leave nothing out: every line, number, date, name, amount and table cell. Use Markdown for headings and tables. ' +
  'Note stamps, signatures and handwriting in [brackets]; write [unreadable] where you cannot read something, never a guess. ' +
  'A page that is a drawing (architectural or engineering plan, layout, section, elevation, site plan, map) is not transcribed: give it one line instead - what it shows, plus the drawing number, project, parties and date from its title block. Output only the transcription.';

/** Pages [from, to) of a PDF as a new PDF. */
export async function pdfPages(buffer, from, to) {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const idx = Array.from({ length: Math.min(to, src.getPageCount()) - from }, (_, i) => from + i);
  for (const p of await out.copyPages(src, idx)) out.addPage(p);
  return Buffer.from(await out.save());
}

const pdfBlock = (buf) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
const pageMark = (n) => `--- Page ${n} ---`;

/**
 * Pages [from, to) read by Claude, each under its own "--- Page n ---" line so an answer can
 * say which page a fact is on. A read that runs out of room is done again a page at a time;
 * a single page that still does not fit says so, rather than ending mid-sentence unnoticed.
 */
export async function readPages(buffer, from, to, total, { extra = '', read = readCall } = {}) {
  const span = to - from === 1 ? `page ${from + 1}` : `pages ${from + 1}-${to}`;
  const { text, full } = await read(await pdfPages(buffer, from, to),
    `These are ${span} of a ${total}-page document. Start each page with a line "${pageMark('n')}" using its page number (${from + 1} is the first here). ${extra}${TRANSCRIBE}`);
  if (full) return text.trim();
  if (to - from > 1) {
    const one = [];
    for (let p = from; p < to; p++) one.push(await readPages(buffer, p, p + 1, total, { read }));
    return one.join('\n\n');
  }
  return `${text.trim()}\n[The rest of page ${from + 1} could not be read: it is longer than one reading allows.]`;
}

// Streamed: a long transcription can run for minutes, past what a plain request waits for.
async function readCall(pdf, prompt) {
  const msg = await claude.messages.stream({
    model: CAREFUL_MODEL, // read once and kept as the file's text: the careful model, not the fast one
    max_tokens: 32000,
    output_config: { effort: 'low' }, // copying out what is on the page needs care, not deliberation
    messages: [{ role: 'user', content: [pdfBlock(pdf), { type: 'text', text: prompt }] }],
  }).finalMessage();
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  // Paid per page and kept as fact: the log says what each reading cost and whether it fit.
  console.log('[read pages]', msg.usage?.input_tokens, 'in,', msg.usage?.output_tokens, 'out,', msg.stop_reason);
  return { text, full: msg.stop_reason !== 'max_tokens' };
}

export async function readPdfPages(buffer, pages, { name = 'the PDF', onProgress, read } = {}) {
  if (pages > MAX_PAGES) throw new Error(`This PDF has ${pages} pages to read page by page; the limit is ${MAX_PAGES}`);
  const step = (from) => onProgress?.(pages > PAGES_PER_READ
    ? `Reading ${name}, page ${from + 1}-${Math.min(from + PAGES_PER_READ, pages)} of ${pages}…`
    : `Reading ${name}…`);
  step(0);
  const head = Math.min(FIRST_LOOK, pages);
  const more = pages > head;
  const first = await readPages(buffer, 0, head, pages, {
    read,
    extra: more ? `If these pages are all drawings, start your reply with the line "${DRAWING_SET}" and then give the one-line descriptions only. ` : '',
  });
  if (more && first.trimStart().startsWith(DRAWING_SET)) {
    return `Drawing set, ${pages} pages. First ${head} pages:\n${first.trimStart().slice(DRAWING_SET.length).trim()}`;
  }
  const parts = [first];
  for (let from = head; from < pages; from += PAGES_PER_READ) {
    step(from);
    parts.push(await readPages(buffer, from, Math.min(from + PAGES_PER_READ, pages), pages, { read }));
  }
  return parts.join('\n\n');
}

const DESCRIBE = 'Describe this image in detail for a searchable archive. Transcribe any visible text exactly.';

export async function describeImage({ buffer, mimetype }, prompt = DESCRIBE) {
  return ask(null, {
    maxTokens: 800,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: prompt },
    ],
  });
}

// ---------- video ----------
// A video is read twice over: once for what is said in it, once for what it shows. Both
// come back as plain text, so from here on it is filed, indexed and searched exactly
// like any other document - the recording itself stays on disk to be played back.
const run = promisify(execFile);

// Stills cost a Claude call each, so four spread through the clip - enough to catch the
// walk-up, the problem and the walk-away without paying for a frame a second. Never the
// very first or last moment, which on a phone recording are usually black or a blur.
export const FRAME_AT = [0.1, 0.35, 0.6, 0.85];
export const MAX_MINUTES = 60;

/** ffmpeg and ffprobe, or a message that says what to install rather than "ENOENT". */
let toolsChecked;
function ffmpegReady() {
  toolsChecked ??= Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])])
    .catch(() => { throw new Error('Reading video needs ffmpeg on the server (sudo apt install -y ffmpeg)'); });
  return toolsChecked;
}

export async function videoSeconds(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  const secs = Number(String(stdout).trim());
  return Number.isFinite(secs) && secs > 0 ? secs : 0;
}

const mmss = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

/** The sound track as a small mono mp3. null when the video is silent - a fact, not a failure. */
export async function videoAudio(path, dir) {
  const out = join(dir, 'audio.mp3');
  // 16 kHz mono at 32 kbps: speech survives it intact, and an hour still fits well
  // inside what the transcriber accepts in one go.
  try {
    await run('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', out]);
    return out;
  } catch {
    return null;
  }
}

/** Stills at FRAME_AT through the clip, as [{ at, path }]. Capped at 1280px wide to keep a frame's cost flat. */
export async function videoFrames(path, dir, secs) {
  const times = secs ? FRAME_AT.map((f) => secs * f) : [0];
  const shots = [];
  for (const [i, at] of times.entries()) {
    const out = join(dir, `frame${i}.jpg`);
    // -ss before -i seeks rather than decodes up to the mark, so a long clip is no slower than a short one
    try {
      await run('ffmpeg', ['-v', 'error', '-ss', at.toFixed(2), '-i', path, '-frames:v', '1',
        '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', '-y', out]);
      shots.push({ at, path: out });
    } catch { /* a frame that will not decode is skipped; the others still describe the clip */ }
  }
  return shots;
}

const FRAME_PROMPT = 'This is a still frame from a video. In 1-2 sentences, say what it shows for a searchable archive: '
  + 'the place, the objects, and any damage, defect or work in progress. Transcribe any visible text or numbers exactly. Do not guess at what happens off-screen. '
  + 'Reply with the description only - no heading, no preamble, no Markdown.';

/**
 * A video as text: what is said, then what is shown. Takes a path rather than a buffer
 * because ffmpeg reads from disk, and saveUpload has already put the file there.
 */
export async function readVideo(path) {
  await ffmpegReady();
  const secs = await videoSeconds(path);
  if (secs > MAX_MINUTES * 60) throw new Error(`This video is ${Math.round(secs / 60)} minutes long; the limit is ${MAX_MINUTES}`);

  const dir = mkdtempSync(join(tmpdir(), 'reem-video-'));
  try {
    const audio = await videoAudio(path, dir);
    const shots = await videoFrames(path, dir, secs);
    // The transcript and the stills are independent: ask for them at once rather than in turn.
    const [spoken, shown] = await Promise.all([
      audio ? transcribe(readFileSync(audio), 'audio/mpeg').catch((e) => { console.warn('[video] no transcript:', e.message); return ''; }) : '',
      Promise.all(shots.map((s) => describeImage({ buffer: readFileSync(s.path), mimetype: 'image/jpeg' }, FRAME_PROMPT))),
    ]);

    const parts = [`Video, ${mmss(secs)} long.`];
    if (spoken.trim()) parts.push(`What is said in it:\n${spoken.trim()}`);
    if (shown.length) parts.push(`What it shows:\n${shots.map((s, i) => `- At ${mmss(s.at)}: ${shown[i].trim()}`).join('\n')}`);
    if (parts.length === 1) throw new Error('Nothing could be read from this video');
    return parts.join('\n\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- indexing ----------
/**
 * Pieces of about `size` characters, each starting with the last `overlap` of the one
 * before it - so a sentence that falls on a cut is still whole in one of the two.
 */
export function chunk(text, size = 1500, overlap = 200) {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const out = [];
  for (let i = 0; i < clean.length;) {
    let end = Math.min(i + size, clean.length);
    const para = clean.lastIndexOf('\n', end);
    if (end < clean.length && para > i + size / 2) end = para; // prefer to break at a newline
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = end - overlap;
    const gap = clean.slice(i, end).search(/\s/);
    if (gap > 0) i += gap + 1; // start the next piece on a whole word
  }
  return out.filter(Boolean);
}

/**
 * The text chunk() was given, back from its pieces - for indexing a file again without
 * reading the file again, which for a scan or a video would be paid for twice.
 *
 * Where a piece starts with the end of the one before, the repeat is dropped. Pieces
 * stored before chunk() overlapped have no repeat: those are simply joined, with nothing
 * in between when the first is a full `size` long, since that one was cut mid-text.
 */
export function stitch(pieces, size = 1500) {
  let text = '';
  let last = '';
  for (const p of pieces) {
    if (!last) { text = last = p; continue; }
    let k = Math.min(300, p.length, last.length);
    while (k >= 20 && !last.endsWith(p.slice(0, k))) k--;
    text += k >= 20 ? p.slice(k) : (last.length >= size ? '' : '\n') + p;
    last = p;
  }
  return text;
}

// Float32Array -> pgvector literal, e.g. '[0.1,-0.2,…]'. Always passed as a bound parameter.
const toVecLiteral = (v) => (v ? `[${Array.from(v).join(',')}]` : null);

// embed() normalises, so cosine distance = 1 - similarity. EMBED_MODEL scores everything
// high: measured on Arabic and English samples, a question and an unrelated piece came to
// 0.71-0.77, a question and the piece that answers it to 0.84-0.93, in either language. So a
// match is similarity > 0.78. Two memories that say different things came to 0.94-0.96 and
// the same one said twice to 0.985: already known is similarity > 0.98.
const MAX_DIST = 0.22;
const DUPE_DIST = 0.02;

/** What indexChunks() puts in front of every piece of a document, without the brackets. */
export const chunkLabel = (doc) => [doc.title, doc.folder, doc.title !== doc.name && doc.name].filter(Boolean).join(' · ');

// Split a stored document into searchable chunks, labelled with its smart title and folder
export async function indexChunks(doc, text) {
  const label = chunkLabel(doc);
  const pieces = chunk(text).map((c) => `[${label}] ${c}`);
  const vectors = [];
  for (let i = 0; i < pieces.length; i += 32) vectors.push(...(await embed(pieces.slice(i, i + 32))));
  await tx(async () => {
    await db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
    // shared is denormalised off the document; carry it over or re-processing a shared
    // file would silently unshare its chunks while the document still reads as shared.
    const ins = db.prepare('INSERT INTO chunks (user_id, agent_id, document_id, text, shared, embedding, embed_model) VALUES (?, ?, ?, ?, ?, ?::vector, ?)');
    for (const [i, p] of pieces.entries()) {
      const lit = toVecLiteral(vectors[i]);
      await ins.run(doc.user_id, doc.agent_id, doc.id, p, !!doc.shared, lit, lit && EMBED_MODEL);
    }
  });
}

/**
 * Save a memory. If it updates something already remembered ("rent is now 60,000" after
 * "rent is 50,000"), the old one is marked replaced, not deleted: chats then read only
 * the new one, and the history tool can still say what it was before.
 *
 * `judge` decides which of the similar current memories the new one makes out of date;
 * tests pass their own so no model is called.
 */
export async function addMemory(userId, text, { judge = whichReplaced } = {}) {
  const [vec] = await embed([text]);
  const lit = toVecLiteral(vec);
  if (lit) {
    // Already known? Answered by the index, rather than by reading every memory the user has.
    // Only current memories count: a value that changes back (50,000 → 60,000 → 50,000) is news.
    const known = await db.prepare(`SELECT 1 FROM memories
      WHERE user_id = ? AND replaced_at IS NULL AND embedding IS NOT NULL AND embedding <=> ?::vector < ${DUPE_DIST} LIMIT 1`).get(userId, lit);
    if (known) return null;
  }
  const { id } = await db.prepare('INSERT INTO memories (user_id, text, embedding, embed_model) VALUES (?, ?, ?::vector, ?) RETURNING id')
    .run(userId, text, lit, lit && EMBED_MODEL);

  // Only memories close to the new one can be about the same thing, so only those are judged.
  const near = await rank('memories', { sql: 't.user_id = ? AND t.replaced_at IS NULL AND t.id <> ?', params: [userId, id] }, text, vec, 8);
  if (near.length) {
    const rows = await db.prepare(`SELECT id, text FROM memories WHERE id IN (${near.map(() => '?').join(',')})`).all(...near);
    const old = (await judge(text, rows).catch(() => [])).filter((x) => rows.some((r) => r.id === x));
    if (old.length) {
      await db.prepare(`UPDATE memories SET replaced_at = extract(epoch from now())::bigint, replaced_by = ?
        WHERE user_id = ? AND replaced_at IS NULL AND id = ANY(?::int[])`).run(id, userId, old);
      // A pinned fact that changes stays pinned: the new version is the one every chat needs.
      await db.prepare(`UPDATE memories SET pinned = true WHERE id = ? AND EXISTS
        (SELECT 1 FROM memories WHERE user_id = ? AND pinned AND id = ANY(?::int[]))`).run(id, userId, old);
    }
  }
  return id;
}

/** The ids among `rows` that `text` makes out of date: same subject, newer value. */
async function whichReplaced(text, rows) {
  const out = await ask(
    `New fact: ${text}\n\nRemembered facts:\n${rows.map((r) => `[${r.id}] ${r.text}`).join('\n')}`,
    {
      maxTokens: 100,
      system: 'You maintain the long-term memory of an assistant. A new fact has just been learned. Which remembered facts does it ' +
        'make out of date - the same subject, now with a different value or status (a new rent, a changed phone number, a ' +
        'preference that changed)? A fact that merely adds detail, or is about something else, is NOT out of date. ' +
        'Reply with ONLY a JSON array of their ids, e.g. [12], or [] for none.',
    }
  );
  const ids = JSON.parse(out.match(/\[[\s\S]*?\]/)?.[0] || '[]');
  return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
}

/**
 * Every version of the remembered facts that match `query`, oldest first within each
 * subject, with the date each was saved and replaced. For "what was it before?" questions.
 */
export async function memoryHistory(userId, query, k = 8) {
  const [qvec] = await embed([query], 'query').catch(() => []);
  const hits = await rank('memories', { sql: 't.user_id = ?', params: [userId] }, query, qvec, k);
  const chains = [];
  const seen = new Set();
  for (const hit of hits) {
    if (seen.has(hit)) continue;
    const chain = await memoryChain(userId, hit);
    chain.forEach((m) => seen.add(m.id));
    if (chain.length) chains.push(chain);
  }
  return chains;
}

/** All versions of one memory, oldest first: walks back through replaced_by and forward to the current one. */
export async function memoryChain(userId, id) {
  return db.prepare(`
    WITH RECURSIVE newest AS (
      SELECT id, replaced_by FROM memories WHERE id = ? AND user_id = ?
      UNION SELECT m.id, m.replaced_by FROM memories m JOIN newest n ON m.id = n.replaced_by
    ), top AS (SELECT id FROM newest WHERE replaced_by IS NULL),
    versions AS (
      SELECT id FROM top
      UNION SELECT m.id FROM memories m JOIN versions v ON m.replaced_by = v.id
    )
    SELECT id, text, created_at, replaced_at FROM memories
    WHERE id IN (SELECT id FROM versions) AND user_id = ? ORDER BY created_at, id`).all(id, userId, userId);
}

const fmtDay = (secs) => new Date(secs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });

const MEMORY_TOOLS = [{
  name: 'memory_history',
  description: "Look up how something you remember about the user has changed over time: every earlier version of a remembered fact, " +
    'with the date each was saved and replaced. Your <memory> holds only the current version; use this when they ask for the history, ' +
    'what something was before, or what changed.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look up, e.g. "rent of Building A"' } },
    required: ['query'],
  },
}];

/** The chat's way into earlier versions of memories. Always present: it reads only the user's own. */
export function memoryKit(userId) {
  return {
    definitions: MEMORY_TOOLS,
    status: (name) => (name === 'memory_history' ? 'Looking back through memory…' : null),
    run: async (block) => {
      try {
        const chains = await memoryHistory(userId, String(block.input?.query || ''));
        const content = chains.length
          ? chains.map((c) => c.map((m) => `- ${m.text} (saved ${fmtDay(m.created_at)}${m.replaced_at ? `, replaced ${fmtDay(m.replaced_at)}` : ', current'})`).join('\n')).join('\n\n')
          : 'Nothing remembered about that.';
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- hybrid search: meaning (embeddings) + keywords (tsvector), merged by reciprocal rank ----------
const STOP = new Set('the and for are but not you your with this that have from was what when where which who why how can will just about into than then them they there their our out has had his her its also any all some more most very what\'s'.split(' '));

// to_tsquery wants terms joined by `|` for OR. The words are already stripped to
// letters and digits by the regex, so there is nothing for it to misread.
function keywordQuery(q) {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)))];
  return words.slice(0, 12).join(' | ');
}

// scope: SQL condition on table alias t, plus its params
async function search(table, scope, query, qvec, k) {
  const ids = await rank(table, scope, query, qvec, k);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT id, text FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return ids.map((id) => rows.find((r) => r.id === id).text);
}

/** The ids of the k best rows, best first. */
async function rank(table, scope, query, qvec, k) {
  const scores = new Map();
  const add = (list) => list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (60 + rank)));

  if (qvec) {
    // The vector appears first, in the SELECT, so it takes $1 and the scope's own parameters
    // follow: `?` positions are numbered left to right. Sorting by the output alias keeps the
    // vector to a single placeholder, and the HNSW index still serves the ordering.
    const rows = await db.prepare(`SELECT t.id, t.embedding <=> ?::vector AS dist FROM ${table} t
      WHERE ${scope.sql} AND t.embedding IS NOT NULL
      ORDER BY dist LIMIT 20`).all(toVecLiteral(qvec), ...scope.params);
    add(rows.filter((r) => r.dist < MAX_DIST).map((r) => r.id));
  }
  const kw = keywordQuery(query);
  if (kw) {
    // The query is joined in rather than repeated, so it is parsed once and,
    // more importantly, uses a single placeholder: `?` positions are numbered
    // left to right, so a second one here would shift the scope's parameters.
    const rows = await db.prepare(`SELECT t.id FROM ${table} t, to_tsquery('english', ?) q
      WHERE t.tsv @@ q AND ${scope.sql}
      ORDER BY ts_rank_cd(t.tsv, q) DESC LIMIT 20`).all(kw, ...scope.params);
    add(rows.map((r) => r.id));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

/**
 * The same search recall() runs, but saying which file each piece came from - for the
 * agent's own look through the Shelf (server/shelf.js), which answers in files, not pieces.
 */
export async function findChunks(user, query, k = 20, scope = agentScope(user)) {
  const [qvec] = await embed([query], 'query');
  const ids = await rank('chunks', scope, query, qvec, k);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT id, document_id, text FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return ids.map((id) => rows.find((r) => r.id === id));
}

/**
 * The scope every retrieval uses, as a condition on table alias `t`.
 *
 * Own material has no agent filter: it all belongs to this user, and siloing it per
 * agent would stop their Lawyer agent reading an invoice they uploaded. Shared material
 * has none either: what the master shares reaches every user, whichever shelf it is
 * filed on. The shelf says where a file lives, not who may read it. And the files of
 * anyone the master let this person see (file_access - "Rona can see Said's files").
 *
 * A file in a private document category (Employee Documents: passports, visas) is the
 * exception: shared and file_access do not reach it. Any categorised file is read instead
 * by whoever holds the Document Renewals module - never an external holder, and never an
 * external person's own file. chunks carry category_id too (db.js), so this works on both.
 *
 * `t` is the alias to hang it on, for the queries that already call their table
 * something else.
 */
export function retrievalScope(userId, t = 't') {
  return {
    sql: `(${t}.user_id = ?
      OR (NOT EXISTS (SELECT 1 FROM document_categories dc WHERE dc.id = ${t}.category_id AND dc.private)
          AND (${t}.shared OR ${t}.user_id IN (SELECT owner_id FROM file_access WHERE viewer_id = ?)))
      OR (${t}.category_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM module_access ma JOIN users u ON u.id = ma.user_id
            WHERE ma.user_id = ? AND ma.module = 'document_renewals' AND NOT u.external)
          AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = ${t}.user_id AND o.external)))`,
    params: [userId, userId, userId],
  };
}

/**
 * What a private agent reads: this person's own files and nothing the master shared
 * company-wide, so a personal agent's answers never mix in the team's paperwork.
 * chat.js marks the turn's user `ownFilesOnly` when the agent answering is private.
 */
//
// user.otherCaseAgents: agents bound to a case (agents.case_key) other than the one answering.
// Their own shelf files are about their case, so they stay out of every other agent's chats.
export const agentScope = (user, t = 't') =>
  notOtherCases(user, user.ownFilesOnly ? { sql: `${t}.user_id = ?`, params: [user.id] } : retrievalScope(user.id, t), t);

export function notOtherCases(user, scope, t = 't') {
  if (!user.otherCaseAgents?.length) return scope;
  return { sql: `(${scope.sql}) AND (${t}.agent_id IS NULL OR ${t}.agent_id <> ALL(?::int[]))`, params: [...scope.params, user.otherCaseAgents] };
}

/**
 * What this app remembers about one person. Memories are facts about a person, never
 * about the company, so they are never shared and never scoped by shelf - which is
 * also why this is the one part of recall that can be used on its own, away from the
 * document shelves. `qvec` is optional: without it the ranking is keyword-only.
 */
/**
 * Pinned memories go into every chat, whatever is asked. With a thousand memories, "Hani Al
 * Jasmi Advocates are our own lawyers" was not recalled for "proceed with the email", and a
 * draft told staff to proceed against them.
 */
export const MAX_PINNED = 40;
export async function pinnedMemories(user) {
  const rows = await db.prepare(`SELECT text FROM memories WHERE user_id = ? AND replaced_at IS NULL AND pinned
    ORDER BY id LIMIT ${MAX_PINNED}`).all(user.id);
  return rows.map((r) => r.text);
}

export async function personalMemories(user, query, qvec, k = 12) {
  // Current versions only; each carries the day it was saved, so if two still disagree
  // the model can tell which is newer. Pinned ones come separately (pinnedMemories).
  const scope = { sql: 't.user_id = ? AND t.replaced_at IS NULL AND NOT t.pinned', params: [user.id] };
  const { n } = await db.prepare('SELECT COUNT(*)::int n FROM memories t WHERE ' + scope.sql).get(...scope.params);
  const ids = n <= 25 // small memory: include it all
    ? null
    : await rank('memories', scope, query, qvec, k);
  if (ids && !ids.length) return [];
  const rows = ids
    ? await db.prepare(`SELECT id, text, created_at FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : await db.prepare('SELECT id, text, created_at FROM memories t WHERE ' + scope.sql + ' ORDER BY id').all(...scope.params);
  const ordered = ids ? ids.map((id) => rows.find((r) => r.id === id)) : rows;
  return ordered.map((r) => (r.created_at ? `${r.text} (saved ${fmtDay(r.created_at)})` : r.text));
}

export async function recall(user, query) {
  const [qvec] = await embed([query], 'query');
  const memories = await personalMemories(user, query, qvec);
  const pinned = await pinnedMemories(user);
  const knowledge = await search('chunks', agentScope(user), query, qvec, 6);
  return { memories, pinned, knowledge };
}

// ---------- learning: pull lasting facts out of each exchange ----------

/**
 * Refuses anything that reads as being about a particular person, sum or document.
 *
 * The prompt already asks for general rules only, but the model is the last thing
 * deciding and a captured fact is one click from reaching everyone. "Notice period is
 * 30 days" is a rule; "Rahul is serving his notice" is somebody's business. This is a
 * blunt instrument on purpose - a rule wrongly withheld costs nothing, and the fact is
 * still in the conversation it came from.
 */
export function tooSpecificToShare(text) {
  const t = String(text || '');
  if (/(\b(AED|USD|EUR|GBP|SAR)|[$€£])\s?[\d,.]+|\b[\d,.]{3,}\s?(AED|USD|EUR|GBP|SAR|dirhams?)\b/i.test(t)) return true;
  if (/\b[A-Z]{0,2}\d[\d-]{4,}\b/.test(t)) return true; // licence, Ejari, passport, phone…
  // Two capitalised words in a row reads as a full name. Single capitals are left
  // alone, or UAE, Ejari and December would all trip it.
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t)) return true;
  return false;
}

/**
 * A fact the app noticed, filed to the shelf of the agent that answered - and switched
 * OFF. It is indexed immediately so that publishing it is instant, but `shared = false`
 * keeps it out of everyone else's retrieval until the master ticks it in the Shelf, the
 * same Private/Shared control that governs an uploaded file.
 *
 * Spec §7.4 wrote these shared straight away, with no review. That was reconsidered:
 * the deterministic guard below catches a salary but not "the new hire is on probation
 * until March", and a fact wrongly shared has already been read by the time it is seen.
 */
export async function saveFact(master, agentId, conversationId, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  const { saveNote } = await import('./files.js');
  const { doc, duplicate } = await saveNote(master.id, agentId, body);
  if (duplicate) return doc;

  await db.prepare(`UPDATE documents SET kind = 'fact', title = ?, folder = 'Other',
    summary = ?, status = 'ready', origin_conversation_id = ? WHERE id = ?`)
    .run(body.slice(0, 120), body.slice(0, 600), conversationId ?? null, doc.id);
  const filed = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  await indexChunks(filed, body); // indexed now so publishing is a single toggle
  return filed;
}

/**
 * Pull lasting facts out of a turn. Personal ones go to the user's private memory, as
 * they always have. Company ones - only from the master's own chats - are captured onto
 * the answering agent's shelf switched off, for them to publish or delete.
 */
export async function learn(user, userText, reply, { agentId = null, conversationId = null } = {}) {
  const known = (await db.prepare('SELECT text FROM memories WHERE user_id = ? AND replaced_at IS NULL ORDER BY id DESC LIMIT 60').all(user.id)).map((r) => r.text);
  // Only the master's own conversations produce company knowledge. Staff chats are
  // theirs: nothing anyone else says can turn into an item on the master's shelf.
  const collecting = isMaster(user) && agentId;

  const out = await ask(
    `Conversation turn:\nUSER: ${userText.slice(0, 4000)}\nASSISTANT: ${reply.slice(0, 2000)}\n\nAlready known:\n${known.map((k) => `- ${k}`).join('\n') || '(nothing)'}`,
    {
      maxTokens: 400,
      system: 'You maintain the long-term memory of an assistant. From the turn, extract NEW durable facts that will still be true and useful weeks from now: who the user is, their work, preferences, long-term goals, ongoing projects, important people and assets, and standing instructions. Do NOT store the current request or task itself, one-off questions, advice you gave, small talk, or facts already known. A change to something already known (a new value, a new status) IS new: state it in full as the new fact, e.g. "Building A rent is 60,000". Most turns contain nothing worth storing.'
        + (collecting
          ? ' Sort what you find into two kinds. "personal" - anything about this user themselves, their preferences, their own affairs, a named person, a specific case, a sum of money, or one particular document. "company" - standing rules, policies and processes that would be true for a colleague too, and that you would be comfortable printing in a staff handbook. When in doubt it is personal; most turns produce no company facts at all.'
            + ' Reply with ONLY JSON: {"personal": ["…"], "company": ["…"]}, using [] for either when there is nothing.'
          : ' Reply with ONLY a JSON array of short standalone sentences (e.g. ["User\'s name is Sara", "User prefers short answers"]), or [] if nothing new.'),
    }
  );

  const clean = (list) => (Array.isArray(list) ? list : []).filter((f) => typeof f === 'string' && f.length < 300);
  let personal = [];
  let company = [];
  if (collecting) {
    const d = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || '{}');
    personal = clean(d.personal);
    // The model has the last word on the split, so re-check it: a rule wrongly held
    // back costs nothing, and it is still in the conversation it came from.
    company = clean(d.company).filter((f) => !tooSpecificToShare(f));
  } else {
    personal = clean(JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]'));
  }

  for (const f of personal.slice(0, 5)) await addMemory(user.id, f);
  for (const f of company.slice(0, 3)) await saveFact(user, agentId, conversationId, f);
  return { personal, company };
}
