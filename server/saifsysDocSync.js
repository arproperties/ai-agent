import { mkdirSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { isMaster } from './access.js';
import { askSaifsys, fileFromSaifsys, dubaiHour } from './saifsys/client.js';

// saifsys's employee documents (passports, visas, Emirates IDs, labour cards, contracts),
// copied onto the Shelf so Document Renewals, its alerts and its cases work on them like
// on any file. Read through the Jarvis API (saifsys module hr_docs), never its database.
// saifsys keeps its own copy: this only ever reads it. Run every night, and by the master
// on the Document Renewals screen.
//
// A copied file is the master's, filed under Employee Documents (a private category, so
// only the master and Document Renewals holders see it), and its date and employee count
// as confirmed: a person typed them into saifsys. A later change in saifsys is taken,
// unless someone in Reem has corrected that date since.

// saifsys's doc_type → the Employee Documents type it is. Anything else is "Other".
export const SAIFSYS_TYPES = {
  Passport: 'Passport', 'National ID': 'Emirates ID', Visa: 'Residence Visa', LaborCard: 'Labour Card', Contract: 'Labour Contract',
};
const OTHER = 'Other employee document';
const UPLOAD_DIR = `${DATA_DIR}/uploads`;

/** saifsys's file for one document, as bytes. Throws when it has none. */
async function saifsysFile(id) {
  const res = await fileFromSaifsys('hr_docs', 'document_file', { id });
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
}

// The Employee Documents types by label, retired ones too: a copied file keeps its kind.
async function employeeTypes() {
  const rows = await db.prepare(`SELECT t.id, t.label, t.category_id FROM document_types t
    JOIN document_categories c ON c.id = t.category_id WHERE c.links_to = 'employee' ORDER BY c.sort, c.id, t.id`).all();
  const by = new Map();
  for (const r of rows) if (!by.has(r.label)) by.set(r.label, r);
  return by;
}

async function attachFile(docId, ownerId, d, fetchFile) {
  const { buffer, mime } = await fetchFile(d.id);
  const name = d.file_name || `saifsys-${d.id}`;
  mkdirSync(`${UPLOAD_DIR}/${ownerId}`, { recursive: true });
  const path = `${UPLOAD_DIR}/${ownerId}/${docId}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  writeFileSync(path, buffer);
  const kind = mime.startsWith('image/') ? 'image' : 'doc';
  await db.prepare('UPDATE documents SET path = ?, name = ?, mime = ?, size = ?, hash = ?, kind = ? WHERE id = ?')
    .run(path, name, mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), kind, docId);
  await db.prepare('UPDATE saifsys_doc_links SET has_file = true WHERE saifsys_id = ?').run(d.id);
}

const summaryOf = (d) => [
  `From saifsys HR documents (#${d.id}).`,
  d.number && `Number ${d.number}.`,
  d.issued_at && `Issued ${d.issued_at}.`,
  d.notes,
].filter(Boolean).join(' ');

/**
 * Bring saifsys's employee documents up to date on the Shelf. Returns what it did:
 * { added, updated, files, superseded } (or { skipped } when there is no master to own them).
 * One document going wrong is logged and skipped, never the whole run.
 */
export async function syncSaifsysDocs({ lookup = askSaifsys, fetchFile = saifsysFile } = {}) {
  const out = { added: 0, updated: 0, files: 0, superseded: 0 };
  const owner = await db.prepare("SELECT id FROM users WHERE role = 'master' ORDER BY id LIMIT 1").get();
  if (!owner) return { ...out, skipped: 'no master account' };
  const types = await employeeTypes();
  const now = Math.floor(Date.now() / 1000);

  let after = 0;
  for (;;) {
    const page = await lookup('hr_docs', 'documents', { after_id: after, limit: 500 });
    for (const d of page.documents || []) {
      try {
        const type = types.get(SAIFSYS_TYPES[d.type] || OTHER) || types.get(OTHER);
        if (!type) continue; // the master took the Employee Documents types away
        const link = await db.prepare('SELECT * FROM saifsys_doc_links WHERE saifsys_id = ?').get(d.id);
        let docId = link?.document_id;
        if (!link) {
          const title = `${type.label === OTHER ? d.type || 'Document' : type.label} – ${d.employee_name}`.slice(0, 120);
          ({ id: docId } = await db.prepare(`INSERT INTO documents (user_id, name, title, folder, summary, kind, status, tags,
              category_id, type_id, employee_code, employee_name, expires_on, expiry_confirmed_at, link_confirmed_at)
            VALUES (?, ?, ?, 'HR & Employees', ?, 'doc', 'ready', '[]', ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
            .run(owner.id, d.file_name || `${title}`, title, summaryOf(d), type.category_id, type.id, d.employee_code, d.employee_name,
              d.expires_at, d.expires_at ? now : null, now));
          await db.prepare('INSERT INTO saifsys_doc_links (saifsys_id, document_id, changed_at) VALUES (?, ?, ?)').run(d.id, docId, d.updated_at);
          out.added++;
        } else if (link.changed_at !== d.updated_at) {
          // saifsys changed it. Its date wins, unless someone in Reem has set the date since.
          await db.prepare(`UPDATE documents SET employee_name = ?, summary = ?,
              expires_on = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expires_on END,
              expiry_confirmed_at = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expiry_confirmed_at END
            WHERE id = ?`).run(d.employee_name, summaryOf(d), d.expires_at, d.expires_at ? now : null, docId);
          await db.prepare('UPDATE saifsys_doc_links SET changed_at = ?, synced_at = ? WHERE saifsys_id = ?').run(d.updated_at, now, d.id);
          out.updated++;
        }
        if (d.has_file && !link?.has_file) {
          try {
            await attachFile(docId, owner.id, d, fetchFile);
            out.files++;
          } catch (e) {
            console.error(`[saifsys-docs] no file yet for saifsys document #${d.id}:`, e.message); // tried again next run
          }
        }
      } catch (e) {
        console.error(`[saifsys-docs] saifsys document #${d.id} skipped:`, e.message);
      }
    }
    if (page.next_after_id == null) break;
    after = page.next_after_id;
  }
  out.superseded = await supersedeOlder();
  return out;
}

/**
 * An older confirmed document of the same kind for the same employee is replaced by the
 * one that runs out last: the old passport stops alerting once the new one is filed.
 */
async function supersedeOlder() {
  const rows = await db.prepare(`UPDATE documents d SET superseded_by = n.id
    FROM (SELECT DISTINCT ON (employee_code, type_id) id, employee_code, type_id, expires_on FROM documents
          WHERE employee_code IS NOT NULL AND type_id IS NOT NULL AND expires_on IS NOT NULL
            AND expiry_confirmed_at IS NOT NULL AND link_confirmed_at IS NOT NULL AND superseded_by IS NULL
          ORDER BY employee_code, type_id, expires_on DESC, id DESC) n
    WHERE d.employee_code = n.employee_code AND d.type_id = n.type_id AND d.id <> n.id
      AND d.superseded_by IS NULL AND d.expires_on IS NOT NULL AND d.expires_on < n.expires_on
      AND d.expiry_confirmed_at IS NOT NULL AND d.link_confirmed_at IS NOT NULL
    RETURNING d.id`).all();
  return rows.length;
}

/** The master's "Sync now" on the Document Renewals screen. */
export async function syncNow(user, deps = {}) {
  if (!isMaster(user)) throw Object.assign(new Error('Only the master can do this'), { status: 403 });
  return syncSaifsysDocs(deps);
}

/** Every night at 2 (Dubai), and once shortly after start-up. */
export function startSaifsysDocSync() {
  let lastDay = null;
  const run = (why) => syncSaifsysDocs()
    .then((r) => console.log(`[saifsys-docs] ${why}:`, JSON.stringify(r)))
    .catch((e) => console.error('[saifsys-docs] sync failed:', e.message));
  setTimeout(() => run('after start-up'), 60_000).unref();
  setInterval(() => {
    const today = new Date().toDateString();
    if (dubaiHour() === 2 && lastDay !== today) {
      lastDay = today;
      run('nightly');
    }
  }, 10 * 60_000).unref();
}
