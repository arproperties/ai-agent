// Works out the expiry date for files filed before expiries were recorded.
//
// Reads each file's indexed text back out of chunks (the original is not re-parsed) and
// asks the same question an upload now asks. Only touches rows whose expires_on is NULL,
// so it is safe to re-run.
//
// Only the folders where paper actually runs out are asked about. Every file costs one
// Claude call, and an invoice or a photograph has no expiry to find - asking about the
// whole shelf would be paying to be told null. Anything the folders miss can still be
// set by hand on the file itself.
//
// Prints what it would do and changes nothing until you add --apply:
//   node scripts/backfill-expiry.js
//   node scripts/backfill-expiry.js --apply
import { db, closeDb } from '../server/db.js';
import { findExpiry } from '../server/files.js';

const apply = process.argv.includes('--apply');

const FOLDERS = ['Company & Licenses', 'IDs & Personal', 'Tenancy & Property', 'Contracts & Agreements', 'HR & Employees', 'Legal'];

const docs = await db.prepare(`SELECT id, user_id, name, title, summary FROM documents
  WHERE expires_on IS NULL AND status = 'ready' AND kind IS DISTINCT FROM 'fact'
    AND folder = ANY(?::text[]) ORDER BY user_id, id`).all(FOLDERS);

console.log(`${docs.length} file(s) to check, in: ${FOLDERS.join(', ')}`);
if (!docs.length) { await closeDb(); process.exit(0); }
if (!apply) {
  console.log('\nDry run - nothing will be changed and no Claude calls are made.');
  console.log(`Running with --apply costs ${docs.length} Claude call(s), one per file:\n`);
  for (const d of docs) console.log(`  #${d.id} ${d.title || d.name}`);
  console.log('\nRe-run with --apply to do it.');
  await closeDb();
  process.exit(0);
}

let found = 0;
for (const d of docs) {
  const chunks = await db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY id').all(d.id);
  const text = [d.title, d.summary, ...chunks.map((c) => c.text)].filter(Boolean).join('\n\n');
  try {
    const expires = await findExpiry(d.name, text);
    if (expires) {
      await db.prepare('UPDATE documents SET expires_on = ? WHERE id = ?').run(expires, d.id);
      found++;
    }
    console.log(`  #${d.id} ${d.title || d.name} -> ${expires ?? 'does not expire'}`);
  } catch (e) {
    console.error(`  #${d.id} ${d.title || d.name}: ${e.message}`);
  }
}
console.log(`done: ${found} with an expiry, ${docs.length - found} that do not run out`);
await closeDb();
