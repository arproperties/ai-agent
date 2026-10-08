// How Leasing and Properties write a phone number and a date: 555-123-4567 and MM/DD/YYYY.
//
// This file is shared: the server imports it, and so does the app (client/src/lib/usFormat.js),
// so it may not import anything. A date is kept as YYYY-MM-DD everywhere and only written
// the American way; it is turned by its letters, never through a Date, so no time zone can
// move it a day.

const pad = (n) => String(n).padStart(2, '0');

/** A stored date (YYYY-MM-DD) as it is written: 10/08/2026. Nothing for no date. */
export function usDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** A moment (in milliseconds) as the day it falls on here: 10/08/2026. */
export function usDateOf(ms) {
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

/** A typed date (MM/DD/YYYY) as it is stored, or '' while it is unfinished or not a real day. */
export function isoDate(us) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(us ?? '').trim());
  if (!m) return '';
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${m[3]}-${m[1]}-${m[2]}` : '';
}

/** What a date box shows as it is typed into: the digits, with the slashes put in. */
export function typeDate(text) {
  const d = String(text ?? '').replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
}

/**
 * A phone number as it is written: 555-123-4567. One that starts with + has its own
 * country code and is left alone, and so is one that is not ten digits long.
 */
export function usPhone(v) {
  const raw = String(v ?? '').trim();
  if (raw.startsWith('+')) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : raw;
}

/** What a phone box shows as it is typed into: up to ten digits, with the dashes put in. */
export function typePhone(text) {
  const raw = String(text ?? '');
  if (raw.trimStart().startsWith('+')) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length >= 11 && d.startsWith('1')) d = d.slice(1);
  d = d.slice(0, 10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].filter(Boolean).join('-');
}

/** An EIN as it is written: 12-3456789. One that is not nine digits is left as written. */
export function usEin(v) {
  const raw = String(v ?? '').trim();
  const d = raw.replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : raw;
}

/** What an EIN box shows as it is typed into: up to nine digits, with the dash put in. */
export function typeEin(text) {
  const d = String(text ?? '').replace(/\D/g, '').slice(0, 9);
  return [d.slice(0, 2), d.slice(2)].filter(Boolean).join('-');
}

/** What a ZIP box shows as it is typed into: five digits, or nine with the dash put in. */
export function typeZip(text) {
  const d = String(text ?? '').replace(/\D/g, '').slice(0, 9);
  return [d.slice(0, 5), d.slice(5)].filter(Boolean).join('-');
}

// What is wrong with a value, in words for the person who typed it, or '' when nothing is.
// Nothing typed is never a problem: whether a field must be filled is decided elsewhere.
export const einProblem = (v) => (!String(v ?? '').trim() || /^\d{2}-\d{7}$/.test(usEin(v)) ? '' : 'An EIN is nine digits, like 12-3456789.');
export const emailProblem = (v) => (!String(v ?? '').trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? '' : 'That email address does not look right.');
export const zipProblem = (v) => (!String(v ?? '').trim() || /^\d{5}(-\d{4})?$/.test(String(v).trim()) ? '' : 'A ZIP code is five digits, like 78701.');

/** An address on one line, the way it ends in America: "500 Congress Ave, Austin, TX 78701". */
export function usAddress(street, city, state, zip) {
  return [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
