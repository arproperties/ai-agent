import { randomUUID, createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db, tx } from './db.js';
import { addTenant, listTenants } from './leasing.js';
import { fileBlock } from './documentReader.js';

// Bringing in the tenant list from Rent Manager (the old software): its "Tenants" report as
// screenshots, a PDF or a CSV. Claude only copies the rows out as they are written; the
// cleaning is done here, by rules that can be read and changed: Rent Manager's tags come out of
// the names (and are kept in the notes), a name cut off in one column is finished from the
// other, one person on several accounts becomes one tenant. Nothing is saved until someone has
// looked at the preview and ticked the rows; whatever is unclear starts unticked.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const MODEL = 'claude-sonnet-5'; // the small model misreads a page of tiny print; this one does not
const MAX_TEXT = 200_000;

// ---------- reading the files ----------

const PROMPT = `This is a tenant list from property management software (such as Rent Manager): a screenshot, a printed report or an export. For every tenant row, copy the Tenant name, the Contacts cell and the Account number exactly as written: keep tags such as M2M, MTM, HUD, (LEGACY), EMP, ABP/75, FF, WDC, *SEE NOTE* where they are, and do not fix spelling or finish cut-off words.
Reply with one JSON object and nothing else: {"rows":[["tenant","contacts","account",cut,company], ...]}
cut is 1 when the tenant's name is clipped in both the Tenant and Contacts columns (it runs into the next column, so the whole name cannot be seen), otherwise 0.
company is 1 when the tenant is a business rather than a person, otherwise 0.
Leave out column headings, page headers and footers, and blank lines. If this is not a list of tenants, reply {"rows":[]}.`;

const ROW = /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"?([^",\]]*?)"?\s*,\s*([01])\s*,\s*([01])\s*\]/g;
const unquote = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };

/** The rows out of the reader's reply, one array at a time, so a reply cut short still gives every row before the cut. */
export function parseRows(reply) {
  return [...String(reply).matchAll(ROW)]
    .map(([, tenant, contacts, account, cut, company]) => ({
      // The account no. is the last number in the cell: the unit beside it ("GSL 109 4950") is sometimes read into it.
      tenant: unquote(tenant).trim(), contacts: unquote(contacts).trim(), account: String(account).match(/\d+(?!.*\d)/)?.[0] ?? String(account).trim(), cut: cut === '1', company: company === '1',
    }))
    .filter((r) => r.tenant);
}

const TEXT = /^text\/|\/(csv|json)$|vnd\.ms-excel$/; // a CSV comes as text/csv, or as Excel's type from Windows
const isText = (f) => TEXT.test(f.mimetype || '') || /\.(csv|txt|tsv)$/i.test(f.originalname || '');

/** What the reader is given for one file: the picture or the PDF, or the file's text. Null for a kind it cannot read. */
function contentFor(file) {
  if (isText(file)) return [{ type: 'text', text: `<file name="${file.originalname}">\n${file.buffer.toString('utf8').slice(0, MAX_TEXT)}\n</file>` }, { type: 'text', text: PROMPT }];
  const b = fileBlock(file);
  return b && [b, { type: 'text', text: PROMPT }];
}

async function claudeRead(content) {
  const { claude } = await import('./ai.js');
  // Streamed: a long list is a long reply, more than a plain request is allowed to wait for.
  const msg = await claude.messages.stream({ model: MODEL, max_tokens: 32000, messages: [{ role: 'user', content }] }).finalMessage();
  return { text: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), partial: msg.stop_reason === 'max_tokens' };
}

// A file already read is not read (or paid for) again. The fingerprint covers the instructions
// and the model too, so changing either reads every file afresh. Only whole readings are kept.
const fingerprint = (file) => createHash('sha256').update(MODEL).update(PROMPT).update(file.buffer).digest('hex');
const savedReads = {
  get: async (hash) => (await db.prepare('SELECT rows FROM lease_import_reads WHERE hash = ?').get(hash))?.rows,
  set: (hash, rows) => db.prepare('INSERT INTO lease_import_reads (hash, rows) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET rows = EXCLUDED.rows').run(hash, JSON.stringify(rows)),
};

/**
 * Every file read, a few at a time. { rows, failed }: the rows in the order of the files,
 * and the names of the files that could not be read (or only partly), so the page can say so.
 */
