// The document inside a Jarvis reply - what its PDF is made from. Kept in step with
// documentPart() in server/replyDoc.js, which builds the PDF: this copy only decides
// whether to offer one and shows the preview.

const OPEN = /^[ \t]*<!--\s*doc\s*-->[ \t]*$/im;
const CLOSE = /^[ \t]*<!--\s*\/doc\s*-->[ \t]*$/im;
const OFFER = /^(want me|would you|shall i|should i|do you want|let me know|if you (?:want|need|'d like|would like)|i can also|happy to|need (?:me|any)|tell me)/i;

function isOffer(para) {
  const p = para.trim();
  if (/^(#|\||[-*+] |\d+[.)] |>)/.test(p) || p.length > 300) return false;
  return OFFER.test(p.replace(/^[*_]+/, '')) || /\?\s*[*_]*$/.test(p);
}

const clean = (s) => String(s).replace(/[*_`#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

/** { title, markdown } of the document in a reply, or null for an ordinary answer. */
export function documentPart(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  let body;
  const open = OPEN.exec(text);
  if (open) {
    const rest = text.slice(open.index + open[0].length);
    const close = CLOSE.exec(rest);
    body = close ? rest.slice(0, close.index) : rest;
  } else {
    const first = /^#{1,3}[ \t]+\S/m.exec(text);
    if (!first || text.length < 600) return null;
    body = text.slice(first.index);
    const paras = body.trimEnd().split(/\n{2,}/);
    while (paras.length > 1 && isOffer(paras.at(-1))) paras.pop();
    body = paras.join('\n\n');
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!body) return null;
  const h = /^#{1,3}[ \t]+(.+)$/m.exec(body);
  return { title: clean(h ? h[1] : body.split('\n')[0]).slice(0, 100) || 'Document', markdown: body };
}

/** The reply as the person reads it: the markers out, including one still being streamed. */
export const hideMarkers = (content) => String(content || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[^>]*$/, '');
