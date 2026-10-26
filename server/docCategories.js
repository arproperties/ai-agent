import { Router } from 'express';
import { db, tx } from './db.js';
import { isMaster } from './access.js';
import { requireMaster } from './auth.js';

// Document Renewals: the kinds of document a Shelf file can be filed as. A category
// (Employee Documents, Company Documents, any the master adds later) holds types
// (Passport, Trade Licence...). They are rows the master manages, never code: nothing may
// test a category by its label or id. What a category does comes only from its flags:
//   private    - hidden from shared and file_access (knowledge.js retrievalScope)
//   links_to   - 'employee' (a saifsys employee) or 'subject' (free text)
//   opens_case - on a type: an expiring file of it opens an Employee Renewals case
//   required   - on a type: every current employee should have one; who has not is listed
// Nothing is deleted. Retiring one (active false) hides it from new files; the files
// that have it keep it, and its alerts.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const LINKS = ['employee', 'subject'];

const SEED = [
  { label: 'Employee Documents', private: true, links_to: 'employee', types: [
    ['Passport', false, true], ['Residence Visa', false, true], ['Emirates ID', false, true], ['Labour Contract', true], 'Labour Card', 'Health Card', 'Driving Licence', 'Other employee document',
  ] },
  { label: 'Company Documents', private: false, links_to: 'subject', types: [
    'Trade Licence', 'Establishment Card', 'Insurance Policy', 'Vehicle Registration (Mulkiya)', 'Tenancy Contract (Ejari)', 'Other company document',
  ] },
];

/** Run at start-up: the two first categories, only into an empty list. */
export async function seedCategories() {
  await tx(async () => {
    await db.exec('LOCK TABLE document_categories IN EXCLUSIVE MODE');
    if (await db.prepare('SELECT 1 FROM document_categories LIMIT 1').get()) {
      // A list seeded before "required" existed (2026-10-24) gets its first must-haves once.
      if (await db.prepare("SELECT 1 FROM module_rollouts WHERE module = 'doc_types_required'").get()) return;
      const must = SEED.flatMap((c) => c.types.filter((t) => Array.isArray(t) && t[2]).map((t) => t[0]));
      await db.prepare(`UPDATE document_types t SET required = true FROM document_categories c
        WHERE c.id = t.category_id AND c.links_to = 'employee' AND t.label = ANY(?::text[])`).run(must);
      await db.prepare("INSERT INTO module_rollouts (module) VALUES ('doc_types_required')").run();
      return;
    }
    await db.prepare("INSERT INTO module_rollouts (module) VALUES ('doc_types_required') ON CONFLICT DO NOTHING").run();
    for (const [i, c] of SEED.entries()) {
      const { id } = await db.prepare('INSERT INTO document_categories (label, private, links_to, sort) VALUES (?, ?, ?, ?) RETURNING id')
        .run(c.label, c.private, c.links_to, i);
      for (const [j, t] of c.types.entries()) {
        const [label, opensCase = false, required = false] = Array.isArray(t) ? t : [t];
        await db.prepare('INSERT INTO document_types (category_id, label, opens_case, required, sort) VALUES (?, ?, ?, ?, ?)').run(id, label, opensCase, required, j);
      }
    }
  });
}

/** The list, with each category's types. Retired ones only when asked (the master's settings). */
export async function listCategories({ includeRetired = false } = {}) {
  const cats = await db.prepare(`SELECT id, label, private, links_to, active, sort FROM document_categories
    WHERE ? OR active ORDER BY sort, id`).all(includeRetired);
  const types = await db.prepare(`SELECT id, category_id, label, opens_case, required, active, sort FROM document_types
    WHERE ? OR active ORDER BY sort, id`).all(includeRetired);
  return cats.map((c) => ({
    ...c,
    types: types.filter((t) => t.category_id === c.id).map(({ category_id, ...t }) => t),
  }));
}

/** One type with its category, retired or not: a file keeps the type it was given. */
export async function typeById(id) {
  const t = await db.prepare(`SELECT t.id, t.label, t.opens_case, t.active,
      c.id c_id, c.label c_label, c.private c_private, c.links_to c_links_to, c.active c_active
    FROM document_types t JOIN document_categories c ON c.id = t.category_id WHERE t.id = ?`).get(Number(id) || 0);
  if (!t) return null;
  return {
    id: t.id, label: t.label, opens_case: t.opens_case, active: t.active,
    category: { id: t.c_id, label: t.c_label, private: t.c_private, links_to: t.c_links_to, active: t.c_active },
  };
}

