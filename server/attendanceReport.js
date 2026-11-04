import archiver from 'archiver';
import ExcelJS from 'exceljs';

// The period's report, as the office asked for it on the first period: one Excel file per
// person (every date of the period with status, timing, company and who posted it), and a
// summary of everyone. Skipped and not-yet-verified people are in it too, marked as such.

const LABEL = { P: 'Present', L: 'Late', A: 'Absent', V: 'Vacation / leave', O: 'Day off', S: 'Sick', '?': 'Other' };
const FILL = { P: 'FFC6EFCE', L: 'FFFFEB9C', A: 'FFFFC7CE', V: 'FFBDD7EE', O: 'FFE7E6E6', S: 'FFF8CBAD' };
const STATE = { verified: 'Verified', skipped: 'Skipped', to_verify: 'Not verified' };
const HEAD = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } } };
const long = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const ddmm = (d) => d.split('-').reverse().join('-');
const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').trim();

function state(p) {
  const s = STATE[p.state];
  return p.review?.by ? `${s} by ${p.review.by}${p.review.note ? ` (${p.review.note})` : ''}` : s;
}

async function personBook(period, p) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${ddmm(period.start).slice(0, 5)} - ${ddmm(period.end).slice(0, 5)}`);
  ws.addRow([p.name]).font = { bold: true, size: 14 };
  ws.addRow([`${p.companies.join(' → ')}   |   ${long(period.start)} to ${long(period.end)}   |   ${state(p)}`]);
  const c = p.counts;
  ws.addRow([`Present ${c.present + c.late}   Absent ${c.absent}   Vacation ${c.vacation}   Off ${c.off}   Sick ${c.sick}   Not in any list ${c.missing}`]).font = { bold: true };
  if (p.reasons.length) ws.addRow([p.reasons.join('   |   ')]).font = { color: { argb: 'FFC00000' } };
  ws.addRow([]);
  const head = ws.addRow(['Date', 'Day', 'Company', 'Status', 'Timing', 'Changed by hand']);
  head.eachCell((cell) => Object.assign(cell, HEAD));
  for (const d of p.days) {
    const row = ws.addRow([ddmm(d.d), weekday(d.d), d.c || '', d.s ? LABEL[d.s] : d.s === null ? '' : '-', d.h || '', d.m ? 'yes' : '']);
    if (d.s && FILL[d.s]) row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[d.s] } };
  }
  [13, 6, 26, 16, 26, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: head.number }];
  return wb.xlsx.writeBuffer();
}

async function summaryBook(period) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Everyone');
  const head = ws.addRow(['Name', 'Companies', 'State', 'Complete', 'Present', 'Absent', 'Vacation', 'Off', 'Sick', 'Not in any list', 'Why not complete']);
  head.eachCell((cell) => Object.assign(cell, HEAD));
  for (const p of period.people) {
    const c = p.counts;
    ws.addRow([p.name, p.companies.join(', '), state(p), p.complete ? 'yes' : 'no', c.present + c.late, c.absent, c.vacation, c.off, c.sick, c.missing, p.reasons.join(' | ')]);
  }
  [30, 34, 24, 10, 9, 8, 9, 7, 7, 14, 50].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'K1' };
  return wb.xlsx.writeBuffer();
}

/** The zip, streamed: Summary.xlsx, then Verified/, Skipped/ and Not verified/ with a file each. */
export async function sendReport(res, period) {
  const title = `Attendance ${long(period.start)} - ${long(period.end)}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${title}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  zip.append(Buffer.from(await summaryBook(period)), { name: `${title}/Summary.xlsx` });
  const names = new Set();
  for (const p of period.people) {
    let name = safe(p.name);
    while (names.has(name)) name += ` (${p.id})`;
    names.add(name);
    zip.append(Buffer.from(await personBook(period, p)), { name: `${title}/${STATE[p.state]}/${name}.xlsx` });
  }
  await zip.finalize();
}
