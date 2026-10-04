import { api } from './api';

// Where the business is: its currency, time zone and phone country code, set by the master
// (server/leasingRegion.js). Read once after signing in and kept here, so any screen can
// write an amount without asking. The UAE is the default until the server has answered.

let now = { currency: 'AED', timezone: 'Asia/Dubai', phone_code: '971' };
const listeners = new Set();
const set = (r) => { now = r; listeners.forEach((fn) => fn(now)); return now; };

export const CURRENCIES = [
  ['AED', 'AED · UAE dirham'], ['USD', 'USD · US dollar'], ['SAR', 'SAR · Saudi riyal'], ['QAR', 'QAR · Qatari riyal'], ['KWD', 'KWD · Kuwaiti dinar'],
  ['BHD', 'BHD · Bahraini dinar'], ['OMR', 'OMR · Omani rial'], ['EUR', 'EUR · Euro'], ['GBP', 'GBP · Pound sterling'], ['CAD', 'CAD · Canadian dollar'],
  ['INR', 'INR · Indian rupee'], ['PKR', 'PKR · Pakistani rupee'],
];

export const region = () => now;
export const currency = () => now.currency;
/** An amount as it is written: "AED 4,500". */
export const money = (n) => `${now.currency} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Today's date where the business is (YYYY-MM-DD), whatever time zone this phone or computer is set to. */
export const today = () => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: now.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); }
};

export const loadRegion =() => api.get('/leasing/region').then(set).catch(() => now);
export const saveRegion = (v) => api.put('/leasing/region', v).then(set);
/** Be told when the region changes; returns how to stop being told. */
export const onRegion = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
