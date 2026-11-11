// Tables in an email body. Drafts are plain text, and an agent writes a table as rows with
// "|" between the cells, header first. Sent as-is that reads as a jumble of pipes, so the
// email goes out with an HTML part where those rows are a real bordered table; the plain-text
// part keeps the rows as written for mail apps that show text only.
//
// The same parser lives in client/src/lib/emailTable.js so the card shows what will be sent.
// Keep the two in step.

const cellsOf = (line) => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};
const isRow = (line) => line.includes('|') && cellsOf(line).length >= 2;
// The "|---|---|" line Markdown puts under a header: it marks the header, it is not a row.
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * The body as a list of blocks: { text } for ordinary lines, { rows } for a table. Two or more
 * rows in a row with the same number of cells make a table; a lone line with a "|" in it
 * ("Lease Voucher | Receipt") is just text.
 */
export function splitTables(body) {
  const lines = String(body ?? '').split('\n');
  const blocks = [];
  let text = [];
  const flushText = () => { if (text.length) blocks.push({ text: text.join('\n') }); text = []; };

  for (let i = 0; i < lines.length;) {
    if (!isRow(lines[i]) || isRule(lines[i])) { text.push(lines[i]); i++; continue; }
    const width = cellsOf(lines[i]).length;
    const rows = [cellsOf(lines[i])];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (isRule(lines[j])) continue;
      if (!isRow(lines[j]) || cellsOf(lines[j]).length !== width) break;
      rows.push(cellsOf(lines[j]));
    }
    if (rows.length < 2) { text.push(lines[i]); i++; continue; }
    flushText();
    blocks.push({ rows });
    i = j;
  }
  flushText();
  return blocks;
}

export const hasTable = (body) => splitTables(body).some((b) => b.rows);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Numbers line up on the right, the way they do in a ledger.
const numeric = (s) => /^[-–—]?$|^[(-]?[A-Z]{0,3}\s?[\d,]+(\.\d+)?\)?%?$/.test(s.trim());

const CELL = 'border:1px solid #cfcfd6;padding:6px 10px;';

/** The email's HTML part: the text as written, with each table drawn as a table. */
export function bodyHtml(body) {
  const parts = splitTables(body).map((b) => {
    if (b.text != null) return `<div style="white-space:pre-wrap">${esc(b.text)}</div>`;
    const [head, ...rest] = b.rows;
    const th = head.map((c) => `<th style="${CELL}background:#f2f2f5;text-align:left;font-weight:600">${esc(c)}</th>`).join('');
    const trs = rest.map((r) => `<tr>${r.map((c, k) =>
      `<td style="${CELL}text-align:${k > 0 && numeric(c) ? 'right' : 'left'}">${esc(c)}</td>`).join('')}</tr>`).join('');
    return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:8px 0"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1d1b2e">${parts.join('')}</div>`;
}
