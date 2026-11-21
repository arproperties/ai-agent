// Phone numbers in a reply become WhatsApp links. The number and link logic is shared with the
// server (server/whatsappCore.js); only the part that reads a reply's text lives here.
import { waNumber, whatsappUrl, greeting, COMPANY } from '../../../server/whatsappCore.js';

export { waNumber, whatsappUrl, greeting, COMPANY };

// What a phone number looks like in running text. Deliberately strict, since it is run over
// every reply: dates (2026-11-21), amounts (1,200,000.50) and ids must not turn into links.
// A number with + or 00 in front, or a UAE mobile (050/052/054/055/056/058, with or without 971).
const PHONE = /(?<![\w.,/+-])(?:\+\s?\d[\d\s-]{7,17}\d|00\d[\d\s-]{7,17}\d|(?:\+?971[\s-]?|0)?5[024568][\s-]?\d{3}[\s-]?\d{4})(?!\d|[.,]\d)/g;

const SKIP = new Set(['a', 'code', 'pre', 'script', 'style']);

const link = (text, href) => ({
  type: 'element',
  tagName: 'a',
  properties: { href, target: '_blank', rel: 'noopener noreferrer', title: 'Open in WhatsApp with a drafted message', className: ['wa-link'] },
  children: [{ type: 'text', value: text }],
});

// A piece of text cut into text and links; null when it holds no number.
function split(value) {
  const out = [];
  let last = 0;
  for (const m of value.matchAll(PHONE)) {
    const href = whatsappUrl(m[0]);
    if (!href) continue;
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push(link(m[0], href));
    last = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

/** rehype plugin: phone numbers in a reply become WhatsApp links. Code and existing links are left as written. */
export function rehypeWhatsApp() {
  const walk = (node) => {
    if (node.type === 'element' && SKIP.has(node.tagName)) return;
    if (!node.children) return;
    node.children = node.children.flatMap((c) => {
      if (c.type === 'text') return split(c.value) || [c];
      walk(c);
      return [c];
    });
  };
  return walk;
}
