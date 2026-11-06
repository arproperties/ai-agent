import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import yauzl from 'yauzl';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { saveUpload } from './files.js';
import { kickImports } from './imports.js';
import { Worker } from 'node:worker_threads';
import { videoSeconds, IMAGE_TYPES, VIDEO_EXT, FRAME_AT } from './knowledge.js';
import { caseRegex } from './caseMatch.js';
import { userModules } from './modules.js';

// A Dropbox link pasted in a chat: the whole file or folder is downloaded on the server,
// counted and priced first, and once the person says yes every file goes into the same
// import queue a folder upload uses (imports.js), so it is filed in the background, a
// file already on their Shelf is skipped, and a restart carries on where it stopped.
// A folder about one of their case folders lands in that case.

const WORK_DIR = `${DATA_DIR}/dropbox`;
const KEEP_MS = 2 * 60 * 60_000; // a look not saved within two hours is thrown away
const MIN_FREE_BYTES = 3 * 1024 ** 3; // the server's own disk: a huge folder must not fill it

// ---------- the link ----------

const DROPBOX_HOST = /^(www\.)?dropbox\.com$/i;
const DOWNLOAD_HOST = /(^|\.)dropbox(usercontent)?\.com$/i;

/**
 * The download address of a shared Dropbox link, or null for anything that is not one.
 * dl=1 makes Dropbox send the file itself (a folder comes as one zip) instead of its
 * preview page; rlkey, the key of a newer link, has to stay.
 */
export function dropboxLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !DROPBOX_HOST.test(u.hostname)) return null;
  if (!/^\/(s|sh|scl\/fi|scl\/fo)\//.test(u.pathname)) return null;
  u.searchParams.set('dl', '1');
  return { url: u.toString(), folder: /^\/(sh|scl\/fo)\//.test(u.pathname) };
}

// ---------- what it costs ----------

// US dollars, from what Reem pays on live: filing a file is one Haiku call (~$0.0056); a
// scanned page is read as a picture by Sonnet 5 (~2,500 tokens in, ~900 out at $2/$10 a
// million); a photo is one description; a video is its sound turned into text plus a few
// stills. Text pages are read on the server and cost nothing.
export const PRICE = { file: 0.0056, scannedPage: 0.014, image: 0.005, videoMinute: 0.003, frame: 0.005 };
export const AED = 3.6725;

export function estimate({ files = 0, scannedPages = 0, images = 0, videoMinutes = 0, videos = 0 }) {
  return files * PRICE.file + scannedPages * PRICE.scannedPage + images * PRICE.image
    + videoMinutes * PRICE.videoMinute + videos * FRAME_AT.length * PRICE.frame;
}

// ---------- what Reem can read ----------

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'text/xml',
  dwg: 'application/acad', dxf: 'application/dxf', ifc: 'application/x-step',
};
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|~\$)/i;

/** What kind of file a name is to Reem: pdf, image, video, other readable, or null (skipped). */
export function kindOf(name) {
  if (JUNK.test(name)) return null;
  const ext = extname(name).slice(1).toLowerCase();
  if (!MIME[ext]) return null;
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_TYPES.includes(MIME[ext])) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'doc';
}

// ---------- which case it is about ----------

