import { Router } from 'express';
import { listDrafts, getDraft, decideDraft, hideDraft, deleteDraft, draftOut, logAction, actionLog, sendQuota } from './drafts.js';
import { kick } from './outbox.js';
import mammoth from 'mammoth';
import { discard, fileOf } from './draftFiles.js';
import { inlineType } from './files.js';

// Approving and rejecting. This is the only thing in the app that moves a draft out of
// 'pending', and it is reachable only by the signed-in owner of the mailbox — which is
// what "agents never send directly" means in code.

const decide = (verb, approved) => async (req, res) => {
  const d = await decideDraft(req.user.id, req.params.id, approved);
  await logAction(req.user.id, {
    agentId: d.agent_id, action: verb, draftId: d.id, recipients: d.to_addrs, target: d.reply_to_id,
  });
  // Approving sends now rather than up to a minute from now. Its failure is the draft's,
  // recorded on the row the screen is about to reload — never this response's.
  if (approved) kick();
  else discard(d); // a rejected draft will never send: its copies of the files go with it
  res.json({ draft: draftOut(await getDraft(req.user.id, d.id)) });
};

// The handlers are named here as well as registered below so the tests can call the
// approval door directly, with a fake req/res, rather than only through a live server.
export const emailHandlers = {
  // Drafts are the user's own, always: every query here is scoped by req.user.id, and there
  // is deliberately no master view. Reading someone's outgoing mail is not oversight.
  listDrafts: async (req, res) => {
    const rows = await listDrafts(req.user.id, {
      conversationId: Number(req.query.conversation) || null,
      status: ['pending', 'approved', 'sending', 'sent', 'rejected', 'failed'].includes(req.query.status) ? req.query.status : null,
    });
    res.json({ drafts: rows.map(draftOut) });
  },

  // One draft, so the card that has just been approved can watch for what became of it.
  getDraft: async (req, res) => {
    const d = await getDraft(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    res.json({ draft: draftOut(d) });
  },

  // Looking at an attachment before approving: the same rules as opening a Shelf file.
  // Safe types show in the app, a Word file is turned into plain HTML, the rest download.
  file: async (req, res) => {
    const f = fileOf(await getDraft(req.user.id, req.params.id), req.params.n);
    if (!f) return res.status(404).json({ error: 'That file is no longer available' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.preview && /\.docx$/i.test(f.name)) {
      const { value } = await mammoth.convertToHtml({ buffer: f.buffer });
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;color:#1d1b2e;max-width:760px;margin:0 auto;padding:28px 22px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px}img{max-width:100%}</style>${value}`);
    }
    const inline = !req.query.download && inlineType(f);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.type(inline || 'application/octet-stream').send(f.buffer);
  },

  approve: decide('approve', true),
  reject: decide('reject', false),

  hide: async (req, res) => {
    res.json({ draft: draftOut(await hideDraft(req.user.id, req.params.id, req.body?.hidden !== false)) });
  },
  remove: async (req, res) => {
    const d = await getDraft(req.user.id, req.params.id);
    await deleteDraft(req.user.id, req.params.id);
    discard(d); // only reached when the delete was allowed
    res.json({ ok: true });
  },

  activity: async (req, res) => {
    res.json({ quota: await sendQuota(req.user.id), actions: await actionLog(req.user.id, 50) });
  },
};

export const emailRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

emailRoutes.get('/drafts', wrap(emailHandlers.listDrafts));
emailRoutes.get('/drafts/:id', wrap(emailHandlers.getDraft)); // after /drafts, so it cannot shadow it
emailRoutes.get('/drafts/:id/files/:n', wrap(emailHandlers.file));
emailRoutes.post('/drafts/:id/approve', wrap(emailHandlers.approve));
emailRoutes.post('/drafts/:id/reject', wrap(emailHandlers.reject));
emailRoutes.post('/drafts/:id/hide', wrap(emailHandlers.hide));
emailRoutes.delete('/drafts/:id', wrap(emailHandlers.remove));
emailRoutes.get('/activity', wrap(emailHandlers.activity));
