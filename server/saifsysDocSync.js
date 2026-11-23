import { existsSync, unlinkSync } from 'node:fs';
import { extname } from 'node:path';
import { db, tx } from './db.js';
import { isMaster } from './access.js';
import { readableDocument } from './files.js';
import { askSaifsys, fileFromSaifsys } from './saifsys/client.js';
import { scanCases } from './renewalCases.js';
import { fileBytes } from './saifsysFiles.js';

// saifsys's employee documents (passports, visas, Emirates IDs, labour cards, contracts),
// copied onto the Shelf so Document Renewals, its alerts and its cases work on them like
// on any file. Read through saifsys's HR API or its api/jarvis/v1 door (module hr_docs), never
// its database. Run every 15 minutes, and by the master on the Document Renewals screen.
//
// Only the details come across. The files stay in saifsys (Francis, 2026-11-23): opening one,
// reading it in chat or attaching it fetches it from saifsys there and then (saifsysFiles.js).
//
// A copied record is the master's, filed under Employee Documents, and company_wide: every one
// inside the company reads them (Francis, 2026-11-23; knowledge.js retrievalScope), never anyone
// external; hand-uploaded files in that category stay private. Its date and employee count
// as confirmed: a person typed them into saifsys. A later change in saifsys is taken,
// unless someone in Reem has corrected that date since.

// saifsys's doc_type → the Employee Documents type it is. Anything else is "Other".
export const SAIFSYS_TYPES = {
  Passport: 'Passport', 'National ID': 'Emirates ID', Visa: 'Residence Visa', LaborCard: 'Labour Card', Contract: 'Labour Contract',
};
const OTHER = 'Other employee document';
// A run that would hide more than this many documents at once stops short and says so: a
// saifsys answer that leaves documents out by mistake must not empty Document Renewals.
export const MAX_REMOVED_PER_RUN = 25;
// What a file is, from its name, so the screens know how to open it before it is fetched.
const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const mimeOf = (name) => MIME[extname(String(name || '')).toLowerCase()] || null;

/** saifsys's file for one document, as bytes. Throws when it has none. */
async function saifsysFile(id) {
  const res = await fileFromSaifsys('hr_docs', 'document_file', { id });
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
}

// ---------- saifsys's HR API (api/hr/v1, its own X-HR-Key), the other way in ----------

const LEFT = ['resigned', 'terminated', 'not_renewed', 'inactive']; // saifsys hr_employee_left_statuses()

/**
 * The same two questions asked of saifsys's HR API: its pages (100 at a time, by page
 * number - carried here as the cursor) and a document's file. That API answers a file
 * by sending the browser on to where saifsys keeps it; the file is fetched there, and
 * the HR key goes only to the API itself.
 */