/**
 * The one case folder the files are about: the folder whose case number turns up most in
 * the folder's own name, its file names and the text of its PDFs. null when none does, or
 * when two cases turn up equally - then the person is asked.
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

// ---------- download and unpack ----------

function freeBytes(dir) {
  try { const s = statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

async function download(link, dir) {
  const res = await fetch(link.url, { redirect: 'follow' });
  if (!DOWNLOAD_HOST.test(new URL(res.url).hostname)) throw new Error('The link went somewhere other than Dropbox, so it was not opened.');
  if (res.status === 404) throw new Error('Dropbox says this link does not exist or was deleted.');
  if (!res.ok) throw new Error(`Dropbox would not send the files (${res.status}). The link may need to be set to "anyone with the link".`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) throw new Error('Dropbox sent a sign-in page instead of the files. The link needs to be shared as "anyone with the link".');
  const size = Number(res.headers.get('content-length')) || 0;
  if (freeBytes(dir) - size < MIN_FREE_BYTES) throw new Error('The server does not have enough free disk space for this folder.');
  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] || /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'Dropbox';
  const name = decodeURIComponent(named);
  const file = join(dir, 'download');
  // Streamed to disk: a folder of case files is hundreds of MB, more than the server's memory.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return { file, name, zip: /zip/i.test(type) || /\.zip$/i.test(name) };
}

/**
 * Every file in the zip, written out under a number of its own: the name in the zip is
 * kept only as text, never used as a path, so a crafted name cannot write anywhere else.
 */
function unzip(zipPath, dir) {
  return new Promise((resolve, reject) => {
    // decodeStrings off: Dropbox puts a "/" entry at the top that yauzl would refuse as an
    // absolute path. Names are decoded here and never touch the disk.
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zip) => {
      if (err) return reject(new Error('The download is not a zip that can be opened.'));
      const out = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (e) => {
        const rel = e.fileName.toString('utf8').replace(/^\/+/, '');
        if (!rel || rel.endsWith('/') || !kindOf(rel)) {
          if (rel && !rel.endsWith('/') && !JUNK.test(rel)) out.push({ rel, size: e.uncompressedSize, kind: null });
          return zip.readEntry();
        }
        const path = join(dir, `${out.length}${extname(rel).toLowerCase().replace(/[^.\w]/g, '')}`);
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          pipeline(stream, createWriteStream(path))
            .then(() => { out.push({ rel, size: e.uncompressedSize, kind: kindOf(rel), path }); zip.readEntry(); })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  });
}

// ---------- look, then save ----------

const looks = new Map(); // id -> { userId, dir, name, files, at }

function sweep() {
  for (const [id, l] of looks) {
    if (Date.now() - l.at > KEEP_MS) { rmSync(l.dir, { recursive: true, force: true }); looks.delete(id); }
  }
}

/** Leftovers from before a restart: their looks were in memory, so nothing can save them now. */
export function clearDropboxWork() {
  rmSync(WORK_DIR, { recursive: true, force: true });
}

/**
 * Pages, scanned pages and opening text of each PDF, counted in a worker with its memory
 * capped (dropboxCount.js): in the server itself a 4,000-page folder pushed it past 1 GB.
 */
export function countPdfs(paths) {
  if (!paths.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./dropboxCount.js', import.meta.url), { workerData: { paths }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error('Counting the PDF pages ran out of memory.')));
  });
}

