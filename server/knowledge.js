import mammoth from 'mammoth';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, tx } from './db.js';
import { ask, embed, transcribe } from './ai.js';
import { shelfIds, isMaster } from './access.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp'];
export const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', '3gp'];
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log', 'js', 'ts', 'py', 'sql', 'tsv'];

// ---------- extraction ----------
export async function extractText({ buffer, mimetype, originalname }) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: true });
    // Scanned PDFs are just page images with little or no text layer: let Claude read the pages instead
    if (text.replace(/\s+/g, '').length < 40 * pdf.numPages) return readScannedPdf(buffer, pdf.numPages);
    return text;
  }
  if (ext === 'docx') return (await mammoth.extractRawText({ buffer })).value;
  if (mimetype.startsWith('text/') || TEXT_EXT.includes(ext)) return buffer.toString('utf8');
  throw new Error(`Unsupported file type: ${originalname}`);
}

// Every scanned page is sent to Claude as a picture, so pages are what cost. The first few
// are read on their own: a drawing set is recognised there and the rest is never sent.
export const FIRST_LOOK = 4;
const DRAWING_SET = 'DRAWING SET';
const TRANSCRIBE = 'Transcribe all text in these scanned pages exactly, page by page, keeping Arabic and English as written. Use Markdown for headings and tables. Note stamps, signatures and handwriting in [brackets]. ' +
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

async function readScannedPdf(buffer, pages) {
  if (pages > 100) throw new Error(`This scanned PDF has ${pages} pages; the limit for scanned documents is 100`);
  const more = pages > FIRST_LOOK;
  const head = more ? await pdfPages(buffer, 0, FIRST_LOOK) : buffer;
  const first = await ask(null, {
    maxTokens: 8000,
    content: [pdfBlock(head), {
      type: 'text',
      text: more
        ? `These are the first ${FIRST_LOOK} of ${pages} pages. If they are all drawings, start your reply with the line "${DRAWING_SET}" and then give the one-line descriptions only. ${TRANSCRIBE}`
        : TRANSCRIBE,
    }],
  });
  if (!more) return first;
  if (first.trimStart().startsWith(DRAWING_SET)) {
    return `Drawing set, ${pages} pages. First ${FIRST_LOOK} pages:\n${first.trimStart().slice(DRAWING_SET.length).trim()}`;
  }
  const rest = await ask(null, {
    maxTokens: 16000,
    content: [pdfBlock(await pdfPages(buffer, FIRST_LOOK, pages)), { type: 'text', text: `These are pages ${FIRST_LOOK + 1}-${pages} of the document. ${TRANSCRIBE}` }],
  });
  return `${first}\n\n${rest}`;
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

  const dir = mkdtempSync(join(tmpdir(), 'jarvis-video-'));
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
function chunk(text, size = 1500, overlap = 200) {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    let end = Math.min(i + size, clean.length);
    const para = clean.lastIndexOf('\n', end);
    if (end < clean.length && para > i + size / 2) end = para; // prefer to break at a newline
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = end - (size - overlap);
  }
  return out.filter(Boolean);
}

// Float32Array -> pgvector literal, e.g. '[0.1,-0.2,…]'. Always passed as a bound parameter.
const toVecLiteral = (v) => (v ? `[${Array.from(v).join(',')}]` : null);

// embed() normalises, so cosine distance = 1 - similarity. These are the old JS thresholds:
// a match was similarity > 0.25, and a memory was already known at similarity > 0.9.
const MAX_DIST = 0.75;
const DUPE_DIST = 0.1;

// Split a stored document into searchable chunks, labelled with its smart title and folder
export async function indexChunks(doc, text) {
  const label = [doc.title, doc.folder, doc.title !== doc.name && doc.name].filter(Boolean).join(' · ');
  const pieces = chunk(text).map((c) => `[${label}] ${c}`);
  const vectors = [];
  for (let i = 0; i < pieces.length; i += 32) vectors.push(...(await embed(pieces.slice(i, i + 32))));
  await tx(async () => {
    await db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
    // shared is denormalised off the document; carry it over or re-processing a shared
    // file would silently unshare its chunks while the document still reads as shared.
    const ins = db.prepare('INSERT INTO chunks (user_id, agent_id, document_id, text, shared, embedding) VALUES (?, ?, ?, ?, ?, ?::vector)');
    for (const [i, p] of pieces.entries()) await ins.run(doc.user_id, doc.agent_id, doc.id, p, !!doc.shared, toVecLiteral(vectors[i]));
  });
}

export async function addMemory(userId, text) {
  const [vec] = await embed([text]);
  const lit = toVecLiteral(vec);
  if (lit) {
    // Already known? Answered by the index, rather than by reading every memory the user has.
    const known = await db.prepare(`SELECT 1 FROM memories
      WHERE user_id = ? AND embedding IS NOT NULL AND embedding <=> ?::vector < ${DUPE_DIST} LIMIT 1`).get(userId, lit);
    if (known) return null;
  }
  const { id } = await db.prepare('INSERT INTO memories (user_id, text, embedding) VALUES (?, ?, ?::vector) RETURNING id').run(userId, text, lit);
  return id;
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
  const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT id, text FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return ids.map((id) => rows.find((r) => r.id === id).text);
}

/**
 * The scope every retrieval uses, as a condition on table alias `t`.
 *
 * Own material has no agent filter: it all belongs to this user, and siloing it per
 * agent would stop their Lawyer agent reading an invoice they uploaded. Shared material
 * keeps the agent filter - that one is a real boundary between roles.
 *
 * An empty shelf list is fine: `= ANY('{}'::int[])` is simply false.
 */
export function retrievalScope(userId, shelves) {
  return {
    sql: '(t.user_id = ? OR (t.shared AND (t.agent_id IS NULL OR t.agent_id = ANY(?::int[]))))',
    params: [userId, shelves],
  };
}

export async function recall(user, query) {
  const [qvec] = await embed([query]);
  const { n: memCount } = await db.prepare('SELECT COUNT(*)::int n FROM memories WHERE user_id = ?').get(user.id);
  // Memories are facts about a person, never about the company, so they are never
  // shared and never scoped by shelf.
  const memories = memCount <= 25 // small memory: include it all
    ? (await db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id').all(user.id)).map((r) => r.text)
    : await search('memories', { sql: 't.user_id = ?', params: [user.id] }, query, qvec, 12);
  const knowledge = await search('chunks', retrievalScope(user.id, await shelfIds(user)), query, qvec, 6);
  return { memories, knowledge };
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
  const known = (await db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(user.id)).map((r) => r.text);
  // Only the master's own conversations produce company knowledge. Staff chats are
  // theirs: nothing anyone else says can turn into an item on the master's shelf.
  const collecting = isMaster(user) && agentId;

  const out = await ask(
    `Conversation turn:\nUSER: ${userText.slice(0, 4000)}\nASSISTANT: ${reply.slice(0, 2000)}\n\nAlready known:\n${known.map((k) => `- ${k}`).join('\n') || '(nothing)'}`,
    {
      maxTokens: 400,
      system: 'You maintain the long-term memory of an assistant. From the turn, extract NEW durable facts that will still be true and useful weeks from now: who the user is, their work, preferences, long-term goals, ongoing projects, important people and assets, and standing instructions. Do NOT store the current request or task itself, one-off questions, advice you gave, small talk, or facts already known. Most turns contain nothing worth storing.'
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
