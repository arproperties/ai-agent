import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { db, tx } from './db.js';
import { ask } from './ai.js';
import { billAs } from './billing.js';
import { DATA_DIR, FOLDERS } from './config.js';
import { IMAGE_TYPES, VIDEO_TYPES, VIDEO_EXT, extractText, describeImage, readVideo, indexChunks, retrievalScope, agentScope } from './knowledge.js';
import { isMaster, isExternal, masterReach } from './access.js';
import { listCategories, typeById } from './docCategories.js';
import { lookupCode } from './hrLinks.js';
import { userModules } from './modules.js';
import { askSaifsys } from './saifsys/client.js';
import { keepText } from './copies.js';

const UPLOAD_DIR = `${DATA_DIR}/uploads`;

export const fileName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer gives latin1
export const isImage = (f) => IMAGE_TYPES.includes(f.mimetype);
// Browsers are inconsistent about video types (a .mov can arrive as video/quicktime, as
// application/octet-stream, or as nothing at all), so the extension gets a say too.
export const isVideo = (f) => VIDEO_TYPES.includes(f.mimetype)
  || VIDEO_EXT.includes(String(f.originalname || '').split('.').pop().toLowerCase());

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
    .run(userId, agentId, conversationId, name, name, kind ?? (isImage(f) ? 'image' : isVideo(f) ? 'video' : 'doc'), f.size, f.mimetype, hash);
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

// What counts as an expiry, in one place: the classifier asks it of every new file and
// findExpiry asks the same of the files that were filed before the question existed.
const EXPIRY_RULE = `the date this document stops being valid, as YYYY-MM-DD, or null`;
const EXPIRY_GUIDE = `An expiry belongs only to paper that genuinely runs out: a trade licence or establishment card, a residence visa, an Emirates ID, a passport, a tenancy contract (its end date), an insurance policy, a warranty, a fixed-term employment contract, a vehicle registration (mulkiya). An invoice due date, a payment date, a meeting date or the date something was signed is NOT an expiry - answer null. Null is the ordinary answer.`;

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

