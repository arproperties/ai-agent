// Rebuilds the search index for whatever has no embedding.
//
// Needed after the embedding model changes: db.js clears every vector the old model made
// at boot, and this builds them again from the text, which was never lost. A file is cut
// into pieces afresh while it is at it, so files indexed before the pieces overlapped get
// the overlap too - from the text already stored, without reading the file again. Safe to
// run repeatedly: it only touches what is still missing, so an interrupted run simply
// resumes. The app can stay up meanwhile; search answers by keyword for what is not done.
//
// Usage: npm run backfill-embeddings
import { db, closeDb } from '../server/db.js';
import { embed } from '../server/ai.js';
import { EMBED_MODEL } from '../server/config.js';
import { indexChunks, chunkLabel, stitch } from '../server/knowledge.js';

const BATCH = 32; // same batch size indexChunks uses

const toVecLiteral = (v) => (v ? `[${Array.from(v).join(',')}]` : null);

/** Every file with a piece that has no embedding: cut again from its stored text, and embedded. */
async function reindexDocuments() {
  const ids = (await db.prepare('SELECT DISTINCT document_id id FROM chunks WHERE embedding IS NULL AND document_id IS NOT NULL ORDER BY 1').all()).map((r) => r.id);
  if (!ids.length) { console.log('files: nothing to do'); return; }

  console.log(`files: ${ids.length} to index again`);
  let done = 0;
  for (const id of ids) {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    const rows = await db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY id').all(id);
    // Each piece carries the file's label in front. Normally it is the label the file has
    // now; if the file was renamed since, fall back to whatever is in the first brackets.
    const front = `[${chunkLabel(doc)}] `;
    const pieces = rows.map((r) => (r.text.startsWith(front) ? r.text.slice(front.length) : r.text.replace(/^\[[^\]]*\]\s*/, '')));
    await indexChunks(doc, stitch(pieces));
    process.stdout.write(`  ${++done}/${ids.length}\r`);
  }
  console.log(`files: indexed ${done} again`);
}

/** Rows that stand alone - memories, and pieces that belong to no file - embedded as they are. */
async function backfill(table) {
  const { n: total } = await db.prepare(`SELECT COUNT(*)::int n FROM ${table} WHERE embedding IS NULL`).get();
  if (!total) { console.log(`${table}: nothing to do`); return; }

  console.log(`${table}: ${total} row(s) to embed`);
  const update = db.prepare(`UPDATE ${table} SET embedding = ?::vector, embed_model = ? WHERE id = ?`);
  let done = 0;

  // Re-read each batch rather than paging with OFFSET: the rows stop matching once filled in,
  // so a plain LIMIT always returns the next outstanding ones.
  for (;;) {
    const rows = await db.prepare(`SELECT id, text FROM ${table} WHERE embedding IS NULL ORDER BY id LIMIT ${BATCH}`).all();
    if (!rows.length) break;
    const vectors = await embed(rows.map((r) => r.text));
    for (const [i, row] of rows.entries()) await update.run(toVecLiteral(vectors[i]), EMBED_MODEL, row.id);
    done += rows.length;
    process.stdout.write(`  ${done}/${total}\r`);
  }
  console.log(`${table}: embedded ${done}`);
}

// Without the model there is nothing to do but leave every row as it is for a later run.
if (!(await embed(['ready?']))[0]) {
  console.error('The local embedding model did not load, so nothing was changed. Search still works on keywords.');
  await closeDb();
  process.exit(1);
}

await reindexDocuments();
await backfill('chunks');
await backfill('memories');

await closeDb();
console.log('\nDone.');
process.exit(0);
