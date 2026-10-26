// A Reem reply, turned into a PDF.
//
// When an agent writes something meant to be kept - an interview packet, a letter, a
// checklist - it wraps the document itself in <!--doc--> ... <!--/doc-->, and the chat
// around it ("Here is your packet", "Want me to add more?") stays outside. Only what is
// inside goes into the PDF. A reply without markers goes in from its first heading on,
// or whole when it has none, minus a closing offer either way.
//
// The PDF is laid out here with pdf-lib: no browser, no outside service, no model call.
// Same reply in, same bytes out (the dates in it are the reply's own), so saving it to
// the Shelf twice is caught by saveUpload's duplicate check. The routes are replyPdf.js.
//
// The built-in PDF fonts only cover Western European letters. Arabic is drawn with Noto
// Sans Arabic (server/fonts), embedded only when a document has Arabic in it: fontkit joins
// the letters, and the lines of an Arabic paragraph run right to left. Anything else is
// swapped for a near equivalent or dropped, and a document that is mostly another script
// (Hindi, say) is refused rather than handed over with its words missing.
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const OPEN = /^[ \t]*<!--\s*doc\s*-->[ \t]*$/im;
const CLOSE = /^[ \t]*<!--\s*\/doc\s*-->[ \t]*$/im;
// A closing line that talks to the reader rather than belonging to the document.
const OFFER = /^(want me|would you|shall i|should i|do you want|let me know|if you (?:want|need|'d like|would like)|i can also|happy to|need (?:me|any)|tell me)/i;

// Text the person typed: the request for a PDF ("convert into pdf") is not part of it, and
// each line they typed stays its own line rather than running on into a paragraph.
const ASK = /^\s*(?:please\s+)?(?:(?:convert|make|turn|export|save|change|create|put|give)\b.{0,40}\bpdf|pdf(?:\s+please)?)\W*$/i;
function ownText(text) {
  const lines = text.split('\n');
  const edge = (l) => !l.trim() || ASK.test(l);
  while (lines.length && edge(lines[0])) lines.shift();
  while (lines.length && edge(lines.at(-1))) lines.pop();
  return lines.map((l) => (l.trim() && !l.trim().startsWith('|') ? `${l.trimEnd()}  ` : l)).join('\n');
}

// The first line that is not part of a table: a reply that is only a table was titled
// "| Item | Status | Amount (AED) |".
const firstLine = (body) => (body.split('\n').find((l) => l.trim() && !l.trim().startsWith('|')) || 'Table').split(/(?<=[.!?])\s/)[0];

/**
 * The part of a reply that goes in its PDF, or null for an empty reply.
 * Returns { title, markdown }. Kept in step with client/src/lib/replyDoc.js.
 */
export function documentPart(content, { own = false } = {}) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  let body;
  const open = !own && OPEN.exec(text);
  if (own) {
    body = ownText(text);
  } else if (open) {
    const rest = text.slice(open.index + open[0].length);
    const close = CLOSE.exec(rest);
    body = close ? rest.slice(0, close.index) : rest;
  } else {
    // No markers: from the first heading on when there is one, otherwise the whole reply.
    const first = /^#{1,3}[ \t]+\S/m.exec(text);
    body = first ? text.slice(first.index) : text;
    const paras = body.trimEnd().split(/\n{2,}/);
    while (paras.length > 1 && isOffer(paras.at(-1))) paras.pop();
    body = paras.join('\n\n');
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!body) return null;
  const h = /^#{1,3}[ \t]+(.+)$/m.exec(body);
  const title = clean(h ? h[1] : firstLine(body)).slice(0, 100) || 'Document';
  return { title, markdown: body };
}

function isOffer(para) {
  const p = para.trim();
  if (/^(#|\||[-*+] |\d+[.)] |>)/.test(p) || p.length > 300) return false;
  return OFFER.test(p.replace(/^[*_]+/, '')) || /\?\s*[*_]*$/.test(p);
}

// Markdown decoration off, for titles and file names.
export const clean = (s) => String(s).replace(/[*_`#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

// ---------- characters the standard fonts can draw ----------

const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const ARABIC_CHARS = '؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿';
const ARABIC = new RegExp(`[${ARABIC_CHARS}]`, 'u');
const ARABIC_RUN = new RegExp(`([${ARABIC_CHARS}]+)`, 'u');
export const hasArabic = (s) => ARABIC.test(String(s));
/** Right to left when the first letter is Arabic. */
export const isRtl = (s) => hasArabic(String(s).match(/\p{L}/u)?.[0] || '');
const drawable = (c) => {
  const n = c.codePointAt(0);
  return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || WIN_ANSI_EXTRA.includes(c) || ARABIC.test(c);
};
const SWAP = {
  '✓': 'v', '✔': 'v', '☑': '[x]', '✅': 'v', '✗': 'x', '✘': 'x', '❌': 'x', // no tick in the standard fonts
  '→': '->', '⇒': '=>', '←': '<-', '↔': '<->', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~',
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—', '′': "'", '″': '"',
  '▪': '•', '◦': '•', '●': '•', '○': 'o', '■': '•', '□': '[ ]', '☐': '[ ]', '★': '*', '☆': '*',
  ' ': ' ', ' ': ' ', '​': '', '‎': '', '‏': '', '️': '',
};

// Colour marks: a table row starting with one is shaded that colour, and in text the mark is
// drawn as a coloured dot. Only green existed, so a register asked for in green, yellow and pink
// came out with the yellow and pink rows plain and a "Colour" column spelling them out.
export const MARKS = {
  '🟢': { name: 'green', fill: rgb(0.83, 0.94, 0.85), dot: rgb(0.16, 0.65, 0.33) },
  '🟡': { name: 'yellow', fill: rgb(1, 0.95, 0.7), dot: rgb(0.96, 0.75, 0.05) },
  '🟠': { name: 'orange', fill: rgb(1, 0.88, 0.75), dot: rgb(0.95, 0.5, 0.1) },
  '🔴': { name: 'red', fill: rgb(0.99, 0.83, 0.83), dot: rgb(0.86, 0.2, 0.2) },
  '🩷': { name: 'pink', fill: rgb(0.99, 0.86, 0.93), dot: rgb(0.93, 0.36, 0.64) },
  '🔵': { name: 'blue', fill: rgb(0.83, 0.9, 0.99), dot: rgb(0.2, 0.45, 0.9) },
  '🟣': { name: 'purple', fill: rgb(0.91, 0.86, 0.99), dot: rgb(0.55, 0.3, 0.85) },
  '⚪': { name: 'grey', fill: rgb(0.92, 0.92, 0.93), dot: rgb(0.6, 0.6, 0.64) },
};
export const MARK_RE = new RegExp(`(${Object.keys(MARKS).join('|')})\\uFE0F?`, 'gu');
const markOf = (cells) => cells.map((c) => String(c || '').match(MARK_RE)?.[0]?.replace('\uFE0F', '')).find(Boolean);

/** Text the standard fonts can draw. `keepMarks` leaves colour marks in, for wrap() to draw as dots. */
export function sanitize(s, { keepMarks = false } = {}) {
  let out = '';
  for (const c of String(s).normalize('NFC')) {
    if (MARKS[c]) { out += keepMarks ? c : `(${MARKS[c].name})`; continue; }
    const r = SWAP[c] ?? c;
    for (const d of r) if (drawable(d) || d === '\n') out += d; // \n: a hard break, split out by wrap()
  }
  return out;
}

/** True when too much of the text is in a script the standard fonts cannot draw. */
export function unsupportedScript(markdown) {
  const letters = [...markdown].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const lost = letters.filter((c) => !drawable(c)).length;
  return lost / letters.length > 0.05;
}

// ---------- markdown → blocks ----------

/** Lines of markdown as blocks: heading, para, list item, table, quote, code, rule. */
export function parseBlocks(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  // A line ending in two spaces or a backslash is a hard break; any other joins the next.
  const flush = () => { if (para.length) blocks.push({ type: 'para', text: para.join('').trim() }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if (!t) { flush(); continue; }
    if (/^(```|~~~)/.test(t)) {
      flush();
      const fence = t.slice(0, 3);
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
      blocks.push({ type: 'code', lines: code });
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t))) {
      flush(); blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
    } else if (/^([-*_])(\s*\1){2,}$/.test(t)) {
      flush(); blocks.push({ type: 'rule' });
    } else if (t.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = row(line);
      const rows = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) rows.push(row(lines[++i]));
      blocks.push({ type: 'table', head, rows });
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush();
      let text = m[3];
      let check = null;
      const c = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (c) { check = c[1] !== ' '; text = c[2]; }
      const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
      blocks.push({ type: 'item', depth, marker: /\d/.test(m[2]) ? m[2].replace(')', '.') : '•', check, text });
    } else if (t.startsWith('>')) {
      flush();
      const text = t.replace(/^>\s?/, '');
      const prev = blocks.at(-1);
      if (prev?.type === 'quote' && !para.length && lines[i - 1]?.trim().startsWith('>')) prev.text += ` ${text}`;
      else blocks.push({ type: 'quote', text });
    } else if (para.length === 0 && blocks.at(-1)?.type === 'item' && /^\s{2,}/.test(line) && lines[i - 1]?.trim()) {
      blocks.at(-1).text += ` ${t}`; // a wrapped list item
    } else {
      para.push(/( {2,}|\\)$/.test(line) ? `${t.replace(/\\$/, '')}\n` : `${t} `);
    }
  }
  flush();
  return blocks;
}

