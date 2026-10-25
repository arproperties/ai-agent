import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { db } from './db.js';
import { isExternal } from './access.js';
import { ask as claude } from './ai.js';
import { caseMailbox } from './caseMail.js';
import { buildCasePdf } from './casePdf.js';
import { pdfName } from './replyDoc.js';
import { cleanAddresses, createDraft, decideDraft, logAction, MAX_RECIPIENTS } from './drafts.js';
import { kick as outboxKick } from './outbox.js';
import { sendMail as appMail } from './mailer.js';
import { ownFolder } from './caseRoutes.js';

// Sharing a case folder, for the external person who owns it.
//  - By email: the full case PDF attached. From their own mailbox when it can send (the same
//    way a meeting is emailed: the Send tap is the approval), else from the app's address
//    with Reply-To set to theirs.
//  - By link: anyone with it can open the folder's files, while the link is on. Off keeps
//    the token, so on again gives the same link.

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const base = (req) => (process.env.APP_URL || req.get('origin') || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const linkOf = (req, token) => (token ? `${base(req)}/api/case-share/${token}` : null);

/** The summary's "Latest position" as plain text, for the email's default body. */
export function latestPosition(markdown) {
  const m = /^##\s+Latest position\s*#*\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(String(markdown || ''));
  return (m?.[1] || '').split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/, '- ').trimEnd())
    .join('\n').trim();
}

/** The folder's full case PDF: the stored one, or made now if the folder keeps none. */
async function casePdf(userId, f, ask) {
  const doc = f.summary_doc_id && await db.prepare('SELECT d.*, t.text FROM documents d LEFT JOIN document_texts t ON t.document_id = d.id WHERE d.id = ? AND d.user_id = ?').get(f.summary_doc_id, userId);
  if (doc?.path && existsSync(doc.path)) return { bytes: readFileSync(doc.path), name: doc.name || pdfName(f.name), markdown: doc.text || '' };
  const emails = await db.prepare('SELECT * FROM case_emails WHERE folder_id = ? ORDER BY at, id').all(f.id);
  return buildCasePdf(f, emails, { ask });
}

/** deps: { mailbox, ask, kick, sendMail } - only tests pass them; the app uses the real ones. */
export function caseShareRouter(deps = {}) {
  const r = Router();
  r.use((req, res, next) => (isExternal(req.user) ? next() : res.status(404).json({ error: 'Not found' })));

  r.post('/:id/email', wrap(async (req, res) => {
    const f = await ownFolder(req.user.id, req.params.id);
    const { to, cc, subject, body } = req.body || {};
    const toList = cleanAddresses(to, 'To');
    const ccList = cleanAddresses(cc, 'Cc');
    if (!toList.length) throw bad('Who should it go to?');
    if (toList.length + ccList.length > MAX_RECIPIENTS) throw bad(`Too many recipients (at most ${MAX_RECIPIENTS})`);
    const pdf = await casePdf(req.user.id, f, deps.ask || claude);
    const mail = {
      subject: String(subject || '').trim() || f.name,
      text: String(body || '').trim() || latestPosition(pdf.markdown) || 'The case file is attached.',
    };
    const box = await (deps.mailbox || caseMailbox)(req.user.id);
    if (box?.canSend) {
      const draft = await createDraft(req.user.id, {
        to: toList, cc: ccList, from: box.address, subject: mail.subject, body: mail.text,
        attachments: [{ filename: pdf.name, contentType: 'application/pdf', content: Buffer.from(pdf.bytes).toString('base64') }],
      });
      await logAction(req.user.id, { action: 'draft', draftId: draft.id, recipients: draft.to_addrs });
      await decideDraft(req.user.id, draft.id, true);
      await logAction(req.user.id, { action: 'approve', draftId: draft.id, recipients: draft.to_addrs });
      (deps.kick || outboxKick)();
      return res.json({ via: 'mailbox' });
    }
    // The app's own address; answers go to the person, at their mailbox if it has an address.
    const own = /@/.test(box?.address || '') ? box.address : req.user.email
      || (await db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id))?.email;
    await (deps.sendMail || appMail)({
      to: toList, cc: ccList, subject: mail.subject, text: mail.text, replyTo: own,
      attachments: [{ filename: pdf.name, contentType: 'application/pdf', content: Buffer.from(pdf.bytes) }],
    });
    res.json({ via: 'app' });
  }));

  r.post('/:id/link', wrap(async (req, res) => {
    const f = await ownFolder(req.user.id, req.params.id);
    const on = !!req.body?.on;
    const token = f.share_token || (on ? randomBytes(24).toString('base64url') : null);
    await db.prepare('UPDATE case_folders SET share_on = ?, share_token = ? WHERE id = ?').run(on, token, f.id);
    res.json({ url: linkOf(req, token), on });
  }));
  return r;
}

export const caseShareRoutes = caseShareRouter();

// ---------- the public link: no sign-in ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);
const dateOf = (d) => d.doc_date || new Date(Number(d.created_at) * 1000).toISOString().slice(0, 10);
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

// Nothing on the page runs, nothing is fetched from elsewhere, and search engines keep out.
function guard(res) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Cache-Control': 'no-store',
  });
}
const gone = (res) => res.status(404).type('text/plain').send('This link is not available.');

/** A folder shared by this token, while sharing is on and its owner is still external. */
async function sharedFolder(token) {
  if (!TOKEN.test(String(token))) return null;
  return db.prepare(`SELECT f.* FROM case_folders f JOIN users u ON u.id = f.user_id
    WHERE f.share_token = ? AND f.share_on AND u.external AND u.role IS DISTINCT FROM 'master'`).get(token);
}
const sharedFiles = (f) => db.prepare('SELECT * FROM documents WHERE case_folder_id = ? AND user_id = ? ORDER BY created_at, id').all(f.id, f.user_id);

export const publicCaseRoutes = Router();

publicCaseRoutes.get('/:token', wrap(async (req, res) => {
  guard(res);
  const f = await sharedFolder(req.params.token);
  if (!f) return gone(res);
  const files = await sharedFiles(f);
  const rows = files.map((d) => `<li><a href="${esc(`${req.params.token}/files/${d.id}`)}">${esc(d.name)}</a><span>${esc(dateOf(d))} · ${esc(size(d.size))}</span></li>`).join('');
  // The links are relative to the base, so the page works with or without a trailing slash.
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(f.name)}</title><base href="/api/case-share/">
<style>body{font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#1d1b2e;background:#fff}
h1{font-weight:500;font-size:20px}ul{list-style:none;padding:0}li{padding:12px 0;border-bottom:1px solid #eee;display:flex;flex-direction:column}
a{color:#6d28d9;word-break:break-word}span{color:#777;font-size:13px}</style></head>
<body><h1>${esc(f.name)}</h1><p><span>${files.length} ${files.length === 1 ? 'file' : 'files'}</span></p><ul>${rows || '<li><span>No files</span></li>'}</ul></body></html>`);
}));

publicCaseRoutes.get('/:token/files/:docId', wrap(async (req, res) => {
  guard(res);
  const f = await sharedFolder(req.params.token);
  const d = f && await db.prepare('SELECT * FROM documents WHERE id = ? AND case_folder_id = ? AND user_id = ?').get(Number(req.params.docId) || 0, f.id, f.user_id);
  if (!d?.path || !existsSync(d.path)) return gone(res);
  // Always a download, never shown inline on this address.
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.name || 'file')}`);
  res.type(d.mime || 'application/octet-stream');
  createReadStream(d.path).on('error', () => res.destroy()).pipe(res);
}));
