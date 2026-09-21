// Reading a ZIP without loading it: the central directory at the end lists every file and
// where it starts, so each one is sliced out and inflated only when it is about to be sent.
// A 1 GB WhatsApp export never has to fit in the browser's memory at once.

const u32 = (v, i) => v.getUint32(i, true);
const u16 = (v, i) => v.getUint16(i, true);
const u64 = (v, i) => Number(v.getBigUint64(i, true));
const MAX32 = 0xffffffff;

/** Every entry in the ZIP: { name, size, csize, method, offset, encrypted }. Folders excluded. */
export async function zipEntries(file) {
  const tailLen = Math.min(file.size, 22 + 0xffff + 20);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like a ZIP file');

  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64: the real numbers live in a second record the locator points at
  const loc = eocd - 20;
  if (loc >= 0 && u32(tail, loc) === 0x07064b50 && (cdOffset === MAX32 || cdSize === MAX32 || count === 0xffff)) {
    const at = u64(tail, loc + 8);
    const z = new DataView(await file.slice(at, at + 56).arrayBuffer());
    if (u32(z, 0) === 0x06064b50) { count = u64(z, 32); cdSize = u64(z, 40); cdOffset = u64(z, 48); }
  }

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const text = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50; n++) {
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = text.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end; e += 4 + u16(cd, e + 2)) {
      if (u16(cd, e) !== 1) continue; // ZIP64 sizes, present only for the fields that overflowed
      let q = e + 4;
      if (size === MAX32) { size = u64(cd, q); q += 8; }
      if (csize === MAX32) { csize = u64(cd, q); q += 8; }
      if (offset === MAX32) offset = u64(cd, q);
    }
    if (!name.endsWith('/')) out.push({ name, size, csize, method, offset, encrypted: !!(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes, as a Blob. */
export async function zipRead(file, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} is password-protected`);
  const head = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (u32(head, 0) !== 0x04034b50) throw new Error(`${entry.name} could not be found in the ZIP`);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = file.slice(start, start + entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`${entry.name} uses a compression this app cannot open`);
  return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
}

// ---------- what an import keeps and what it leaves out ----------

// Kept: what the Shelf already reads. The type is set here because files out of a ZIP have none.
const KEEP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'text/xml', yaml: 'text/plain', yml: 'text/plain', log: 'text/plain', tsv: 'text/tab-separated-values',
};
// Left out on purpose, and counted so the summary can say so.
const SKIP = {
  voice: ['opus', 'ogg', 'oga', 'm4a', 'mp3', 'aac', 'wav', 'amr', 'caf', 'weba'],
  excel: ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'numbers'],
  contacts: ['vcf'],
  videos: ['mp4', 'mov', '3gp', 'avi', 'mkv', 'webm', 'm4v', 'wmv'],
  archives: ['rar', 'zip', '7z', 'tar', 'gz', 'tgz'],
};
export const MAX_FILE = 25 * 1024 * 1024; // the server's per-file limit

export const baseName = (path) => path.split('/').pop();
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

/** Files a person would not call theirs: macOS resource forks, .DS_Store and the like. Not counted at all. */
export const isJunk = (path) => path.includes('__MACOSX/') || baseName(path).startsWith('.');

/** 'keep', or which kind of left-out file it is. */
export function sortFile(path, size) {
  const ext = extOf(baseName(path));
  for (const [kind, exts] of Object.entries(SKIP)) if (exts.includes(ext)) return kind;
  if (!KEEP[ext]) return 'other';
  if (size > MAX_FILE) return 'large';
  return 'keep';
}
export const mimeOf = (path) => KEEP[extOf(baseName(path))] || 'application/octet-stream';

const LABELS = {
  voice: ['voice note', 'voice notes'], excel: ['Excel file', 'Excel files'], contacts: ['contact', 'contacts'],
  videos: ['video', 'videos'], archives: ['archive', 'archives'], large: ['file over 25 MB', 'files over 25 MB'],
  other: ['other file', 'other files'], failed: ['file that did not upload', 'files that did not upload'],
};
/** "894 voice notes · 18 Excel files · …", in a fixed order. */
export function describeIgnored(ignored) {
  return Object.keys(LABELS).filter((k) => ignored[k] > 0)
    .map((k) => `${ignored[k].toLocaleString()} ${LABELS[k][ignored[k] === 1 ? 0 : 1]}`).join(' · ');
}
