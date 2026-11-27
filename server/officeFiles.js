import yauzl from 'yauzl';
import * as XLSX from 'xlsx';
import { simpleParser } from 'mailparser';
import MsgReaderModule from '@kenjiuno/msgreader';

// Reading the everyday office files people send: spreadsheets, PowerPoint, OpenDocument,
// rich text, saved emails (.eml, Outlook .msg), ZIPs and iPhone photos. Each one is turned
// into plain text the same way a PDF or Word file is, so the chat 📎, the Shelf, case folders
// and email attachments all read them alike. Nothing here opens the database: what is inside
// an email or a ZIP is handed back to `readInner`, which is knowledge.js's own extractText.

const MsgReader = MsgReaderModule.default || MsgReaderModule;
const extOf = (name) => String(name || '').split('.').pop().toLowerCase();

export const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'ods'];
export const SLIDE_EXT = ['pptx', 'odp'];
export const OFFICE_EXT = [...SHEET_EXT, ...SLIDE_EXT, 'odt', 'rtf', 'eml', 'msg', 'zip'];
export const HEIC_EXT = ['heic', 'heif'];
export const isOffice = (name) => OFFICE_EXT.includes(extOf(name));
export const isHeic = (name, mimetype = '') => HEIC_EXT.includes(extOf(name)) || /^image\/hei[cf]/i.test(mimetype);

// A ZIP or an email can hold many files, and each one costs reading time (and a picture
// costs an AI call). These keep one upload from turning into hundreds of reads, and keep a
// "zip bomb" (a tiny file that unpacks to gigabytes) from filling the server's memory.
const MAX_INNER_FILES = 40;
const MAX_INNER_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED = 120 * 1024 * 1024;
const MAX_DEPTH = 2; // a ZIP inside an email inside a ZIP, and no deeper

/** Every entry of a ZIP held in memory: [{ name, read() }], folders and Mac junk left out. */
function zipEntries(buffer, { limit = MAX_UNPACKED } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new Error('This ZIP could not be opened'));
      const out = [];
      let total = 0;
      zip.on('entry', (e) => {
        if (!/\/$/.test(e.fileName) && !/(^|\/)(__MACOSX\/|\.)/.test(e.fileName)) {
          total += e.uncompressedSize;
          if (total > limit) { zip.close(); return reject(new Error('This ZIP unpacks to more than the server can read at once')); }
          out.push({ name: e.fileName, size: e.uncompressedSize, read: () => readEntry(zip, e) });
        }
        zip.readEntry();
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, s) => {
      if (err) return reject(err);
      const parts = [];
      s.on('data', (c) => parts.push(c));
      s.on('end', () => resolve(Buffer.concat(parts)));
      s.on('error', reject);
    });
  });
}

/** A few named files out of a ZIP-based document (.pptx, .odt, .odp), as text. */
async function zipFiles(buffer, want) {
  const entries = await zipEntries(buffer);
  const hits = entries.filter((e) => want(e.name));
  const out = {};
  for (const e of hits) out[e.name] = (await e.read()).toString('utf8');
  return out;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return XML_ENTITIES[code] ?? all;
});

// ---------- spreadsheets ----------

/** Every sheet as CSV under its name, so the AI sees the rows and columns as they are. */
export function sheetText(buffer) {
  // Formulas are read as the values they last showed, which is what a person sees in Excel.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, dateNF: 'yyyy-mm-dd' }).replace(/^(,+\n)+|(\n,+)+$/g, '').trim();
    return csv ? `## Sheet: ${name}\n${csv}` : '';
  }).filter(Boolean).join('\n\n');
}

// ---------- PowerPoint (.pptx) ----------

const slideNo = (name) => Number(name.match(/(\d+)\.xml$/)?.[1] || 0);
/** The words on one slide (or its notes): each paragraph on its own line. */
const drawingText = (xml) => xml.split(/<\/a:p>/).map((p) => unXml([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''))).map((s) => s.trim()).filter(Boolean).join('\n');

