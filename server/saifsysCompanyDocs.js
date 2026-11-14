import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { db, tx } from './db.js';
import { DATA_DIR } from './config.js';
import { billAs } from './billing.js';
import { extractText, describeImage, indexChunks, IMAGE_TYPES } from './knowledge.js';
import { keepText } from './copies.js';
import { askSaifsys, fileFromSaifsys } from './saifsys/client.js';

// saifsys's company documents (HR -> Company Documents: trade licences, MOA, Ejari,
// establishment cards, POA, VAT and corporate tax certificates), copied onto the Shelf so
// Reem's chat answers from the issue saifsys holds now, not an old copy someone uploaded.
// Staff upload and renew them in saifsys; Reem only ever reads them, through saifsys's
// api/jarvis/v1 door (module company_docs), every 15 minutes and on the master's Sync button.
//
// Each saifsys document is its live row (always the current issue) plus its earlier issues
// (archived there on Renew). Each becomes one Shelf file, linked in saifsys_company_doc_links
// by (saifsys id, version_no) - 0 being the live one. The live file is read like an upload, so
// the chat can answer from what is written in it; earlier issues are kept to open, marked
// superseded by the current one, and the chat leaves them out unless asked for an old one.
//
// A copied file is the master's, shared with every internal user (external people reach only
// their own files), filed under the company documents category with the company as its
// subject, and its expiry counts as confirmed: a person typed it into saifsys. A date someone
// in Reem has corrected since is kept.

// saifsys's doc_type -> the type label on Reem's side. Missing ones are added to the category.
export const COMPANY_TYPES = {
  trade_license: 'Trade Licence',
  moa: 'Memorandum of Association (MOA)',
  ejari: 'Tenancy Contract (Ejari)',
  establishment_card: 'Establishment Card',
  power_of_attorney: 'Power of Attorney',
  vat_certificate: 'VAT Certificate',
  corporate_tax_certificate: 'Corporate Tax Certificate',
  other: 'Other company document',
};
const OTHER = 'other';
const LIVE = 0;
const UPLOAD_DIR = `${DATA_DIR}/uploads`;
const FOLDER = 'Company & Licenses';

const defaultSource = {
  lookup: askSaifsys,
  fetchFile: async (id, version) => {
    const res = await fileFromSaifsys('company_docs', 'document_file', { id, version: version || undefined });
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
  },
  read: readText,
  uploadDir: UPLOAD_DIR, // tests use their own, never the real uploads
};

