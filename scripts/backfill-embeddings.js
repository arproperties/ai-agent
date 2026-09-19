// Re-embeds any chunk or memory whose embedding is NULL.
//
// Needed once after the move to pgvector: the old float32 BYTEA vectors cannot be cast to
// vector() in SQL, so the migration in db.js drops the column and this rebuilds it from the
// text, which was never lost. Safe to run repeatedly — it only touches NULL rows, so an
// interrupted run simply resumes.
//
// Usage: npm run backfill-embeddings
import { db, closeDb } from '../server/db.js';
import { embed } from '../server/ai.js';

const BATCH = 32; // same batch size indexChunks uses

const toVecLiteral = (v) => (v ? `[${Array.from(v).join(',')}]` : null);

async function backfill(table) {
  const { n: total } = await db.prepare(`SELECT COUNT(*)::int n FROM ${table} WHERE embedding IS NULL`).get();
  if (!total) { console.log(`${table}: nothing to do`); return { done: 0, skipped: 0 }; }

  console.log(`${table}: ${total} row(s) to embed`);
  const update = db.prepare(`UPDATE ${table} SET embedding = ?::vector WHERE id = ?`);
  let done = 0;
  let skipped = 0;

  // Re-read each batch rather than paging with OFFSET: the rows stop matching once filled in,
  // so a plain LIMIT always returns the next outstanding ones.
  for (;;) {
    const rows = await db.prepare(`SELECT id, text FROM ${table} WHERE embedding IS NULL ORDER BY id LIMIT ${BATCH}`).all();
    if (!rows.length) break;

    const vectors = await embed(rows.map((r) => r.text));
    let progressed = false;
    for (const [i, row] of rows.entries()) {
      const lit = toVecLiteral(vectors[i]);
      if (!lit) { skipped++; continue; } // embedder unavailable; leave it for a later run
      await update.run(lit, row.id);
      done++;
      progressed = true;
    }
    if (!progressed) break; // embedder is down: stop rather than spin on the same rows
    process.stdout.write(`  ${done}/${total}\r`);
  }

  console.log(`${table}: embedded ${done}${skipped ? `, skipped ${skipped}` : ''}`);
  return { done, skipped };
}

const chunks = await backfill('chunks');
const memories = await backfill('memories');

if (chunks.skipped || memories.skipped) {
  console.error('\nSome rows were skipped because the local embedding model was unavailable.');
  console.error('Search still works on keywords for those rows. Re-run this once it loads.');
}

await closeDb();
console.log('\nDone.');
process.exit(chunks.skipped || memories.skipped ? 1 : 0);
