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

const toBlob = (v) => (v ? new Uint8Array(v.buffer) : null);
const toVec = (b) => (b ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : null);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Split a stored document into searchable chunks, labelled with its smart title and folder
export async function indexChunks(doc, text) {
  const label = [doc.title, doc.folder, doc.title !== doc.name && doc.name].filter(Boolean).join(' · ');
  const pieces = chunk(text).map((c) => `[${label}] ${c}`);
  const vectors = [];
  for (let i = 0; i < pieces.length; i += 32) vectors.push(...(await embed(pieces.slice(i, i + 32))));
  tx(() => {
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
    const ins = db.prepare('INSERT INTO chunks (user_id, agent_id, document_id, text, embedding) VALUES (?, ?, ?, ?, ?)');
    pieces.forEach((p, i) => ins.run(doc.user_id, doc.agent_id, doc.id, p, toBlob(vectors[i])));
  });
}

export async function addMemory(userId, text) {
  const [vec] = await embed([text]);
  if (vec) {
    const rows = db.prepare('SELECT embedding FROM memories WHERE user_id = ?').all(userId);
    if (rows.some((r) => r.embedding && dot(vec, toVec(r.embedding)) > 0.9)) return null; // already known
  }
  return Number(db.prepare('INSERT INTO memories (user_id, text, embedding) VALUES (?, ?, ?)').run(userId, text, toBlob(vec)).lastInsertRowid);
}

// ---------- hybrid search: meaning (embeddings) + keywords (FTS5), merged by reciprocal rank ----------
const STOP = new Set('the and for are but not you your with this that have from was what when where which who why how can will just about into than then them they there their our out has had his her its also any all some more most very what\'s'.split(' '));

function keywordQuery(q) {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)))];
  return words.slice(0, 12).map((w) => `"${w}"`).join(' OR ');
}

// scope: SQL condition on table alias t, plus its params
function search(table, scope, query, qvec, k) {
  const scores = new Map();
  const add = (list) => list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (60 + rank)));

  if (qvec) {
    const rows = db.prepare(`SELECT t.id, t.embedding FROM ${table} t WHERE ${scope.sql} AND t.embedding IS NOT NULL`).all(...scope.params);
    add(rows.map((r) => ({ id: r.id, s: dot(qvec, toVec(r.embedding)) }))
      .filter((r) => r.s > 0.25).sort((a, b) => b.s - a.s).slice(0, 20).map((r) => r.id));
  }
  const kw = keywordQuery(query);
  if (kw) {
    add(db.prepare(`SELECT t.id FROM ${table}_fts f JOIN ${table} t ON t.id = f.rowid
      WHERE ${table}_fts MATCH ? AND ${scope.sql} ORDER BY bm25(${table}_fts) LIMIT 20`).all(kw, ...scope.params).map((r) => r.id));
  }
  const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, text FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return ids.map((id) => rows.find((r) => r.id === id).text);
}

export async function recall(userId, agentId, query) {
  const [qvec] = await embed([query]);
  const memCount = db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id = ?').get(userId).n;
  const memories = memCount <= 25 // small memory: include it all
    ? db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id').all(userId).map((r) => r.text)
    : search('memories', { sql: 't.user_id = ?', params: [userId] }, query, qvec, 12);
  const knowledge = search('chunks', { sql: 't.user_id = ? AND (t.agent_id IS NULL OR t.agent_id = ?)', params: [userId, agentId] }, query, qvec, 6);
  return { memories, knowledge };
}

// ---------- learning: pull lasting facts out of each exchange ----------
export async function learn(userId, userText, reply) {
  const known = db.prepare('SELECT text FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(userId).map((r) => r.text);
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
