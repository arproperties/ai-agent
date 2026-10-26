// Matching a case number in mail, and naming case folders. Pure: no DB, no imports.

export const DEFAULT_PATTERN = 'Case - [Case Number] - [Party A] vs [Party B]';

// Letter runs and digit runs of a case number, e.g. 'Soutex E - 205791' -> Soutex, E, 205791.
const runs = (caseNumber) => String(caseNumber || '').match(/\p{L}+|\p{N}+/gu) || [];

// Lowercase letters and digits only: how a case is stored and compared.
export function caseKey(caseNumber) {
  return runs(caseNumber).join('').toLowerCase();
}

// The same number written with other spaces, dashes or dots still matches, but a
// longer or shorter number does not (no letter/digit before, no digit after).
export function caseRegex(caseNumber) {
  const parts = runs(caseNumber);
  if (!parts.length) return /(?!)/u; // nothing to look for: never matches
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${parts.join(String.raw`[\s\-–_/.]*`)}(?!\p{N})`, 'iu');
}

// The longest digit run: what we hand to the mailbox's own search.
export function searchTerm(caseNumber) {
  const digits = String(caseNumber || '').match(/\p{N}+/gu) || [];
  return digits.reduce((best, d) => (d.length > best.length ? d : best), '');
}

// The new text of a mail, without the quoted history below it, so a case that
// is only mentioned in an old thread does not count.
export function unquoted(text) {
  let body = String(text || '');
  const cuts = [
    /^On\s[^\n]*(?:\n[^\n]*)?wrote:/m,
    /^-----Original Message-----/m,
    /^_{20,}\s*$/m,
    /^From:[^\n]*\r?\n\s*Sent:/im,
  ];
  for (const re of cuts) {
    const m = re.exec(body);
    if (m) body = body.slice(0, m.index);
  }
  return body.split('\n').filter((l) => !l.startsWith('>')).join('\n').trimEnd();
}

export function mentionsCase(mail, caseNumber) {
  const re = caseRegex(caseNumber);
  return re.test(mail?.subject || '') || re.test(unquoted(mail?.text));
}

// Fills [Case Number] / [Party A] / [Party B]; the result is safe as a folder name.
export function folderName(pattern, { case_number, party_a, party_b } = {}) {
  const name = (String(pattern || '').trim() || DEFAULT_PATTERN)
    .replaceAll('[Case Number]', case_number || '')
    .replaceAll('[Party A]', String(party_a || '').trim() || 'Party A unknown')
    .replaceAll('[Party B]', String(party_b || '').trim() || 'Party B unknown');
  return name.replace(/[\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
}
