import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { DATA_DIR } from './config.js';

// Properties: the companies of the group, their buildings, and each building's units.
// Everyone signed in can read them; only the master adds, changes or removes. A company
// with buildings, or a building with units, cannot be removed: empty it first.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// The fields each one keeps, and what kind of value each is. Anything else sent is ignored.
const KINDS = {
  company: { table: 'prop_companies', parent: null, need: 'name',
    fields: { name: 'text', trade_license_no: 'text', trn: 'text', phone: 'text', email: 'text', address: 'text', notes: 'text' } },
  building: { table: 'prop_buildings', parent: 'company_id', need: 'name',
    fields: { name: 'text', emirate: 'text', area: 'text', address: 'text', plot_no: 'text', makani_no: 'text', notes: 'text' } },
  unit: { table: 'prop_units', parent: 'building_id', need: 'unit_no',
    fields: { unit_no: 'text', floor: 'text', type: 'text', size_sqft: 'number', furnished: 'bool',
      dewa_no: 'text', blocked: 'bool', notes: 'text' } },
};

function clean(kind, body = {}) {
  const out = {};
  for (const [f, type] of Object.entries(KINDS[kind].fields)) {
    if (!(f in body)) continue;
    const v = body[f];
    if (type === 'bool') out[f] = !!v;
    else if (type === 'number') {
      if (v === '' || v == null) out[f] = null;
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) throw bad(`${f.replace(/_/g, ' ')} must be a number.`);
      else out[f] = Number(v);
    } else out[f] = String(v ?? '').trim().slice(0, 500) || null;
  }
  return out;
}

const dupe = (e, kind) => {
  if (e.code === '23505') throw bad(kind === 'unit' ? 'That unit number already exists in this building.' : `A ${kind} with that name already exists.`, 409);
  throw e;
};

export async function create(kind, body, parentId, by) {
  const k = KINDS[kind];
  const row = clean(kind, body);
  if (!row[k.need]) throw bad(`${k.need === 'name' ? 'Name' : 'Unit number'} is required.`);
  if (k.parent) {
    const ptable = kind === 'building' ? 'prop_companies' : 'prop_buildings';
    if (!(await db.prepare(`SELECT 1 FROM ${ptable} WHERE id = ?`).get(Number(parentId)))) throw bad('Not found', 404);
    row[k.parent] = Number(parentId);
  }
  if (kind === 'company') row.created_by = by ?? null;
  const cols = Object.keys(row);
  try {
    const { id } = await db.prepare(`INSERT INTO ${k.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
      .run(...cols.map((c) => row[c]));
    return db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(id);
  } catch (e) { return dupe(e, kind); }
}

export async function update(kind, id, body) {
  const k = KINDS[kind];
  const row = clean(kind, body);
  if (k.need in row && !row[k.need]) throw bad(`${k.need === 'name' ? 'Name' : 'Unit number'} is required.`);
  const cols = Object.keys(row);
  if (cols.length) {
    try {
      const r = await db.prepare(`UPDATE ${k.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => row[c]), Number(id));
      if (!r.changes) throw bad('Not found', 404);
    } catch (e) { if (e.status) throw e; dupe(e, kind); }
  }
  const out = await db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(Number(id));
  if (!out) throw bad('Not found', 404);
  return out;
}

export async function remove(kind, id) {
  // A company takes its documents with it; their rows cascade, their files are removed here.
  const files = kind === 'company'
    ? (await db.prepare('SELECT file_path FROM prop_documents WHERE company_id = ? AND file_path IS NOT NULL').all(Number(id))).map((d) => d.file_path)
    : [];
  try {
    const r = await db.prepare(`DELETE FROM ${KINDS[kind].table} WHERE id = ?`).run(Number(id));
    if (!r.changes) throw bad('Not found', 404);
  } catch (e) {
    if (e.code === '23503') throw bad(kind === 'company' ? 'Remove its buildings first.' : 'Remove its units first.', 409);
    throw e;
  }
  for (const f of files) rmSync(f, { force: true });
  return { ok: true };
}

