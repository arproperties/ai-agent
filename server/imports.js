import { Router } from 'express';
import multer from 'multer';
import { readFileSync } from 'node:fs';
import { db } from './db.js';
import { saveUpload, processDocument } from './files.js';
import { chatAgents } from './access.js';

// Importing a whole folder or ZIP (a WhatsApp export, say: thousands of files). The browser
// unpacks it, leaves out what Jarvis does not read, and sends the rest ten at a time. Each
// file is stored straight away as 'queued' and filed from here in the background, a couple
// at a time, so the upload never waits on Claude and a restart picks up where it stopped.

const CONCURRENCY = 2; // Claude calls at once: gentle on rate limits and on the server's 2 GB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

// What the browser may report as left out, and nothing else.
export const IGNORED_KINDS = ['voice', 'excel', 'contacts', 'videos', 'archives', 'large', 'other', 'failed'];
export function cleanIgnored(raw) {
  const out = {};
  for (const k of IGNORED_KINDS) {
    const n = Math.floor(Number(raw?.[k]));
    if (n > 0) out[k] = Math.min(n, 1e6);
  }
  return out;
}

/**
 * Failures that are Claude's state, not the file's: out of credit, rate-limited, overloaded
 * or unreachable. The file goes back in the queue and the queue waits, instead of every file
 * behind it being marked unreadable. null means the file itself is the problem.
 */
export function pauseFor(message) {
  const m = String(message || '');
  if (/credit balance/i.test(m)) return { reason: 'credits', ms: 5 * 60_000 };
  if (/rate.?limit|overloaded|\b(429|500|502|503|529)\b|api_error|connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(m)) {
    return { reason: 'busy', ms: 30_000 };
  }
  return null;
}

// ---------- the queue ----------

let running = 0;
let pausedUntil = 0;
let pauseReason = null;
let timer = null;

/** Only one worker can take a given file: the claim is a row update, like the outbox's. */
const claim = () => db.prepare(`UPDATE documents SET status = 'processing' WHERE id = (
    SELECT id FROM documents WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) RETURNING *`).get();