const masterOnly = (user) => { if (!isMaster(user)) throw bad('Only the master changes the document categories', 403); };
const cleanLabel = (label) => {
  const s = String(label ?? '').trim().slice(0, 80);
  if (!s) throw bad('Give it a name');
  return s;
};
// The unique indexes on lower(label) answer a clash; turn it into words.
const named = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e.code === '23505') throw bad('That name is already in the list');
    throw e;
  }
};

export async function addCategory(user, { label, private: priv, links_to } = {}) {
  masterOnly(user);
  const name = cleanLabel(label);
  if (!LINKS.includes(links_to)) throw bad('Say whether its files are for an employee or for a company, vehicle or policy');
  return named(async () => (await db.prepare(`INSERT INTO document_categories (label, private, links_to, sort)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM document_categories)) RETURNING id`).run(name, !!priv, links_to)).id);
}

export async function updateCategory(user, id, changes = {}) {
  masterOnly(user);
  const cat = await db.prepare('SELECT * FROM document_categories WHERE id = ?').get(Number(id) || 0);
  if (!cat) throw bad('Category not found', 404);
  const next = { ...cat };
  if ('label' in changes) next.label = cleanLabel(changes.label);
  if ('active' in changes) next.active = !!changes.active;
  if ('sort' in changes) next.sort = Number(changes.sort) || 0;
  if ('private' in changes) next.private = !!changes.private;
  if ('links_to' in changes) {
    if (!LINKS.includes(changes.links_to)) throw bad('Say whether its files are for an employee or for a company, vehicle or policy');
    next.links_to = changes.links_to;
  }
  // Who may see a file, and what it is for, cannot change under files already filed.
  if (next.private !== cat.private || next.links_to !== cat.links_to) {
    if (await db.prepare('SELECT 1 FROM documents WHERE category_id = ? LIMIT 1').get(cat.id)) {
      throw bad('This category already has files, so who can see them and what they are for cannot change. Add a new category instead.');
    }
  }
  await named(() => db.prepare('UPDATE document_categories SET label = ?, active = ?, sort = ?, private = ?, links_to = ? WHERE id = ?')
    .run(next.label, next.active, next.sort, next.private, next.links_to, cat.id));
}

export async function addType(user, categoryId, { label, opens_case } = {}) {
  masterOnly(user);
  const cat = await db.prepare('SELECT id FROM document_categories WHERE id = ?').get(Number(categoryId) || 0);
  if (!cat) throw bad('Category not found', 404);
  const name = cleanLabel(label);
  return named(async () => (await db.prepare(`INSERT INTO document_types (category_id, label, opens_case, sort)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM document_types WHERE category_id = ?)) RETURNING id`)
    .run(cat.id, name, !!opens_case, cat.id)).id);
}

export async function updateType(user, id, changes = {}) {
  masterOnly(user);
  const t = await db.prepare('SELECT * FROM document_types WHERE id = ?').get(Number(id) || 0);
  if (!t) throw bad('Type not found', 404);
  const label = 'label' in changes ? cleanLabel(changes.label) : t.label;
  const active = 'active' in changes ? !!changes.active : t.active;
  const opensCase = 'opens_case' in changes ? !!changes.opens_case : t.opens_case;
  const required = 'required' in changes ? !!changes.required : t.required;
  await named(() => db.prepare('UPDATE document_types SET label = ?, active = ?, opens_case = ?, required = ? WHERE id = ?').run(label, active, opensCase, required, t.id));
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Mounted at /api: everyone reads the list (the Shelf offers it), the master writes it. */
export const docCategoryRoutes = Router();
docCategoryRoutes.get('/doc-categories', wrap(async (req, res) => {
  res.json({ categories: await listCategories({ includeRetired: isMaster(req.user) && req.query.all === '1' }) });
}));
docCategoryRoutes.post('/doc-categories', requireMaster, wrap(async (req, res) => {
  res.json({ id: await addCategory(req.user, req.body || {}) });
}));
docCategoryRoutes.patch('/doc-categories/:id', requireMaster, wrap(async (req, res) => {
  await updateCategory(req.user, req.params.id, req.body || {});
  res.json({ ok: true });
}));
docCategoryRoutes.post('/doc-categories/:id/types', requireMaster, wrap(async (req, res) => {
  res.json({ id: await addType(req.user, req.params.id, req.body || {}) });
}));
docCategoryRoutes.patch('/doc-types/:id', requireMaster, wrap(async (req, res) => {
  await updateType(req.user, req.params.id, req.body || {});
  res.json({ ok: true });
}));
