// The full case PDF: an AI summary first, then every email of the case oldest first, so the
// boss reads one file instead of a mailbox. If the AI is down the PDF is still made, with a
// plain list of dates and subjects in place of the summary.
import { renderPdf, pdfName } from './replyDoc.js';
import { ask as claude } from './ai.js';

const BODY_CUT = 4000; // enough for any real email; keeps a long thread inside one request

const when = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const day = (secs) => new Date(secs * 1000).toLocaleDateString('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric',
});

// One line of plain text: a subject or an address must never run into the next line.
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// An email body is someone else's text. A line that starts "# ", "| a | b |", "```", "- " or ">"
// would become a heading, table, code block or list in the PDF and could fake the next email's
// heading. A zero-width space at the front of every line means none of those markers is at the
// start any more; the PDF drops the invisible character when it draws. Two trailing spaces keep
// the email's own line breaks.
const ZWSP = '\u200B';
const safeBody = (body) => String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
  .map((l) => (l.trim() ? `${ZWSP}${l.replace(/\s+$/, '')}  ` : '')).join('\n').trim();

const oldestFirst = (emails) => [...emails].sort((a, b) => a.at - b.at);

/** One email alone, as markdown: the per-email PDF. */
export function emailMarkdown(email, level = 1) {
  return [
    `${'#'.repeat(level)} ${when(email.at)} · ${oneLine(email.subject) || '(no subject)'}`,
    '',
    `**From:** ${oneLine(email.sender)}  `,
    `**To:** ${oneLine(email.recipients)}`,
    '',
    safeBody(email.body),
  ].join('\n').trim();
}

const SYSTEM = [
  'You summarise a legal case from its emails for the person who owns the case.',
  'Write from the emails only. Never invent dates, parties or facts; if something is not in the emails, leave it out.',
  'Keep the parties\' names exactly as written. Write the headings in English, whatever language the emails are in.',
  'Use exactly these four markdown sections, in this order, and nothing else:',
  '## Parties',
  '## What has happened  (dated bullets, oldest first)',
  '## Latest position',
  '## Pending / awaiting reply',
].join('\n');

/** The case summary as markdown with the four sections; a plain email list if the AI fails. */
export async function summarizeCase(folder, emails, { ask = claude } = {}) {
  const sorted = oldestFirst(emails);
  const prompt = [
    `Case: ${oneLine(folder.name)}${folder.case_number ? `, number ${folder.case_number}` : ''}`,
    `Parties: ${oneLine(folder.party_a)} / ${oneLine(folder.party_b)}`,
    '',
    ...sorted.map((e, i) => `--- Email ${i + 1}, ${when(e.at)} ---\nFrom: ${oneLine(e.sender)}\nTo: ${oneLine(e.recipients)}\nSubject: ${oneLine(e.subject)}\n\n${String(e.body ?? '').slice(0, BODY_CUT)}`),
  ].join('\n');
  try {
    const text = String(await ask(prompt, { system: SYSTEM, maxTokens: 2000 }) ?? '').trim();
    if (text) return text;
  } catch { /* fall through to the plain list */ }
  return ['## Emails', '', ...sorted.map((e) => `- ${day(e.at)} · ${oneLine(e.subject) || '(no subject)'}`)].join('\n');
}

/** The whole case as markdown: title, one-line facts, summary, then every email oldest first. */
export function caseMarkdown(folder, emails, summary) {
  const sorted = oldestFirst(emails);
  const updated = sorted.length ? day(sorted.at(-1).at) : day(Date.now() / 1000);
  const facts = `Case ${oneLine(folder.case_number)} · ${oneLine(folder.party_a)} vs ${oneLine(folder.party_b)} · ${sorted.length} emails · updated ${updated}`;
  return [
    `# ${oneLine(folder.name)}`, '',
    facts, '',
    String(summary ?? '').trim(), '',
    '## All emails', '',
    ...sorted.flatMap((e) => [emailMarkdown(e, 3), '']),
  ].join('\n').trim();
}

/** Summary, markdown and the PDF bytes for a case. */
export async function buildCasePdf(folder, emails, { ask = claude } = {}) {
  const summary = await summarizeCase(folder, emails, { ask });
  const markdown = caseMarkdown(folder, emails, summary);
  const bytes = await renderPdf({ title: folder.name, markdown });
  return { bytes: Buffer.from(bytes), name: pdfName(folder.name), markdown };
}