/** Companies with how many buildings and units each has. */
export const listCompanies = () => db.prepare(`
  SELECT c.*, (SELECT count(*)::int FROM prop_buildings b WHERE b.company_id = c.id) AS buildings,
    (SELECT count(*)::int FROM prop_units u JOIN prop_buildings b ON b.id = u.building_id WHERE b.company_id = c.id) AS units
  FROM prop_companies c ORDER BY c.name`).all();

export const listBuildings = (companyId) => db.prepare(`
  SELECT b.*, (SELECT count(*)::int FROM prop_units u WHERE u.building_id = b.id) AS units
  FROM prop_buildings b WHERE b.company_id = ? ORDER BY b.name`).all(Number(companyId));

// Units in floor then number order, the way they read on a building's board (2, 10, 101…).
export const listUnits = (buildingId) => db.prepare(`
  SELECT * FROM prop_units WHERE building_id = ?
  ORDER BY NULLIF(regexp_replace(floor, '\\D', '', 'g'), '')::int NULLS FIRST, floor,
    NULLIF(regexp_replace(unit_no, '\\D', '', 'g'), '')::bigint NULLS LAST, unit_no`).all(Number(buildingId));

const one = async (table, id) => {
  const r = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!r) throw bad('Not found', 404);
  return r;
};

// ---------- company documents ----------

const DOC_DIR = `${DATA_DIR}/properties`;
const SOON = 30; // days before expiry a document shows as due
const DOC_COLS = `id, company_id, title, number, notes, file_name, file_mime, uploaded_by, created_at,
  (file_path IS NOT NULL) AS has_file,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date`;
// Newest first within a name: the one that expires last, then the one added last.
const NEWEST = 'expiry_date DESC NULLS LAST, id DESC';

const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;

/** valid | due | expired | on_file (no expiry) for one document, as of `today` (YYYY-MM-DD). */
export function docStatus(doc, today) {
  if (!doc.expiry_date) return 'on_file';
  const left = day(doc.expiry_date) - day(today);
  return left < 0 ? 'expired' : left <= SOON ? 'due' : 'valid';
}

const todayUae = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const key = (title) => title.trim().toLowerCase();

/**
 * Each company with its documents grouped by name ("Trade License" twice is one licence,
 * renewed): the newest of each name decides its status, and the card counts those.
 */
export async function docBoard(today = todayUae()) {
  const companies = await listCompanies();
  const docs = await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents ORDER BY lower(title), ${NEWEST}`).all();
  return companies.map((c) => {
    const groups = new Map();
    for (const d of docs) {
      if (d.company_id !== c.id) continue;
      const g = groups.get(key(d.title));
      if (g) g.count += 1;
      else groups.set(key(d.title), { title: d.title, count: 1, doc: { ...d, status: docStatus(d, today) } });
    }
    const list = [...groups.values()].map((g) => ({ ...g, status: g.doc.status }));
    return { ...c, docs: list, expired: list.filter((g) => g.status === 'expired').length, due: list.filter((g) => g.status === 'due').length };
  });
}

/** Every document of one company, or only those under one name (its renewals). */
export async function companyDocs(companyId, title, today = todayUae()) {
  const rows = title
    ? await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? AND lower(title) = ? ORDER BY ${NEWEST}`).all(Number(companyId), key(title))
    : await db.prepare(`SELECT ${DOC_COLS} FROM prop_documents WHERE company_id = ? ORDER BY lower(title), ${NEWEST}`).all(Number(companyId));
  return rows.map((d) => ({ ...d, status: docStatus(d, today) }));
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(day(v));
function docFields(body = {}) {
  const out = {};
  for (const f of ['title', 'number', 'notes']) if (f in body) out[f] = String(body[f] ?? '').trim().slice(0, 300) || null;
  for (const f of ['issue_date', 'expiry_date']) {
    if (!(f in body)) continue;
    const v = String(body[f] ?? '').trim();
    if (v && !isDate(v)) throw bad(`${f === 'issue_date' ? 'Issue' : 'Expiry'} date is not a date.`);
    out[f] = v || null;
  }
  if ('title' in out && !out.title) throw bad('Give the document a name.');
  return out;
}

