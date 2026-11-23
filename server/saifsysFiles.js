import { readFileSync, existsSync } from 'node:fs';
import { db } from './db.js';
import { fetchEmployeeFile } from './saifsysDocSync.js';
import { fetchCompanyFile } from './saifsysCompanyDocs.js';
import { extractText, describeImage, IMAGE_TYPES } from './knowledge.js';

// saifsys's documents stay in saifsys (Francis, 2026-11-23): Reem keeps their details (name,
// number, dates) so search and expiry alerts work, never the files. When someone opens one,
// reads one in chat or attaches one to an email, the file is fetched from saifsys there and
// then and handed on, not saved. For a little while it is held in memory only, so opening a
// passport and then reading it in chat does not ask saifsys twice.

const HOLD_MS = 5 * 60_000;
const HOLD_BYTES = 40 * 1024 * 1024; // the server has 2 GB; a few scans at most
const held = new Map(); // doc id -> { at, file }
const heldText = new Map(); // doc id -> { at, text }

function forget() {
  const now = Date.now();
  for (const m of [held, heldText]) for (const [k, v] of m) if (now - v.at > HOLD_MS) m.delete(k);
  let size = [...held.values()].reduce((n, v) => n + v.file.buffer.length, 0);
  for (const [k, v] of held) { if (size <= HOLD_BYTES) break; size -= v.file.buffer.length; held.delete(k); }
}

/** Which saifsys document a Shelf file stands for, or null when it is a file of Reem's own. */
export async function saifsysLink(docId) {
  const e = await db.prepare('SELECT saifsys_id FROM saifsys_doc_links WHERE document_id = ?').get(docId);
  if (e) return { kind: 'employee', id: e.saifsys_id };
  const c = await db.prepare('SELECT saifsys_id, version_no FROM saifsys_company_doc_links WHERE document_id = ?').get(docId);
  if (c) return { kind: 'company', id: c.saifsys_id, version: c.version_no };
  return null;
}

/**
 * A document's file as { buffer, mime, name }: from saifsys for a saifsys document, else the
 * file Reem keeps. Throws a 404 when there is none. `deps` lets tests stand in for saifsys.
 */
export async function fileBytes(doc, deps = {}) {
  const link = await saifsysLink(doc.id);
  if (!link) {
    if (!doc.path || !existsSync(doc.path)) throw Object.assign(new Error(`${doc.name || 'This file'} has no file`), { status: 404 });
    return { buffer: readFileSync(doc.path), mime: doc.mime || 'application/octet-stream', name: doc.name };
  }
  forget();
  const hit = held.get(doc.id);
  if (hit) return hit.file;
  let got;
  try {
    got = link.kind === 'employee'
      ? await (deps.fetchEmployeeFile || fetchEmployeeFile)(link.id)
      : await (deps.fetchCompanyFile || fetchCompanyFile)(link.id, link.version || null);
  } catch (e) {
    console.error(`[saifsys-files] #${doc.id} not fetched from saifsys:`, e.message);
    throw Object.assign(new Error('saifsys has no file for this document, or could not be reached'), { status: 404 });
  }
  const file = { buffer: got.buffer, mime: got.mime || doc.mime || 'application/octet-stream', name: doc.name || `saifsys-${link.id}` };
  held.set(doc.id, { at: Date.now(), file });
  return file;
}

/** What a saifsys document says, read from its file now (a scan described). Not kept. */
export async function saifsysText(doc, deps = {}) {
  forget();
  const hit = heldText.get(doc.id);
  if (hit) return hit.text;
  const file = await fileBytes(doc, deps);
  const read = deps.read || (({ buffer, mime, name }) => (IMAGE_TYPES.includes(mime)
    ? describeImage({ buffer, mimetype: mime })
    : extractText({ buffer, mimetype: mime, originalname: name })));
  const text = String(await read(file) || '').replace(/\u0000/g, '').trim();
  heldText.set(doc.id, { at: Date.now(), text });
  return text;
}

/** Tests start from nothing held. */
export function forgetHeld() { held.clear(); heldText.clear(); }
