// Spotting which case a chat is about. Pure: no DB. caseFocus.js does the storing.
//
// The first case a chat names becomes its primary case, and every other case mentioned
// after that is a reference. A guess here is locked for the life of the chat, so this
// prefers saying nothing to saying the wrong case: two equally good cases in one message
// give no answer at all, and the next message is looked at instead.
import { DEFAULT_PATTERN, caseKey, caseRegex, searchTerm } from './caseMatch.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A case folder's own file name read backwards: "Case - E-205791 - JEFF AKHTAR ET AL vs
 * JEREMY MITCHELL ET AL.pdf" gives the number and both parties. The person's own naming
 * pattern is tried first, then Reem's default one.
 */
export function fromFileName(name, patterns = []) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  for (const pattern of [...new Set([...patterns.filter(Boolean), DEFAULT_PATTERN])]) {
    if (!pattern.includes('[Case Number]')) continue;
    const re = new RegExp(`^${escape(pattern.trim())
      // Up to the first run of digits that the rest fits after: "Soutex E - 205791 - Ahmed vs …"
      // is the number "Soutex E - 205791", not "Soutex E" with "205791 - Ahmed" as a party.
      .replace(escape('[Case Number]'), '(?<number>.*?\\p{N}+)')
      .replace(escape('[Party A]'), '(?<a>.+?)')
      .replace(escape('[Party B]'), '(?<b>.+?)')
      .replace(/\s+/g, '\\s*')}$`, 'iu');
    const m = re.exec(base);
    if (m && /\p{N}{3,}/u.test(m.groups.number)) {
      return { number: m.groups.number.trim(), partyA: m.groups.a?.trim() || null, partyB: m.groups.b?.trim() || null };
    }
  }
  return null;
}

// "case", "file no." and their Arabic forms, followed directly by a case-shaped number:
// a few letters and at least four digits, e.g. E-205791, 205791, 2024/1234. Directly,
// so that "case due 26/10/2026" or "the unit 2057 file" do not count.
const WORD = String.raw`(?:case|matter|claim|suit|lawsuit|petition|file|قضية|القضية|قضيه|دعوى|الدعوى|ملف)`;
const WORDS = String.raw`${WORD}(?:\s+${WORD})*`; // "case file 205791"
const LABEL = String.raw`(?:\s*(?:no\.?|number|num\.?|ref\.?|رقم))?\s*[:#]?\s*`;
// Spaces only around a dash or slash, so "case 205791 2024" stops at 205791.
const TOKEN = String.raw`((?:\p{L}{1,3}\s?[-–]?\s?)?\p{N}+(?:\s?[/\-–]\s?\p{N}+)*)`;
const NEAR_WORD = new RegExp(String.raw`(?<![\p{L}])(?<!\bin\s)${WORDS}${LABEL}${TOKEN}`, 'giu');

function plausible(token) {
  const t = token.trim().replace(/^\p{L}+\s?[-–]?\s?/u, ''); // the number without its letters
  const digits = t.replace(/\D/g, '');
  if (digits.length < 4) return false;
  if (/^\+?\d[\d\s-]{8,}$/.test(t) && (digits.length >= 10 || digits.startsWith('05') || digits.startsWith('971'))) return false; // a phone
  if (/^(19|20)\d\d$/.test(t)) return false; // a year on its own
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return false; // a date
  return true;
}

/** Case-shaped numbers written next to a case word, or a message that is nothing but one. */
export function numbersInText(text) {
  const s = String(text || '');
  const found = [];
  for (const m of s.matchAll(NEAR_WORD)) if (plausible(m[1])) found.push(m[1].trim());
  // "205791" or "E-205791" typed on its own is a case being looked up.
  const whole = s.trim();
  if (!found.length && /^(?:\p{L}{1,3}\s?[-–]?\s?)?\p{N}{5,}$/u.test(whole) && plausible(whole)) found.push(whole);
  return found;
}

// The longest digit run, when it is long enough to tell a case apart on its own:
// "205791" typed in a chat is the folder "Soutex E - 205791".
const digitsOf = (number) => {
  const d = searchTerm(number);
  return d.length >= 5 ? d : '';
};

/** Two ways of writing one case: the same letters and digits, or the same long number. */
export function sameCase(a, b) {
  if (!a || !b) return false;
  if (caseKey(a) && caseKey(a) === caseKey(b)) return true;
  const da = digitsOf(a);
  return Boolean(da) && da === digitsOf(b);
}

// Whether a known case is named in this text: written out in full, or by its long number.
export const names =(haystack, number) => {
  if (caseRegex(number).test(haystack)) return true;
  const d = digitsOf(number);
  return Boolean(d) && new RegExp(String.raw`(?<!\p{N})${d}(?!\p{N})`, 'u').test(haystack);
};

