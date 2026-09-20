import { Router } from 'express';
import { listDrafts, getDraft, decideDraft, draftOut, logAction, actionLog, sendQuota } from './drafts.js';
import { kick } from './outbox.js';

// Approving and rejecting. This is the only thing in the app that moves a draft out of
// 'pending', and it is reachable only by the signed-in owner of the mailbox — which is
// what "agents never send directly" means in code.

export const emailRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Drafts are the user's own, always: every query here is scoped by req.user.id, and there
// is deliberately no master view. Reading someone's outgoing mail is not oversight.
emailRoutes.get('/drafts', wrap(async (req, res) => {
  const rows = await listDrafts(req.user.id, {
    conversationId: Number(req.query.conversation) || null,
    status: ['pending', 'approved', 'sent', 'rejected', 'failed'].includes(req.query.status) ? req.query.status : null,
  });
  res.json({ drafts: rows.map(draftOut) });
}));

for (const [verb, approved] of [['approve', true], ['reject', false]]) {
  emailRoutes.post(`/drafts/:id/${verb}`, wrap(async (req, res) => {
    const d = await decideDraft(req.user.id, req.params.id, approved);
    await logAction(req.user.id, {
      agentId: d.agent_id, action: verb, draftId: d.id, recipients: d.to_addrs, target: d.reply_to_id,
    });
    // Approving sends now rather than up to a minute from now. Its failure is the draft's,
    // recorded on the row the screen is about to reload — never this response's.
    if (approved) kick();
    res.json({ draft: draftOut(await getDraft(req.user.id, d.id)) });
  }));
}

emailRoutes.get('/activity', wrap(async (req, res) => {
  res.json({ quota: await sendQuota(req.user.id), actions: await actionLog(req.user.id, 50) });
}));
