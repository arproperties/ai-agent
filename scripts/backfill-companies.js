// Works out the company for files filed before companies were recorded.
//
// Reads each file's indexed text back out of chunks (the original is not re-parsed) and
// asks the same question an upload does. Only touches rows whose company is NULL, so it
// is safe to re-run; a file that genuinely names no company is simply asked again.
//
// Usage: npm run backfill-companies
import { db, closeDb } from '../server/db.js';
import { findCompany, userCompanies } from '../server/files.js';

const docs = await db.prepare(`SELECT id, user_id, name, title, summary FROM documents
  WHERE company IS NULL AND status = 'ready' ORDER BY user_id, id`).all();
console.log(`${docs.length} file(s) to check`);

let found = 0;
for (const d of docs) {
  const chunks = await db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY id').all(d.id);
  const text = [d.title, d.summary, ...chunks.map((c) => c.text)].filter(Boolean).join('\n\n');
  try {
    // Re-read per file so a company found a moment ago is offered for the next one.
    const company = await findCompany(d.name, text, await userCompanies(d.user_id));
    if (company) {
      await db.prepare('UPDATE documents SET company = ? WHERE id = ?').run(company, d.id);
      found++;
    }
    console.log(`  #${d.id} ${d.title} -> ${company ?? 'Other'}`);
  } catch (e) {
    console.error(`  #${d.id} ${d.title}: ${e.message}`);
  }
}
console.log(`done: ${found} filed under a company, ${docs.length - found} left as Other`);
await closeDb();
