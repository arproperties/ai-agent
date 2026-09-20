import { Router } from 'express';
import { listDrafts, getDraft, decideDraft, draftOut, logAction, actionLog, sendQuota } from './drafts.js';
import { kick } from './outbox.js';

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

  approve: decide('approve', true),
  reject: decide('reject', false),

  activity: async (req, res) => {
    res.json({ quota: await sendQuota(req.user.id), actions: await actionLog(req.user.id, 50) });
  },
};

export const emailRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

emailRoutes.get('/drafts', wrap(emailHandlers.listDrafts));
emailRoutes.get('/drafts/:id', wrap(emailHandlers.getDraft)); // after /drafts, so it cannot shadow it
emailRoutes.post('/drafts/:id/approve', wrap(emailHandlers.approve));
emailRoutes.post('/drafts/:id/reject', wrap(emailHandlers.reject));
emailRoutes.get('/activity', wrap(emailHandlers.activity));