/** What is written in a file: a picture described, anything else read as an upload is. */
async function readText({ buffer, mime, name }) {
  if (IMAGE_TYPES.includes(mime)) return describeImage({ buffer, mimetype: mime });
  return extractText({ buffer, mimetype: mime, originalname: name });
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The category company documents go in: the first active, not private one that files by
 * subject (Company Documents, as seeded). Found by what it does, never by its label.
 */
async function companyCategory() {
  return db.prepare(`SELECT id FROM document_categories WHERE links_to = 'subject' AND active AND NOT private
    ORDER BY sort, id LIMIT 1`).get();
}

/** saifsys type -> Reem type id, adding the missing types to the category once. */
async function typeIds(categoryId) {
  const rows = await db.prepare('SELECT id, label FROM document_types WHERE category_id = ?').all(categoryId);
  const byLabel = new Map(rows.map((r) => [norm(r.label), r.id]));
  const out = {};
  let sort = rows.length;
  for (const [code, label] of Object.entries(COMPANY_TYPES)) {
    let id = byLabel.get(norm(label));
    if (!id) {
      ({ id } = await db.prepare(`INSERT INTO document_types (category_id, label, sort) VALUES (?, ?, ?)
        ON CONFLICT (category_id, lower(label)) DO UPDATE SET label = document_types.label RETURNING id`).run(categoryId, label, sort++));
    }
    out[code] = id;
  }
  return out;
}

const typeLabel = (code) => COMPANY_TYPES[code] || COMPANY_TYPES[OTHER];

/** Its title on the Shelf: "Trade Licence – Saif Holding LLC", an earlier issue with its dates. */
function titleOf(d, v = null) {
  const kind = d.type === OTHER || !COMPANY_TYPES[d.type] ? d.title || typeLabel(d.type) : typeLabel(d.type);
  const extra = d.title && kind !== d.title ? ` (${d.title})` : '';
  const when = v ? ` – earlier issue${v.issued_at ? ` ${v.issued_at}` : ''}${v.expires_at ? ` to ${v.expires_at}` : ''}` : '';
  return `${kind}${extra} – ${d.company_name}${when}`.slice(0, 160);
}

/** The details saifsys holds, as a line for the summary and the top of what the chat reads. */
function detailsOf(d, v = null) {
  const x = v || d;
  return [
    `${v ? 'Earlier issue' : 'Current issue'} of the ${typeLabel(d.type)}${d.title ? ` "${d.title}"` : ''} of ${d.company_name}, from saifsys (company documents #${d.id}${v ? `, version ${v.version_no}` : ''}).`,
    x.number && `Number ${x.number}.`,
    x.authority && `Issued by ${x.authority}.`,
    x.issued_at && `Issue date ${x.issued_at}.`,
    x.expires_at ? `Expiry date ${x.expires_at}.` : 'No expiry date.',
    v && 'This is not the current issue.',
    x.notes,
  ].filter(Boolean).join(' ');
}

/** Fetch a file from saifsys and put it under the document; returns { buffer, mime, name } or null. */
async function attach(docId, ownerId, d, v, src) {
  const f = v || d;
  if (!f.has_file) return null;
  const { buffer, mime } = await src.fetchFile(d.id, v ? v.version_no : null);
  const name = f.file_name || `saifsys-company-${d.id}${v ? `-v${v.version_no}` : ''}`;
  mkdirSync(`${src.uploadDir}/${ownerId}`, { recursive: true });
  const old = await db.prepare('SELECT path FROM documents WHERE id = ?').get(docId);
  const path = `${src.uploadDir}/${ownerId}/${docId}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  writeFileSync(path, buffer);
  if (old?.path && old.path !== path && existsSync(old.path)) unlinkSync(old.path);
  await db.prepare('UPDATE documents SET path = ?, name = ?, mime = ?, size = ?, hash = ?, kind = ? WHERE id = ?')
    .run(path, name, mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), mime.startsWith('image/') ? 'image' : 'doc', docId);
  return { buffer, mime, name };
}

/**
 * Index what the chat reads: saifsys's details on top, then the file's own words. The live
 * issue's file is read; an earlier issue's is not (it is there to open), so only its details
 * are searchable. A file that cannot be read still leaves the details, never an empty file.
 */
async function index(docId, d, v, file, src, { reread = true } = {}) {
  let own = null;
  if (!v) {
    if (file && reread) {
      try {
        own = String(await src.read(file) || '').replace(/\u0000/g, '');
      } catch (e) {
        console.error(`[saifsys-company-docs] #${d.id} could not be read:`, e.message);
      }
    } else if (!reread) {
      own = (await db.prepare('SELECT text FROM document_texts WHERE document_id = ?').get(docId))?.text ?? null;
    }
  }
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  const details = detailsOf(d, v);
  await indexChunks(doc, own?.trim() ? `${details}\n\n${own}` : details);
  if (own?.trim()) await keepText(doc, own);
  await db.prepare("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?").run(docId);
}

/**
 * A new Shelf file for one saifsys document (v null) or one of its earlier issues. The row and
 * its link are made together under a lock on the saifsys id, so two runs at once never copy it
 * twice; the file is fetched and read after, outside the transaction (indexing runs its own).
 * Returns the new document's id, or null when another run got there first.
 */
