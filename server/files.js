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
export async function saveUpload(userId, agentId, f, conversationId = null, kind = null) {
  const hash = createHash('sha256').update(f.buffer).digest('hex');
  // Keyed on the bytes alone, not the shelf: the shelf is usually chosen by the
  // classifier after this point, so including it would let the same file land twice
  // whenever the classifier changed its mind. One copy per person, wherever it is filed.
  const existing = await db.prepare('SELECT * FROM documents WHERE user_id = ? AND hash = ?').get(userId, hash);
  if (existing) return { doc: existing, duplicate: true };

  const name = fileName(f);
  const { id } = await db.prepare(`INSERT INTO documents (user_id, agent_id, conversation_id, name, title, kind, size, mime, hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing') RETURNING id`)
    .run(userId, agentId, conversationId, name, name, kind ?? (isImage(f) ? 'image' : 'doc'), f.size, f.mimetype, hash);
  mkdirSync(`${UPLOAD_DIR}/${userId}`, { recursive: true });
  const path = `${UPLOAD_DIR}/${userId}/${id}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  writeFileSync(path, f.buffer);
  await db.prepare('UPDATE documents SET path = ? WHERE id = ?').run(path, id);
  return { doc: await db.prepare('SELECT * FROM documents WHERE id = ?').get(id), duplicate: false };
}

/**
 * A working filename for a note, from its opening words. Only ever a placeholder: the
 * classifier titles it properly a moment later, the same as it does for an upload.
 */
export function noteName(text) {
  const first = String(text || '').split('\n').find((l) => l.trim()) || '';
  const words = first.replace(/[^\p{L}\p{N} ,.'-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return `${words.slice(0, 60).replace(/[.\s]+$/, '') || `Note ${new Date().toISOString().slice(0, 10)}`}.txt`;
}

/**
 * A note is an upload we synthesise: the same bytes-on-disk, dedup, classification and
 * indexing path as a file, so it can be opened, downloaded and searched like one. The
 * only thing that differs is where it came from, which `kind` records.
 */
export async function saveNote(userId, agentId, text) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('The note is empty'), { status: 400 });
  const buffer = Buffer.from(body, 'utf8');
  const f = { buffer, originalname: noteName(body), mimetype: 'text/plain', size: buffer.length };
  return saveUpload(userId, agentId, f, null, 'note');
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

// Which company a document is "for". The side it concerns, not whoever issued it: an
// invoice belongs to the company billed, not the supplier. Shared by classify() and
// findCompany() so an upload and the backfill judge it the same way.
const COMPANY_RULE = `the company this document is for - the business it concerns: the one billed, the licence or trade-name holder, the employer, the company tenant or buyer. Not a company that merely issued, sent or serviced it (a supplier, a bank, a developer, a government authority), unless the document is about that company itself. It must be an organisation: a private person - an owner, client, landlord, employee - is never the company, even when the document is for them, so use null for them. A bare personal name with no business form or word in it (LLC, L.L.C, Ltd, FZE, FZCO, Est., Group, Trading, Properties, Contracting, Consultants...) is a person, however it is capitalised. Write the name as the document does. null if it names only individuals or no company`;

const knownCompanies = (companies) => (companies.length ? `
Companies already on file - when it is one of these, reply with that exact spelling:
${companies.map((c) => `- ${c}`).join('\n')}` : '');

// "AIN AL REEM PROPERTIES L.L.C" and "Ain Al Reem Properties LLC" are one company.
const companyKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  .replace(/(llc|fzllc|fze|fzco|fzc|ltd|limited|inc|sarl|plc|co|company|est|establishment)$/u, '');

/**
 * The company the model named, cleaned up. Refusals come back as null (the Shelf's
 * "Other"), and a name matching one already on file takes that spelling, so one
 * company does not split into several groups over punctuation or capitals.
 */
export function pickCompany(raw, companies = []) {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!name || /^(null|none|n\/?a|unknown|other|-)$/i.test(name)) return null;
  const key = companyKey(name);
  if (!key) return null;
  return companies.find((c) => companyKey(c) === key) ?? name;
}

export async function userCompanies(userId) {
  const rows = await db.prepare(`SELECT company FROM documents WHERE user_id = ? AND company IS NOT NULL
    GROUP BY company ORDER BY COUNT(*) DESC LIMIT 50`).all(userId);
  return rows.map((r) => r.company);
}

/** Just the company, for files filed before companies were recorded. */
export async function findCompany(name, text, companies = []) {
  const out = await ask(`File name: ${name}\n\nContent (start):\n${text.slice(0, 6000)}`, {
    maxTokens: 100,
    system: `Reply with ONLY JSON: {"company": "<${COMPANY_RULE}>"}${knownCompanies(companies)}`,
  });
  return pickCompany(JSON.parse(out.match(/\{[\s\S]*\}/)[0]).company, companies);
}

async function classify(name, text, agents = [], companies = []) {
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
 "company": "<${COMPANY_RULE}>",
 "date": "<the document's own date as YYYY-MM-DD, or null>"${roster}}
Photos of people, places or things with no document content go in "Photos". UAE documents write dates as DD/MM/YYYY.${knownCompanies(companies)}${team}`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  return {
    title: String(d.title || name).slice(0, 120),
    folder: FOLDERS.includes(d.folder) ? d.folder : 'Other',
    summary: String(d.summary || '').slice(0, 600),
    tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).toLowerCase().slice(0, 30)).slice(0, 5),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
    company: pickCompany(d.company, companies),
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
    // Some PDFs carry NUL characters in their text layer, which Postgres refuses to store.
    const content = (text ?? (isImage(f) ? await describeImage(f) : await extractText({ ...f, originalname: doc.name })))?.replace(/\u0000/g, '');
    if (!content?.trim()) throw new Error('No readable text found');
    const c = await classify(doc.name, content, doc.agent_id ? [] : agents, await userCompanies(doc.user_id));
    await db.prepare('UPDATE documents SET title = ?, folder = ?, summary = ?, tags = ?, doc_date = ?, company = ?, agent_id = COALESCE(agent_id, ?) WHERE id = ?')
      .run(c.title, c.folder, c.summary, JSON.stringify(c.tags), c.date, c.company, c.agentId, doc.id);
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

