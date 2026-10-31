// The readable text of a parsed email (mailparser result).
// Many phones and webmail apps send HTML only, with no plain-text part. mailparser then
// leaves `text` empty, and the agent saw those mails as blank - Francisca's daily progress
// reports looked like "no body". So when there is no text part, the HTML is turned into text.

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (all, e) => {
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e) && e !== '#39') return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/[ \t]*\|[ \t]*\n/g, '\n') // a row's last cell leaves a trailing " | "
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text if the mail has it, otherwise its HTML as text. */
export const mailText = (p) => String(p?.text || '').trim() ? String(p.text) : htmlToText(p?.html);