async function addCopy(owner, cat, types, d, v, src, now) {
  const x = v || d;
  const id = await tx(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext('saifsys_company_doc_links'), ?)").get(d.id);
    if (await db.prepare('SELECT 1 FROM saifsys_company_doc_links WHERE saifsys_id = ? AND version_no = ?').get(d.id, v ? v.version_no : LIVE)) return null;
    const { id: docId } = await db.prepare(`INSERT INTO documents (user_id, name, title, folder, summary, kind, status, tags, shared,
        category_id, type_id, subject, doc_date, expires_on, expiry_confirmed_at, link_confirmed_at)
      VALUES (?, ?, ?, ?, ?, 'doc', 'processing', '[]', true, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(owner, x.file_name || titleOf(d, v), titleOf(d, v), FOLDER, detailsOf(d, v), cat, types[d.type] || types[OTHER],
        d.company_name, x.issued_at, x.expires_at, x.expires_at ? now : null, now);
    await db.prepare(`INSERT INTO saifsys_company_doc_links (saifsys_id, version_no, document_id, company_id, doc_type, changed_at, file_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(d.id, v ? v.version_no : LIVE, docId, d.company_id, d.type, v ? v.archived_at : d.updated_at, x.file_key || null);
    return docId;
  });
  if (!id) return null;
  let file = null;
  try {
    file = await attach(id, owner, d, v, src);
  } catch (e) {
    // Kept with its details. With no file_key, the next run sees a new file and tries again.
    console.error(`[saifsys-company-docs] #${d.id}${v ? ` v${v.version_no}` : ''} file not fetched:`, e.message);
    await db.prepare('UPDATE saifsys_company_doc_links SET file_key = NULL WHERE document_id = ?').run(id);
  }
  await index(id, d, v, file, src);
  return id;
}

/** Bring a Shelf file's details in line with saifsys. A date corrected in Reem is kept. */
async function updateDetails(docId, d, v, now) {
  const x = v || d;
  await db.prepare(`UPDATE documents SET title = ?, summary = ?, subject = ?, doc_date = ?,
      expires_on = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expires_on END,
      expiry_confirmed_at = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expiry_confirmed_at END
    WHERE id = ?`).run(titleOf(d, v), detailsOf(d, v), d.company_name, x.issued_at, x.expires_at, x.expires_at ? now : null, docId);
}

/** One saifsys document and its earlier issues. Returns what changed. */
async function syncOne(owner, cat, types, d, src, now) {
  const out = { added: 0, updated: 0, renewed: 0 };
  const links = await db.prepare('SELECT * FROM saifsys_company_doc_links WHERE saifsys_id = ?').all(d.id);
  const have = new Set(links.map((l) => l.version_no));
  let live = links.find((l) => l.version_no === LIVE);

  // Earlier issues saifsys holds that Reem does not have yet, oldest first. On Renew, saifsys
  // archives the issue Reem already holds as live: that copy becomes the earlier issue (it keeps
  // its file and reading), and the new live issue is copied after. It is the same issue when the
  // stored file is the same one, or, with no file on either, when the live row has changed since.
  for (const v of [...(d.versions || [])].sort((a, b) => a.version_no - b.version_no)) {
    if (have.has(v.version_no)) continue;
    const same = live && live.file_key === (v.file_key || null) && (v.file_key || live.changed_at !== d.updated_at);
    if (same) {
      await db.prepare('UPDATE saifsys_company_doc_links SET version_no = ?, changed_at = ?, synced_at = ? WHERE saifsys_id = ? AND version_no = ?')
        .run(v.version_no, v.archived_at, now, d.id, LIVE);
      await updateDetails(live.document_id, d, v, now);
      await index(live.document_id, d, v, null, src);
      live = null;
      out.renewed++;
    } else if (await addCopy(owner, cat, types, d, v, src, now)) out.added++;
  }

  if (!live) {
    if (await addCopy(owner, cat, types, d, null, src, now)) out.added++;
    return out;
  }
  if (live.changed_at === d.updated_at && live.file_key === (d.file_key || null)) return out;
  await updateDetails(live.document_id, d, null, now);
  // A different stored name is a new file: saifsys saves every upload under a fresh name.
  const newFile = live.file_key !== (d.file_key || null);
  let file = null;
  if (newFile) {
    file = await attach(live.document_id, owner, d, null, src);
    if (!file) {
      // saifsys no longer holds a file for it: the old one must not be read as current.
      const doc = await db.prepare('SELECT path FROM documents WHERE id = ?').get(live.document_id);
      if (doc?.path && existsSync(doc.path)) unlinkSync(doc.path);
      await db.prepare('UPDATE documents SET path = NULL, hash = NULL WHERE id = ?').run(live.document_id);
      await db.prepare('DELETE FROM document_texts WHERE document_id = ?').run(live.document_id);
    }
  }
  await index(live.document_id, d, null, file, src, { reread: newFile });
  await db.prepare(`UPDATE saifsys_company_doc_links SET changed_at = ?, file_key = ?, company_id = ?, doc_type = ?, synced_at = ?
    WHERE saifsys_id = ? AND version_no = ?`).run(d.updated_at, d.file_key || null, d.company_id, d.type, now, d.id, LIVE);
  out.updated++;
  return out;
}