export async function readTenantFiles(files, { read = claudeRead, onProgress = () => {}, saved = savedReads } = {}) {
  const out = files.map(() => []);
  const failed = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      const content = contentFor(f);
      if (!content) failed.push(f.originalname);
      else {
        try {
          const hash = fingerprint(f);
          const before = await saved.get(hash).catch(() => null);
          if (before) out[i] = before;
          else {
            const got = await read(content);
            out[i] = parseRows(typeof got === 'string' ? got : got.text);
            if (got?.partial) failed.push(`${f.originalname} (only partly read)`);
            else if (out[i].length) await saved.set(hash, out[i]).catch((e) => console.error('[tenant-import] keeping the reading:', e.message));
          }
        } catch (e) {
          console.error('[tenant-import]', f.originalname, e.message);
          failed.push(f.originalname);
        }
      }
      onProgress(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  return { rows: out.flat(), failed };
}

// ---------- cleaning a row ----------

// Rent Manager's tags, as they appear inside names. Each is taken out of the name and kept in
// the tenant's notes. What they mean is the office's to say; only LEGACY does more so far (HOUSING below).
const TAGS = [
  [/\(\s*hud\s*\)|\bhud\b/gi, 'HUD'],
  [/\(\s*legacy\s*\)|\blegacy\b/gi, 'LEGACY'],
  [/\b(m2m|mtm)\b/gi, 'M2M'],
  [/\(\s*emp\s*\)|\bemp(loyee)?\b/gi, 'EMP'],
  [/\babp\s*\/\s*\d+\b/gi, null], // kept as written, e.g. ABP/75
  [/\bff\b/gi, 'FF'],
  [/\bcollec\w*/gi, 'COLLEC'],
  [/\bmti\b/gi, 'MTI'],
  [/\bairbnb\b/gi, 'AIRBNB'],
  [/\b(wdc|wdr|wdb)\b\*?/gi, null], // the unit's tag, not part of the name
];
// The tags that say which housing authority pays part of the rent: such a tenant is saved as a
// housing tenant with that authority. (LEGACY) is Legacy; a tag cut off by the column, "(LEGA", too.
// HUD is not here: it does not say which authority, and the form needs one.
const HOUSING = [['LEGACY', 'Legacy']];
const housingOf = (tags) => HOUSING.find(([tag]) => tags.some((t) => t.length >= 4 && tag.startsWith(t)))?.[1] ?? null;

const ORDINAL = /\(\s*(primary|first|second|third|fourth|fifth)\s*\)/gi; // BRET (THIRD) NAZWORTH: one person on several accounts
const SUFFIX = new Set(['JR', 'SR', 'II', 'III', 'IV']);

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** The name without its tags, and the tags found. Marks like *SEE NOTE* or "- Balance" are cut off and reported; a name ending in "…" was cut off in the list. */
function untag(raw) {
  const tags = [];
  const marks = [];
  const cut = /(\.\.\.|…)\s*$/.test(raw);
  let s = ` ${raw.replace(/(\.\.\.|…)\s*$/, '')} `.replace(ORDINAL, ' ');
  s = s.replace(/\*[^*]*\*?/g, (m) => { marks.push(squash(m)); return ' '; });
  s = s.replace(/\(([^)]*)$/, (m, inner) => { if (inner.trim()) tags.push(inner.trim().toUpperCase()); return ' '; }); // a tag cut off by the column: "(Lega"
  s = s.replace(/[.,;:]+(?=\s|$)/g, ' '); // "Lapoint." is Lapoint
  s = s.replace(/\s-\s+(.*)$/, (m, rest) => { marks.push(`- ${squash(rest)}`); return ' '; });
  for (const [re, label] of TAGS) s = s.replace(re, (m) => { const t = label ?? m.toUpperCase().replace(/\s+/g, ''); if (label !== null || /abp/i.test(m)) tags.push(t); return ' '; });
  return { name: squash(s.replace(/[()]/g, ' ')), tags, marks, cut };
}

const words = (s) => s.toLowerCase().split(' ').filter(Boolean);
/** b is a, finished: every word of a starts the same word of b (and b may have more, such as JR). */
const finishes = (a, b) => a.length > 0 && b.length >= a.length && a.every((w, i) => b[i].startsWith(w));
// The Tenant column holds about 17 letters. A name that fills it was cut off there, often in the
// middle of a letter the screenshot blurs (BEESI for BEESL…), so its last word only has to start
// like the Contacts one: the same first 4 letters, the other words the same.
const FULL_COLUMN = 15;
const cutShort = (raw, a, b) => raw.length >= FULL_COLUMN && a.length === b.length && a.at(-1).length >= 4 && b.at(-1).length > a.at(-1).length
  && b.at(-1).startsWith(a.at(-1).slice(0, 4)) && a.slice(0, -1).every((w, i) => w === b[i]);

// Names are saved in the capitals Rent Manager writes them in (NICHOLAS RYAN), as the office keeps
// them. false turns NICHOLAS RYAN into Nicholas Ryan, keeping DeYoung, McBride, O'Neil and JR right.
const AS_WRITTEN = true;

function tidy(name) {
  if (AS_WRITTEN) return name;
  return name.split(' ').map((w) => {
    if (SUFFIX.has(w.toUpperCase().replace(/\./g, ''))) return w.toUpperCase();
    if (w !== w.toUpperCase() && w !== w.toLowerCase()) return w; // written with care already: DeYoung, LeBlanc
    const t = w.toLowerCase().replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    return t.replace(/^Mc([a-z])/, (m, c) => `Mc${c.toUpperCase()}`);
  }).join(' ');
}

/** One row of the list, cleaned: the name to save, its kind, its tags, the other people on the account, and anything to look at. */
export function cleanRow(r) {
  const raw = squash(r.tenant || '');
  const t = untag(raw);
  const reasons = t.marks.map((m) => `Rent Manager marks it "${m}"`);
  let name = t.name;
  const own = words(name);
  const others = [];
  let mine = false;
  let stillCut = t.cut;
  for (const part of String(r.contacts || '').split(',')) {
    const u = untag(squash(part));
    const c = u.name;
    if (!c) continue;
    const cw = words(c);
    if (finishes(own, cw) || cutShort(raw, own, cw)) {
      mine = true;
      if (c.length > name.length) { name = c; stillCut = u.cut; }
    } else if (finishes(cw, own)) mine = true;
    else others.push(tidy(c));
  }
  // The Tenant column is the account holder; a different name in Contacts (JOHN CAIN / jodi cain) is a
  // second person or a slip there, kept in the notes as "Also on the account", never a reason to stop.
  const company = !!r.company;
  // An employee's or Airbnb's account, or a tag with no name left, is not a person: ARTURO EMP, FF, AIRBNB 1.
  // One name and other tags (GUSTAVO FF ABP/75) is a person whose surname is missing: looked at, not skipped.
  const lone = !company && words(name).length < 2;
  const skip = /airbnb|maint/i.test(raw) || !name || (lone && t.tags.includes('EMP'));
  if (lone && !skip) reasons.push('Only one name is given');
  // Finished from Contacts: cut only if the Contacts name is cut too. Seen whole in Contacts: not cut.
  // Otherwise the reader's word for it, or a trailing "…".
  if (name !== t.name ? stillCut : !mine && (t.cut || r.cut)) reasons.push('The name may be cut off in the list');
  const notesOf = notes(t.tags, others);
  return { name: tidy(name), kind: company ? 'company' : 'person', account: String(r.account || '').trim(), original: raw, tags: t.tags, others, reasons, skip, notes: notesOf };
}

function notes(tags, others) {
  return [tags.length && `Rent Manager: ${[...new Set(tags)].join(', ')}.`, others.length && `Also on the account: ${[...new Set(others)].join(', ')}.`].filter(Boolean).join(' ') || null;
}

const key = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const accountsOf = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The preview: the rows cleaned, one person on several accounts made one, and each matched
 * against the tenants on file. status: new (ticked), check (something to look at), exists
 * (already on file, by account no. or name), skip (not a person: AIRBNB, FF, an employee's account).
 */
export function planImport(rows, existing = []) {
  const byAccount = new Map();
  const byName = new Map();
  for (const e of existing) {
    for (const a of accountsOf(e.old_account)) byAccount.set(a, e.id);
    byName.set(key(e.full_name), e.id);
  }
  const groups = new Map();
  for (const r of rows) {
    const c = cleanRow(r);
    const k = `${c.kind}:${key(c.name) || key(c.original)}`;
    const g = groups.get(k);
    if (!g) { groups.set(k, { ...c, accounts: c.account ? [c.account] : [], original: [c.original], skips: [c.skip] }); continue; }
    if (c.account && !g.accounts.includes(c.account)) g.accounts.push(c.account);
    if (!g.original.includes(c.original)) g.original.push(c.original);
    g.tags.push(...c.tags);
    g.others.push(...c.others.filter((o) => !g.others.includes(o)));
    g.reasons.push(...c.reasons.filter((x) => !g.reasons.includes(x)));
    g.skips.push(c.skip);
  }
  return [...groups.values()].map(({ account, skip, skips, ...g }) => {
    const found = g.accounts.map((a) => byAccount.get(a)).find(Boolean) ?? byName.get(key(g.name));
    const status = skips.every(Boolean) ? 'skip' : found ? 'exists' : g.reasons.length ? 'check' : 'new';
    return { ...g, tags: [...new Set(g.tags)], notes: notes(g.tags, g.others), housing_authority: housingOf(g.tags), status, pick: status === 'new', tenant_id: found ?? null };
  });
}

// ---------- saving ----------

/** The ticked rows saved as tenants, all under one batch so they can be undone together. Anyone already on file is left alone. */
export async function importTenants(rows, by) {
  if (!Array.isArray(rows) || !rows.length) throw bad('Tick the tenants to import.');
  if (rows.length > 5000) throw bad('That is more tenants than one import takes.');
  const batch = randomUUID();
  let added = 0;
  let skipped = 0;
  await tx(async () => {
    const existing = await listTenants();
    const accounts = new Set(existing.flatMap((e) => accountsOf(e.old_account)));
    const names = new Set(existing.map((e) => key(e.full_name)));
    for (const r of rows) {
      const name = String(r.name ?? '').trim();
      const acc = (Array.isArray(r.accounts) ? r.accounts : accountsOf(r.accounts)).map((a) => String(a).trim()).filter(Boolean);
      if (!name || acc.some((a) => accounts.has(a)) || names.has(key(name))) { skipped += 1; continue; }
      const housing = r.housing_authority ? { housing: true, housing_authority: r.housing_authority } : {}; // checked against the list by addTenant
      const t = await addTenant({ full_name: name, kind: r.kind, notes: r.notes, ...housing }, by);
      const old = (Array.isArray(r.original) ? r.original : [r.original]).filter(Boolean).join(' / ').slice(0, 300) || null;
      await db.prepare('UPDATE lease_tenants SET old_account = ?, old_name = ?, import_batch = ? WHERE id = ?').run(acc.join(', ') || null, old, batch, t.id);
      acc.forEach((a) => accounts.add(a));
      names.add(key(name));
      added += 1;
    }
  });
  return { batch, added, skipped };
}

/** One import taken back: its tenants deleted, except any who have a lease by now. */
export async function undoImport(batch) {
  if (!batch) throw bad('Which import?');
  const r = await db.prepare(`DELETE FROM lease_tenants t WHERE t.import_batch = ?
    AND NOT EXISTS (SELECT 1 FROM lease_bookings b WHERE b.tenant_id = t.id)`).run(String(batch));
  const { n } = await db.prepare('SELECT count(*)::int AS n FROM lease_tenants WHERE import_batch = ?').get(String(batch));
  return { removed: r.changes, kept: n };
}

// ---------- the reading, as a job the page asks after ----------

// Eight screenshots take a minute or two to read, longer than a request should hang open
// behind a proxy, so the page starts a reading and asks how it is going.
const jobs = new Map();
const KEEP_MS = 30 * 60 * 1000;

export function startReading(files, by) {
  if (!files?.length) throw bad('Choose the screenshots, PDF or CSV of the tenant list.');
  for (const [id, j] of jobs) if (Date.now() - j.at > KEEP_MS) jobs.delete(id);
  const id = randomUUID();
  const job = { by, at: Date.now(), done: 0, total: files.length, finished: false };
  jobs.set(id, job);
  readTenantFiles(files, { onProgress: (d) => { job.done = d; } })
    .then(async ({ rows, failed }) => Object.assign(job, { rows: planImport(rows, await listTenants()), failed, read: rows.length }))
    .catch((e) => { console.error('[tenant-import]', e.message); job.error = 'The files could not be read. Try again.'; })
    .finally(() => { job.finished = true; });
  return { id };
}

export function readingStatus(id, by) {
  const j = jobs.get(id);
  if (!j || j.by !== by) throw bad('That reading is no longer here. Upload the files again.', 404);
  return { done: j.done, total: j.total, finished: j.finished, error: j.error, failed: j.failed, read: j.read, rows: j.finished ? j.rows : undefined };
}

// ---------- routes, under /api/leasing/tenants/import (anyone signed in, as adding a tenant is) ----------

export const tenantImportRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const files = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } }).array('files', 20);

tenantImportRoutes.post('/read', files, wrap(async (req, res) => res.json(startReading(req.files, req.user.id))));
tenantImportRoutes.get('/read/:id', wrap(async (req, res) => res.json(readingStatus(req.params.id, req.user.id))));
tenantImportRoutes.post('/', wrap(async (req, res) => res.json(await importTenants(req.body?.rows, req.user.id))));
tenantImportRoutes.delete('/:batch', wrap(async (req, res) => res.json(await undoImport(req.params.batch))));
