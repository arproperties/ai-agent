import { Router } from 'express';
import { db, tx } from './db.js';
import { requireMaster } from './auth.js';

// Whose files a person may read besides their own: "Rona can see Said's files".
//
// The master sets it per person. It reaches everything that reads files through
// retrievalScope() - the Shelf, search_files, opening a file, recall - and nothing that
// changes one: rename, move, delete and share stay with the file's owner.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** The people whose files this person may read, by name. */
export const ownersFor = (viewerId) =>
  db.prepare(`SELECT u.id, u.name, u.email FROM file_access f JOIN users u ON u.id = f.owner_id
    WHERE f.viewer_id = ? ORDER BY lower(u.name)`).all(Number(viewerId));

/** Replace the list in one go: the screen sends every ticked person. */
export async function setOwners(master, viewerId, ownerIds) {
  const viewer = await db.prepare('SELECT id, external FROM users WHERE id = ?').get(Number(viewerId));
  if (!viewer) throw bad('User not found', 404);
  const ids = [...new Set((Array.isArray(ownerIds) ? ownerIds : []).map(Number).filter((n) => Number.isInteger(n) && n !== viewer.id))];
  // Someone external neither reads anyone's files nor has theirs read (access.js).
  if (viewer.external && ids.length) throw bad('This person is external: they see only their own files');
  const known = ids.length ? await db.prepare('SELECT id FROM users WHERE id = ANY(?::int[]) AND NOT external').all(ids) : [];
  await tx(async () => {
    await db.prepare('DELETE FROM file_access WHERE viewer_id = ?').run(viewer.id);
    for (const { id } of known) {
      await db.prepare('INSERT INTO file_access (viewer_id, owner_id, granted_by) VALUES (?, ?, ?)').run(viewer.id, id, master.id);
    }
  });
  return ownersFor(viewer.id);
}

// ---------- routes (master only) ----------

export const fileAccessRoutes = Router();
fileAccessRoutes.use(requireMaster);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

fileAccessRoutes.get('/user/:id', wrap(async (req, res) => res.json(await ownersFor(req.params.id))));
fileAccessRoutes.put('/user/:id', wrap(async (req, res) => res.json(await setOwners(req.user, req.params.id, req.body?.owners))));
