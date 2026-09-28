// The document inside a Jarvis reply - what its PDF is made from. Kept in step with
// documentPart() in server/replyDoc.js, which builds the PDF: this copy only decides
// what the preview shows.

const OPEN = /^[ \t]*<!--\s*doc\s*-->[ \t]*$/im;
const CLOSE = /^[ \t]*<!--\s*\/doc\s*-->[ \t]*$/im;
const OFFER = /^(want me|would you|shall i|should i|do you want|let me know|if you (?:want|need|'d like|would like)|i can also|happy to|need (?:me|any)|tell me)/i;

function isOffer(para) {
  const p = para.trim();
  if (/^(#|\||[-*+] |\d+[.)] |>)/.test(p) || p.length > 300) return false;
  return OFFER.test(p.replace(/^[*_]+/, '')) || /\?\s*[*_]*$/.test(p);
}

const clean = (s) => String(s).replace(/[*_`#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

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

/** { title, markdown } of what goes in a reply's PDF, or null for an empty reply. */
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
  return { title: clean(h ? h[1] : body.split('\n')[0].split(/(?<=[.!?])\s/)[0]).slice(0, 100) || 'Document', markdown: body };
}

/** The reply as the person reads it: the markers out, including one still being streamed. */
export const hideMarkers = (content) => String(content || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[^>]*$/, '');
