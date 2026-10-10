// Reading a document as it is filed: the name, number, dates and figures on a policy, a
// licence or a certificate, suggested to whoever is filing it. Nothing is saved here and
// nothing is guessed: what cannot be seen is left out, and any failure gives back nothing,
// so the form is simply filled in by hand.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
// Loaded when first needed, so the checks below work where no model is set up.
const claudeAsk = (...args) => import('./ai.js').then((m) => m.ask(...args));

const DETAILS = ['insurer', 'premium', 'sum_insured', 'deductible', 'cover'];
const IMAGE = /^image\/(jpeg|png|gif|webp)$/;
const WAIT = 45_000; // how long a reading is waited for before the form is left to be filled in by hand

const PROMPT = `This is a document a property company keeps on file (an insurance policy, a licence, a certificate, a contract). Read it and reply with one JSON object and nothing else, using only these keys and leaving out any you cannot see on the page:
"title": what the document is, in a few words (e.g. "Property insurance", "Trade License"), without the name of the company or the insurer
"number": its policy, licence or reference number
"issue_date": the date it starts or was issued, as YYYY-MM-DD
"expiry_date": the date it expires or the cover ends, as YYYY-MM-DD
"renew_by": "quotes" if it is bought from a choice of suppliers (insurance, a maintenance or service contract), otherwise "remind"
"insurer": the name of the insurer or supplier
"premium": the price for the period, with its currency
"sum_insured": the amount insured, with its currency
"deductible": the deductible or excess, with its currency
"cover": what is covered, in one short line
Never guess a date or a number.`;

const line = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 300) : '');

/** A real day written YYYY-MM-DD: 2026-02-31 is not one. */
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))).toISOString().slice(0, 10) === v;
}

/** The figures kept with a document: a few known names, each a short line of text. Given as an object or as its JSON. */
export function cleanDetails(v) {
  let o = v;
  if (typeof v === 'string') {
    try { o = JSON.parse(v || '{}'); } catch { throw bad('The details of the document could not be read.'); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  return Object.fromEntries(DETAILS.map((k) => [k, line(o[k])]).filter(([, x]) => x));
}

/** What is worth suggesting out of whatever came back: the known fields, and only dates that are dates. */
export function suggestion(reply) {
  let o;
  try { o = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const f of ['title', 'number']) if (line(o[f])) out[f] = line(o[f]);
  for (const f of ['issue_date', 'expiry_date']) if (isDate(o[f])) out[f] = o[f];
  if (o.renew_by === 'quotes' || o.renew_by === 'remind') out.renew_by = o.renew_by;
  const details = cleanDetails(o);
  if (Object.keys(details).length) out.details = details;
  return out;
}

/** The file as Claude takes it: a PDF as a document, a photo as a picture. Nothing for any other kind. */
function block(file) {
  const data = file.buffer.toString('base64');
  if (file.mimetype === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  if (IMAGE.test(file.mimetype)) return { type: 'image', source: { type: 'base64', media_type: file.mimetype, data } };
  return null;
}

/** What an uploaded file says about itself, to fill the form with. {} when it cannot be read, for any reason. */
export async function readDocument(file, { ask = claudeAsk, timeoutMs = WAIT } = {}) {
  const b = file && block(file);
  if (!b) return {};
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('the reading took too long')), timeoutMs); });
  try {
    return suggestion(await Promise.race([ask(null, { maxTokens: 600, content: [b, { type: 'text', text: PROMPT }] }), late]));
  } catch (e) {
    console.error('[document-reader]', e.message);
    return {};
  } finally {
    clearTimeout(timer);
  }
}
