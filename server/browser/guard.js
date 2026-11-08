// Which clicks need the person's OK before Reem makes them. Anything that files, pays,
// sends, deletes or signs: a website can't take those back, so a person taps OK first.
// This can't be switched off. When in doubt it asks: an extra tap costs nothing, a wrong
// Submit on a government portal can't be undone.

// Safe even though they submit a form: they only look something up or sign in.
const SAFE = /^(search|find|go|calculate|show( results)?|view|next( page)?|previous|back|more|load more|filter|apply filters?|sort|log ?in|sign ?in|continue with email|open|close|بحث|عرض|التالي|السابق|دخول|تسجيل الدخول)$/i;

const RISKY = [
  /\b(submit|send|pay|purchase|buy|order|checkout|check out|confirm|delete|remove|sign|apply|register|agree|accept|file|book|transfer|approve|reject|publish|post|upload and submit|finish|complete|place)\b/i,
  /(إرسال|ارسال|تأكيد|تاكيد|دفع|سداد|حذف|تقديم|توقيع|موافق|أوافق|اوافق|قبول|تسجيل|حجز|تحويل|شراء|اعتماد)/,
];

const PAYMENT_URL = /(\/|\.|-)(pay|payment|payments|checkout|billing)(\/|\.|-|\?|$)|ngenius|telr|ziina|stripe|paypal|checkout\.com|payfort|amazonpay/i;

/**
 * { label, role, pageHasCardFields, url, isFormSubmit } → { ok: true } or { ok: false, why }.
 * label: the button's words; isFormSubmit: it sends a form (a submit button or input).
 */
export function needsOk({ label = '', role = 'button', pageHasCardFields = false, url = '', isFormSubmit = false } = {}) {
  const words = String(label).replace(/\s+/g, ' ').trim();
  if (pageHasCardFields) return { ok: false, why: 'This page asks for card details.' };
  if (PAYMENT_URL.test(url)) return { ok: false, why: 'This is a payment page.' };
  if (SAFE.test(words)) return { ok: true };
  if (RISKY.some((r) => r.test(words))) return { ok: false, why: `"${words}" can't be taken back.` };
  if (isFormSubmit && !words) return { ok: false, why: 'This button sends a form and has no name.' };
  if (role === 'link' || role === 'tab' || role === 'option' || role === 'checkbox' || role === 'menuitem') return { ok: true };
  return { ok: true };
}
