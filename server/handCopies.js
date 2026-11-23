import { spellingMatch } from './shelf.js';

// saifsys first: staff keep the company documents current in saifsys, and Reem copies them
// every 15 minutes (saifsysCompanyDocs.js). Before that, people uploaded the same licences and
// Ejaris to the Shelf by hand: about forty files on live, with no category, no type and no
// expiry, named the way the AI read them ("Madar Al Wadi – Trade License 2025"). A search
// for a company's licence matched those as well as the saifsys copy, and whichever matched
// the words better came first, so Reem could answer from a licence two years old.
//
// Nothing here changes a file. In what a search hands back, the saifsys copy takes the place
// of a hand copy of the same document, and the hand copy goes to the end, marked as one.
// A hand copy is matched only when it is plainly the same paper: the same kind of document
// in its title, and every other word of its title in the company's name. Anything unsure is
// left where it was, which is how search worked before.

const plain = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s) => plain(s).split(' ').filter(Boolean);

// What kind of company document a title names. Each entry: every group must have a word in
// the title (a word ending in * matches its start: licen* is licence and license).
const KINDS = {
  trade_license: [['trade', 'commercial'], ['licen*']],
  moa: [['moa', 'memorandum']],
  ejari: [['ejari']],
  establishment_card: [['establishment'], ['card']],
  power_of_attorney: [['poa', 'attorney']],
  vat_certificate: [['vat'], ['certificate', 'registration']],
  corporate_tax_certificate: [['corporate'], ['tax']],
};
// A vehicle licence or a VAT return is not a company document of these kinds.
const NOT_KIND = new Set(['vehicle', 'traffic', 'plate', 'return', 'invoice', 'fee', 'payment', 'request', 'credentials']);
// Words that say what the paper is or when, not whose it is.
const KIND_WORDS = new Set(('trade commercial license licence licensed moa memorandum association ejari tenancy contract unified ' +
  'establishment card power attorney poa vat certificate certificates registration corporate tax copy renewal renewed new updated ' +
  'scan scanned original issue issued document dubai uae').split(' '));
// The legal ending of a company name, the same company with or without it.
const ENDINGS = new Set('llc l.l.c fze fzco fzc est co company the and of'.split(' '));
// Words many of the group's companies carry: they do not tell two companies apart.
const COMMON = new Set('building contracting construction trading general services service properties property group holding'.split(' '));

const has = (list, w) => (w.endsWith('*') ? list.some((x) => x.startsWith(w.slice(0, -1))) : list.includes(w));

/** The kind of company document a hand-uploaded file's title names, or null. */
export function kindOf(title) {
  const list = words(title);
  if (list.some((w) => NOT_KIND.has(w))) return null;
  for (const [kind, groups] of Object.entries(KINDS)) {
    if (groups.every((g) => g.some((w) => has(list, w)))) return kind;
  }
  return null;
}

// A company's own words, and each pair run together: "Madar Alwadi" also reads "Al Wadi".
const nameWords = (s) => {
  const list = words(s).filter((w) => !ENDINGS.has(w));
  return [...new Set([...list, ...list.slice(0, -1).map((w, i) => w + list[i + 1])])];
};
const near = (w, list) => list.some((m) => m === w || (w.length >= 4 && m.length >= 4 && (m.startsWith(w) || spellingMatch(w, m) >= 0.62)));

/**
 * True when a hand copy's title names this company and nothing else: every word of the title
 * that is not about the kind of paper is in the company's name, and the name's own telling
 * words are in the title. "Prime Elite Construction" is not "Prime Elite Transportation".
 */
export function sameCompany(title, company) {
  const name = nameWords(company);
  const rest = words(title).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !KIND_WORDS.has(w) && !ENDINGS.has(w));
  if (!rest.length || !rest.every((w) => near(w, name))) return false;
  const titleWords = nameWords(title);
  const telling = words(company).filter((w) => w.length >= 3 && !ENDINGS.has(w) && !COMMON.has(w));
  return telling.length > 0 && telling.every((w) => near(w, titleWords));
}

const later = (a, b) => (a.expires_on || '9999-12-31') > (b.expires_on || '9999-12-31');

/**
 * `found` (best first) with each hand copy of a saifsys company document replaced by the
 * saifsys copy, the hand copy moved to the end. `docs` is everything the person may see, so
 * the saifsys copy comes in even when only the hand copy matched the words. Marks the hand
 * copies (handCopyOf) and the saifsys copies that have run out (expired). When the saifsys
 * copy has run out and the hand copy runs out later, the hand copy is the newer issue: it
 * keeps its place, with the saifsys one right after it.
 */
export function saifsysFirst(found, docs, today) {
  const current = docs.filter((d) => d.saifsys_type && d.saifsys_type !== 'other' && !d.superseded_by && d.subject);
  if (!current.length) return found;
  const out = [];
  const tail = [];
  const placed = new Set();
  const put = (d) => { if (!placed.has(d.id)) { placed.add(d.id); out.push(d); } };
  for (const d of found) {
    if (d.saifsys_type && !d.superseded_by && d.expires_on && d.expires_on < today) d.expired = true;
    const kind = !d.from_saifsys && !d.superseded_by ? kindOf(d.title || d.name) : null;
    const twins = kind ? current.filter((s) => s.saifsys_type === kind && sameCompany(d.title || d.name, s.subject)) : [];
    if (!twins.length) { put(d); continue; }
    const twin = twins.reduce((w, s) => (later(s, w) ? s : w));
    if (twin.expires_on && twin.expires_on < today) twin.expired = true;
    d.handCopyOf = twin.id;
    if (twin.expired && d.expires_on && d.expires_on > twin.expires_on) {
      d.newerThan = twin.id;
      put(d);
      put(twin);
    } else {
      put(twin);
      tail.push(d);
    }
  }
  for (const d of tail) put(d);
  return out;
}
