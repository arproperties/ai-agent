import mammoth from 'mammoth';
import { db, tx } from './db.js';
import { ask, embed } from './ai.js';

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
    const ins = db.prepare('INSERT INTO chunks (user_id, agent_id, document_id, text, embedding) VALUES (?, ?, ?, ?, ?::vector)');
    for (const [i, p] of pieces.entries()) await ins.run(doc.user_id, doc.agent_id, doc.id, p, toVecLiteral(vectors[i]));
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

export async function recall(userId, agentId, query) {
  const [qvec] = await embed([query]);
  const { n: memCount } = await db.prepare('SELECT COUNT(*)::int n FROM memories WHERE user_id = ?').get(userId);
  const memories = memCount <= 25 // small memory: include it all
    ? (await db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id').all(userId)).map((r) => r.text)
    : await search('memories', { sql: 't.user_id = ?', params: [userId] }, query, qvec, 12);
  const knowledge = await search('chunks', { sql: 't.user_id = ? AND (t.agent_id IS NULL OR t.agent_id = ?)', params: [userId, agentId] }, query, qvec, 6);
  return { memories, knowledge };
}

// ---------- learning: pull lasting facts out of each exchange ----------
export async function learn(userId, userText, reply) {
  const known = (await db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(userId)).map((r) => r.text);
  const out = await ask(
    `Conversation turn:\nUSER: ${userText.slice(0, 4000)}\nASSISTANT: ${reply.slice(0, 2000)}\n\nAlready known:\n${known.map((k) => `- ${k}`).join('\n') || '(nothing)'}`,
    {
      maxTokens: 400,
      system: 'You maintain the long-term memory of an assistant. From the turn, extract NEW durable facts that will still be true and useful weeks from now: who the user is, their work, preferences, long-term goals, ongoing projects, important people and assets, and standing instructions. Do NOT store the current request or task itself, one-off questions, advice you gave, small talk, or facts already known. Most turns contain nothing worth storing. Reply with ONLY a JSON array of short standalone sentences (e.g. ["User\'s name is Sara", "User prefers short answers"]), or [] if nothing new.',
    }
  );
  const facts = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]').filter((f) => typeof f === 'string' && f.length < 300);
  for (const f of facts.slice(0, 5)) await addMemory(userId, f);
  return facts;
}
