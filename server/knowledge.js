import mammoth from 'mammoth';
import { db, tx } from './db.js';
import { ask, embed } from './ai.js';
import { shelfIds, isMaster } from './access.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
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

async function readScannedPdf(buffer, pages) {
  if (pages > 100) throw new Error(`This scanned PDF has ${pages} pages; the limit for scanned documents is 100`);
  return ask(null, {
    maxTokens: 16000,
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'Transcribe all text in this scanned document exactly, page by page, keeping Arabic and English as written. Use Markdown for headings and tables. Note stamps, signatures and handwriting in [brackets]. Output only the transcription.' },
    ],
  });
}

export async function describeImage({ buffer, mimetype }) {
  return ask(null, {
    maxTokens: 800,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: 'Describe this image in detail for a searchable archive. Transcribe any visible text exactly.' },
    ],
  });
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