// Streamed, not read whole: a folder of big PDFs read into memory one after another piled up
// faster than it was given back.
async function sha(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/**
 * Download a link and say what is in it and what reading it costs. Nothing is filed yet:
 * the files wait on disk under a look id until saveDropbox() is called with it.
 */
export async function lookDropbox(user, url, deps = {}) {
  const link = dropboxLink(url);
  if (!link) throw new Error('That is not a Dropbox share link.');
  sweep();
  const id = randomBytes(6).toString('hex');
  const dir = join(WORK_DIR, String(user.id), id);
  mkdirSync(dir, { recursive: true });
  try {
    const got = await (deps.download || download)(link, dir);
    const files = got.zip ? await unzip(got.file, dir) : [{ rel: got.name, size: 0, kind: kindOf(got.name), path: got.file }];
    if (got.zip) rmSync(got.file, { force: true });
    const name = got.name.replace(/\.zip$/i, '');

    // Counted the way the queue will read them, so the price is the price.
    const texts = [name];
    const have = new Set((await db.prepare('SELECT hash FROM documents WHERE user_id = ? AND hash IS NOT NULL').all(user.id)).map((r) => r.hash));
    const seen = new Set();
    for (const f of files) {
      texts.push(f.rel);
      if (!f.kind) continue;
      f.hash = await sha(f.path);
      f.duplicate = have.has(f.hash) || seen.has(f.hash);
      seen.add(f.hash);
      if (f.duplicate) continue;
      if (f.kind === 'video') f.minutes = (await (deps.videoSeconds || videoSeconds)(f.path).catch(() => 0)) / 60;
    }

    const fresh = files.filter((f) => f.kind && !f.duplicate);
    const pdfs = fresh.filter((f) => f.kind === 'pdf');
    (await (deps.countPdfs || countPdfs)(pdfs.map((f) => f.path))).forEach((c, i) => {
      Object.assign(pdfs[i], { pages: c.pages, scanned: c.scanned });
      texts.push(c.text);
    });
    const count = {
      files: fresh.length,
      pages: fresh.reduce((n, f) => n + (f.pages || 0), 0),
      scannedPages: fresh.reduce((n, f) => n + (f.scanned || 0), 0),
      images: fresh.filter((f) => f.kind === 'image').length,
      videos: fresh.filter((f) => f.kind === 'video').length,
      videoMinutes: fresh.reduce((n, f) => n + (f.minutes || 0), 0),
      duplicates: files.filter((f) => f.duplicate).length,
      skipped: files.filter((f) => !f.kind).map((f) => f.rel),
    };
    const usd = estimate(count);

    const folders = await db.prepare('SELECT id, name, case_number FROM case_folders WHERE user_id = ? ORDER BY id').all(user.id);
    const match = matchCase(folders, texts);
    looks.set(id, { userId: user.id, dir, name, files, at: Date.now() });
    return { id, name, folder: got.zip, count, usd, aed: usd * AED, match, folders };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * File a look's files on the person's Shelf through the import queue. caseFolderId puts
 * them in one of their own case folders; anyone else's is refused.
 */
export async function saveDropbox(user, lookId, caseFolderId = null, deps = {}) {
  const look = looks.get(String(lookId));
  if (!look || look.userId !== user.id) throw new Error('That Dropbox look has expired. Open the link again.');
  let folder = null;
  if (caseFolderId) {
    folder = await db.prepare('SELECT id, name FROM case_folders WHERE id = ? AND user_id = ?').get(Number(caseFolderId), user.id);
    if (!folder) throw new Error('That case folder is not one of theirs.');
  }
  looks.delete(String(lookId));
  try {
    const skipped = look.files.filter((f) => !f.kind).length;
    const { id: importId } = await db.prepare('INSERT INTO imports (user_id, name, ignored, uploaded) VALUES (?, ?, ?, true) RETURNING id')
      .run(user.id, `Dropbox: ${look.name}`.slice(0, 200), JSON.stringify(skipped ? { other: skipped } : {}));
    let added = 0;
    let duplicates = 0;
    for (const f of look.files) {
      if (!f.kind) continue;
      const buffer = readFileSync(f.path);
      // saveUpload reads names the way multer hands them over (latin1), so the name goes in that way.
      const originalname = Buffer.from(basename(f.rel), 'utf8').toString('latin1');
      const { doc, duplicate } = await saveUpload(user.id, null, { buffer, path: f.path, originalname, mimetype: MIME[extname(f.rel).slice(1).toLowerCase()], size: buffer.length });
      if (duplicate) { duplicates++; continue; }
      await db.prepare(`UPDATE documents SET status = 'queued', import_id = ?, case_folder_id = ? WHERE id = ?`).run(importId, folder?.id ?? null, doc.id);
      added++;
    }
    await db.prepare('UPDATE imports SET added = ?, duplicates = ?, updated_at = extract(epoch from now())::bigint WHERE id = ?').run(added, duplicates, importId);
    (deps.kick || kickImports)();
    return { importId, added, duplicates, skipped, folder };
  } finally {
    rmSync(look.dir, { recursive: true, force: true });
  }
}

// ---------- in the chat ----------

const LOOK = {
  name: 'look_at_dropbox_link',
  description: 'Use whenever the user shares a Dropbox link (dropbox.com/s/..., /scl/fi/..., /scl/fo/...), instead of web_fetch. ' +
    'It downloads the file or folder and reports what is inside, how many pages are scans, and what reading it all costs. ' +
    'Nothing is saved by this. Tell the user in a few short lines (files, pages, cost in AED, and the case it will go into) and ask whether to save it to their Shelf.',
  input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The Dropbox link exactly as the user gave it.' } }, required: ['url'] },
};

const SAVE = {
  name: 'save_dropbox_link',
  description: 'Saves the files of a Dropbox link already looked at with look_at_dropbox_link to the user\'s Shelf, where they are read and filed in the background. ' +
    'Only after the user has said yes to the cost. Pass the case folder id the look matched, or the one the user picked; leave it out for none.',
  input_schema: {
    type: 'object',
    properties: {
      look_id: { type: 'string', description: 'The look id from look_at_dropbox_link.' },
      case_folder_id: { type: 'integer', description: 'One of the user\'s case folder ids, or leave out.' },
    },
    required: ['look_id'],
  },
};

const money = (usd) => `about AED ${Math.max(1, Math.round(usd * AED))} ($${usd.toFixed(2)})`;

export function lookText(l) {
  const c = l.count;
  const lines = [
    `Look id: ${l.id}`,
    `"${l.name}": ${c.files} file(s) to read${c.pages ? `, ${c.pages} PDF pages of which ${c.scannedPages} are scans` : ''}` +
      `${c.images ? `, ${c.images} photo(s)` : ''}${c.videos ? `, ${c.videos} video(s) (${Math.round(c.videoMinutes)} min)` : ''}.`,
    `Reading it all costs ${money(l.usd)}, once. Scanned pages are most of that; text pages are free.`,
  ];
  if (c.duplicates) lines.push(`${c.duplicates} file(s) are already on their Shelf or repeated in the folder: skipped, no cost.`);
  if (c.skipped.length) lines.push(`${c.skipped.length} file(s) Reem cannot read are left out: ${c.skipped.slice(0, 5).join(', ')}${c.skipped.length > 5 ? ', …' : ''}.`);
  if (l.match) lines.push(`It is about their case "${l.match.name}" (case folder id ${l.match.id}): the files will go into that case.`);
  else if (l.folders.length) lines.push(`No case matched. Their case folders: ${l.folders.map((f) => `id ${f.id} "${f.name}"`).join('; ')}. Ask which case it belongs to, or none.`);
  lines.push('NOT saved yet. Ask the user whether to save it; call save_dropbox_link only after they say yes.');
  return lines.join('\n');
}

/** The Dropbox tools, only for people given the Dropbox links module: a big folder of scans costs money to read. */
export async function dropboxKit(user, deps = {}) {
  const open = (await userModules(user)).includes('dropbox');
  return {
    definitions: open ? [LOOK, SAVE] : [],
    status: (name) => (name === LOOK.name ? 'Opening the Dropbox link and counting its pages…' : 'Putting the files on your Shelf…'),
    run: async (block) => {
      try {
        if (!open) throw new Error(`Unknown tool ${block.name}`);
        const input = block.input || {};
        let content;
        if (block.name === LOOK.name) content = lookText(await lookDropbox(user, input.url, deps));
        else if (block.name === SAVE.name) {
          const s = await saveDropbox(user, input.look_id, input.case_folder_id, deps);
          content = `${s.added} file(s) are being read and filed on their Shelf now, in the background${s.folder ? `, into the case "${s.folder.name}"` : ''}. ` +
            `${s.duplicates ? `${s.duplicates} were already there. ` : ''}Progress shows on the Shelf. Big scanned files take a while; they can keep chatting meanwhile.`;
        } else throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
