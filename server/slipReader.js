// Reading a payment slip as it is attached: the amount on it, the day, how it was paid and its
// reference, to fill the payment in with, and the amount as the most that can be recorded against
// it. What cannot be seen is left out, and a slip that cannot be read limits nothing.
// A reading is kept for an hour by the file's fingerprint, so saving does not read it a second time.

import { createHash } from 'node:crypto';
import { fileBlock, isDate } from './documentReader.js';

let ask = (...args) => import('./ai.js').then((m) => m.ask(...args));
/** Tests put their own reader in place of Claude. */
export const useAsk = (fn) => { ask = fn; seen.clear(); };

const METHODS = ['transfer', 'cash', 'card', 'money_order', 'online'];
const WAIT = 45_000;
const KEEP = 60 * 60_000;
const seen = new Map(); // fingerprint -> { at, slip }

const PROMPT = `This is the proof of a payment of rent or charges (a bank transfer slip, a card slip, a money order, an online payment confirmation, a cash receipt). Read it and reply with one JSON object and nothing else, using only these keys and leaving out any you cannot see on it:
"amount": the amount paid, as a plain number (no currency, no commas)
"received_on": the date it was paid, as YYYY-MM-DD
"method": "transfer" (bank transfer), "cash", "card" (card at a terminal), "money_order" or "online" (paid online by card or e-check)
"reference": the transaction, authorisation, receipt or money order number, with the card type if shown (e.g. "ePay VISA 123456")
Never guess a number or a date.`;

/** What is worth using out of the reply: an amount above zero, a real date, a known method, a short reference. */
export function slipFrom(reply) {
  let o;
  try { o = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  const amount = Math.round(Number(String(o.amount ?? '').replace(/[^\d.]/g, '')) * 100) / 100;
  if (amount > 0) out.amount = amount;
  if (isDate(o.received_on)) out.received_on = o.received_on;
  if (METHODS.includes(o.method)) out.method = o.method;
  if (typeof o.reference === 'string' && o.reference.trim()) out.reference = o.reference.trim().slice(0, 120);
  return out;
}

/** What a slip says. {} when it cannot be read, for any reason. */
export async function readSlip(file, { timeoutMs = WAIT } = {}) {
  const b = file?.buffer && fileBlock(file);
  if (!b) return {};
  const key = createHash('sha256').update(file.buffer).digest('hex');
  const kept = seen.get(key);
  if (kept && Date.now() - kept.at < KEEP) return kept.slip;
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('the reading took too long')), timeoutMs); });
  try {
    const slip = slipFrom(await Promise.race([ask(null, { maxTokens: 300, content: [b, { type: 'text', text: PROMPT }] }), late]));
    for (const [k, v] of seen) if (Date.now() - v.at >= KEEP) seen.delete(k);
    seen.set(key, { at: Date.now(), slip });
    return slip;
  } catch (e) {
    console.error('[slip-reader]', e.message);
    return {};
  } finally {
    clearTimeout(timer);
  }
}
