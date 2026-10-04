import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { askSaifsys } from './saifsys/client.js';

// Links a Riley account to its employee in saifsys HR, by employee code.
//
// The code is checked against HR before it is saved, and the master sees the name,
// company and job title HR has for it first - a typo shows the wrong person, it does
// not quietly link them. Nothing is written to saifsys.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const tidy = (code) => String(code ?? '').trim().toUpperCase().slice(0, 40);

/** The employee HR has under exactly this code, or an error saying why not. */
export async function lookupCode(code, ask = askSaifsys) {
  const want = tidy(code);
  if (!want) throw bad('Type an employee code, e.g. E00012.');
  const answer = await ask('hr', 'employee', { q: want });
  const e = answer.employee;
  // saifsys also matches a bare number as its own id, and a name as a search; only an
  // exact code counts here.
  if (!e || tidy(e.code) !== want) throw bad(`HR has no employee with code ${want}.`, 404);
  return { code: e.code, name: e.name, position: e.position, company: e.company, status: e.status, left: !!e.left };
}

export const linkFor = (userId) =>
  db.prepare('SELECT employee_code AS code, hr_name AS name, linked_at FROM hr_links WHERE user_id = ?').get(Number(userId));

export async function linkUser(master, userId, code, ask = askSaifsys) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw bad('User not found', 404);
  const e = await lookupCode(code, ask);
  const taken = await db.prepare(`SELECT u.name FROM hr_links l JOIN users u ON u.id = l.user_id
      WHERE l.employee_code = ? AND l.user_id <> ?`).get(e.code, target.id);
  if (taken) throw bad(`${e.code} is already linked to ${taken.name}. Unlink it there first.`, 409);
  await db.prepare(`INSERT INTO hr_links (user_id, employee_code, hr_name, linked_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, hr_name = EXCLUDED.hr_name,
        linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at`).run(target.id, e.code, e.name, master.id);
  return { ...(await linkFor(target.id)), employee: e };
}

export const unlinkUser = async (userId) =>
  (await db.prepare('DELETE FROM hr_links WHERE user_id = ?').run(Number(userId))).changes > 0;

// ---------- routes (master only) ----------

export const hrLinkRoutes = Router();
hrLinkRoutes.use(requireMaster);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

hrLinkRoutes.get('/lookup', wrap(async (req, res) => res.json(await lookupCode(req.query.code))));
hrLinkRoutes.get('/user/:id', wrap(async (req, res) => res.json((await linkFor(req.params.id)) || null)));
hrLinkRoutes.put('/user/:id', wrap(async (req, res) => res.json(await linkUser(req.user, req.params.id, req.body?.code))));
hrLinkRoutes.delete('/user/:id', wrap(async (req, res) => res.json({ ok: await unlinkUser(req.params.id) })));
