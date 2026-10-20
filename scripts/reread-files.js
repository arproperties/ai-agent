// Files one person filed before 2026-10-20, brought up to how files are read now.
//
// Court PDFs were kept as the jumbled text their Arabic reads out as, and long scans lost
// their last pages; an agent answering from those misread names, figures and orders. This
// finds that person's PDFs that need their pages read and puts them back in the filing queue,
// which reads them again page by page. Every other file gets its full text kept, from the
// pieces already stored - no AI, no cost - so read_file can page through it and a new upload
// can be recognised as a copy of it.
//
// Without --apply it only reports: how many files, how many pages, and a rough cost.
// Re-reading is paid per page, so look at that before running it.
//
// Usage (on the server):
//   node --env-file=.env scripts/reread-files.js someone@example.com
//   node --env-file=.env scripts/reread-files.js someone@example.com --apply
import { readFileSync } from 'node:fs';
import { db, closeDb } from '../server/db.js';
import { pdfTextLayer } from '../server/knowledge.js';
import { fullText } from '../server/shelf.js';

// Measured reading his court files on 2026-10-20 (Sonnet, a page in, its transcription out).
const DOLLARS_PER_PAGE = 0.03; // 62 pages of court files cost $1.74

const [email, flag] = process.argv.slice(2);
if (!email) { console.error('Usage: scripts/reread-files.js <email> [--apply]'); process.exit(1); }
const apply = flag === '--apply';

const user = await db.prepare('SELECT id, name FROM users WHERE lower(email) = lower(?)').get(email);
if (!user) { console.error(`No user ${email}`); process.exit(1); }

const docs = await db.prepare(`SELECT id, name, path, mime FROM documents
  WHERE user_id = ? AND status = 'ready' AND kind IS DISTINCT FROM 'fact' ORDER BY id`).all(user.id);
const kept = new Set((await db.prepare(`SELECT document_id FROM document_texts t JOIN documents d ON d.id = t.document_id
  WHERE d.user_id = ?`).all(user.id)).map((r) => r.document_id));

const reread = [];
let filled = 0;
for (const d of docs) {
  if (kept.has(d.id)) continue; // filed since 2026-10-20: already read the new way
  const pdf = d.mime === 'application/pdf' || /\.pdf$/i.test(d.name);
  if (pdf && d.path) {
    try {
      const layer = await pdfTextLayer(readFileSync(d.path));
      if (layer.readPages) { reread.push({ ...d, pages: layer.pages, why: layer.why }); continue; }
    } catch (e) {
      console.warn(`  could not open #${d.id} ${d.name}: ${e.message}`);
    }
  }
  if (apply) {
    const text = await fullText(d.id);
    if (text) await db.prepare('INSERT INTO document_texts (document_id, text) VALUES (?, ?) ON CONFLICT DO NOTHING').run(d.id, text);
  }
  filled++;
}

const pages = reread.reduce((n, d) => n + d.pages, 0);
console.log(`${user.name} (${email}): ${docs.length} filed files`);
console.log(`To read again, page by page: ${reread.length} files, ${pages} pages, about $${(pages * DOLLARS_PER_PAGE).toFixed(2)}`);
for (const d of reread) console.log(`  #${d.id} ${d.name} - ${d.pages} p, ${d.why}`);
console.log(`Full text ${apply ? 'kept' : 'to keep'} from what is stored (free): ${filled} files`);

if (apply && reread.length) {
  await db.prepare(`UPDATE documents SET status = 'queued' WHERE id IN (${reread.map(() => '?').join(',')})`).run(...reread.map((d) => d.id));
  console.log(`Queued ${reread.length} files. The app files them a couple at a time; they show as waiting on the Shelf until done.`);
} else if (!apply) {
  console.log('Nothing changed. Run again with --apply to do it.');
}
await closeDb();