/**
 * setShared for a whole company or folder at once. Same rules: master only, and only
 * ids that are the master's own - anything else in the list is skipped, not an error,
 * so one stale id cannot sink the rest. Returns how many files changed.
 */
export async function setSharedMany(user, docIds, shared) {
  if (!isMaster(user)) throw Object.assign(new Error('Not allowed'), { status: 403 });
  const ids = [...new Set((Array.isArray(docIds) ? docIds : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;

  const on = !!shared;
  return tx(async () => {
    const rows = await db.prepare('UPDATE documents SET shared = ? WHERE user_id = ? AND id = ANY(?::int[]) AND shared <> ? RETURNING id')
      .all(on, user.id, ids, on);
    if (rows.length) await db.prepare('UPDATE chunks SET shared = ? WHERE document_id = ANY(?::int[])').run(on, rows.map((r) => r.id));
    return rows.length;
  });
}

// Compact catalogue of the files this user can see, so agents can answer
// "what files do I have?" or "find my lease". Same scope as recall().
export async function libraryCatalog(user) {
  const scope = retrievalScope(user.id, await shelfIds(user));
  const rows = await db.prepare(`SELECT title, folder, name, doc_date FROM documents t
    WHERE ${scope.sql} AND status = 'ready' ORDER BY id DESC LIMIT 40`).all(...scope.params);
  return rows.map((d) => `- ${d.title} (${d.folder}${d.doc_date ? `, ${d.doc_date}` : ''}; file: ${d.name})`);
}
