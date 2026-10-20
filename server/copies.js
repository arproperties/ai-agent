import { db } from './db.js';

// The same document filed twice under different names: a judgment downloaded from the court
// portal and again from a lawyer's email, a scan made a second time. Byte-for-byte copies
// never get this far (saveUpload refuses them); these differ in the bytes but say the same
// thing. An agent that read both reported "conflicts" between a file and itself, so a later
// copy is marked as one, and read_file says so.
//
// Only a near-whole match counts. A judgment on appeal quotes the one it reviews at length,
// and those are two documents; a missed copy costs a little confusion, a wrong one hides a
// decision. So the bar is high and the lengths must be close.

const SAME = 0.5; // share of word pairs in common, of all the pairs either has
const MIN_CHARS = 500; // a photo caption or a one-line note is too short to tell
const CLOSE_LENGTH = 0.3; // within 30% of each other's length

// Two readings of one page differ in more than the words: page marks, punctuation, vowel
// signs, and in Arabic the stretching stroke (ـ) and how alef, ya and ta marbuta are written.
// Measured on two downloads of one 15-page judgment: 28% alike before this, 70% after;
// different judgments in the same case stayed at 2%.
const words = (text) => String(text || '')
  .replace(/--- Page \d+ ---/g, ' ')
  .replace(/\u0640/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
  .normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim().split(' ').filter(Boolean);

function pairs(text) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
}

/** How alike two texts are, 0 to 1. */
export function likeness(a, b) {
  const ta = pairs(a);
  const tb = pairs(b);
  if (!ta.size || !tb.size) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both);
}

/**
 * Keep a filed document's text, and mark it as a copy when the same person already has
 * the same document. Returns the id it copies, or null.
 */
export async function keepText(doc, text) {
  await db.prepare(`INSERT INTO document_texts (document_id, text) VALUES (?, ?)
    ON CONFLICT (document_id) DO UPDATE SET text = EXCLUDED.text`).run(doc.id, text);
  await db.prepare('DELETE FROM document_copies WHERE document_id = ?').run(doc.id);
  if (text.length < MIN_CHARS) return null;
  // Compared only with originals, so a third copy points at the first, not the second.
  const others = await db.prepare(`SELECT d.id, t.text FROM documents d JOIN document_texts t ON t.document_id = d.id
    WHERE d.user_id = ? AND d.id <> ? AND d.status = 'ready'
      AND length(t.text) BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM document_copies c WHERE c.document_id = d.id)
    ORDER BY d.id LIMIT 50`)
    .all(doc.user_id, doc.id, Math.floor(text.length * (1 - CLOSE_LENGTH)), Math.ceil(text.length * (1 + CLOSE_LENGTH)));
  const same = others.find((o) => likeness(text, o.text) >= SAME);
  if (!same) return null;
  await db.prepare('INSERT INTO document_copies (document_id, same_as) VALUES (?, ?)').run(doc.id, same.id);
  return same.id;
}

/** Copy marks for these documents, as a Map of id → the id it copies. */
export async function copiesOf(ids) {
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT document_id, same_as FROM document_copies WHERE document_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((r) => [r.document_id, r.same_as]));
}