export function hrApiSource({ base, key, fetch: get = globalThis.fetch }) {
  const call = (params) => {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return get(url, { headers: { 'X-HR-Key': key, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  };
  const bad = (m) => Object.assign(new Error(m), { status: 502 });
  return {
    lookup: async (_module, _action, { after_id = 0 } = {}) => {
      const page = Number(after_id) + 1;
      const res = await call({ action: 'documents', page });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw bad(`saifsys HR API said: ${body?.error?.message || `HTTP ${res.status}`}`);
      return {
        documents: (body.documents || []).map((d) => ({
          id: d.id,
          employee_code: d.employee?.code,
          employee_name: d.employee?.name,
          employee_left: LEFT.includes(String(d.employee?.status || '').toLowerCase()),
          type: d.type, number: d.number ?? null, issued_at: d.issued_at ?? null, expires_at: d.expires_at ?? null,
          notes: d.notes ?? null, has_file: !!d.has_file, file_name: d.file_name ?? null,
          updated_at: d.updated_at || d.uploaded_at || null,
        })),
        next_after_id: page < Number(body.pages || 1) ? page : null,
      };
    },
    fetchFile: async (id) => {
      let res = await call({ action: 'document_file', id });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        res = await get(new URL(res.headers.get('location'), base), { signal: AbortSignal.timeout(60_000) });
      }
      if (!res.ok) throw Object.assign(new Error('That file could not be found.'), { status: 404 });
      return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
    },
  };
}

/**
 * One employee's company salary from saifsys's HR API (action=salaries): basic, allowance,
 * bonus, total and how it is paid, or null when it does not know them. Left staff included.
 */
export async function hrSalary(code, { base = process.env.SAIFSYS_HR_URL, key = process.env.SAIFSYS_HR_KEY, fetch: get = globalThis.fetch } = {}) {
  if (!base || !key) throw Object.assign(new Error('Reem has no key for the saifsys HR API'), { status: 502 });
  const url = new URL(base);
  for (const [k, v] of Object.entries({ action: 'salaries', code, status: 'all' })) url.searchParams.set(k, v);
  const res = await get(url, { headers: { 'X-HR-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw Object.assign(new Error(`saifsys HR API said: ${body?.error?.message || `HTTP ${res.status}`}`), { status: 502 });
  const e = (body.employees || []).find((x) => String(x.code).toLowerCase() === String(code).toLowerCase());
  return e ? { basic: e.basic, allowance: e.allowance, bonus: e.bonus, total: e.total, paid_by: e.payment_label } : null;
}

/** One document's file from saifsys, as { buffer, mime }. Never saved (saifsysFiles.js). */
export const fetchEmployeeFile = (id) => source().fetchFile(id);

/** Where saifsys's documents come from: its HR API when Reem has its key, else its api/jarvis/v1 door. */
function source() {
  const base = process.env.SAIFSYS_HR_URL;
  const key = process.env.SAIFSYS_HR_KEY;
  return base && key ? hrApiSource({ base, key }) : { lookup: askSaifsys, fetchFile: saifsysFile };
}

// The Employee Documents types by label, retired ones too: a copied file keeps its kind.
async function employeeTypes() {
  const rows = await db.prepare(`SELECT t.id, t.label, t.category_id FROM document_types t
    JOIN document_categories c ON c.id = t.category_id WHERE c.links_to = 'employee' ORDER BY c.sort, c.id, t.id`).all();
  const by = new Map();
  for (const r of rows) if (!by.has(r.label)) by.set(r.label, r);
  return by;
}

const summaryOf = (d) => [
  `From saifsys HR documents (#${d.id}).`,
  d.number && `Number ${d.number}.`,
  d.issued_at && `Issued ${d.issued_at}.`,
  d.notes,
].filter(Boolean).join(' ');

/**
 * Bring saifsys's employee documents up to date on the Shelf. Returns what it did:
 * { added, updated, superseded, removed } (or { skipped } when there is no master to own them).
 * Only the details come across; a file is fetched from saifsys when it is opened. One document
 * going wrong is logged and skipped, never the whole run; a document saifsys no longer lists is
 * hidden only after a run that read every page without an error.
 */
export async function syncSaifsysDocs(deps = {}) {
  const { lookup } = { ...source(), ...deps };
  const out = { added: 0, updated: 0, superseded: 0, removed: 0 };
  const seen = new Set();
  let clean = true;
  const owner = await db.prepare("SELECT id FROM users WHERE role = 'master' ORDER BY id LIMIT 1").get();
  if (!owner) return { ...out, skipped: 'no master account' };
  const types = await employeeTypes();
  const now = Math.floor(Date.now() / 1000);

  let after = 0;
  for (;;) {
    const page = await lookup('hr_docs', 'documents', { after_id: after, limit: 500 });
    for (const d of page.documents || []) {
      seen.add(d.id);
      try {
        const type = types.get(SAIFSYS_TYPES[d.type] || OTHER) || types.get(OTHER);
        if (!type) continue; // the master took the Employee Documents types away
        // One saifsys document at a time, under a lock on its id: two runs at once (a restart,
        // the master's button during the night's run, two servers) must not both add it.
        await tx(async () => {
          await db.prepare("SELECT pg_advisory_xact_lock(hashtext('saifsys_doc_links'), ?)").get(d.id);
          const link = await db.prepare('SELECT * FROM saifsys_doc_links WHERE saifsys_id = ?').get(d.id);
          if (!link) {
            const title = `${type.label === OTHER ? d.type || 'Document' : type.label} – ${d.employee_name}`.slice(0, 120);
            const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, folder, summary, kind, status, tags, company_wide, mime,
                category_id, type_id, employee_code, employee_name, expires_on, expiry_confirmed_at, link_confirmed_at)
              VALUES (?, ?, ?, 'HR & Employees', ?, 'doc', 'ready', '[]', true, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
              .run(owner.id, d.file_name || title, title, summaryOf(d), mimeOf(d.file_name), type.category_id, type.id, d.employee_code, d.employee_name,
                d.expires_at, d.expires_at ? now : null, now);
            await db.prepare('INSERT INTO saifsys_doc_links (saifsys_id, document_id, changed_at, saifsys_has_file) VALUES (?, ?, ?, ?)').run(d.id, id, d.updated_at, !!d.has_file);
            out.added++;
            return id;
          }
          if (link.changed_at !== d.updated_at) {
            // saifsys changed it. Its date wins, unless someone in Reem has set the date since.
            await db.prepare(`UPDATE documents SET employee_name = ?, summary = ?,
                expires_on = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expires_on END,
                expiry_confirmed_at = CASE WHEN expiry_confirmed_by IS NULL THEN ? ELSE expiry_confirmed_at END
              WHERE id = ?`).run(d.employee_name, summaryOf(d), d.expires_at, d.expires_at ? now : null, link.document_id);
            await db.prepare('UPDATE saifsys_doc_links SET changed_at = ?, synced_at = ? WHERE saifsys_id = ?').run(d.updated_at, now, d.id);
            out.updated++;
          }
          if (link.saifsys_has_file !== !!d.has_file) {
            await db.prepare('UPDATE saifsys_doc_links SET saifsys_has_file = ? WHERE saifsys_id = ?').run(!!d.has_file, d.id);
          }
          // A new file in saifsys keeps its own name: the screens open it by that.
          if (d.file_name) {
            await db.prepare('UPDATE documents SET name = ?, mime = coalesce(?, mime) WHERE id = ? AND name IS DISTINCT FROM ?')
              .run(d.file_name, mimeOf(d.file_name), link.document_id, d.file_name);
          }
          // saifsys deleted it and now lists it again: back on the Shelf.
          await db.prepare("UPDATE documents SET status = 'ready' WHERE id = ? AND status = 'removed'").run(link.document_id);
          return link.document_id;
        });
      } catch (e) {
        clean = false;
        console.error(`[saifsys-docs] saifsys document #${d.id} skipped:`, e.message);
      }
    }
    if (page.next_after_id == null) break;
    after = page.next_after_id;
  }
  if (clean) out.removed = await removeGone(seen);
  out.superseded = await supersedeOlder();
  await keepNoFiles();
  return out;
}

/**
 * Deleted in saifsys: hidden from the Shelf, the chat and Document Renewals, not deleted, after
 * a run that read every page without an error. Never more than MAX_REMOVED_PER_RUN at once.
 */
async function removeGone(seen) {
  const links = await db.prepare(`SELECT l.saifsys_id, l.document_id FROM saifsys_doc_links l JOIN documents d ON d.id = l.document_id
    WHERE d.status <> 'removed'`).all();
  const gone = links.filter((l) => !seen.has(l.saifsys_id));
  if (!gone.length) return 0;
  if (!seen.size || gone.length > MAX_REMOVED_PER_RUN) {
    console.error(`[saifsys-docs] saifsys no longer lists ${gone.length} documents: too many to hide at once, nothing hidden. Check saifsys.`);
    return 0;
  }
  await db.prepare("UPDATE documents SET status = 'removed' WHERE id = ANY(?::int[])").run(gone.map((l) => l.document_id));
  return gone.length;
}

/**
 * The files stay in saifsys: a copy kept before that was decided (one opened, then saved) is
 * taken off this server, and every copied record is read by everyone inside the company.
 */
async function keepNoFiles() {
  const kept = await db.prepare(`SELECT d.id, d.path FROM documents d JOIN saifsys_doc_links l ON l.document_id = d.id
    WHERE d.path IS NOT NULL`).all();
  for (const k of kept) {
    if (existsSync(k.path)) unlinkSync(k.path);
    await db.prepare('UPDATE documents SET path = NULL, hash = NULL WHERE id = ?').run(k.id);
    await db.prepare('DELETE FROM document_texts WHERE document_id = ?').run(k.id);
  }
  await db.prepare('UPDATE documents SET company_wide = true WHERE NOT company_wide AND id IN (SELECT document_id FROM saifsys_doc_links)').run();
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

/**
 * A document with its file's bytes: { ...doc, buffer, mime, name }. A saifsys document's file is
 * fetched from saifsys now and not kept. Only for someone who may read the document at all;
 * anyone else gets the same 404 as a file that is not there, and saifsys is not asked.
 */
export async function fileFor(user, docId, deps = {}) {
  const doc = await readableDocument(user, docId);
  if (!doc) throw Object.assign(new Error('Not found'), { status: 404 });
  const file = await fileBytes(doc, deps.fetchFile ? { fetchEmployeeFile: deps.fetchFile } : deps);
  return { ...doc, ...file };
}

/** The master's "Sync now" on the Document Renewals screen. */
export async function syncNow(user, deps = {}) {
  if (!isMaster(user)) throw Object.assign(new Error('Only the master can do this'), { status: 403 });
  return syncSaifsysDocsOnce(deps);
}

// One run at a time: the master's button during a timed run must not start a second one.
let running = null;
export function syncSaifsysDocsOnce(deps) {
  running ||= syncSaifsysDocs(deps).finally(() => { running = null; });
  return running;
}

/** Every 15 minutes, and once shortly after start-up. */
export function startSaifsysDocSync() {
  // Then the renewal cases, after a run that changed something: a contract just brought in
  // may be within 60 days of its end.
  const run = (why) => syncSaifsysDocsOnce()
    .then(async (r) => {
      if (!(r.added || r.updated || r.superseded || r.removed)) return;
      console.log(`[saifsys-docs] ${why}:`, JSON.stringify(r), 'cases:', JSON.stringify(await scanCases()));
    })
    .catch((e) => console.error('[saifsys-docs] sync failed:', e.message));
  setTimeout(() => run('after start-up'), 60_000).unref();
  setInterval(() => run('every 15 minutes'), 15 * 60_000).unref();
}
