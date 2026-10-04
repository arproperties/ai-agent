import { Router } from 'express';
import { db } from './db.js';
import { bad, bookingRef, dueName, receiptNo, METHODS } from './leasing.js';
import { cash, currencyWords } from './leasingRegion.js';

// The receipt for one payment, as a PDF on the letterhead of the company that owns the
// building: who paid, how much (in figures and in words), what for, how, and what is still
// owed on that row of the schedule. Made fresh each time from the payment, never stored.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below1000 = (n) => [n >= 100 && `${ONES[Math.floor(n / 100)]} Hundred`, n % 100 >= 20 ? [TENS[Math.floor((n % 100) / 10)], ONES[n % 10]].filter(Boolean).join('-') : ONES[n % 100]]
  .filter(Boolean).join(' ');

/** 4500.5 → "Four Thousand Five Hundred Dirhams and 50 Fils Only", in whatever the currency is. */
export function inWords(amount) {
  const whole = Math.floor(amount);
  const fils = Math.round((amount - whole) * 100);
  const parts = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']].map(([size, name]) => {
    const n = Math.floor(whole / size) % 1000;
    return n ? `${below1000(n)} ${name}`.trim() : '';
  }).filter(Boolean);
  const [units, hundredths] = currencyWords();
  return `${parts.join(' ') || 'Zero'} ${units}${fils ? ` and ${fils} ${hundredths}` : ''} Only`;
}

// The built-in PDF fonts only know Western letters; anything else would stop the page being made.
const plain = (v) => String(v ?? '').replace(/[–—]/g, '-').replace(/[^\x20-\x7E -ÿ]/g, '?');
const aed = (n) => cash(n, { exact: true });
const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Everything one receipt says, read from the payment. */
export async function receiptRow(paymentId) {
  const p = await db.prepare(`SELECT p.id, p.amount, p.method, p.reference, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, w.name AS recorded_by,
      i.kind, i.label, i.amount AS due_amount, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
      (SELECT coalesce(sum(x.amount), 0) FROM lease_payments x WHERE x.installment_id = i.id AND x.id <= p.id) AS paid_so_far,
      b.id AS booking_id, to_char(b.start_date, 'YYYY-MM-DD') AS start_date, to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
      t.full_name AS tenant, t.phone AS tenant_phone, u.unit_no, bl.name AS building,
      c.name AS company, c.trn, c.trade_license_no, c.address, c.phone, c.email
    FROM lease_payments p JOIN lease_installments i ON i.id = p.installment_id JOIN lease_bookings b ON b.id = i.booking_id
    JOIN lease_tenants t ON t.id = b.tenant_id JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id
    JOIN prop_companies c ON c.id = bl.company_id LEFT JOIN users w ON w.id = p.recorded_by WHERE p.id = ?`).get(Number(paymentId) || 0);
  if (!p) throw bad('Not found', 404);
  return p;
}

/** The receipt's page, from receiptRow(). The PDF library is loaded when the first receipt is asked for. */
export async function renderReceipt(p) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 420]); // A5, on its side
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  const L = 40;
  const R = 555;
  const put = (text, x, y, { size = 10, f = font, color = ink, right = false } = {}) => {
    const s = plain(text);
    page.drawText(s, { x: right ? x - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color });
  };
  const rule = (y, color = rgb(0.8, 0.8, 0.83)) => page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.7, color });

  // Letterhead: the company on the left, the receipt's number and date on the right.
  put(p.company, L, 372, { size: 16, f: bold });
  put([p.address, p.phone, p.email].filter(Boolean).join('  ·  '), L, 356, { size: 8.5, color: grey });
  put([p.trn && `TRN ${p.trn}`, p.trade_license_no && `Licence ${p.trade_license_no}`].filter(Boolean).join('  ·  '), L, 344, { size: 8.5, color: grey });
  put('RECEIPT', R, 372, { size: 16, f: bold, right: true });
  put(receiptNo(p), R, 356, { size: 10, right: true });
  put(longDate(p.received_on), R, 344, { size: 8.5, color: grey, right: true });
  rule(330, ink);

  const left = Number(p.due_amount) - Number(p.paid_so_far);
  const rows = [
    ['Received from', [p.tenant, p.tenant_phone].filter(Boolean).join('  ·  ')],
    ['The sum of', inWords(Number(p.amount))],
    ['For', `${dueName(p)} due ${longDate(p.due_date)}`],
    ['Property', `Unit ${p.unit_no}, ${p.building}  ·  ${bookingRef({ id: p.booking_id, start_date: p.start_date })}  ·  ${longDate(p.start_date)} to ${longDate(p.end_date)}`],
    ['Paid by', [METHODS.find(([k]) => k === p.method)?.[1], p.reference && `Ref. ${p.reference}`].filter(Boolean).join('  ·  ')],
    ['Still owed', left > 0.004 ? `${aed(left)} of ${aed(p.due_amount)}` : 'Nothing: paid in full'],
  ];
  let y = 304;
  for (const [label, value] of rows) {
    put(label, L, y, { size: 9, color: grey });
    put(value, L + 90, y, { size: 10.5 });
    rule(y - 9);
    y -= 28;
  }

  page.drawRectangle({ x: L, y: 62, width: 190, height: 40, borderColor: ink, borderWidth: 1 });
  put(aed(p.amount), L + 14, 76, { size: 17, f: bold });
  page.drawLine({ start: { x: 380, y: 70 }, end: { x: R, y: 70 }, thickness: 0.7, color: ink });
  put(`Received by${p.recorded_by ? `: ${p.recorded_by}` : ''}`, 380, 58, { size: 8.5, color: grey });
  put('This receipt was made by the leasing system and is valid without a stamp.', L, 34, { size: 7.5, color: grey });

  return { bytes: Buffer.from(await doc.save()), name: `${receiptNo(p)}.pdf` };
}

export const receiptPdf = async (paymentId) => renderReceipt(await receiptRow(paymentId));

export const receiptRoutes = Router();
receiptRoutes.get('/:id/receipt', (req, res, next) => receiptPdf(req.params.id).then(({ bytes, name }) => {
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.type('application/pdf').send(bytes);
}).catch(next));
