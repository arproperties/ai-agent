import { mkdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { saveUpload } from './files.js';
import { kickImports } from './imports.js';
import { videoSeconds, FRAME_AT } from './knowledge.js';
import { caseKey, caseRegex } from './caseMatch.js';
import { userModules } from './modules.js';
import { dropboxLink, kindOf, gather, MIME } from './dropboxFiles.js';

export { dropboxLink, kindOf };

// A Dropbox link pasted in a chat. Reem says "reading it now" and gets on with it: the
// file or folder is downloaded on the server (zips inside it opened too), sorted into the
// case it is about, and every file goes into the import queue a folder upload uses
// (imports.js): read in the background, a file already on their Shelf skipped, and a
// restart carrying on where it stopped. When the last file is read, the chat it was pasted
// in gets a message and their phone a notification (imports.js, announceFinished).
//
// The people who use this are clients, not the ones paying: no cost is shown and nothing
// waits for a yes. What it cost is logged on the server and shows in Billing.

const WORK_DIR = `${DATA_DIR}/dropbox`;

// ---------- what it costs (for the server log, never shown in the chat) ----------

// US dollars, from what Reem pays on live: filing a file is one Haiku call (~$0.0056); a
// scanned page is read as a picture by Sonnet 5 (~2,500 tokens in, ~900 out at $2/$10 a
// million); a photo is one description; a video is its sound turned into text plus a few
// stills. Text pages are read on the server and cost nothing.
export const PRICE = { file: 0.0056, scannedPage: 0.014, image: 0.005, videoMinute: 0.003, frame: 0.005 };

export function estimate({ files = 0, scannedPages = 0, images = 0, videoMinutes = 0, videos = 0 }) {
  return files * PRICE.file + scannedPages * PRICE.scannedPage + images * PRICE.image
    + videoMinutes * PRICE.videoMinute + videos * FRAME_AT.length * PRICE.frame;
}

// ---------- which case it is about ----------

/**
 * The one case folder the files are about: the folder whose case number turns up most in
 * the folder's own name, its file names and the text of its PDFs. null when none does, or
 * when two cases turn up equally.
 */
export function matchCase(folders, texts) {
  const all = texts.filter(Boolean);
  const scored = folders.map((f) => {
    const re = caseRegex(f.case_number);
    return { f, hits: all.filter((t) => re.test(t)).length };
  }).filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!scored.length || (scored[1] && scored[1].hits === scored[0].hits)) return null;
  return scored[0].f;
}

/** The case folder of the case a chat is about (caseFocus.js), if they have one. */
function folderOfCase(folders, number) {
  if (!number) return null;
  const re = caseRegex(number);
  return folders.find((f) => f.case_key === caseKey(number)) || folders.find((f) => re.test(f.case_number)) || null;
}

// ---------- the file work, in a worker ----------

/**
 * Download, unzip, fingerprint and count in a worker thread whose memory is capped and given
 * back when it ends (dropboxWorker.js). Tests hand in their own download and run it here.
 */
function gatherIn(link, dir, known, deps) {
  if (deps.download) return gather(link, dir, { known }, deps);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./dropboxWorker.js', import.meta.url), {
      workerData: { link, dir, known }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.ok)));
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error('the folder was too big to unpack in one go')));
  });
}

/** "8,030 .dcm files" rather than 8,030 names: what the chat says Reem left out. */
export function skippedSummary(names) {
  const byExt = new Map();
  for (const n of names) {
    const ext = (extname(n).slice(1) || 'other').toLowerCase();
    byExt.set(ext, [...(byExt.get(ext) || []), n]);
  }
  return [...byExt].sort((a, b) => b[1].length - a[1].length).map(([ext, list]) => (list.length > 3
    ? `${list.length.toLocaleString('en')} ${ext === 'other' ? '' : `.${ext} `}files`
    : list.map((n) => n.split('/').pop()).join(', ')));
}

/**
 * At start-up: a download a restart cut short has lost its files, so its chat is told to
 * send the link again (the queue's announcement), and what it left on disk goes.
 */
