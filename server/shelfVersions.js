// A new version of a form saved from a chat, and the older copy it replaces. The Ayla AC
// checklist was made over again in chats (indoor and outdoor, then indoor only), each copy
// saved beside the last, and staff were handed two forms for one job. Saving now asks
// whether the new copy replaces the older one; a Yes marks the old one OLD (superseded_by),
// the same mark the Shelf, search and chat already treat as "replaced, use the new one".
import { db } from './db.js';

// Words that say nothing about which form a title names.
const FILLER = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'pdf']);

/**
 * The words that name a form. What is in brackets is left out: that is the version
 * ("(Level 2)", "(Indoor Unit Only)"), and two versions of one form differ exactly there.
 */
export function titleWords(title) {
  const plain = String(title || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return new Set(plain.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w)));
}

const shared = (a, b) => [...a].filter((w) => b.has(w)).length;

/** Two titles name the same form: nearly all of their words are the same. */
export function sameForm(a, b) {
  const x = titleWords(a), y = titleWords(b);
  if (x.size < 2 || y.size < 2) return false;
  return shared(x, y) / new Set([...x, ...y]).size >= 0.75;
}

/**
 * The person's current files that the new one (`doc`, titled `title`) may replace, newest
 * first, at most three. Two ways in: a file the reply names by its number ("file #8046",
 * what it was made from) when the two titles have something in common, and a file whose
 * title names the same form. Only their own files, never a fact, never one already OLD.
 */
export async function olderVersions(userId, doc, title, text = '') {
  if (!doc || doc.superseded_by) return [];
  const rows = await db.prepare(`SELECT id, title, name, created_at FROM documents
    WHERE user_id = ? AND id <> ? AND superseded_by IS NULL AND status = 'ready'
      AND kind IS DISTINCT FROM 'fact' AND path IS NOT NULL
    ORDER BY id DESC LIMIT 3000`).all(userId, doc.id);
  const named = new Set([...String(text).matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
  const words = titleWords(title);
  const found = rows.filter((r) => {
    const own = r.title || r.name;
    if (named.has(r.id)) return shared(words, titleWords(own)) >= 2;
    return sameForm(title, own) || sameForm(title, r.name);
  });
  return found.slice(0, 3).map((r) => ({ id: r.id, title: r.title || r.name, name: r.name, created_at: r.created_at }));
}

/**
 * Mark `oldId` OLD, replaced by `newId`. Both must be the person's own, current files, and
 * not the same one. Returns false when nothing was marked.
 */
export async function markReplaced(userId, newId, oldId) {
  newId = Number(newId) || 0; oldId = Number(oldId) || 0;
  if (!newId || !oldId || newId === oldId) return false;
  const fresh = await db.prepare(`SELECT id FROM documents WHERE id = ? AND user_id = ? AND superseded_by IS NULL
    AND kind IS DISTINCT FROM 'fact'`).get(newId, userId);
  if (!fresh) return false;
  const r = await db.prepare(`UPDATE documents SET superseded_by = ? WHERE id = ? AND user_id = ?
    AND superseded_by IS NULL AND kind IS DISTINCT FROM 'fact'`).run(newId, oldId, userId);
  return r.changes > 0;
}
