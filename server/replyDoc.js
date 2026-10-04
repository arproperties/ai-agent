// A Riley reply, turned into a PDF.
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
// The built-in PDF fonts only cover Western European letters. Anything else is swapped
// for a near equivalent or dropped, and a document that is mostly another script
// (Arabic, say) is refused rather than handed over with its words missing.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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
  const title = clean(h ? h[1] : body.split('\n')[0].split(/(?<=[.!?])\s/)[0]).slice(0, 100) || 'Document';
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
const drawable = (c) => {
  const n = c.codePointAt(0);
  return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || WIN_ANSI_EXTRA.includes(c);
};
const SWAP = {
  '✓': 'v', '✔': 'v', '☑': '[x]', '✅': 'v', '✗': 'x', '✘': 'x', '❌': 'x', // no tick in the standard fonts
  '→': '->', '⇒': '=>', '←': '<-', '↔': '<->', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~',
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—', '′': "'", '″': '"',
  '▪': '•', '◦': '•', '●': '•', '○': 'o', '■': '•', '□': '[ ]', '☐': '[ ]', '★': '*', '☆': '*',
  ' ': ' ', ' ': ' ', '​': '', '‎': '', '‏': '', '️': '',
};

export function sanitize(s) {
  let out = '';
  for (const c of String(s).normalize('NFC')) {
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
  return runs.map((r) => ({ ...r, text: sanitize(r.text.replaceAll(BLANK, '_')) })).filter((r) => r.text);
}

// ---------- layout ----------

const A4 = [595.28, 841.89];
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
  pdf.setCreator('Riley');
  pdf.setProducer('Riley');
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
  const width = A4[0] - MARGIN.x * 2;
  let page;
  let y;

  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - MARGIN.top; };
  const room = (h) => { if (y - h < MARGIN.bottom) newPage(); };

  // Runs → lines no wider than `max`, each line a list of { text, font, w }.
  const wrap = (runs, size, max, base = {}) => {
    const lines = [[]];
    let w = 0;
    const words = [];
    for (const r of runs) {
      const font = fontOf({ ...base, ...r });
      const sz = r.code ? size * 0.92 : size;
      for (const part of r.text.split(/(\n|[^\S\n]+)/)) {
        if (part) words.push({ text: part === '\n' ? '\n' : /^\s+$/.test(part) ? ' ' : part, font, size: sz, color: base.color });
      }
    }
    for (const word of words) {
      if (word.text === '\n') {
        while (lines.at(-1).at(-1)?.text === ' ') lines.at(-1).pop();
        lines.push([]); w = 0;
        continue;
      }
      const ww = word.font.widthOfTextAtSize(word.text, word.size);
      if (word.text === ' ') {
        if (lines.at(-1).length) { lines.at(-1).push({ ...word, w: ww }); w += ww; }
        continue;
      }
      if (w + ww > max && lines.at(-1).length) {
        while (lines.at(-1).at(-1)?.text === ' ') w -= lines.at(-1).pop().w;
        lines.push([]); w = 0;
      }
      if (ww > max) { // a word longer than the line: break it by letters
        let chunk = '';
        for (const ch of word.text) {
          if (word.font.widthOfTextAtSize(chunk + ch, word.size) > max - w && chunk) {
            lines.at(-1).push({ ...word, text: chunk, w: word.font.widthOfTextAtSize(chunk, word.size) });
            lines.push([]); w = 0; chunk = '';
          }
          chunk += ch;
        }
        const cw = word.font.widthOfTextAtSize(chunk, word.size);
        lines.at(-1).push({ ...word, text: chunk, w: cw }); w += cw;
        continue;
      }
      lines.at(-1).push({ ...word, w: ww }); w += ww;
    }
    while (lines.at(-1).at(-1)?.text === ' ') lines.at(-1).pop();
    return lines.filter((l, i) => l.length || i === 0);
  };

  const drawLine = (line, x, baseline, color = INK) => {
    let cx = x;
    for (const seg of line) {
      if (seg.text !== ' ') page.drawText(seg.text, { x: cx, y: baseline, size: seg.size, font: seg.font, color: seg.color || color });
      cx += seg.w;
    }
  };

  // A wrapped paragraph at x, `lead` apart, moving y down as it goes.
  const flow = (runs, { size = 10.5, x = MARGIN.x, max = width - (x - MARGIN.x), lead = size * 1.45, color = INK, base = {}, before } = {}) => {
    const lines = wrap(runs, size, max, base);
    lines.forEach((line, i) => {
      room(lead);
      if (i === 0 && before) before(y - size);
      drawLine(line, x, y - size, color);
      y -= lead;
    });
  };

  // ---- title block ----
  newPage();
  const when = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
  page.drawRectangle({ x: MARGIN.x, y: y - 3, width: 36, height: 3, color: ACCENT });
  y -= 18;
  flow([{ text: sanitize(title) }], { size: 21, lead: 26, base: { bold: true } });
  y -= 2;
  flow([{ text: when }], { size: 9.5, color: SOFT });
  y -= 6;
  page.drawLine({ start: { x: MARGIN.x, y }, end: { x: MARGIN.x + width, y }, thickness: 0.6, color: LINE });
  y -= 18;

  const blocks = parseBlocks(markdown);
  // The first heading is the title, already drawn above.
  if (blocks[0]?.type === 'heading' && clean(blocks[0].text) === clean(title)) blocks.shift();

  for (const b of blocks) {
    if (b.type === 'heading') {
      const size = b.level === 1 ? 16 : b.level === 2 ? 13.5 : b.level === 3 ? 11.5 : 10.5;
      y -= b.level <= 2 ? 10 : 6;
      room(size * 3.2); // never a heading alone at the foot of a page
      flow(parseInline(b.text), { size, lead: size * 1.35, base: { bold: true }, color: b.level <= 2 ? ACCENT : INK });
      if (b.level <= 2) y -= 2;
      y -= 3;
    } else if (b.type === 'para') {
      flow(parseInline(b.text));
      y -= 6;
    } else if (b.type === 'item') {
      const indent = MARGIN.x + 6 + b.depth * 16;
      const gap = b.check !== null ? 17 : b.marker === '•' ? 11 : 17;
      flow(parseInline(b.text), {
        x: indent + gap,
        before: (baseline) => {
          if (b.check !== null) {
            page.drawRectangle({ x: indent, y: baseline - 1, width: 9, height: 9, borderColor: SOFT, borderWidth: 0.8 });
            if (b.check) page.drawText('x', { x: indent + 2, y: baseline + 0.5, size: 8.5, font: F.bold, color: ACCENT });
          } else {
            page.drawText(b.marker, { x: indent, y: baseline, size: 10.5, font: b.marker === '•' ? F.regular : F.bold, color: ACCENT });
          }
        },
      });
      y -= 3;
    } else if (b.type === 'quote') {
      const top = y;
      const startPage = page;
      flow(parseInline(b.text), { x: MARGIN.x + 14, color: SOFT, base: { italic: true } });
      if (page === startPage) page.drawRectangle({ x: MARGIN.x + 2, y: y + 4, width: 2, height: top - y - 4, color: ACCENT });
      y -= 6;
    } else if (b.type === 'code') {
      for (const l of b.lines) {
        room(13);
        page.drawRectangle({ x: MARGIN.x, y: y - 13, width, height: 13, color: FILL });
        const text = sanitize(l.replace(/\t/g, '  '));
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

  function drawTable({ head, rows }) {
    const cols = Math.max(head.length, ...rows.map((r) => r.length));
    const size = cols > 4 ? 8.5 : 9.5;
    const pad = 5;
    const plain = (c) => sanitize(clean(c || ''));
    // Column widths by how much each holds, with a floor so no column collapses.
    const want = Array.from({ length: cols }, (_, i) => Math.max(
      F.bold.widthOfTextAtSize(plain(head[i]), size),
      ...rows.map((r) => Math.min(F.regular.widthOfTextAtSize(plain(r[i]), size), 220)),
    ) + pad * 2);
    const floor = Math.min(60, width / cols);
    const total = want.reduce((a, b) => a + b, 0);
    let widths = want.map((w) => Math.max(floor, (w / total) * width));
    const sum = widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => (w / sum) * width);
    const lead = size * 1.35;

    const drawRow = (cells, header) => {
      const wrapped = widths.map((w, i) => wrap(parseInline(cells[i] || ''), size, w - pad * 2, header ? { bold: true } : {}));
      const h = Math.max(...wrapped.map((l) => l.length)) * lead + pad * 2;
      if (y - h < MARGIN.bottom) { newPage(); if (!header) drawRow(head, true); }
      if (header) page.drawRectangle({ x: MARGIN.x, y: y - h, width, height: h, color: FILL });
      let x = MARGIN.x;
      wrapped.forEach((lines, i) => {
        lines.forEach((line, j) => drawLine(line, x + pad, y - pad - size - j * lead + 1.5));
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
  const foot = sanitize(title).slice(0, 80);
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN.x, y: 44 }, end: { x: MARGIN.x + width, y: 44 }, thickness: 0.5, color: LINE });
    p.drawText(foot, { x: MARGIN.x, y: 30, size: 8, font: F.regular, color: SOFT });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: MARGIN.x + width - F.regular.widthOfTextAtSize(n, 8), y: 30, size: 8, font: F.regular, color: SOFT });
  });

  return pdf.save();
}

// Letters, digits and a few separators, so the name survives every phone's file system.
export const pdfName = (title) => `${clean(title).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Document'}.pdf`;
