import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';

// Where the business is: its currency, its time zone and its phone country code. It began
// in the UAE, which is still the default; the master changes it here and everything in
// properties and leasing follows — what "today" is, when the quiet hours fall, the currency
// on screens, receipts and reminders, and how a local phone number is dialled for WhatsApp.
//
// It is one setting for the whole app (lease_settings, key 'region'), kept in memory so
// that "what is today's date" can be answered without a query each time.

const DEFAULT = { currency: 'AED', timezone: 'Asia/Dubai', phone_code: '971' };
// What a currency's whole and hundredth are called, for the amount in words on a receipt.
const WORDS = {
  AED: ['Dirhams', 'Fils'], USD: ['Dollars', 'Cents'], CAD: ['Dollars', 'Cents'], EUR: ['Euros', 'Cents'], GBP: ['Pounds', 'Pence'],
  SAR: ['Riyals', 'Halalas'], QAR: ['Riyals', 'Dirhams'], INR: ['Rupees', 'Paise'], PKR: ['Rupees', 'Paisa'],
};
const bad = (message) => Object.assign(new Error(message), { status: 400 });

let now = { ...DEFAULT };
const saved = await db.prepare("SELECT value FROM lease_settings WHERE key = 'region'").get();
if (saved) now = { ...DEFAULT, ...JSON.parse(saved.value) };

export const region = () => now;

export async function saveRegion(body = {}) {
  const next = { ...now };
  if ('currency' in body) {
    next.currency = String(body.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(next.currency)) throw bad('The currency is its three-letter code, like AED or USD.');
  }
  if ('timezone' in body) {
    next.timezone = String(body.timezone ?? '').trim();
    try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw bad('That time zone is not known. Choose one from the list, like America/New_York.'); }
  }
  if ('phone_code' in body) {
    next.phone_code = String(body.phone_code ?? '').replace(/\D/g, '');
    if (!/^\d{1,4}$/.test(next.phone_code)) throw bad('The phone country code is one to four digits, like 971 or 1.');
  }
  await db.prepare("INSERT INTO lease_settings (key, value) VALUES ('region', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").run(JSON.stringify(next));
  now = next;
  return now;
}

const parts = (date, opts) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: now.timezone, hourCycle: 'h23', ...opts }).formatToParts(date).map((p) => [p.type, p.value]));

/** Today's date where the business is, as YYYY-MM-DD. */
export function todayHere(date = new Date()) {
  const p = parts(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}
/** The hour of the day there, 0–23. */
export const hourHere = (date = new Date()) => Number(parts(date, { hour: '2-digit' }).hour);
/** The date there of a moment stored as unix seconds. */
export const dayOf = (secs) => todayHere(new Date(Number(secs) * 1000));

/** An amount as it is written: "AED 4,500", with fils or cents only when there are any ("AED 4,500.50"), or always, with `exact`. */
export const cash = (n, { exact = false } = {}) => {
  const digits = exact || Math.round(Number(n) * 100) % 100 ? 2 : 0;
  return `${now.currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
/** What the currency's whole and hundredth are called; the code itself for one not listed. */
export const currencyWords = () => WORDS[now.currency] || [now.currency, 'Cents'];

export const regionRoutes = Router();
regionRoutes.get('/', (req, res) => res.json(now));
regionRoutes.put('/', requireMaster, (req, res, next) => saveRegion(req.body).then((r) => res.json(r)).catch(next));
