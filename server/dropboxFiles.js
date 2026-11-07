import { createReadStream, createWriteStream, readFileSync, rmSync, statfsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import yauzl from 'yauzl';
import { scrambledArabic } from './pdfText.js';

// The file work of a Dropbox link: download, unzip, fingerprint and count pages. No database
// and no Claude, so it runs in a worker thread (dropboxWorker.js) whose memory is capped and
// all given back when it ends: done in the server itself, a folder of 8,000 imaging files
// took it past 1 GB, more than the live server has spare.

const MIN_FREE_BYTES = 3 * 1024 ** 3; // the server's own disk: a huge folder must not fill it
const ZIP_DEPTH = 3; // a zip inside a zip inside the folder is opened; deeper is left alone
const KEEP_TEXT = 20000; // the opening text of each PDF kept, to find the case number in

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

// ---------- what Reem can read ----------

// The same kinds the Shelf reads (knowledge.js IMAGE_TYPES / VIDEO_EXT), listed here because
// this file must not load knowledge.js: that opens the database.
export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'text/xml',
  dwg: 'application/acad', dxf: 'application/dxf', ifc: 'application/x-step',
};
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', '3gp'];
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|~\$)/i;

/** What kind of file a name is to Reem: pdf, image, video, zip, other readable, or null (skipped). */
export function kindOf(name) {
  if (JUNK.test(name)) return null;
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === 'zip') return 'zip';
  if (!MIME[ext]) return null;
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'doc';
}

// ---------- download and unpack ----------

function freeBytes(dir) {
  try { const s = statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

export async function download(link, dir) {
  const res = await fetch(link.url, { redirect: 'follow' });
  if (!DOWNLOAD_HOST.test(new URL(res.url).hostname)) throw new Error('the link went somewhere other than Dropbox');
  if (res.status === 404) throw new Error('Dropbox says this link does not exist or was deleted');
  if (!res.ok) throw new Error('Dropbox would not share the files. The link may need to be set to "anyone with the link"');
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) throw new Error('Dropbox asked for a sign-in. The link needs to be shared as "anyone with the link"');
  const size = Number(res.headers.get('content-length')) || 0;
  if (freeBytes(dir) - size < MIN_FREE_BYTES) throw new Error('the server does not have enough free space for this folder');
  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] || /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'Dropbox';
  const name = decodeURIComponent(named);
  const file = join(dir, 'download');
  // Streamed to disk: a folder of case files is hundreds of MB, more than the server's memory.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return { file, name, zip: /zip/i.test(type) || /\.zip$/i.test(name) };
}

/**
 * Every file in the zip, written out under a name of its own: the name in the zip is kept
 * only as text, never used as a path, so a crafted name cannot write anywhere else. A zip
 * inside it (an imaging study sent as a zip, say) is opened the same way.
 */
export function unzip(zipPath, dir, { prefix = '', depth = 0, out = [] } = {}) {
  return new Promise((resolve, reject) => {
    // decodeStrings off: Dropbox puts a "/" entry at the top that yauzl would refuse as an
    // absolute path. Names are decoded here and never touch the disk.
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (err, zip) => {
      if (err) return reject(new Error('the download could not be opened'));
      const inner = [];
      zip.on('error', reject);
      zip.on('end', async () => {
        try {
          for (const z of inner) {
            await unzip(z.path, dir, { prefix: `${z.rel.replace(/\.zip$/i, '')}/`, depth: depth + 1, out })
              .catch(() => out.push({ rel: z.rel, kind: null }));
            rmSync(z.path, { force: true });
          }
          resolve(out);
        } catch (e) { reject(e); }
      });
      zip.on('entry', (e) => {
        const name = e.fileName.toString('utf8').replace(/^\/+/, '');
        const rel = prefix + name;
        if (!name || rel.endsWith('/')) return zip.readEntry(); // a folder, or the "/" at the top
        const kind = kindOf(rel);
        if (!kind || (kind === 'zip' && depth >= ZIP_DEPTH)) {
          if (!JUNK.test(rel)) out.push({ rel, kind: null });
          return zip.readEntry();
        }
        const path = join(dir, `${depth}-${randomBytes(5).toString('hex')}${extname(rel).toLowerCase().replace(/[^.\w]/g, '')}`);
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          pipeline(stream, createWriteStream(path))
            .then(() => { (kind === 'zip' ? inner : out).push({ rel, kind, path }); zip.readEntry(); })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  });
}

// Streamed, not read whole.
export async function sha(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/**
 * A PDF's pages, how many have to be read as pictures, and its opening text. The rule is
 * the queue's own (pdfText.js): fewer than 40 letters a page is a scan, and Arabic that reads
 * out scrambled is read as pictures too. A page at a time, each let go of before the next.
 */
export async function countPdf(path) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  try {
    let letters = 0;
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const words = (await page.getTextContent()).items.map((i) => i.str || '').join(' ');
      letters += words.replace(/\s+/g, '').length;
      if (text.length < KEEP_TEXT) text += `${words}\n`;
      page.cleanup();
    }
    const pages = pdf.numPages;
    return { pages, scanned: letters < 40 * pages || scrambledArabic(text) ? pages : 0, text: text.slice(0, KEEP_TEXT) };
  } finally {
    await (pdf.destroy?.() ?? pdf.cleanup?.()); // the proxy has destroy() in some pdf.js builds, cleanup() in others
  }
}

/**
 * Everything about a link the server needs, with nothing held in memory: the folder's name,
 * every file (where it was written, its fingerprint, PDF pages) and the text to find its
 * case in. `known` are fingerprints already on their Shelf: those are not counted again.
 */
export async function gather(link, dir, { known = [] } = {}, deps = {}) {
  const got = await (deps.download || download)(link, dir);
  const files = got.zip ? await unzip(got.file, dir) : [{ rel: got.name, kind: kindOf(got.name), path: got.file }];
  if (got.zip) rmSync(got.file, { force: true });
  const have = new Set(known);
  const seen = new Set();
  const texts = [];
  for (const f of files) {
    if (!f.kind) continue;
    f.hash = await sha(f.path);
    f.duplicate = have.has(f.hash) || seen.has(f.hash);
    seen.add(f.hash);
    if (f.duplicate) { rmSync(f.path, { force: true }); continue; }
    if (f.kind === 'pdf') {
      const c = await countPdf(f.path).catch(() => ({ pages: 0, scanned: 0, text: '' }));
      f.pages = c.pages;
      f.scanned = c.scanned;
      texts.push(c.text);
    }
  }
  return { name: got.name.replace(/\.zip$/i, ''), files, texts };
}
