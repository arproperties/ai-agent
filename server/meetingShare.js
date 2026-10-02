// A meeting, passed on: as a PDF to download, kept on the Shelf, or emailed with the PDF
// attached. Sending it into a team chat needs nothing here - the page posts this same PDF
// as an ordinary file message.
//
// The PDF is laid out by replyDoc.js from markdown built here, so a meeting looks like
// every other document Reem makes. The transcript goes in only when asked for: a two-hour
// meeting is dozens of pages, and the summary is what most people want.
import { Router } from 'express';
import { getMeeting, clock, turns, UNKNOWN } from './meetings.js';
import { renderPdf, unsupportedScript, pdfName } from './replyDoc.js';
import { saveUpload, processDocument } from './files.js';
import { chatAgents } from './access.js';
import { imapAccount } from './imap.js';
import { createDraft, decideDraft, getDraft, draftOut, logAction } from './drafts.js';
import { kick } from './outbox.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const titleOf = (m) => m.title || 'Meeting notes';
const length = (secs) => {
  const min = Math.round((secs || 0) / 60);
  if (!min) return 'under a minute';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const when = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/** The meeting as markdown: who and when, summary, decisions, action items, and the transcript if asked. */
export function meetingMarkdown(m, { transcript = false } = {}) {
  const s = m.summary;
  const out = [`# ${titleOf(m)}`, ''];
  out.push(`${when(m.created_at)} · ${length(m.duration_s)}${m.speaker_names.length ? ` · ${m.speaker_names.join(', ')}` : ''}`, '');
  if (s) {
    out.push('## Summary', '', s.summary, '');
    if (s.decisions.length) out.push('## Decisions', '', ...s.decisions.map((d) => `- ${d}`), '');
    if (s.actions.length) out.push('## Action items', '', ...s.actions.map((a) => `- **${a.who || UNKNOWN}:** ${a.what}${a.when ? ` (${a.when})` : ''}`), '');
  }
  if (transcript && m.lines.length) {
    out.push('## Transcript', '');
    for (const t of turns(m.lines)) out.push(`**${t.who}** · ${clock(t.at)}  `, t.text, '');
  }
  return out.join('\n').trim();
}

/** The same meeting as plain text, for the body of an email or a chat message. */
export function meetingText(m) {
  const s = m.summary;
  const out = [titleOf(m), `${when(m.created_at)} · ${length(m.duration_s)}${m.speaker_names.length ? ` · ${m.speaker_names.join(', ')}` : ''}`, ''];
  if (s) {
    out.push(s.summary, '');
    if (s.decisions.length) out.push('Decisions:', ...s.decisions.map((d) => `- ${d}`), '');
    if (s.actions.length) out.push('Action items:', ...s.actions.map((a) => `- ${a.who || UNKNOWN}: ${a.what}${a.when ? ` (${a.when})` : ''}`), '');
  }
  return out.join('\n').trim();
}

async function ready(userId, id) {
  const m = await getMeeting(userId, id);
  if (!m) throw bad('Meeting not found', 404);
  if (m.status !== 'ready' || (!m.summary && !m.lines.length)) throw bad('This meeting is not written up yet');
  return m;
}

async function buildPdf(m, transcript) {
  const markdown = meetingMarkdown(m, { transcript });
  if (unsupportedScript(markdown)) throw bad('PDFs can only be made from English text for now');
  const bytes = Buffer.from(await renderPdf({ title: titleOf(m), markdown, date: new Date(m.created_at * 1000) }));
  return { markdown, bytes, name: pdfName(`${titleOf(m)}${transcript ? ' (with transcript)' : ''}`) };
}

const wantsTranscript = (v) => v === true || v === '1' || v === 'true';

export const meetingShareRoutes = Router();

// Download: the PDF itself, stored nowhere.
meetingShareRoutes.get('/:id/pdf', wrap(async (req, res) => {
  const m = await ready(req.user.id, req.params.id);
  const { bytes, name } = await buildPdf(m, wantsTranscript(req.query.transcript));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.type('application/pdf').send(bytes);
}));

// Keep it on the Shelf, filed like any upload. The same meeting makes the same bytes, so a
// second tap finds the first copy instead of adding another.
meetingShareRoutes.post('/:id/pdf/shelf', wrap(async (req, res) => {
  const m = await ready(req.user.id, req.params.id);
  const { bytes, name, markdown } = await buildPdf(m, wantsTranscript(req.body?.transcript));
  // saveUpload reads names the way multer hands them over: as latin1.
  const f = { buffer: bytes, originalname: Buffer.from(name, 'utf8').toString('latin1'), mimetype: 'application/pdf', size: bytes.length };
  const { doc, duplicate } = await saveUpload(req.user.id, null, f);
  if (!duplicate) await processDocument(doc, f, markdown, await chatAgents(req.user));
  res.json({ id: doc.id, name: doc.name, duplicate });
}));

// Email it. The person wrote the address and read the email before tapping Send, so the
// draft is approved as it is made - that tap is the approval - and the outbox sends it
// from their own mailbox, the same way an approved chat draft goes.
meetingShareRoutes.post('/:id/email', wrap(async (req, res) => {
  const m = await ready(req.user.id, req.params.id);
  const acc = await imapAccount(req.user.id);
  if (!acc?.can_write || !acc.smtp_host) throw bad('Connect your mailbox and turn sending on under Email first');
  const { to, cc, subject, body, transcript } = req.body || {};
  const pdf = await buildPdf(m, wantsTranscript(transcript)).catch(() => null);
  const draft = await createDraft(req.user.id, {
    to, cc, from: acc.email,
    subject: String(subject || '').trim() || titleOf(m),
    body: String(body || '').trim() || meetingText(m),
    attachments: pdf ? [{ filename: pdf.name, contentType: 'application/pdf', content: pdf.bytes.toString('base64') }] : [],
  });
  await logAction(req.user.id, { action: 'draft', draftId: draft.id, recipients: draft.to_addrs });
  await decideDraft(req.user.id, draft.id, true);
  await logAction(req.user.id, { action: 'approve', draftId: draft.id, recipients: draft.to_addrs });
  kick();
  res.json({ draft: draftOut(await getDraft(req.user.id, draft.id)), attached: !!pdf });
}));

// The text that goes with the PDF when it is posted into a team chat.
meetingShareRoutes.get('/:id/text', wrap(async (req, res) => {
  res.json({ text: meetingText(await ready(req.user.id, req.params.id)) });
}));