const BLANK = '';

/** Inline markdown as styled runs: [{ text, bold, italic, code }]. */
export function parseInline(text) {
  const runs = [];
  const push = (t, s) => { if (t) runs.push({ text: t, ...s }); };
  // Blanks to fill in ("Name: ________") are not emphasis: set aside while the rest is read.
  const src = String(text).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/_{3,}/g, (u) => BLANK.repeat(u.length));
  const re = /(\\[\\`*_{}[\]()#+\-.!|])|(`+)([\s\S]+?)\2|(\*\*\*|___)(?=\S)([\s\S]+?)(?<=\S)\4|(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\6|(\*)(?=\S)([\s\S]+?)(?<=\S)\*|(?<![\p{L}\p{N}])_(?=\S)([\s\S]+?)(?<=\S)_(?![\p{L}\p{N}])/gu;
  const walk = (s, style) => {
    let last = 0;
    for (const m of s.matchAll(re)) {
      push(s.slice(last, m.index), style);
      if (m[1]) push(m[1].slice(1), style);
      else if (m[2]) push(m[3], { ...style, code: true });
      else if (m[4]) walk(m[5], { ...style, bold: true, italic: true });
      else if (m[6]) walk(m[7], { ...style, bold: true });
      else if (m[8]) walk(m[9], { ...style, italic: true });
      else walk(m[10], { ...style, italic: true });
      last = m.index + m[0].length;
    }
    push(s.slice(last), style);
  };
  walk(src, {});
  return runs.map((r) => ({ ...r, text: sanitize(r.text.replaceAll(BLANK, '_'), { keepMarks: true }) })).filter((r) => r.text);
}

// ---------- layout ----------

const ARABIC_FONTS = {};
const arabicFont = (weight) => (ARABIC_FONTS[weight] ??= readFileSync(new URL(`./fonts/NotoSansArabic-${weight}.ttf`, import.meta.url)));

// Brackets face the other way in right-to-left text.
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const mirror = (t) => [...t].map((c) => MIRROR[c] ?? c).join('');
const kindOf = (seg) => (seg.dot || !seg.text.trim() ? 'n' : hasArabic(seg.text) ? 'r' : /[\p{L}\p{N}]/u.test(seg.text) ? 'l' : 'n');

/**
 * A line's words in the order they are drawn, left to right. A right-to-left line is turned
 * round, keeping English words and numbers inside it the right way; a left-to-right line
 * keeps its order, with a run of Arabic words inside it turned round.
 */
export function visualOrder(line, rtl) {
  const out = rtl ? [...line].reverse() : [...line];
  const flip = rtl ? 'l' : 'r';
  for (let i = 0; i < out.length; i++) {
    if (kindOf(out[i]) !== flip) continue;
    let end = i;
    for (let j = i + 1; j < out.length; j++) {
      const k = kindOf(out[j]);
      if (k === flip) end = j;
      else if (k !== 'n') break;
    }
    out.splice(i, end - i + 1, ...out.slice(i, end + 1).reverse());
    i = end;
  }
  return out;
}

const A4 = [595.28, 841.89];
// A table this wide turns the whole document sideways: eight columns on an upright page left
// each one a word wide, and a case table became a column of broken lines.
export const LANDSCAPE_COLUMNS = 6;
/** The page size for this markdown: A4 upright, or on its side when a table is wide. */
export const pageSize = (blocks) =>
  (blocks.some((b) => b.type === 'table' && Math.max(b.head.length, ...b.rows.map((r) => r.length)) >= LANDSCAPE_COLUMNS) ? [A4[1], A4[0]] : A4);
const MARGIN = { x: 56, top: 60, bottom: 58 };
const INK = rgb(0.11, 0.1, 0.18);
const SOFT = rgb(0.42, 0.41, 0.5);
const ACCENT = rgb(0.36, 0.3, 0.78);
const LINE = rgb(0.84, 0.83, 0.89);
const FILL = rgb(0.95, 0.94, 0.98);

/**
 * The document as PDF bytes. `date` is the reply's time: it goes on the page and into the
 * file's metadata, so the same reply always produces the same file.
 */
export async function renderPdf({ title, markdown, date = new Date() }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(sanitize(title));
  pdf.setCreator('Reem');
  pdf.setProducer('Reem');
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const F = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const fontOf = (r) => (r.code ? F.mono : r.bold && r.italic ? F.boldItalic : r.bold ? F.bold : r.italic ? F.italic : F.regular);
  // Arabic is only embedded when there is some; the name is fixed so the same reply still makes the same bytes.
  let A = null;
  if (hasArabic(title) || hasArabic(markdown)) {
    pdf.registerFontkit(fontkit);
    A = {
      regular: await pdf.embedFont(arabicFont('Regular'), { subset: true, customName: 'NotoSansArabic' }),
      bold: await pdf.embedFont(arabicFont('Bold'), { subset: true, customName: 'NotoSansArabic-Bold' }),
    };
  }
  // A word as pieces, each in a font that can draw it: Arabic letters in Noto, the rest in the standard font.
  const piecesOf = (text, font) => {
    if (!A || !hasArabic(text) || font === F.mono) return [{ text, font }];
    const ar = font === F.bold || font === F.boldItalic ? A.bold : A.regular;
    return text.split(ARABIC_RUN).filter(Boolean).map((t) => (ARABIC.test(t) ? { text: t, font: ar, arabic: true } : { text: t, font }));
  };
  const widthOf = (pieces, size) => pieces.reduce((w, p) => w + p.font.widthOfTextAtSize(p.text, size), 0);
  const textWidth = (text, size, font = F.regular) => widthOf(piecesOf(text, font), size);
  // An Arabic document reads from the right: its tables run right to left too.
  const letters = [...markdown].filter((c) => /\p{L}/u.test(c));
  const docRtl = letters.filter((c) => ARABIC.test(c)).length > letters.length / 2;
  const blocks = parseBlocks(markdown);
  const SIZE = pageSize(blocks);
  const width = SIZE[0] - MARGIN.x * 2;
  let page;
  let y;

  const newPage = () => { page = pdf.addPage(SIZE); y = SIZE[1] - MARGIN.top; };
  const room = (h) => { if (y - h < MARGIN.bottom) newPage(); };

  // Runs → lines no wider than `max`, each line a list of { text, font, w }.
  const wrap = (runs, size, max, base = {}) => {
    const lines = [[]];
    let w = 0;
    const words = [];
    for (const r of runs) {
      const font = fontOf({ ...base, ...r });
      const sz = r.code ? size * 0.92 : size;
      for (const part of r.text.split(MARK_RE).flatMap((t) => (MARKS[t] ? [t] : t.split(/(\n|[^\S\n]+)/)))) {
        if (MARKS[part]) words.push({ text: part, dot: MARKS[part].dot, font, size: sz });
        else if (part) {
          const text = part === '\n' ? '\n' : /^\s+$/.test(part) ? ' ' : part;
          words.push({ text, font, pieces: piecesOf(text, font), size: sz, color: base.color });
        }
      }
    }
    for (const word of words) {
      if (word.text === '\n') {
        while (lines.at(-1).at(-1)?.text === ' ') lines.at(-1).pop();
        lines.push([]); w = 0;
        continue;
      }
      const ww = word.dot ? word.size * 1.05 : widthOf(word.pieces, word.size);
      if (word.text === ' ') {
        if (lines.at(-1).length) { lines.at(-1).push({ ...word, w: ww }); w += ww; }
        continue;
      }
      if (w + ww > max && lines.at(-1).length) {
        while (lines.at(-1).at(-1)?.text === ' ') w -= lines.at(-1).pop().w;
        lines.push([]); w = 0;
      }
      if (ww > max && !word.dot && !hasArabic(word.text)) { // a word longer than the line: break it by letters
        let chunk = '';
        for (const ch of word.text) {
          if (word.font.widthOfTextAtSize(chunk + ch, word.size) > max - w && chunk) {
            lines.at(-1).push({ ...word, text: chunk, pieces: [{ text: chunk, font: word.font }], w: word.font.widthOfTextAtSize(chunk, word.size) });
            lines.push([]); w = 0; chunk = '';
          }
          chunk += ch;
        }
        const cw = word.font.widthOfTextAtSize(chunk, word.size);
        lines.at(-1).push({ ...word, text: chunk, pieces: [{ text: chunk, font: word.font }], w: cw }); w += cw;
        continue;
      }
      lines.at(-1).push({ ...word, w: ww }); w += ww;
    }
    while (lines.at(-1).at(-1)?.text === ' ') lines.at(-1).pop();
    return lines.filter((l, i) => l.length || i === 0);
  };

  const lineWidth = (line) => line.reduce((w, seg) => w + seg.w, 0);
  // A right-to-left line is drawn against the right edge of its `max` wide space.
  const drawLine = (line, x, baseline, color = INK, { rtl = false, max = 0 } = {}) => {
    let cx = rtl ? x + max - lineWidth(line) : x;
    for (const seg of visualOrder(line, rtl)) {
      if (seg.dot) page.drawCircle({ x: cx + seg.size * 0.33, y: baseline + seg.size * 0.33, size: seg.size * 0.33, color: seg.dot });
      else if (seg.text !== ' ') {
        // An English word keeps its brackets; around Arabic they face the other way.
        const flip = rtl && kindOf(seg) !== 'l';
        let px = cx;
        for (const p of flip ? [...seg.pieces].reverse() : seg.pieces) {
          const text = flip && !p.arabic ? mirror(p.text) : p.text;
          page.drawText(text, { x: px, y: baseline, size: seg.size, font: p.font, color: seg.color || color });
          px += p.font.widthOfTextAtSize(text, seg.size);
        }
      }
      cx += seg.w;
    }
  };

  // A wrapped paragraph at x, `lead` apart, moving y down as it goes.
  const flow = (runs, { size = 10.5, x = MARGIN.x, max = width - (x - MARGIN.x), lead = size * 1.45, color = INK, base = {}, before, rtl = false } = {}) => {
    const lines = wrap(runs, size, max, base);
    lines.forEach((line, i) => {
      room(lead);
      if (i === 0 && before) before(y - size);
      drawLine(line, x, y - size, color, { rtl, max });
      y -= lead;
    });
  };
  const rtlOf = (text) => isRtl(clean(String(text || '')).replace(MARK_RE, ''));

  // ---- title block ----
  newPage();
  const when = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
  const titleRtl = isRtl(title);
  page.drawRectangle({ x: titleRtl ? MARGIN.x + width - 36 : MARGIN.x, y: y - 3, width: 36, height: 3, color: ACCENT });
  y -= 18;
  flow([{ text: sanitize(title) }], { size: 21, lead: 26, base: { bold: true }, rtl: titleRtl });
  y -= 2;
  flow([{ text: when }], { size: 9.5, color: SOFT, rtl: titleRtl });
  y -= 6;
  page.drawLine({ start: { x: MARGIN.x, y }, end: { x: MARGIN.x + width, y }, thickness: 0.6, color: LINE });
  y -= 18;

  // The first heading is the title, already drawn above.
  if (blocks[0]?.type === 'heading' && clean(blocks[0].text) === clean(title)) blocks.shift();

  for (const b of blocks) {
    if (b.type === 'heading') {
      const size = b.level === 1 ? 16 : b.level === 2 ? 13.5 : b.level === 3 ? 11.5 : 10.5;
      y -= b.level <= 2 ? 10 : 6;
      room(size * 3.2); // never a heading alone at the foot of a page
      flow(parseInline(b.text), { size, lead: size * 1.35, base: { bold: true }, color: b.level <= 2 ? ACCENT : INK, rtl: rtlOf(b.text) });
      if (b.level <= 2) y -= 2;
      y -= 3;
    } else if (b.type === 'para') {
      flow(parseInline(b.text), { rtl: rtlOf(b.text) });
      y -= 6;
    } else if (b.type === 'item') {
      const indent = MARGIN.x + 6 + b.depth * 16;
      // A line starting with a colour mark (a colour key) has its dot in place of the bullet.
      const dotted = b.check === null && b.marker === '•' && new RegExp(`^\\s*${MARK_RE.source}`, 'u').test(b.text);
      const gap = dotted ? 0 : b.check !== null ? 17 : b.marker === '•' ? 11 : 17;
      // Right to left, the bullet sits at the right edge, indented from there.
      const rtl = rtlOf(b.text);
      const markFont = b.marker === '•' ? F.regular : F.bold;
      const markX = rtl ? MARGIN.x * 2 + width - indent - (b.check !== null ? 9 : markFont.widthOfTextAtSize(b.marker, 10.5)) : indent;
      flow(parseInline(b.text), {
        x: rtl ? MARGIN.x : indent + gap,
        max: width - (indent - MARGIN.x) - gap,
        rtl,
        before: (baseline) => {
          if (dotted) return;
          if (b.check !== null) {
            page.drawRectangle({ x: markX, y: baseline - 1, width: 9, height: 9, borderColor: SOFT, borderWidth: 0.8 });
            if (b.check) page.drawText('x', { x: markX + 2, y: baseline + 0.5, size: 8.5, font: F.bold, color: ACCENT });
          } else {
            page.drawText(b.marker, { x: markX, y: baseline, size: 10.5, font: markFont, color: ACCENT });
          }
        },
      });
      y -= 3;
    } else if (b.type === 'quote') {
      const top = y;
      const startPage = page;
      const rtl = rtlOf(b.text);
      flow(parseInline(b.text), { x: rtl ? MARGIN.x : MARGIN.x + 14, max: width - 14, color: SOFT, base: { italic: true }, rtl });
      if (page === startPage) page.drawRectangle({ x: rtl ? MARGIN.x + width - 4 : MARGIN.x + 2, y: y + 4, width: 2, height: top - y - 4, color: ACCENT });
      y -= 6;
    } else if (b.type === 'code') {
      for (const l of b.lines) {
        room(13);
        page.drawRectangle({ x: MARGIN.x, y: y - 13, width, height: 13, color: FILL });
        const text = sanitize(l.replace(/\t/g, '  ')).replace(new RegExp(ARABIC_RUN.source, 'gu'), '?'); // the code font has no Arabic
        let fit = text;
        while (fit && F.mono.widthOfTextAtSize(fit, 9) > width - 16) fit = fit.slice(0, -1);
        page.drawText(fit, { x: MARGIN.x + 8, y: y - 9.5, size: 9, font: F.mono, color: INK });
        y -= 13;
      }
      y -= 8;
    } else if (b.type === 'rule') {
      y -= 4;
      room(10);
      page.drawLine({ start: { x: MARGIN.x, y }, end: { x: MARGIN.x + width, y }, thickness: 0.6, color: LINE });
      y -= 12;
    } else if (b.type === 'table') {
      drawTable(b);
      y -= 10;
    }
  }

  function drawTable(table) {
    const cols = Math.max(table.head.length, ...table.rows.map((r) => r.length));
    // Right to left, the first column is the one on the right.
    const order = (r) => { const full = Array.from({ length: cols }, (_, i) => r[i] ?? ''); return docRtl ? full.reverse() : full; };
    const head = order(table.head);
    const rows = table.rows.map(order);
    const size = cols > 4 ? 8.5 : 9.5;
    const pad = 5;
    // A colour mark shades its row and is not printed in the cell.
    const unmark = (c) => String(c || '').replace(new RegExp(`${MARK_RE.source}\\s*`, 'gu'), '');
    const plain = (c) => sanitize(clean(unmark(c)));
    // Column widths by how much each holds, with a floor so no column collapses.
    const want = Array.from({ length: cols }, (_, i) => Math.max(
      textWidth(plain(head[i]), size, F.bold),
      ...rows.map((r) => Math.min(textWidth(plain(r[i]), size), 220)),
    ) + pad * 2);
    const floor = Math.min(60, width / cols);
    const total = want.reduce((a, b) => a + b, 0);
    let widths = want.map((w) => Math.max(floor, (w / total) * width));
    const sum = widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => (w / sum) * width);
    // No column narrower than its longest word, so "204/2024/1667" is never split across
    // lines: the room comes from the columns with the most to spare.
    const longest = Array.from({ length: cols }, (_, i) => Math.max(0, ...[head[i], ...rows.map((r) => r[i])]
      .flatMap((c) => plain(c).split(/\s+/)).map((w) => textWidth(w, size, F.bold))) + pad * 2 + 1);
    const short = widths.map((w, i) => Math.max(0, Math.min(longest[i], width / 3) - w));
    const need = short.reduce((a, b) => a + b, 0);
    const spare = widths.map((w, i) => (short[i] ? 0 : Math.max(0, w - longest[i])));
    const free = spare.reduce((a, b) => a + b, 0);
    if (need > 0 && free >= need) widths = widths.map((w, i) => w + short[i] - (spare[i] / free) * need);
    const lead = size * 1.35;

    const drawRow = (cells, header) => {
      const wrapped = widths.map((w, i) => wrap(parseInline(unmark(cells[i])), size, w - pad * 2, header ? { bold: true } : {}));
      const h = Math.max(...wrapped.map((l) => l.length)) * lead + pad * 2;
      if (y - h < MARGIN.bottom) { newPage(); if (!header) drawRow(head, true); }
      if (header) page.drawRectangle({ x: MARGIN.x, y: y - h, width, height: h, color: FILL });
      else if (markOf(cells)) {
        const m = MARKS[markOf(cells)];
        page.drawRectangle({ x: MARGIN.x, y: y - h, width, height: h, color: m.fill });
        page.drawRectangle({ x: docRtl ? MARGIN.x + width - 3 : MARGIN.x, y: y - h, width: 3, height: h, color: m.dot });
      }
      let x = MARGIN.x;
      wrapped.forEach((lines, i) => {
        const rtl = rtlOf(unmark(cells[i]));
        lines.forEach((line, j) => drawLine(line, x + pad, y - pad - size - j * lead + 1.5, INK, { rtl, max: widths[i] - pad * 2 }));
        x += widths[i];
      });
      page.drawLine({ start: { x: MARGIN.x, y: y - h }, end: { x: MARGIN.x + width, y: y - h }, thickness: header ? 0.8 : 0.5, color: header ? SOFT : LINE });
      y -= h;
    };
    room(size * 5);
    drawRow(head, true);
    for (const r of rows) drawRow(r, false);
  }

  // ---- footer on every page ----
  const pages = pdf.getPages();
  const foot = wrap([{ text: sanitize(title).slice(0, 80) }], 8, width * 0.7)[0];
  pages.forEach((p, i) => {
    page = p;
    p.drawLine({ start: { x: MARGIN.x, y: 44 }, end: { x: MARGIN.x + width, y: 44 }, thickness: 0.5, color: LINE });
    drawLine(foot, MARGIN.x, 30, SOFT, { rtl: titleRtl, max: width });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: titleRtl ? MARGIN.x : MARGIN.x + width - F.regular.widthOfTextAtSize(n, 8), y: 30, size: 8, font: F.regular, color: SOFT });
  });

  return pdf.save();
}

// Letters, digits and a few separators, so the name survives every phone's file system.
export const pdfName = (title) => `${clean(title).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Document'}.pdf`;