const distinct = (cases) => cases.filter((c, i) => cases.findIndex((o) => sameCase(o.number, c.number)) === i);
// A number found loosely is the known case it belongs to, when there is one: its parties come along.
const asKnown = (c, known) => {
  const k = known.find((x) => sameCase(x.number, c.number));
  return k ? { ...k, ...c, number: k.number, key: caseKey(k.number) } : c;
};

/**
 * Every case one message names, best evidence first. known: the person's own case folders
 * and legal cases ({ number, partyA, partyB, title, folderId, legalCaseId }).
 * Returns { level, cases }: level is which kind of evidence was found, cases the distinct
 * cases at that level.
 */
export function casesIn({ text = '', fileNames = [], known = [], patterns = [] } = {}) {
  const haystacks = [text, ...fileNames];
  const named = fileNames.map((n) => fromFileName(n, patterns)).filter(Boolean)
    .map((c) => asKnown({ ...c, key: caseKey(c.number), source: 'file_name' }, known));
  if (named.length) return { level: 'file_name', cases: distinct(named) };

  const hits = known.filter((k) => caseKey(k.number) && haystacks.some((h) => names(h, k.number)))
    .map((k) => ({ ...k, key: caseKey(k.number), source: 'known' }));
  if (hits.length) return { level: 'known', cases: distinct(hits) };

  const loose = haystacks.flatMap(numbersInText).map((n) => ({ number: n, key: caseKey(n), source: 'text' })).filter((c) => c.key);
  return { level: loose.length ? 'text' : null, cases: distinct(loose) };
}

/** The one case a message is about, or null when it names none or more than one. */
export function detectCase(input) {
  const { cases } = casesIn(input);
  return cases.length === 1 ? cases[0] : null;
}

/** Every case a later message names, of every kind of evidence: what becomes a reference. */
export function allCases({ text = '', fileNames = [], known = [], patterns = [] } = {}) {
  const haystacks = [text, ...fileNames];
  const named = fileNames.map((n) => fromFileName(n, patterns)).filter(Boolean).map((c) => c.number);
  const hits = known.filter((k) => haystacks.some((h) => names(h, k.number))).map((k) => k.number);
  const loose = haystacks.flatMap(numbersInText);
  return distinct([...named, ...hits, ...loose].map((n) => asKnown({ number: n, key: caseKey(n) }, known)).filter((c) => c.key))
    .map(({ number, key }) => ({ number, key }));
}

/**
 * A recalled excerpt marked with the case it belongs to. Every chunk starts with
 * "[file label]" (knowledge.js), so the label is what is matched: a case number quoted in
 * the body of another case's file does not make it that case's file.
 */
export function labelExcerpt(chunk, primary, references = []) {
  const head = /^\[([^\]]*)\]/.exec(String(chunk))?.[1] || '';
  if (!primary || !head) return chunk;
  if (names(head, primary.number)) return `[primary case ${primary.number}] ${chunk}`;
  const ref = references.find((r) => names(head, r.number));
  return ref ? `[reference: ${ref.number}] ${chunk}` : chunk;
}

const attr = (s) => String(s).replace(/"/g, "'");

/**
 * The block the agent is given while the chat has a primary case. brief: the case brief the
 * person approved (caseBrief.js), what earlier chats on the case settled.
 */
export function primaryCaseBlock(userName, primary, references = [], brief = '') {
  if (!primary) return '';
  const parties = primary.partyA || primary.partyB
    ? `${primary.partyA || 'Party A unknown'} vs ${primary.partyB || 'Party B unknown'}` : primary.title || '';
  const refs = references.filter((r) => !sameCase(r.number, primary.number)).map((r) => r.number);
  return `<primary_case number="${attr(primary.number)}"${parties ? ` parties="${attr(parties)}"` : ''}>\n` +
    `This conversation is about case ${primary.number}. "The case", "my case", "this file", deadlines, drafts and to-dos all mean this case ` +
    `unless ${userName} clearly names another.\n` +
    `Other cases mentioned here are references: use them only to compare, for precedent, or because ${userName} asked about them. ` +
    'Always name a reference case by its number when you use it. ' +
    `Never carry a reference case's parties, dates, amounts, deadlines or rulings over to ${primary.number}. ` +
    'Recalled excerpts are marked [primary case ...] or [reference: ...] where the file belongs to one of them. ' +
    'If you are not sure which case a fact belongs to, say so and ask.\n' +
    `The primary case is fixed for this chat. If ${userName} wants another case to be the main one, tell them to start a new chat for it.` +
    (refs.length ? `\nReference cases so far: ${refs.join(', ')}.` : '') +
    (brief ? `\n<case_brief>\nWhat earlier chats on ${primary.number} settled, approved by ${userName}. Treat it as known; ` +
      `if this chat contradicts it, point that out.\n${brief}\n</case_brief>` : '') +
    '\n</primary_case>';
}