/**
 * Which copy is current. A document's earlier issues are superseded by its live one. Several
 * live documents of one type for one company (a new issue added as new instead of renewed) -
 * the one that runs out last is current (no expiry counts as last), as saifsys's own screen
 * shows it; "Other" documents are different papers, never compared. A Company Documents file
 * uploaded by hand for the same company and type that runs out earlier is superseded too.
 */
async function settleCurrent(cat, types) {
  // Earlier issues -> their own live copy.
  await db.prepare(`UPDATE documents d SET superseded_by = l.document_id
    FROM saifsys_company_doc_links v JOIN saifsys_company_doc_links l ON l.saifsys_id = v.saifsys_id AND l.version_no = 0
    WHERE v.version_no <> 0 AND d.id = v.document_id AND d.superseded_by IS DISTINCT FROM l.document_id`).run();

  const lives = await db.prepare(`SELECT l.saifsys_id, l.company_id, l.doc_type, d.id, d.expires_on, d.subject, d.superseded_by
    FROM saifsys_company_doc_links l JOIN documents d ON d.id = l.document_id
    WHERE l.version_no = 0 AND d.status <> 'removed'`).all();
  const groups = new Map();
  for (const r of lives) {
    if (r.doc_type === OTHER || !COMPANY_TYPES[r.doc_type]) continue;
    const k = `${r.company_id}|${r.doc_type}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const later = (a, b) => (a.expires_on || '9999-12-31') > (b.expires_on || '9999-12-31') || ((a.expires_on || '9999-12-31') === (b.expires_on || '9999-12-31') && a.saifsys_id > b.saifsys_id);
  let superseded = 0;
  const winners = [];
  for (const r of lives) {
    const g = groups.get(`${r.company_id}|${r.doc_type}`);
    const best = g ? g.reduce((w, x) => (later(x, w) ? x : w)) : r;
    const want = best.id === r.id ? null : best.id;
    if (want !== (r.superseded_by ?? null)) {
      await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(want, r.id);
      if (want) superseded++;
    }
    if (!want && g) winners.push(best);
  }

  // Hand-uploaded copies: same category, same type, same company name, an earlier expiry.
  for (const w of winners) {
    if (!w.expires_on) continue;
    const rows = await db.prepare(`UPDATE documents d SET superseded_by = ?
      WHERE d.category_id = ? AND d.type_id = ? AND lower(regexp_replace(trim(d.subject), '\\s+', ' ', 'g')) = ?
        AND d.expires_on IS NOT NULL AND d.expires_on < ? AND d.superseded_by IS NULL AND d.id <> ?
        AND NOT EXISTS (SELECT 1 FROM saifsys_company_doc_links l WHERE l.document_id = d.id)
      RETURNING d.id`).all(w.id, cat, types[w.doc_type], norm(w.subject), w.expires_on, w.id);
    superseded += rows.length;
  }
  return superseded;
}

/**
 * Bring saifsys's company documents up to date on the Shelf. Returns
 * { added, updated, renewed, removed, superseded } (or { skipped }). One document going wrong is
 * logged and skipped, never the whole run; a document saifsys no longer lists is hidden only
 * after a run that read every page and every document without an error.
 */
export async function syncCompanyDocs(deps = {}) {
  const src = { ...defaultSource, ...deps };
  const out = { added: 0, updated: 0, renewed: 0, removed: 0, superseded: 0 };
  const owner = await db.prepare("SELECT id FROM users WHERE role = 'master' ORDER BY id LIMIT 1").get();
  if (!owner) return { ...out, skipped: 'no master account' };
  const cat = (await companyCategory())?.id;
  if (!cat) return { ...out, skipped: 'no company documents category' };
  const types = await typeIds(cat);
  const now = Math.floor(Date.now() / 1000);

  const seen = new Set();
  let clean = true;
  let after = 0;
  for (;;) {
    const page = await src.lookup('company_docs', 'documents', { after_id: after, limit: 500 });
    for (const d of page.documents || []) {
      seen.add(d.id);
      try {
        const r = await syncOne(owner.id, cat, types, d, src, now);
        out.added += r.added; out.updated += r.updated; out.renewed += r.renewed;
      } catch (e) {
        clean = false;
        console.error(`[saifsys-company-docs] saifsys document #${d.id} skipped:`, e.message);
      }
    }
    if (page.next_after_id == null) break;
    after = page.next_after_id;
  }

  if (clean) {
    // Deleted in saifsys: hidden from the Shelf, the chat and Document Renewals, not deleted.
    const gone = (await db.prepare('SELECT DISTINCT saifsys_id FROM saifsys_company_doc_links').all()).map((r) => r.saifsys_id).filter((id) => !seen.has(id));
    if (gone.length) {
      const rows = await db.prepare(`UPDATE documents SET status = 'removed'
        WHERE id IN (SELECT document_id FROM saifsys_company_doc_links WHERE saifsys_id = ANY(?::int[])) AND status <> 'removed'
        RETURNING id`).all(gone);
      out.removed = (await db.prepare(`SELECT COUNT(DISTINCT saifsys_id)::int n FROM saifsys_company_doc_links
        WHERE document_id = ANY(?::int[])`).get(rows.map((r) => r.id))).n;
    }
  }
  out.superseded = await settleCurrent(cat, types);
  return out;
}

/** The master's "Sync from saifsys", and the 15-minute timer: billed to the master as one job. */
export async function runCompanyDocSync(deps = {}) {
  const owner = await db.prepare("SELECT id FROM users WHERE role = 'master' ORDER BY id LIMIT 1").get();
  return billAs({ userId: owner?.id ?? null, job: 'saifsys-company-docs' }, () => syncCompanyDocs(deps));
}

// One run at a time: a slow run (the first one reads every document) must not overlap the next.
let running = null;
export function syncCompanyDocsOnce(deps) {
  running ||= runCompanyDocSync(deps).finally(() => { running = null; });
  return running;
}

/** Every 15 minutes, and once shortly after start-up. */
export function startSaifsysCompanyDocSync() {
  const run = (why) => syncCompanyDocsOnce()
    .then((r) => { if (r.added || r.updated || r.renewed || r.removed || r.superseded || r.skipped) console.log(`[saifsys-company-docs] ${why}:`, JSON.stringify(r)); })
    .catch((e) => console.error('[saifsys-company-docs] sync failed:', e.message));
  setTimeout(() => run('after start-up'), 90_000).unref();
  setInterval(() => run('every 15 minutes'), 15 * 60_000).unref();
}

