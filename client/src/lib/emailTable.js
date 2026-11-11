// Tables in an email body. Drafts are plain text, and an agent writes a table as rows with
// "|" between the cells, header first. Sent as-is that reads as a jumble of pipes, so the
// email goes out with an HTML part where those rows are a real bordered table; the plain-text
// part keeps the rows as written for mail apps that show text only.
//
// The same parser lives in server/emailTable.js, which builds the email that is sent.
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

// Numbers line up on the right, the way they do in a ledger.
export const numeric = (s) => /^[-–—]?$|^[(-]?[A-Z]{0,3}\s?[\d,]+(\.\d+)?\)?%?$/.test(s.trim());
