// Select text in a reply → Remove. What was selected is the text on screen; the reply is
// stored as markdown. So the markdown is read as it shows (no ** or list marks, one space
// for any run of spaces), the selection is found in that, and the matching stretch of the
// markdown is taken out.

const MARK = new Set(['*', '_', '`', '|', '[']);
const LEAD = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+|>[ \t]?)*/;

// The markdown as it reads on screen, and where each character of that came from.
function asShown(src) {
  const text = [];
  const from = [];
  const space = (i) => { if (text.length && text[text.length - 1] !== ' ') { text.push(' '); from.push(i); } };
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { // hidden markers
      const end = src.indexOf('-->', i);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (lineStart) { // list marks, headings and quotes are not part of the text
      const lead = LEAD.exec(src.slice(i, i + 40))[0];
      i += lead.length;
      lineStart = false;
      continue;
    }
    const c = src[i];
    if (c === '\n') { space(i); i++; lineStart = true; continue; }
    if (/\s/.test(c)) { space(i); i++; continue; }
    if (c === ']' && src[i + 1] === '(') { // a link: keep its words, not its address
      const end = src.indexOf(')', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (MARK.has(c) || c === ']') { i++; continue; }
    text.push(c);
    from.push(i);
    i++;
  }
  return { text: text.join(''), from };
}

const tidy = (s) => String(s || '').replace(/[*_`|[\]]/g, '').replace(/\s+/g, ' ').trim();

/** The reply without the selected text, or null when it cannot be found. */
export function cutSelection(markdown, selected) {
  const want = tidy(selected);
  if (!want) return null;
  const { text, from } = asShown(markdown);
  let at = text.indexOf(want);
  if (at < 0) at = text.toLowerCase().indexOf(want.toLowerCase());
  if (at < 0) return null;
  const start = from[at];
  const end = from[at + want.length - 1] + 1;

  let out = markdown.slice(0, start) + markdown.slice(end);
  // The line the cut was on: if nothing readable is left of it ("- **" or "1. "), it goes too.
  const lineStart = out.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = out.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = out.length;
  const line = out.slice(lineStart, lineEnd);
  if (!/[\p{L}\p{N}]/u.test(line.replace(LEAD, ''))) out = out.slice(0, lineStart) + out.slice(lineEnd + 1);
  else out = out.slice(0, lineStart) + line.replace(/(\*\*|__)\s*\1/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '') + out.slice(lineEnd);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
