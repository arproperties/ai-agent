import { Router } from 'express';
import { db } from './db.js';
import { isExternal } from './access.js';
import { DOC_SELECT, docOut, deleteDocument } from './files.js';
import { cardsFor, decide, refresh, getPattern, setPattern } from './caseFolders.js';

// /api/cases: the case folder cards from the chat, and the folders themselves on the Shelf.
// Only for someone from outside the company; anyone else is told it does not exist.

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// A typed name is used as typed, only made safe as a folder name (as on Save).
const literalName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();

/** This user's folder, or a 404: someone else's folder does not exist for them. */
export async function ownFolder(userId, id) {
  const f = await db.prepare('SELECT * FROM case_folders WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);
  if (!f) throw bad('Not found', 404);
  return f;
}

/** The user's folders as the Shelf shows them, each with its files, newest change first. */
async function foldersOut(userId, only = null) {
  const folders = await db.prepare(`SELECT f.*, (SELECT COUNT(*)::int FROM case_emails e WHERE e.folder_id = f.id) email_count
    FROM case_folders f WHERE f.user_id = ? AND (?::int IS NULL OR f.id = ?)
    ORDER BY COALESCE(f.updated_at, f.created_at) DESC, f.id DESC`).all(userId, only, only);
  const docs = folders.length
    ? await db.prepare(`${DOC_SELECT} WHERE d.user_id = ? AND d.case_folder_id = ANY(?::int[]) ORDER BY d.created_at, d.id`).all(userId, folders.map((f) => f.id))
    : [];
  return folders.map((f) => ({
    id: f.id, name: f.name, case_number: f.case_number, party_a: f.party_a, party_b: f.party_b,
    tracking: f.tracking, share_on: f.share_on, new_count: f.new_count, last_checked_at: f.last_checked_at,
    last_error: f.last_error, updated_at: f.updated_at, email_count: f.email_count,
    // The case PDF first, then the rest as they were filed.
    files: docs.filter((d) => d.case_folder_id === f.id)
      .sort((a, b) => (b.id === f.summary_doc_id) - (a.id === f.summary_doc_id))
      .map((d) => docOut(d, userId)),
  }));
}
const oneOut = async (userId, id) => (await foldersOut(userId, Number(id)))[0];

/**
 * The folder and the files it made. A file the user already had before the case (linked in
 * by Save, not copied) is only taken out of the case, never deleted with it.
 */
async function deleteFolder(userId, id) {
  const f = await ownFolder(userId, id);
  // Only a file the case itself made is deleted; anything else in the folder is the user's own.
  const docs = await db.prepare('SELECT id, case_made FROM documents WHERE user_id = ? AND case_folder_id = ?').all(userId, f.id);
  for (const d of docs) {
    if (d.case_made) await deleteDocument(userId, d.id);
    else await db.prepare('UPDATE documents SET case_folder_id = NULL WHERE id = ?').run(d.id);
  }
  await db.prepare('DELETE FROM case_folders WHERE id = ?').run(f.id); // its case_emails go with it
}

/** deps: { mailbox, ask } - only tests pass them; the app uses the real ones. */
export function caseRouter(deps = {}) {
  const r = Router();
  r.use((req, res, next) => (isExternal(req.user) ? next() : res.status(404).json({ error: 'Not found' })));

  // The cards got ready in one chat, whatever became of them.
  r.get('/proposals', wrap(async (req, res) => res.json(await cardsFor(req.user, Number(req.query.conversation) || 0))));
  r.post('/proposals/:id/save', wrap(async (req, res) => {
    const { name, full_pdf: fullPdf, per_email: perEmail, exclude } = req.body || {};
    send(res, await decide(req.user, req.params.id, { save: true, name, full_pdf: fullPdf, per_email: perEmail, exclude }, deps));
  }));
  r.post('/proposals/:id/cancel', wrap(async (req, res) => send(res, await decide(req.user, req.params.id, { save: false }, deps))));

  // The name pattern new folders are named by.
  r.get('/settings', wrap(async (req, res) => res.json({ pattern: await getPattern(req.user.id) })));
  r.put('/settings', wrap(async (req, res) => res.json({ pattern: await setPattern(req.user.id, req.body?.pattern) })));

  // The folders on the Shelf.
  r.get('/', wrap(async (req, res) => res.json(await foldersOut(req.user.id))));

  // Rename, or stop / start keeping it up to date. The case is found by its key, so a new
  // name changes nothing about which emails belong to it.
  r.patch('/:id', wrap(async (req, res) => {
    const f = await ownFolder(req.user.id, req.params.id);
    const { name, tracking } = req.body || {};
    if (name !== undefined) {
      const n = literalName(name);
      if (!n) throw bad('Give the folder a name');
      await db.prepare('UPDATE case_folders SET name = ? WHERE id = ?').run(n, f.id);
    }
    if (tracking !== undefined) await db.prepare('UPDATE case_folders SET tracking = ? WHERE id = ?').run(!!tracking, f.id);
    res.json(await oneOut(req.user.id, f.id));
  }));

  // Opened: the "new" badge goes.
  r.post('/:id/seen', wrap(async (req, res) => {
    const f = await ownFolder(req.user.id, req.params.id);
    await db.prepare('UPDATE case_folders SET new_count = 0 WHERE id = ?').run(f.id);
    res.json({ ok: true });
  }));

  // Update now, without waiting for the watcher.
  r.post('/:id/update', wrap(async (req, res) => {
    const f = await ownFolder(req.user.id, req.params.id);
    res.json(await refresh(req.user, f.id, deps));
  }));

  r.delete('/:id', wrap(async (req, res) => {
    await deleteFolder(req.user.id, req.params.id);
    res.json({ ok: true });
  }));
  return r;
}

export const caseRoutes = caseRouter();