const getDoc = async (id) => {
  const d = await db.prepare(`SELECT ${DOC_COLS}, file_path FROM prop_documents WHERE id = ?`).get(Number(id));
  if (!d) throw bad('Not found', 404);
  return d;
};
const shown = ({ file_path, ...d }) => d;

function saveFile(file) {
  if (!file) return {};
  mkdirSync(DOC_DIR, { recursive: true });
  const path = `${DOC_DIR}/${Date.now()}-${randomBytes(6).toString('hex')}`;
  writeFileSync(path, file.buffer);
  return { file_path: path, file_name: file.originalname.slice(0, 200), file_mime: file.mimetype };
}

export async function addDoc(companyId, body, file, by) {
  const fields = docFields({ title: '', ...body });
  if (!(await db.prepare('SELECT 1 FROM prop_companies WHERE id = ?').get(Number(companyId)))) throw bad('Not found', 404);
  const row = { ...fields, ...saveFile(file), company_id: Number(companyId), uploaded_by: by ?? null };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO prop_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...cols.map((c) => row[c]));
  return shown(await getDoc(id));
}

/** Change a document's details, and replace its file when a new one is sent. */
export async function updateDoc(id, body, file) {
  const old = await getDoc(id);
  const row = { ...docFields(body), ...saveFile(file) };
  const cols = Object.keys(row);
  if (cols.length) await db.prepare(`UPDATE prop_documents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), old.id);
  if (file && old.file_path) rmSync(old.file_path, { force: true });
  return shown(await getDoc(id));
}

export async function removeDoc(id) {
  const d = await getDoc(id);
  await db.prepare('DELETE FROM prop_documents WHERE id = ?').run(d.id);
  if (d.file_path) rmSync(d.file_path, { force: true });
  return { ok: true };
}

// ---------- routes ----------

export const propertyRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const INLINE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/; // opened in the browser; anything else downloads

propertyRoutes.get('/docs', wrap(async (req, res) => res.json(await docBoard())));
propertyRoutes.get('/companies/:id/docs', wrap(async (req, res) => res.json(await companyDocs(req.params.id, req.query.title))));
propertyRoutes.post('/companies/:id/docs', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await addDoc(req.params.id, req.body, req.file, req.user.id))));
propertyRoutes.put('/docs/:id', requireMaster, upload.single('file'), wrap(async (req, res) => res.json(await updateDoc(req.params.id, req.body, req.file))));
propertyRoutes.delete('/docs/:id', requireMaster, wrap(async (req, res) => res.json(await removeDoc(req.params.id))));
propertyRoutes.get('/docs/:id/file', wrap(async (req, res) => {
  const d = await getDoc(req.params.id);
  if (!d.file_path) throw bad('Not found', 404);
  const inline = INLINE.test(d.file_mime || '') && !req.query.download;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.file_name || 'document')}`);
  res.type(inline ? d.file_mime : 'application/octet-stream').sendFile(d.file_path);
}));

propertyRoutes.get('/companies', wrap(async (req, res) => res.json(await listCompanies())));
propertyRoutes.get('/companies/:id', wrap(async (req, res) => res.json({ ...(await one('prop_companies', req.params.id)), list: await listBuildings(req.params.id) })));
propertyRoutes.get('/buildings/:id', wrap(async (req, res) => {
  const b = await one('prop_buildings', req.params.id);
  res.json({ ...b, company: await one('prop_companies', b.company_id), list: await listUnits(b.id) });
}));

propertyRoutes.post('/companies', requireMaster, wrap(async (req, res) => res.json(await create('company', req.body, null, req.user.id))));
propertyRoutes.post('/companies/:id/buildings', requireMaster, wrap(async (req, res) => res.json(await create('building', req.body, req.params.id))));
propertyRoutes.post('/buildings/:id/units', requireMaster, wrap(async (req, res) => res.json(await create('unit', req.body, req.params.id))));

for (const [kind, path] of [['company', 'companies'], ['building', 'buildings'], ['unit', 'units']]) {
  propertyRoutes.put(`/${path}/:id`, requireMaster, wrap(async (req, res) => res.json(await update(kind, req.params.id, req.body))));
  propertyRoutes.delete(`/${path}/:id`, requireMaster, wrap(async (req, res) => res.json(await remove(kind, req.params.id))));
}
