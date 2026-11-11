// The earlier emails under a reply. Outlook and Gmail put the email being answered below
// the new lines ("From: … Sent: … To: … Subject: …" and its words), and that email already
// carries the ones before it — so the person reading has the whole conversation in one
// email. Without it a reply from Reem arrives as a few lines with no history. Pure, so it is
// testable; the original comes in already parsed by mailparser.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The office is in Dubai and the server runs on UTC: the date reads as the people on the
// email saw it, in the same words Outlook uses ("Wednesday, November 11, 2026 4:48 PM").
export const sentLine = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-US', { timeZone: 'Asia/Dubai', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'Asia/Dubai', hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
};

const people = (field) => (field?.value || []).map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name)).filter(Boolean).join('; ');

/** Only what is inside <body>: the original's own <html>/<head> cannot sit inside ours. */
export function innerBody(html) {
  let s = String(html || '');
  const open = s.match(/<body[^>]*>/i);
  if (open) s = s.slice(open.index + open[0].length);
  const close = s.search(/<\/body>/i);
  if (close >= 0) s = s.slice(0, close);
  return s.replace(/<\/?html[^>]*>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '').trim();
}

// Pictures in the original's body (a pasted screenshot, a signature logo) travel with it,
// or the quoted email shows empty boxes. Capped so a heavy thread cannot balloon the reply.
const MAX_INLINE = 8 * 1024 * 1024;

/**
 * { text, html, inline } for the email being answered, or null when there is nothing to quote.
 * text and html go under the reply's own text and HTML; inline are the pictures the html
 * points at (cid:), ready to hand to nodemailer as attachments.
 */
export function quoteOf(p) {
  if (!p) return null;
  const head = [
    ['From', people(p.from)],
    ['Sent', sentLine(p.date)],
    ['To', people(p.to)],
    ['Cc', people(p.cc)],
    ['Subject', p.subject || ''],
  ].filter(([, v]) => v);
  const words = String(p.text || '').replace(/\r/g, '').trim();
  const html = p.html ? innerBody(p.html) : '';
  if (!words && !html) return null;

  const text = `\n\n________________________________\n${head.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${words}`;

  let inline = [];
  let size = 0;
  if (html) {
    for (const a of p.attachments || []) {
      if (!a.cid || !html.includes(`cid:${a.cid}`)) continue;
      size += a.size || a.content?.length || 0;
      if (size > MAX_INLINE) break;
      inline.push({ filename: a.filename || 'image', content: a.content, contentType: a.contentType, cid: a.cid, contentDisposition: 'inline' });
    }
  }

  const block = html || `<div style="white-space:pre-wrap">${esc(words)}</div>`;
  const htmlOut = `<div style="border-top:1px solid #b5b5bd;margin-top:18px;padding-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px">` +
    `<p style="margin:0 0 12px">${head.map(([k, v]) => `<b>${k}:</b> ${esc(v)}`).join('<br>')}</p>` +
    `${block}</div>`;
  return { text, html: htmlOut, inline };
}
