import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { db } from './db.js';
import { ask } from './ai.js';
import { DATA_DIR, FOLDERS } from './config.js';
import { IMAGE_TYPES, extractText, describeImage, indexChunks } from './knowledge.js';

const UPLOAD_DIR = `${DATA_DIR}/uploads`;

export const fileName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer gives latin1
export const isImage = (f) => IMAGE_TYPES.includes(f.mimetype);

/**
 * Store an upload. Returns { doc, duplicate }. A file the user already has (same bytes) is not stored twice.
 * agentId null = shared library.
 */
export function saveUpload(userId, agentId, f, conversationId = null) {
  const hash = createHash('sha256').update(f.buffer).digest('hex');
  const existing = db.prepare('SELECT * FROM documents WHERE user_id = ? AND hash = ? AND agent_id IS ?').get(userId, hash, agentId);
  if (existing) return { doc: existing, duplicate: true };

  const name = fileName(f);
  const { lastInsertRowid } = db.prepare(`INSERT INTO documents (user_id, agent_id, conversation_id, name, title, kind, size, mime, hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`).run(userId, agentId, conversationId, name, name, isImage(f) ? 'image' : 'doc', f.size, f.mimetype, hash);
  const id = Number(lastInsertRowid);
  mkdirSync(`${UPLOAD_DIR}/${userId}`, { recursive: true });
  const path = `${UPLOAD_DIR}/${userId}/${id}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  writeFileSync(path, f.buffer);
  db.prepare('UPDATE documents SET path = ? WHERE id = ?').run(path, id);
  return { doc: db.prepare('SELECT * FROM documents WHERE id = ?').get(id), duplicate: false };
}

async function classify(name, text) {
  const out = await ask(`File name: ${name}\n\nContent (start):\n${text.slice(0, 6000)}`, {
    maxTokens: 400,
    system: `You file documents for a UAE-based user. Reply with ONLY JSON:
{"title": "<clear human title, max 8 words, e.g. \\"Tenancy contract – Marina Heights 1402\\">",
 "folder": "<exactly one of: ${FOLDERS.join(' | ')}>",
 "summary": "<1-2 sentences with the key facts: parties, amounts (AED), dates, deadlines>",
 "tags": ["<up to 5 short lowercase tags>"],
 "date": "<the document's own date as YYYY-MM-DD, or null>"}
Photos of people, places or things with no document content go in "Photos". UAE documents write dates as DD/MM/YYYY.`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  return {
    title: String(d.title || name).slice(0, 120),
    folder: FOLDERS.includes(d.folder) ? d.folder : 'Other',
    summary: String(d.summary || '').slice(0, 600),
    tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).toLowerCase().slice(0, 30)).slice(0, 5),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
  };
}

/** Read → classify → index for search. Safe to run in the background. Pass `text` if already extracted. */
export async function processDocument(doc, f, text) {
  try {
    const content = text ?? (isImage(f) ? await describeImage(f) : await extractText({ ...f, originalname: doc.name }));
    if (!content?.trim()) throw new Error('No readable text found');
    const c = await classify(doc.name, content);
    db.prepare('UPDATE documents SET title = ?, folder = ?, summary = ?, tags = ?, doc_date = ? WHERE id = ?')
      .run(c.title, c.folder, c.summary, JSON.stringify(c.tags), c.date, doc.id);
    await indexChunks({ ...doc, title: c.title, folder: c.folder }, content);
    db.prepare("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?").run(doc.id);
  } catch (e) {
    console.error('[files]', doc.name, e.message);
    db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(e.message, doc.id);
  }
}

// Types that are safe to show inside the app. Anything else (HTML, SVG, …) is only ever downloaded,
// because rendering it on our origin could run scripts.
const SAFE_INLINE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
export function inlineType(doc) {
  if (SAFE_INLINE.includes(doc.mime)) return doc.mime;
  if (doc.mime?.startsWith('text/') || /\.(txt|md|csv|json|log|tsv|yaml|yml|xml)$/i.test(doc.name)) return 'text/plain; charset=utf-8';
  return null;
}

// Word documents → simple HTML for the in-app viewer
export async function docxPreview(doc) {
  const { value } = await mammoth.convertToHtml({ path: doc.path });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;color:#1d1b2e;max-width:760px;margin:0 auto;padding:28px 22px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px}img{max-width:100%}h1,h2,h3{line-height:1.3}</style>${value}`;
}

export function deleteDocument(userId, id) {
  const doc = db.prepare('SELECT path FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
  if (!doc) return false;
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  if (doc.path && existsSync(doc.path)) unlinkSync(doc.path);
  return true;
}

// Compact catalogue of the user's files, so agents can answer "what files do I have?" or "find my lease"
export function libraryCatalog(userId, agentId) {
  return db.prepare(`SELECT title, folder, name, doc_date FROM documents
    WHERE user_id = ? AND (agent_id IS NULL OR agent_id = ?) AND status = 'ready' ORDER BY id DESC LIMIT 40`).all(userId, agentId)
    .map((d) => `- ${d.title} (${d.folder}${d.doc_date ? `, ${d.doc_date}` : ''}; file: ${d.name})`);
}