async function fileOne(doc) {
  let f;
  try {
    f = { buffer: readFileSync(doc.path), mimetype: doc.mime, originalname: doc.name, size: doc.size };
  } catch {
    await db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run('The uploaded file is missing', doc.id);
    return;
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(doc.user_id);
  if (!user) return;
  // processDocument records its own failure on the row; read it back to tell a bad file
  // from a Claude that could not be reached.
  await processDocument(doc, f, undefined, doc.agent_id ? [] : await chatAgents(user));
  const after = await db.prepare('SELECT status, error FROM documents WHERE id = ?').get(doc.id);
  const pause = after?.status === 'error' && pauseFor(after.error);
  if (pause) {
    await db.prepare("UPDATE documents SET status = 'queued', error = NULL WHERE id = ? AND status = 'error'").run(doc.id);
    if (Date.now() + pause.ms > pausedUntil) {
      pausedUntil = Date.now() + pause.ms;
      pauseReason = pause.reason;
      console.warn('[imports] paused:', after.error);
      setTimeout(kickImports, pause.ms + 1000).unref();
    }
  } else if (after?.status === 'ready') {
    pauseReason = null;
  }
}

async function worker() {
  while (Date.now() >= pausedUntil) {
    const doc = await claim();
    if (!doc) return;
    await fileOne(doc).catch((e) => console.error('[imports]', doc.name, e.message));
  }
}

/** Start workers up to the limit. Cheap to call often: idle workers find nothing and stop. */
export function kickImports() {
  while (running < CONCURRENCY && Date.now() >= pausedUntil) {
    running++;
    worker().catch((e) => console.error('[imports]', e.message)).finally(() => { running--; });
  }
}

export async function startImportQueue() {
  if (timer) return;
  // A stopped process leaves the files it was filing half-done. Only imported ones go back:
  // files attached in chat are filed by the request that brought them, not by this queue.
  const back = await db.prepare(`UPDATE documents SET status = 'queued' WHERE status = 'processing' AND import_id IS NOT NULL`).run();
  if (back.changes) console.warn('[imports]', back.changes, 'file(s) left mid-filing are back in the queue');
  timer = setInterval(kickImports, 60_000);
  timer.unref();
  kickImports();
}

// ---------- progress ----------

export async function importsFor(userId) {
  const rows = await db.prepare(`SELECT i.id, i.name, i.added, i.duplicates, i.ignored, i.uploaded, i.updated_at,
      COUNT(d.id) FILTER (WHERE d.status IN ('queued', 'processing'))::int AS waiting,
      COUNT(d.id) FILTER (WHERE d.status = 'ready')::int AS filed,
      COUNT(d.id) FILTER (WHERE d.status = 'error')::int AS failed
    FROM imports i LEFT JOIN documents d ON d.import_id = i.id
    WHERE i.user_id = ? AND NOT i.dismissed
    GROUP BY i.id ORDER BY i.id DESC LIMIT 5`).all(userId);
  const now = Math.floor(Date.now() / 1000);
  const paused = Date.now() < pausedUntil ? pauseReason : null;
  return rows.map(({ ignored, updated_at: updated, ...r }) => ({
    ...r,
    ignored: JSON.parse(ignored),
    // the browser sends the files; if it went away mid-upload, say so rather than wait forever
    stalled: !r.uploaded && now - Number(updated) > 10 * 60,
    paused: r.waiting ? paused : null,
  }));
}

// ---------- routes ----------

async function ownImport(req) {
  const id = Number(req.params.id);
  return id ? db.prepare('SELECT * FROM imports WHERE id = ? AND user_id = ?').get(id, req.user.id) : null;
}
const notFound = (res) => res.status(404).json({ error: 'Not found' });

export const importRoutes = Router();

importRoutes.get('/', async (req, res) => res.json(await importsFor(req.user.id)));

importRoutes.post('/', async (req, res) => {
  const name = String(req.body.name || 'Import').trim().slice(0, 200) || 'Import';
  const { id } = await db.prepare('INSERT INTO imports (user_id, name, ignored) VALUES (?, ?, ?) RETURNING id')
    .run(req.user.id, name, JSON.stringify(cleanIgnored(req.body.ignored)));
  res.json({ id });
});

importRoutes.post('/:id/files', upload.array('files', 10), async (req, res) => {
  const imp = await ownImport(req);
  if (!imp) return notFound(res);
  let added = 0;
  let duplicates = 0;
  // One at a time: two copies of the same file in one batch must meet the dedup check in turn.
  for (const f of req.files || []) {
    const { doc, duplicate } = await saveUpload(req.user.id, null, f);
    if (duplicate) { duplicates++; continue; }
    await db.prepare(`UPDATE documents SET status = 'queued', import_id = ? WHERE id = ?`).run(imp.id, doc.id);
    added++;
  }
  await db.prepare(`UPDATE imports SET added = added + ?, duplicates = duplicates + ?, updated_at = extract(epoch from now())::bigint WHERE id = ?`)
    .run(added, duplicates, imp.id);
  kickImports();
  res.json({ added, duplicates });
});

importRoutes.post('/:id/done', async (req, res) => {
  const imp = await ownImport(req);
  if (!imp) return notFound(res);
  await db.prepare(`UPDATE imports SET uploaded = true, ignored = ?, updated_at = extract(epoch from now())::bigint WHERE id = ?`)
    .run(JSON.stringify(cleanIgnored(req.body.ignored)), imp.id);
  res.json({ ok: true });
});

importRoutes.post('/:id/dismiss', async (req, res) => {
  const imp = await ownImport(req);
  if (!imp) return notFound(res);
  await db.prepare('UPDATE imports SET dismissed = true WHERE id = ?').run(imp.id);
  res.json({ ok: true });
});