/** Just the expiry, for files filed before expiries were recorded. */
export async function findExpiry(name, text) {
  const out = await ask(`File name: ${name}\n\nContent (start):\n${text.slice(0, 6000)}`, {
    maxTokens: 60,
    system: `Reply with ONLY JSON: {"expires": "<${EXPIRY_RULE}>"}
${EXPIRY_GUIDE} UAE documents write dates as DD/MM/YYYY.`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  return /^\d{4}-\d{2}-\d{2}$/.test(d.expires) ? d.expires : null;
}

// ---------- Document Renewals: the kind of document, and who it is for ----------

// saifsys's current staff, for "whose visa is this?". Kept an hour: it changes when
// someone joins or leaves, not between two uploads. Per lookup function, so a test's
// fake never shares the real one's copy. A failure is not kept: the next upload asks again.
const ROSTER_TTL = 60 * 60 * 1000;
const rosters = new WeakMap();
async function employeeRoster(lookup) {
  const hit = rosters.get(lookup);
  if (hit && Date.now() - hit.at < ROSTER_TTL) return hit.list;
  const body = await lookup('hr', 'employees', { status: 'current' });
  const list = (body.employees || []).filter((e) => e.code)
    .map((e) => ({ code: String(e.code), name: String(e.name || ''), nickname: String(e.nickname || '') }));
  rosters.set(lookup, { at: Date.now(), list });
  return list;
}

/**
 * What the classifier may file this person's upload as: the active document types, and
 * - only for the master and Document Renewals holders - saifsys's staff list, so a visa
 * can be tied to its employee. Anyone else's prompt carries no colleague's name. An
 * external person files nothing into a category. saifsys being down costs only the roster.
 */
export async function filingKinds(user, lookup = askSaifsys) {
  if (isExternal(user)) return { types: [], roster: null };
  const types = (await listCategories()).flatMap((c) => c.types.map((t) => ({ id: t.id, label: t.label, category: c })));
  let roster = null;
  if (types.some((t) => t.category.links_to === 'employee') && (await userModules(user)).includes('document_renewals')) {
    roster = await employeeRoster(lookup).catch((e) => {
      console.error('[files] no staff list from saifsys:', e.message);
      return null;
    });
  }
  return { types, roster };
}

/** The employee the model named, by an exact code from the roster only. */
export function pickEmployee(raw, roster = []) {
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim().toLowerCase() : '';
  if (!code) return null;
  const e = (roster || []).find((r) => r.code.toLowerCase() === code);
  return e ? { code: e.code, name: e.name } : null;
}

const kindsPrompt = ({ types = [], roster = null } = {}) => (types.length ? `

What kind of document it is - "type_id" is one of these ids, or null when none clearly fits (most files are none of them):
${types.map((t) => `- ${t.id} · ${t.category.label} › ${t.label}`).join('\n')}${roster?.length ? `
When it is one of the ${[...new Set(types.filter((t) => t.category.links_to === 'employee').map((t) => t.category.label))].join(' / ')} types, "employee_code" is the code of the employee it belongs to, from this staff list, or null if they are not on it:
${roster.map((e) => `- ${e.code} · ${e.name}${e.nickname && e.nickname !== e.name ? ` (${e.nickname})` : ''}`).join('\n')}` : ''}
For the other categories, "subject" is what it is for: the company, the vehicle plate or the policy, or null.` : '');

/**
 * Write what the classifier found about the kind of document. A person's own choice
 * outranks it: a file that already has a type keeps its type, employee and subject.
 * Nothing the AI read is confirmed.
 */
export async function fileAs(docId, c) {
  if (!c.typeId) return;
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = ?, employee_code = ?, employee_name = ?, subject = ?
    WHERE id = ? AND type_id IS NULL`)
    .run(c.typeId, c.categoryId, c.employee?.code ?? null, c.employee?.name ?? null, c.subject, docId);
}

const KIND_FIELDS = ['type_id', 'employee_code', 'subject', 'confirm_expiry', 'confirm_link', 'not_renewing'];
export const kindFieldsIn = (body = {}) => KIND_FIELDS.some((k) => k in body);

/**
 * A person corrects or confirms what a file is, who it is for and when it runs out:
 * body may carry type_id (null clears the kind), employee_code, subject, expires_on,
 * confirm_expiry, confirm_link and not_renewing ({ note } or null).
 * Its owner and the master may; so may a Document Renewals holder, on a file that is
 * already in a category - these fields only, never rename, move or delete. Anyone else
 * gets the same 404 as a file they cannot see. A changed date or employee is unconfirmed.
 */
export async function editDocumentKind(user, docId, body = {}, lookup = askSaifsys) {
  const doc = await readableDocument(user, docId);
  const holder = doc && !isExternal(user) && (await userModules(user)).includes('document_renewals');
  if (!doc || !(doc.user_id === user.id || isMaster(user) || (holder && doc.category_id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const next = { ...doc };
  const now = Math.floor(Date.now() / 1000);

  if ('type_id' in body) {
    if (body.type_id === null || body.type_id === '') {
      Object.assign(next, { type_id: null, category_id: null, employee_code: null, employee_name: null, subject: null });
    } else if (Number(body.type_id) !== doc.type_id) {
      if (isExternal(user)) throw bad('Not allowed');
      const t = await typeById(body.type_id);
      if (!t || !t.active || !t.category.active) throw bad('That kind of document is not in the list');
      const before = doc.category_id ? (await typeById(doc.type_id))?.category : null;
      next.type_id = t.id;
      next.category_id = t.category.id;
      if (before?.links_to !== t.category.links_to) Object.assign(next, { employee_code: null, employee_name: null, subject: null });
    }
  }
  const links = next.type_id ? (await typeById(next.type_id)).category.links_to : null;
  if ('employee_code' in body) {
    if (body.employee_code === null || body.employee_code === '') Object.assign(next, { employee_code: null, employee_name: null });
    else {
      if (links !== 'employee') throw bad('This kind of document is not for an employee');
      const e = await lookupCode(body.employee_code, lookup);
      Object.assign(next, { employee_code: e.code, employee_name: e.name });
    }
  }
  if ('subject' in body) {
    const s = String(body.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    if (s && links !== 'subject') throw bad('This kind of document is for an employee, not a company or vehicle');
    next.subject = s;
  }
  if ('expires_on' in body) next.expires_on = /^\d{4}-\d{2}-\d{2}$/.test(body.expires_on) ? body.expires_on : null;

  // What changed is no longer what was confirmed.
  if (next.expires_on !== doc.expires_on) Object.assign(next, { expiry_confirmed_by: null, expiry_confirmed_at: null });
  if (next.employee_code !== doc.employee_code || next.subject !== doc.subject || next.type_id !== doc.type_id) {
    Object.assign(next, { link_confirmed_by: null, link_confirmed_at: null });
  }
  if (body.confirm_expiry === true) {
    if (!next.expires_on) throw bad('There is no expiry date to confirm');
    Object.assign(next, { expiry_confirmed_by: user.id, expiry_confirmed_at: now });
  }
  if (body.confirm_link === true) {
    if (!next.employee_code && !next.subject) throw bad('Say who or what it is for first');
    Object.assign(next, { link_confirmed_by: user.id, link_confirmed_at: now });
  }
  if ('not_renewing' in body) {
    Object.assign(next, body.not_renewing
      ? { not_renewing_at: now, not_renewing_note: String(body.not_renewing.note || '').trim().slice(0, 300) || null }
      : { not_renewing_at: null, not_renewing_note: null });
  }

  await db.prepare(`UPDATE documents SET type_id = ?, category_id = ?, employee_code = ?, employee_name = ?, subject = ?,
      expires_on = ?, expiry_confirmed_by = ?, expiry_confirmed_at = ?, link_confirmed_by = ?, link_confirmed_at = ?,
      not_renewing_at = ?, not_renewing_note = ? WHERE id = ?`)
    .run(next.type_id, next.category_id, next.employee_code, next.employee_name, next.subject,
      next.expires_on, next.expiry_confirmed_by, next.expiry_confirmed_at, next.link_confirmed_by, next.link_confirmed_at,
      next.not_renewing_at, next.not_renewing_note, doc.id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
}

export async function classify(name, text, agents = [], companies = [], { kinds = null, ask: model = ask } = {}) {
  // The roster rides along in the prompt that was already being sent: same call, same
  // cost. The wording about type and purpose is router.js's, which makes the same
  // judgement about attachments and should not drift from this one.
  const roster = agents.length ? `
 "agent": <one of the id numbers below, or null if none clearly fits>` : '';
  const team = agents.length ? `

The user's agents, to file this against:
${agents.map((a) => `- id=${a.id} · ${a.name}: ${(a.persona || '').slice(0, 200).replace(/\s+/g, ' ')}`).join('\n')}
Judge the file by its type and purpose, not by words that merely appear in it (an offer letter for an accountant job is an HR matter; a tenancy contract is a property matter). Use null when nothing clearly fits - that is the normal answer for personal paperwork.` : '';

  const kindFields = kinds?.types?.length ? `,
 "type_id": <one of the type ids below, or null>${kinds.roster?.length ? `,
 "employee_code": "<a code from the staff list below, or null>"` : ''},
 "subject": "<what it is for, or null>"` : '';
  const out = await model(`File name: ${name}\n\nContent (start):\n${text.slice(0, 6000)}`, {
    maxTokens: 500,
    system: `You file documents for a UAE-based user. Reply with ONLY JSON:
{"title": "<clear human title, max 8 words, e.g. \\"Tenancy contract – Marina Heights 1402\\">",
 "folder": "<exactly one of: ${FOLDERS.join(' | ')}>",
 "summary": "<1-2 sentences with the key facts: parties, amounts (AED), dates, deadlines>",
 "tags": ["<up to 5 short lowercase tags>"],
 "company": "<${COMPANY_RULE}>",
 "date": "<the document's own date as YYYY-MM-DD, or null>",
 "expires": "<${EXPIRY_RULE}>"${roster}${kindFields}}
Photos and videos of people, places or things with no document content go in "Photos". UAE documents write dates as DD/MM/YYYY.
A first line "Sent with the words: ..." is what the user said as they sent it. When it says what the file is for (a project, a building, a person), put that in the summary and the tags. It is not part of the document.
${EXPIRY_GUIDE}${knownCompanies(companies)}${team}${kindsPrompt(kinds || {})}`,
  });
  const d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  // The category comes from the type, never from the model; and only the link its
  // category asks for is kept.
  const type = (kinds?.types || []).find((t) => typeof d.type_id !== 'boolean' && String(t.id) === String(d.type_id ?? '').trim()) || null;
  const subject = typeof d.subject === 'string' ? d.subject.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return {
    typeId: type?.id ?? null,
    categoryId: type?.category.id ?? null,
    employee: type?.category.links_to === 'employee' ? pickEmployee(d.employee_code, kinds.roster) : null,
    subject: type?.category.links_to === 'subject' && subject && !/^(null|none|n\/?a|unknown)$/i.test(subject) ? subject : null,
    title: String(d.title || name).slice(0, 120),
    folder: FOLDERS.includes(d.folder) ? d.folder : 'Other',
    summary: String(d.summary || '').slice(0, 600),
    tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).toLowerCase().slice(0, 30)).slice(0, 5),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
    expires: /^\d{4}-\d{2}-\d{2}$/.test(d.expires) ? d.expires : null,
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
 *
 * `said` is what the person wrote as they sent it in a chat ("this is for the school
 * project"). It is filed with the file, so the Shelf can find the bill by what it was for.
 *
 * `classify: false` only reads and indexes it: the title, folder and shelf it already has
 * stay (a case file keeps its own name and its case folder).
 */
export function processDocument(doc, f, text, agents = [], said = '', { classify: sort = true } = {}) {
  // Priced as reading this file, under whatever job brought it in (a chat, the Shelf, an import).
  return billAs({ note: doc.name }, () => fileDocument(doc, f, text, agents, said, sort));
}

async function fileDocument(doc, f, text, agents, said, sort = true) {
  try {
    // A video is read off disk rather than out of the buffer: ffmpeg needs a file, and
    // saveUpload has already written one.
    const read = async () => {
      if (isImage(f)) return describeImage(f);
      if (isVideo(f)) return readVideo(doc.path);
      return extractText({ ...f, originalname: doc.name });
    };
    // Some PDFs carry NUL characters in their text layer, which Postgres refuses to store.
    let content = (text ?? await read())?.replace(/\u0000/g, '');
    if (!content?.trim()) throw new Error('No readable text found');
    const own = content; // the file's own words, without what was said with it
    const words = String(said || '').replace(/[\u0000\s]+/g, ' ').trim().slice(0, 300);
    if (words) content = `Sent with the words: "${words}"\n\n${content}`;
    if (sort) {
      const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(doc.user_id);
      const kinds = owner ? await filingKinds(owner) : null;
      const c = await classify(doc.name, content, doc.agent_id ? [] : agents, await userCompanies(doc.user_id), { kinds });
      await db.prepare('UPDATE documents SET title = ?, folder = ?, summary = ?, tags = ?, doc_date = ?, expires_on = ?, company = ?, agent_id = COALESCE(agent_id, ?) WHERE id = ?')
        .run(c.title, c.folder, c.summary, JSON.stringify(c.tags), c.date, c.expires, c.company, c.agentId, doc.id);
      await fileAs(doc.id, c);
    }
    // Re-read rather than spreading over the copy we were handed: `doc` predates the
    // UPDATE, and chunks carry agent_id and shared of their own. Indexing from a stale
    // copy would file the chunks on the shelf the document just left, leaving the file
    // listed under one agent and retrievable by another.
    const filed = await db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
    await indexChunks(filed, content);
    await keepText(filed, own);
    await db.prepare("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?").run(doc.id);
  } catch (e) {
    console.error('[files]', doc.name, e.message);
    // Callers run this in the background without awaiting it, so a rejection here would be
    // unhandled and take the server down. The database is a plausible cause of the failure
    // being recorded, so this write has to be allowed to fail quietly.
    await db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(e.message, doc.id)
      .catch((e2) => console.error('[files] could not record failure:', doc.name, e2.message));
  }
}

// Types that are safe to show inside the app. Anything else (HTML, SVG, …) is only ever downloaded,
// because rendering it on our origin could run scripts.
const SAFE_INLINE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', ...VIDEO_TYPES];
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
 * Shared reaches every user, whichever shelf the file is filed on. See retrievalScope().
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
//
// Only the newest few, with how many there are in all: on a Shelf of thousands the list
// is a glimpse, and the agent has to know that or it reads "not listed" as "not there".
// Captured facts are left out - they are not files, and once crowded the real ones off.
export async function libraryCatalog(user) {
  const scope = agentScope(user);
  const files = `${scope.sql} AND status = 'ready' AND kind IS DISTINCT FROM 'fact'`;
  const rows = await db.prepare(`SELECT title, folder, name, doc_date, expires_on FROM documents t
    WHERE ${files} ORDER BY id DESC LIMIT 40`).all(...scope.params);
  const { n } = await db.prepare(`SELECT COUNT(*)::int n FROM documents t WHERE ${files}`).get(...scope.params);
  return {
    total: n,
    files: rows.map((d) => `- ${d.title} (${d.folder}${d.doc_date ? `, ${d.doc_date}` : ''}${d.expires_on ? `; expires ${d.expires_on}` : ''}; file: ${d.name})`),
  };
}

/**
 * The paperwork this user can read that has run out or is about to, soonest first. That
 * is their own and whatever the master shared with them: a reader cannot renew somebody
 * else's licence, but a second pair of eyes on the date is the point of telling them.
 *
 * `within` counts forward from today; everything already expired comes back regardless,
 * because a licence that lapsed last month is the most urgent row on the screen.
 */
export async function expiringDocuments(user, within = 90) {
  const days = Math.min(Math.max(Number(within) || 90, 1), 3650);
  const scope = agentScope(user);
  return db.prepare(`SELECT t.* FROM documents t
    WHERE ${scope.sql} AND status = 'ready' AND expires_on IS NOT NULL
      AND expires_on <= to_char(now() + (? || ' days')::interval, 'YYYY-MM-DD')
    ORDER BY expires_on ASC, id DESC LIMIT 100`).all(...scope.params, String(days));
}

// ---------- the Shelf: a person's own files, and the ones shared with them ----------
export const DOC_SELECT = `SELECT d.*, c.title conversation_title, a.name shelf_name, u.name owner_name FROM documents d
  LEFT JOIN conversations c ON c.id = d.conversation_id AND c.user_id = d.user_id
  LEFT JOIN agents a ON a.id = d.agent_id
  LEFT JOIN users u ON u.id = d.user_id`;

/**
 * A document as the screen gets it. `mine` is what the Shelf goes by to decide whether
 * to offer rename, move and delete: a file shared with someone is theirs to read, not to
 * change. The chat a shared file came from is the owner's chat, so it does not travel.
 */
export function docOut({ path, hash, user_id, owner_name, ...d }, viewerId) {
  const mine = user_id === viewerId;
  return {
    ...d,
    tags: JSON.parse(d.tags || '[]'),
    mine,
    ...(mine ? {} : { owner_name: owner_name ?? null, conversation_id: null, conversation_title: null, origin_conversation_id: null }),
  };
}

/**
 * Everything on this user's Shelf, or on one agent's shelf: what they own and what was
 * shared with them. The same reach as recall(), so the Shelf never shows less than the
 * assistant can already quote from.
 */
export async function readableDocuments(user, agentId = null) {
  const scope = agentScope(user, 'd');
  const shelf = Number(agentId) || null;
  return db.prepare(`${DOC_SELECT} WHERE ${scope.sql} AND (?::int IS NULL OR d.agent_id = ?)
    ORDER BY COALESCE(d.doc_date, to_char(to_timestamp(d.created_at), 'YYYY-MM-DD')) DESC, d.id DESC`).all(...scope.params, shelf, shelf);
}

/**
 * One file, if this user owns it or it was shared with them - or any file at all for the
 * master, who is shown what the team uploaded - never an external person's (access.js).
 * For opening, never for changing.
 */
export async function readableDocument(user, docId) {
  const scope = isMaster(user) ? masterReach('d') : agentScope(user, 'd');
  return db.prepare(`${DOC_SELECT} WHERE d.id = ? AND ${scope.sql}`).get(Number(docId) || 0, ...scope.params);
}
