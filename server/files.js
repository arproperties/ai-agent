import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { db, tx } from './db.js';
import { ask } from './ai.js';
import { DATA_DIR, FOLDERS } from './config.js';
import { IMAGE_TYPES, extractText, describeImage, indexChunks, retrievalScope } from './knowledge.js';
import { shelfIds, isMaster } from './access.js';

const UPLOAD_DIR = `${DATA_DIR}/uploads`;

export const fileName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer gives latin1
export const isImage = (f) => IMAGE_TYPES.includes(f.mimetype);

/**
 * Store an upload. Returns { doc, duplicate }. A file the user already has (same bytes) is not stored twice.
 * agentId null = shared library.
 */
export async function saveUpload(userId, agentId, f, conversationId = null) {
  const hash = createHash('sha256').update(f.buffer).digest('hex');
  // Keyed on the bytes alone, not the shelf: the shelf is usually chosen by the
  // classifier after this point, so including it would let the same file land twice
  // whenever the classifier changed its mind. One copy per person, wherever it is filed.
  const existing = await db.prepare('SELECT * FROM documents WHERE user_id = ? AND hash = ?').get(userId, hash);
  if (existing) return { doc: existing, duplicate: true };

  const name = fileName(f);
  const { id } = await db.prepare(`INSERT INTO documents (user_id, agent_id, conversation_id, name, title, kind, size, mime, hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing') RETURNING id`)
    .run(userId, agentId, conversationId, name, name, isImage(f) ? 'image' : 'doc', f.size, f.mimetype, hash);
  mkdirSync(`${UPLOAD_DIR}/${userId}`, { recursive: true });
  const path = `${UPLOAD_DIR}/${userId}/${id}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  writeFileSync(path, f.buffer);
  await db.prepare('UPDATE documents SET path = ? WHERE id = ?').run(path, id);
  return { doc: await db.prepare('SELECT * FROM documents WHERE id = ?').get(id), duplicate: false };
}

/**
 * The shelf the classifier asked for, but only if it is one actually on offer.
 * Anything else - an id it invented, a refusal, a missing field - means the library,
 * which already means "all of this user's agents" rather than being an error case.
 */
export function pickShelf(raw, agents) {
  const id = Number(raw);
  return agents.some((a) => a.id === id) ? id : null;
}

async function classify(name, text, agents = []) {
  // The roster rides along in the prompt that was already being sent: same call, same
  // cost. The wording about type and purpose is router.js's, which makes the same
  // judgement about attachments and should not drift from this one.
  const roster = agents.length ? `
 "agent": <one of the id numbers below, or null if none clearly fits>` : '';
  const team = agents.length ? `

The user's agents, to file this against:
${agents.map((a) => `- id=${a.id} · ${a.name}: ${(a.persona || '').slice(0, 200).replace(/\s+/g, ' ')}`).join('\n')}
Judge the file by its type and purpose, not by words that merely appear in it (an offer letter for an accountant job is an HR matter; a tenancy contract is a property matter). Use null when nothing clearly fits - that is the normal answer for personal paperwork.` : '';

  const out = await ask(`File name: ${name}\n\nContent (start):\n${text.slice(0, 6000)}`, {
    maxTokens: 400,
    system: `You file documents for a UAE-based user. Reply with ONLY JSON:
{"title": "<clear human title, max 8 words, e.g. \\"Tenancy contract – Marina Heights 1402\\">",
 "folder": "<exactly one of: ${FOLDERS.join(' | ')}>",
 "summary": "<1-2 sentences with the key facts: parties, amounts (AED), dates, deadlines>",
 "tags": ["<up to 5 short lowercase tags>"],
 "date": "<the document's own date as YYYY-MM-DD, or null>"${roster}}
Photos of people, places or things with no document content go in "Photos". UAE documents write dates as DD/MM/YYYY.${team}`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  return {
    title: String(d.title || name).slice(0, 120),
    folder: FOLDERS.includes(d.folder) ? d.folder : 'Other',
    summary: String(d.summary || '').slice(0, 600),
    tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).toLowerCase().slice(0, 30)).slice(0, 5),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
    agentId: pickShelf(d.agent, agents),
  };
}

/**
 * Read → classify → index for search. Safe to run in the background. Pass `text` if
 * already extracted, and `agents` to let the classifier file it against one of them.
 *
 * A file uploaded into a particular agent's shelf keeps that shelf: an explicit choice
 * outranks a guess. The classifier only decides for files that arrived without one.
 */
export async function processDocument(doc, f, text, agents = []) {
  try {
    const content = text ?? (isImage(f) ? await describeImage(f) : await extractText({ ...f, originalname: doc.name }));
    if (!content?.trim()) throw new Error('No readable text found');
    const c = await classify(doc.name, content, doc.agent_id ? [] : agents);
    await db.prepare('UPDATE documents SET title = ?, folder = ?, summary = ?, tags = ?, doc_date = ?, agent_id = COALESCE(agent_id, ?) WHERE id = ?')
      .run(c.title, c.folder, c.summary, JSON.stringify(c.tags), c.date, c.agentId, doc.id);
    // Re-read rather than spreading over the copy we were handed: `doc` predates the
    // UPDATE, and chunks carry agent_id and shared of their own. Indexing from a stale
    // copy would file the chunks on the shelf the document just left, leaving the file
    // listed under one agent and retrievable by another.
    const filed = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
    await indexChunks(filed, content);
    await db.prepare("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?").run(doc.id);
  } catch (e) {
    console.error('[files]', doc.name, e.message);
    await db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(e.message, doc.id);
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

export async function deleteDocument(userId, id) {
  const doc = await db.prepare('SELECT path FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
  if (!doc) return false;
  await db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  if (doc.path && existsSync(doc.path)) unlinkSync(doc.path);
  return true;
}

/**
 * Publish a file to its shelf, or take it back. Master only: a user's own uploads are
 * always private, so the flag is simply not theirs to set.
 *
 * chunks.shared is denormalised off documents.shared - recall() filters chunks without
 * joining documents - so the two move together or retrieval disagrees with the screen.
 *
 * How wide "shared" reaches depends on where the file is filed: on a shelf it reaches
 * the people assigned that shelf, in the library (agent_id NULL) it reaches everyone.
 * See retrievalScope(); the UI says which.
 */
export async function setShared(user, docId, shared) {
  if (!isMaster(user)) throw Object.assign(new Error('Not allowed'), { status: 403 });
  const id = Number(docId);
  const doc = await db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!doc) throw Object.assign(new Error('Not found'), { status: 404 });

  const on = !!shared;
  await tx(async () => {
    await db.prepare('UPDATE documents SET shared = ? WHERE id = ?').run(on, id);
    await db.prepare('UPDATE chunks SET shared = ? WHERE document_id = ?').run(on, id);
  });
  return on;
}

// Compact catalogue of the files this user can see, so agents can answer
// "what files do I have?" or "find my lease". Same scope as recall().
export async function libraryCatalog(user) {
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT title, folder, name, doc_date FROM documents t
    WHERE ${scope.sql} AND status = 'ready' ORDER BY id DESC LIMIT 40`).all(...scope.params);
  return rows.map((d) => `- ${d.title} (${d.folder}${d.doc_date ? `, ${d.doc_date}` : ''}; file: ${d.name})`);
}
