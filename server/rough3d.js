import { readFileSync } from 'node:fs';
import { readableDocument } from './files.js';
import { isDrawing, roughModel } from './dwg.js';

// The last few rough models made, so opening the same drawing again is instant instead of
// converting it again. Keyed by the file's bytes as well, in case it is ever replaced.
const made = new Map();

/**
 * The rough 3D walls of a DWG/DXF the person may open (the same reach as opening the file
 * itself, readableDocument), or null when they may not or it is not a drawing.
 */
export async function roughModelFor(user, docId) {
  const doc = await readableDocument(user, docId);
  if (!doc?.path || !isDrawing(doc.name)) return null;
  const key = `${doc.id}:${doc.hash || doc.size}`;
  if (made.has(key)) return made.get(key);
  const model = await roughModel(readFileSync(doc.path), doc.name);
  made.set(key, model);
  if (made.size > 5) made.delete(made.keys().next().value);
  return model;
}
