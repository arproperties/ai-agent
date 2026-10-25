import { Router } from 'express';
import { isExternal } from './access.js';
import { cardsFor, decide } from './caseFolders.js';

// /api/cases: the case folder cards from the chat, and (Task 8) the folders themselves.
// Only for someone from outside the company; anyone else is told it does not exist.

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

/** deps: { mailbox, ask } - only tests pass them; the app uses the real ones. */
export function caseRouter(deps = {}) {
  const r = Router();
  r.use((req, res, next) => (isExternal(req.user) ? next() : res.status(404).json({ error: 'Not found' })));

  // The cards got ready in one chat, whatever became of them.
  r.get('/proposals', wrap(async (req, res) => res.json(await cardsFor(req.user, Number(req.query.conversation) || 0))));
  r.post('/proposals/:id/save', wrap(async (req, res) => {
    const { name, full_pdf: fullPdf, per_email: perEmail, exclude } = req.body || {};
    send(res, await decide(req.user, req.params.id, { save: true, name, full_pdf: fullPdf, per_email: perEmail, exclude }, deps));
  }));
  r.post('/proposals/:id/cancel', wrap(async (req, res) => send(res, await decide(req.user, req.params.id, { save: false }, deps))));
  return r;
}

export const caseRoutes = caseRouter();
