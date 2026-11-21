// A phone number you can tap: it opens WhatsApp (the app on a phone, WhatsApp Web on a
// computer) on that person with a message already typed. Nothing is sent from Reem and no
// WhatsApp account or key is involved: wa.me is WhatsApp's own "open a chat" link, and the
// person presses send themselves.
//
// Plain functions with no imports, shared by the server (whatsapp.js: the agents' tool and the
// saved numbers) and the browser (client/src/lib/whatsapp.js: numbers in replies become links),
// the way dashboardCore.js is.

// The company named in the greeting. Change it here and every link follows.
export const COMPANY = 'Ain Al Reem Properties';

/** The greeting typed into the chat: with the person's name when we know it. */
export function greeting(name) {
  const who = String(name || '').trim();
  return `Hello${who ? ` ${who}` : ''}, this is ${COMPANY}. `;
}

/**
 * A number as WhatsApp wants it: country code first, digits only ("971501234567"), or null
 * when it cannot be sure what it is looking at. A UAE mobile written "050 123 4567",
 * "+971 50 123 4567" or "00971 50 123 4567" all come out the same. A number with no country
 * code that is not a UAE mobile is left alone rather than guessed at: a wrong guess would open
 * a chat with a stranger.
 */
export function waNumber(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '');
  if (s.startsWith('+')) { /* already has its country code */ }
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('971')) { /* country code written without the + */ }
  else if (d.length === 10 && d.startsWith('05')) d = `971${d.slice(1)}`;
  else if (d.length === 9 && d.startsWith('5')) d = `971${d}`;
  else return null;
  if (d.length < 9 || d.length > 15) return null;
  if (d.startsWith('971') && d.length !== 12) return null; // a UAE number is 971 + nine digits
  return d;
}

/** The wa.me link for a phone number, or null when it is not one WhatsApp can open. The message defaults to the greeting. */
export function whatsappUrl(raw, name, message) {
  const n = waNumber(raw);
  const text = message === undefined || message === null || message === '' ? greeting(name) : String(message);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}