export async function clearDropboxWork() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  await db.prepare(`UPDATE imports SET uploaded = true, error = 'the server restarted while it was downloading'
    WHERE NOT uploaded AND conversation_id IS NOT NULL AND name = 'Dropbox'`).run();
}

// ---------- the work ----------

/**
 * Download a link and put every file in the queue for the person's Shelf. Run in the
 * background by startDropbox(); `imp` is the imports row already made for it.
 */
export async function fetchDropbox(user, imp, url, { caseNumber = null } = {}, deps = {}) {
  const link = dropboxLink(url);
  const dir = join(WORK_DIR, String(user.id), randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true });
  try {
    const known = (await db.prepare('SELECT hash FROM documents WHERE user_id = ? AND hash IS NOT NULL').all(user.id)).map((r) => r.hash);
    const { name, files, texts } = await gatherIn(link, dir, known, deps);

    // The case the chat is about wins; otherwise the case whose number is in the papers.
    const folders = await db.prepare('SELECT id, name, case_number, case_key FROM case_folders WHERE user_id = ? ORDER BY id').all(user.id);
    const folder = folderOfCase(folders, caseNumber) || matchCase(folders, [name, ...files.map((f) => f.rel), ...texts]);

    const fresh = files.filter((f) => f.kind && !f.duplicate);
    let added = 0;
    let duplicates = files.filter((f) => f.duplicate).length;
    let videoMinutes = 0;
    for (const f of fresh) {
      if (f.kind === 'video') videoMinutes += (await (deps.videoSeconds || videoSeconds)(f.path).catch(() => 0)) / 60;
      // Moved into place, never read into memory: its fingerprint came from the worker. The
      // name goes in the way multer hands names over (latin1), which saveUpload expects.
      const originalname = Buffer.from(basename(f.rel), 'utf8').toString('latin1');
      const { doc, duplicate } = await saveUpload(user.id, null, {
        path: f.path, hash: f.hash, originalname, mimetype: MIME[extname(f.rel).slice(1).toLowerCase()], size: statSync(f.path).size,
      });
      if (duplicate) { duplicates++; continue; }
      await db.prepare(`UPDATE documents SET status = 'queued', import_id = ?, case_folder_id = ? WHERE id = ?`).run(imp.id, folder?.id ?? null, doc.id);
      added++;
    }
    const skipped = skippedSummary(files.filter((f) => !f.kind).map((f) => f.rel));
    const skippedCount = files.filter((f) => !f.kind).length;
    await db.prepare(`UPDATE imports SET name = ?, added = ?, duplicates = ?, ignored = ?, skipped_names = ?, case_folder_id = ?, uploaded = true,
        updated_at = extract(epoch from now())::bigint WHERE id = ?`)
      .run(`Dropbox: ${name}`.slice(0, 200), added, duplicates, JSON.stringify(skippedCount ? { other: skippedCount } : {}),
        JSON.stringify(skipped.slice(0, 20)), folder?.id ?? null, imp.id);

    const count = {
      files: added,
      scannedPages: fresh.reduce((n, f) => n + (f.scanned || 0), 0),
      images: fresh.filter((f) => f.kind === 'image').length,
      videos: fresh.filter((f) => f.kind === 'video').length,
      videoMinutes,
    };
    console.log(`[dropbox] user ${user.id} "${name}": ${added} to read, ${duplicates} already there, ${skippedCount} unreadable, ` +
      `${count.scannedPages} scanned pages, about $${estimate(count).toFixed(2)}`);
    (deps.kick || kickImports)();
    return { added, duplicates, skipped, folder };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Start on a link: an imports row now, the download in the background. A link that cannot
 * be fetched says why in the chat it came from, the way a finished one does.
 */
export async function startDropbox(user, url, ctx = {}, deps = {}) {
  if (!dropboxLink(url)) throw new Error('That is not a Dropbox share link.');
  const { id } = await db.prepare(`INSERT INTO imports (user_id, name, ignored, conversation_id, agent_id) VALUES (?, 'Dropbox', '{}', ?, ?) RETURNING id`)
    .run(user.id, ctx.conversationId ?? null, ctx.agentId ?? null);
  const imp = { id };
  const work = fetchDropbox(user, imp, url, ctx, deps).catch(async (e) => {
    console.error('[dropbox]', user.id, e.message);
    await db.prepare(`UPDATE imports SET uploaded = true, error = ?, updated_at = extract(epoch from now())::bigint WHERE id = ?`).run(e.message.slice(0, 300), id);
    (deps.kick || kickImports)(); // the queue is where the chat is told, failure included
  });
  if (deps.wait) await work; // tests wait for it; the chat does not
  return imp;
}

// ---------- how far it has got ----------

/** Their Dropbox folders still being read, and the last ones done, in plain words. */
export async function dropboxProgress(userId) {
  const rows = await db.prepare(`SELECT i.id, i.name, i.uploaded, i.error,
      COUNT(d.id)::int AS total,
      COUNT(d.id) FILTER (WHERE d.status = 'ready')::int AS ready,
      COUNT(d.id) FILTER (WHERE d.status = 'error')::int AS failed
    FROM imports i LEFT JOIN documents d ON d.import_id = i.id
    WHERE i.user_id = ? AND i.name LIKE 'Dropbox%' GROUP BY i.id ORDER BY i.id DESC LIMIT 3`).all(userId);
  if (!rows.length) return 'No Dropbox folders yet.';
  return rows.map((r) => {
    const name = r.name.replace(/^Dropbox:?\s*/, '') || 'the Dropbox folder';
    if (r.error) return `"${name}": could not be opened (${r.error}).`;
    if (!r.uploaded) return `"${name}": still downloading from Dropbox.`;
    const done = r.ready + r.failed;
    if (done < r.total) return `"${name}": ${done} of ${r.total} files read so far, still going.`;
    return `"${name}": finished, all ${r.total} files read${r.failed ? ` (${r.failed} could not be read)` : ''}.`;
  }).join('\n');
}

// ---------- in the chat ----------

const READ = {
  name: 'read_dropbox_link',
  description: 'Use whenever the user shares a Dropbox link (dropbox.com/s/..., /scl/fi/..., /scl/fo/...), instead of web_fetch. ' +
    'It starts reading every file in it onto their Shelf, in the background, into the case this chat is about. ' +
    'Then tell the user in one short, plain line that you are reading their Dropbox files now and will tell them in this chat when they are ready. ' +
    'Never mention cost, pages, scans or file counts, and never ask them to approve anything. You cannot say what is in the files until they are read.',
  input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The Dropbox link exactly as the user gave it.' } }, required: ['url'] },
};

const PROGRESS = {
  name: 'dropbox_progress',
  description: 'How far the reading of their Dropbox folders has got. Use when they ask whether the Dropbox files are done, downloaded or ready. ' +
    'Answer in one short, plain line, e.g. "64 of 119 files read so far, I\'ll tell you here when it\'s done."',
  input_schema: { type: 'object', properties: {} },
};

/** The Dropbox tools, only for people given the Dropbox links module: a big folder of scans costs money to read. */
export async function dropboxKit(user, ctx = {}, deps = {}) {
  const open = (await userModules(user)).includes('dropbox');
  return {
    definitions: open ? [READ, PROGRESS] : [],
    status: (name) => (name === READ.name ? 'Opening the Dropbox link…' : 'Checking your Dropbox files…'),
    run: async (block) => {
      try {
        if (!open) throw new Error(`Unknown tool ${block.name}`);
        let content;
        if (block.name === READ.name) {
          await startDropbox(user, block.input?.url, ctx, deps);
          content = 'Started. Reading every file in the background; this chat gets a message when they are all read. ' +
            'Tell the user that in one short plain line. No cost, no counts, no approval.';
        } else if (block.name === PROGRESS.name) content = await dropboxProgress(user.id);
        else throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
