import { Router } from 'express';
import { db } from '../db.js';
import { isMaster } from '../access.js';
import { needsModule } from '../modules.js';
import { getSettings, setSettings, STEP_CHOICES } from './settings.js';
import { getTask, taskOut, lastFrame, frame, ownerOf, answer, personInput, stopTask } from './engine.js';
import { listLogins, saveLogin, removeLogin } from './logins.js';

// /api/browser: the live window in the chat (frames, Take over, OK/No, Done, Stop), the
// person's saved logins, and the master's switches. Everything here is the person's own:
// a job, a frame or a login of someone else's is "Not found".

export const browserRoutes = Router();
browserRoutes.use(needsModule('browser'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const mine = async (req) => {
  const t = await getTask(req.params.id);
  if (!t || t.user_id !== req.user.id) throw Object.assign(new Error('Not found'), { status: 404 });
  return t;
};

browserRoutes.get('/settings', wrap(async (req, res) => res.json({ ...(await getSettings()), steps: STEP_CHOICES, master: isMaster(req.user) })));
browserRoutes.put('/settings', wrap(async (req, res) => {
  if (!isMaster(req.user)) return res.status(403).json({ error: 'Only the master can change this' });
  res.json({ ...(await setSettings(req.body)), steps: STEP_CHOICES, master: true });
}));

browserRoutes.get('/logins', wrap(async (req, res) => res.json(await listLogins(req.user))));
browserRoutes.post('/logins', wrap(async (req, res) => res.json(await saveLogin(req.user, req.body))));
browserRoutes.delete('/logins/:id', wrap(async (req, res) => res.json(await removeLogin(req.user, req.params.id))));

// The jobs of a chat, for its cards when it is opened again.
browserRoutes.get('/tasks', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM browser_tasks WHERE user_id = ? AND conversation_id = ? ORDER BY id').all(req.user.id, Number(req.query.conversation) || 0);
  res.json((await Promise.all(rows.map((r) => getTask(r.id)))).map(taskOut));
}));
browserRoutes.get('/tasks/:id', wrap(async (req, res) => res.json(taskOut(await mine(req)))));
browserRoutes.get('/tasks/:id/frame.jpg', wrap(async (req, res) => {
  await mine(req);
  const jpeg = lastFrame(req.params.id) || (ownerOf(req.params.id) ? await frame(req.params.id) : null);
  if (!jpeg) return res.status(404).end();
  res.set('Cache-Control', 'no-store').type('image/jpeg').send(jpeg);
}));
browserRoutes.post('/tasks/:id/input', wrap(async (req, res) => { await personInput(req.params.id, req.user, req.body); res.status(204).end(); }));
browserRoutes.post('/tasks/:id/answer', wrap(async (req, res) => {
  await answer(req.params.id, req.user, req.body.done ? { done: true } : { ok: !!req.body.ok });
  res.status(204).end();
}));
browserRoutes.post('/tasks/:id/stop', wrap(async (req, res) => res.json(taskOut(await stopTask(req.params.id, req.user)))));
