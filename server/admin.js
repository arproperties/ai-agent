import { Router } from 'express';
import { db, tx } from './db.js';
import { hashPassword, requireMaster } from './auth.js';

// Master's oversight lives here, in its own router behind requireMaster, rather than
// as an "OR is_master" widening of the ordinary queries. Every cross-user guard in the
// app is `WHERE user_id = ?`; adding a bypass inside those expressions would put it on
// the same line as the protection.

const MODES = ['chat', 'knowledge'];
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function createUser(master, { name, email, password }) {
  const clean = {
    name: String(name || '').trim().slice(0, 60),
    email: String(email || '').trim().toLowerCase().slice(0, 200),
  };
  if (!clean.name) throw fail(400, 'Please enter a name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw fail(400, 'Please enter a valid email');
  if (String(password || '').length < 8) throw fail(400, 'Password must be at least 8 characters');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean.email)) {
    throw fail(409, 'An account with this email already exists');
  }

  const hash = await hashPassword(password);
  const { id } = await db.prepare(
    'INSERT INTO users (email, name, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id'
  ).run(clean.email, clean.name, hash, 'user', master.id);
  return { id, name: clean.name, email: clean.email, role: 'user' };
}

/** Replaces the user's entire assignment set, so the caller sends the desired end state. */
export async function setAssignments(master, userId, wanted) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw fail(404, 'User not found');

  const rows = (Array.isArray(wanted) ? wanted : []).map((a) => ({
    agentId: Number(a.agentId),
    mode: a.mode ?? 'chat',
    primary: !!a.primary,
  }));
  for (const r of rows) {
    if (!MODES.includes(r.mode)) throw fail(400, `Unknown mode: ${r.mode}`);
    const owned = await db.prepare('SELECT 1 FROM agents WHERE id = ? AND user_id = ?').get(r.agentId, master.id);
    if (!owned) throw fail(404, `Agent not found: ${r.agentId}`);
  }

  await tx(async () => {
    await db.prepare('DELETE FROM agent_assignments WHERE user_id = ?').run(target.id);
    const ins = db.prepare('INSERT INTO agent_assignments (agent_id, user_id, mode, is_primary) VALUES (?, ?, ?, ?)');
    for (const r of rows) await ins.run(r.agentId, target.id, r.mode, r.primary);
  });
  return rows.length;
}

export function listUsers() {
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.disabled, u.created_at,
      (SELECT COUNT(*)::int FROM agent_assignments aa WHERE aa.user_id = u.id) agents
    FROM users u ORDER BY u.id`).all();
}

export const adminRoutes = Router();
adminRoutes.use(requireMaster);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

adminRoutes.get('/users', wrap(async (req, res) => res.json(await listUsers())));

adminRoutes.post('/users', wrap(async (req, res) => {
  res.json(await createUser(req.user, req.body));
}));

adminRoutes.put('/users/:id/agents', wrap(async (req, res) => {
  const n = await setAssignments(req.user, req.params.id, req.body.agents);
  res.json({ ok: true, assigned: n });
}));

// Disabling keeps the data and revokes every session. Deleting a user cascades away
// their documents, chunks and conversations irreversibly, so it is not offered here.
adminRoutes.put('/users/:id/disabled', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  const disabled = !!req.body.disabled;
  await db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled, id);
  if (disabled) await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true, disabled });
}));

adminRoutes.get('/users/:id/documents', wrap(async (req, res) => {
  res.json(await db.prepare(`SELECT id, name, title, folder, doc_date, shared, agent_id, created_at
    FROM documents WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(Number(req.params.id)));
}));

adminRoutes.get('/users/:id/conversations', wrap(async (req, res) => {
  res.json(await db.prepare('SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200')
    .all(Number(req.params.id)));
}));