/** Each slide's words and its speaker notes, in slide order. Pictures and charts are not read. */
export async function pptxText(buffer) {
  const files = await zipFiles(buffer, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
  const slides = Object.keys(files).filter((n) => n.startsWith('ppt/slides/')).sort((a, b) => slideNo(a) - slideNo(b));
  if (!slides.length) throw new Error('No slides found in this PowerPoint file');
  return slides.map((n) => {
    const no = slideNo(n);
    const words = drawingText(files[n]);
    // Notes repeat the slide number as a placeholder; only lines that say more are kept.
    const notes = drawingText(files[`ppt/notesSlides/notesSlide${no}.xml`] || '').split('\n').filter((l) => l && l !== String(no)).join('\n');
    return `## Slide ${no}\n${words || '(no text on this slide)'}${notes ? `\n\nSpeaker notes:\n${notes}` : ''}`;
  }).join('\n\n');
}

// ---------- OpenDocument (.odt text, .odp slides; .ods goes through the spreadsheet reader) ----------

export async function openDocText(buffer, ext) {
  const { 'content.xml': xml } = await zipFiles(buffer, (n) => n === 'content.xml');
  if (!xml) throw new Error('This OpenDocument file has no content');
  const body = xml.replace(/<text:tab\/>/g, '\t').replace(/<text:s(?: text:c="(\d+)")?\/>/g, (a, n) => ' '.repeat(Number(n || 1))).replace(/<text:line-break\/>/g, '\n');
  if (ext === 'odp') {
    const pages = body.split(/<draw:page\b/).slice(1);
    return pages.map((p, i) => `## Slide ${i + 1}\n${paragraphs(p) || '(no text on this slide)'}`).join('\n\n');
  }
  return paragraphs(body);
}
const paragraphs = (xml) => xml.split(/<\/text:(?:p|h)>/).map((p) => unXml(p.replace(/<[^>]+>/g, '')).trim()).filter(Boolean).join('\n');

// ---------- rich text (.rtf) ----------

const CODEPAGES = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256' };
// Groups that hold settings, not words: fonts, colours, styles, pictures, document info.
const SKIP_GROUPS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles']);

/** The words of an RTF file. Arabic saved by Word arrives as \uNNNN or as code-page 1256 bytes; both are read. */
export function rtfText(buffer) {
  const src = buffer.toString('latin1');
  if (!src.startsWith('{\\rtf')) throw new Error('This does not look like an RTF file');
  let decoder = new TextDecoder(CODEPAGES[src.match(/\\ansicpg(\d+)/)?.[1]] || 'windows-1252');
  const out = [];
  let bytes = []; // \'hh bytes collect here so a two-byte character decodes whole
  const flush = () => { if (bytes.length) { out.push(decoder.decode(Uint8Array.from(bytes))); bytes = []; } };
  const stack = [];
  let skip = false; let uc = 1; let pendingSkip = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { stack.push({ skip, uc }); continue; }
    if (c === '}') { flush(); ({ skip, uc } = stack.pop() || { skip: false, uc: 1 }); continue; }
    if (c === '\\') {
      const next = src[i + 1];
      if (next === "'") { const hex = src.slice(i + 2, i + 4); i += 3; if (pendingSkip > 0) { pendingSkip--; continue; } if (!skip) bytes.push(parseInt(hex, 16)); continue; }
      if (next === '*') { skip = true; i++; continue; }
      if (/[\\{}]/.test(next)) { i++; if (!skip) { flush(); out.push(next); } continue; }
      if (next === '~') { i++; if (!skip) { flush(); out.push(' '); } continue; }
      const m = /^([a-z]+)(-?\d+)? ?/i.exec(src.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const [, word, arg] = m;
      if (SKIP_GROUPS.has(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'uc') { uc = Number(arg); continue; }
      if (word === 'u') { flush(); const n = Number(arg); out.push(String.fromCharCode(n < 0 ? n + 65536 : n)); pendingSkip = uc; continue; }
      if (word === 'par' || word === 'line' || word === 'row') { flush(); out.push('\n'); continue; }
      if (word === 'tab' || word === 'cell') { flush(); out.push('\t'); continue; }
      continue;
    }
    if (c === '\r' || c === '\n') continue;
    if (pendingSkip > 0) { pendingSkip--; continue; }
    if (!skip) { flush(); out.push(c); }
  }
  flush();
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- files inside other files (emails, ZIPs) ----------

/** Read each inner file with readInner, within the limits above; a file that will not read is named, not fatal. */
async function readInnerFiles(files, readInner, depth) {
  const parts = [];
  const left = files.length - MAX_INNER_FILES;
  for (const f of files.slice(0, MAX_INNER_FILES)) {
    if (f.size > MAX_INNER_BYTES) { parts.push(`### ${f.name}\n(not read: over ${MAX_INNER_BYTES / 1024 / 1024} MB)`); continue; }
    try {
      const text = String(await readInner({ buffer: await f.read(), mimetype: f.mimetype || '', originalname: f.name }, { depth: depth + 1 }) || '').replace(/\r\n?/g, '\n').trim();
      parts.push(`### ${f.name}\n${text || '(no readable text)'}`);
    } catch (e) {
      parts.push(`### ${f.name}\n(not read: ${e.message})`);
    }
  }
  if (left > 0) parts.push(`(${left} more file${left === 1 ? '' : 's'} not read: only the first ${MAX_INNER_FILES} are read)`);
  return parts.join('\n\n');
}

export async function zipText(buffer, readInner, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('ZIP nested too deep to read');
  const entries = await zipEntries(buffer);
  if (!entries.length) throw new Error('This ZIP is empty');
  const list = entries.map((e) => `- ${e.name}`).join('\n');
  return `Files in this ZIP:\n${list}\n\n${await readInnerFiles(entries, readInner, depth)}`;
}

const addresses = (a) => (a?.value || []).map((v) => (v.name ? `${v.name} <${v.address}>` : v.address)).join(', ');
const stripHtml = (html) => unXml(String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();

function emailText({ from, to, cc, date, subject, body, attachments }) {
  const head = [`From: ${from || ''}`, `To: ${to || ''}`, cc && `Cc: ${cc}`, date && `Date: ${date}`, `Subject: ${subject || '(no subject)'}`].filter(Boolean).join('\n');
  return `${head}\n\n${String(body || '').replace(/\r\n?/g, '\n').trim() || '(no message text)'}${attachments ? `\n\n## Attachments\n${attachments}` : ''}`;
}

/** A saved email (.eml): who, when, the message, and what each attachment says. */
export async function emlText(buffer, readInner, depth = 0) {
  const m = await simpleParser(buffer);
  const files = (m.attachments || []).filter((a) => a.contentDisposition !== 'inline' || !a.contentType?.startsWith('image/'))
    .map((a) => ({ name: a.filename || 'attachment', mimetype: a.contentType, size: a.size || a.content.length, read: async () => a.content }));
  return emailText({
    from: addresses(m.from), to: addresses(m.to), cc: addresses(m.cc), date: m.date && `${new Date(m.date.getTime() + 4 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} Dubai time`,
    subject: m.subject, body: m.text || stripHtml(m.html), attachments: files.length ? await readInnerFiles(files, readInner, depth) : '',
  });
}

/** An Outlook email saved as .msg, read the same way as an .eml. */
export async function msgText(buffer, readInner, depth = 0) {
  let reader; let d;
  try { reader = new MsgReader(buffer); d = reader.getFileData(); } catch { d = { error: true }; }
  if (!d || d.error) throw new Error('This Outlook file could not be opened');
  const who = (r) => (r.name && r.email && r.name !== r.email ? `${r.name} <${r.email}>` : r.email || r.name);
  const rec = (kind) => (d.recipients || []).filter((r) => (r.recipType || 'to') === kind).map(who).join(', ');
  const files = (d.attachments || []).filter((a) => !a.attachmentHidden).map((a) => ({
    name: a.fileName || a.name || 'attachment', size: a.contentLength || 0, read: async () => Buffer.from(reader.getAttachment(a).content),
  }));
  return emailText({
    from: d.senderName && d.senderEmail ? `${d.senderName} <${d.senderEmail}>` : d.senderEmail || d.senderName,
    to: rec('to'), cc: rec('cc'), date: d.messageDeliveryTime || d.clientSubmitTime, subject: d.subject,
    body: d.body || stripHtml(d.bodyHtml), attachments: files.length ? await readInnerFiles(files, readInner, depth) : '',
  });
}

/** One of the files above as text. readInner reads files found inside emails and ZIPs. */
export async function officeText(buffer, name, readInner, { depth = 0 } = {}) {
  const ext = extOf(name);
  if (SHEET_EXT.includes(ext)) return sheetText(buffer);
  if (ext === 'pptx') return pptxText(buffer);
  if (ext === 'odt' || ext === 'odp') return openDocText(buffer, ext);
  if (ext === 'rtf') return rtfText(buffer);
  if (ext === 'eml') return emlText(buffer, readInner, depth);
  if (ext === 'msg') return msgText(buffer, readInner, depth);
  if (ext === 'zip') return zipText(buffer, readInner, depth);
  throw new Error(`Unsupported file type: ${name}`);
}

// ---------- iPhone photos ----------

/** A HEIC photo as a JPEG, so it is read and shown like any other picture. */
export async function heicToJpeg(buffer) {
  const { default: convert } = await import('heic-convert');
  return Buffer.from(await convert({ buffer, format: 'JPEG', quality: 0.85 }));
}
export const jpegName = (name) => String(name || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';
