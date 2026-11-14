import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const cats = await import('../server/docCategories.js');
const { syncCompanyDocs, COMPANY_TYPES } = await import('../server/saifsysCompanyDocs.js');
const { searchFiles } = await import('../server/shelf.js');
const { currentOnly, agentScope, retrievalScope } = await import('../server/knowledge.js');
const { readableDocuments, libraryCatalog } = await import('../server/files.js');
const { onlyPrivateAgents } = await import('../server/access.js');

// Files go to a throwaway folder: the real data/uploads holds the same numbers.
const UPLOADS = mkdtempSync(join(tmpdir(), 'company-docs-'));
test.after(() => { rmSync(UPLOADS, { recursive: true, force: true }); return closeDb(); });

const licence = (over = {}) => ({
  id: 1, company_id: 1, company_name: 'Saif Holding LLC', company_code: 'SH', type: 'trade_license', title: null,
  number: '123456', authority: 'DED', issued_at: '2026-01-10', expires_at: '2027-01-09', notes: null,
  updated_at: '2026-11-01 09:00:00', has_file: true, file_name: 'Trade Licence 2026.pdf', file_key: 'tl_2026.pdf', versions: [], ...over,
});
const version = (over = {}) => ({
  version_no: 1, number: '123456', authority: 'DED', issued_at: '2025-01-10', expires_at: '2026-01-09', notes: null,
  archived_at: '2026-01-12 10:00:00', has_file: true, file_name: 'Trade Licence 2025.pdf', file_key: 'tl_2025.pdf', ...over,
});

// saifsys's company_docs door, as a fake: pages of `per`, its files by "id" or "id/version",
// and a reader that says what it read, so no model is called.
function saifsys(docs, { per = 500, files = {}, failPage = false } = {}) {
  const calls = { pages: 0, files: [], reads: [] };
  return {
    calls,
    uploadDir: UPLOADS,
    lookup: async (module, action, { after_id = 0 }) => {
      assert.equal(module, 'company_docs');
      assert.equal(action, 'documents');
      calls.pages++;
      if (failPage && calls.pages > 1) throw new Error('saifsys did not answer');
      const rest = docs.filter((d) => d.id > Number(after_id));
      const page = rest.slice(0, per);
      return { ok: true, documents: page, next_after_id: rest.length > per ? page.at(-1).id : null };
    },
    fetchFile: async (id, v) => {
      const key = v ? `${id}/${v}` : String(id);
      calls.files.push(key);
      if (!(key in files)) throw Object.assign(new Error('That file could not be found.'), { status: 404 });
      return { buffer: Buffer.from(files[key]), mime: 'application/pdf' };
    },
    read: async ({ buffer, name }) => {
      calls.reads.push(name);
      return `READ: ${buffer.toString()}`;
    },
  };
}

async function office() {
  await reset();
  const boss = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss);
  await cats.seedCategories();
  return { boss };
}
const docs = () => db.prepare(`SELECT d.*, t.label AS type, c.label AS category FROM documents d
  LEFT JOIN document_types t ON t.id = d.type_id LEFT JOIN document_categories c ON c.id = d.category_id ORDER BY d.id`).all();
const chunksOf = async (id) => (await db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY id').all(id)).map((r) => r.text).join('\n');

test('every saifsys company type has a Reem type, the missing ones added to Company Documents once', async () => {
  await office();
  await syncCompanyDocs(saifsys([]));
  await syncCompanyDocs(saifsys([]));
  const labels = (await db.prepare(`SELECT t.label FROM document_types t JOIN document_categories c ON c.id = t.category_id
    WHERE c.links_to = 'subject'`).all()).map((r) => r.label);
  for (const l of Object.values(COMPANY_TYPES)) assert.equal(labels.filter((x) => x === l).length, 1, l);
});

test('a company document comes across as the master\'s shared file, read, with its earlier issues kept as old', async () => {
  const { boss } = await office();
  const s = saifsys([licence({ versions: [version()] })], { files: { 1: 'licence 2026 text', '1/1': 'licence 2025 text' } });
  const r = await syncCompanyDocs(s);
  assert.equal(r.added, 2);
  const [old, cur] = await docs();
  assert.equal(cur.user_id, boss);
  assert.equal(cur.shared, true, 'every internal user reads it');
  assert.equal(cur.category, 'Company Documents');
  assert.equal(cur.type, 'Trade Licence');
  assert.equal(cur.subject, 'Saif Holding LLC');
  assert.equal(cur.title, 'Trade Licence – Saif Holding LLC');
  assert.equal(cur.expires_on, '2027-01-09');
  assert.ok(cur.expiry_confirmed_at, 'typed into saifsys, so confirmed');
  assert.equal(cur.status, 'ready');
  assert.equal(cur.superseded_by, null);
  assert.equal(readFileSync(cur.path, 'utf8'), 'licence 2026 text');
  assert.match(await chunksOf(cur.id), /Current issue of the Trade Licence of Saif Holding LLC[\s\S]*READ: licence 2026 text/);

  assert.equal(old.superseded_by, cur.id, 'the earlier issue is replaced by the current one');
  assert.equal(readFileSync(old.path, 'utf8'), 'licence 2025 text', 'and its file is there to open');
  assert.match(old.title, /earlier issue 2025-01-10 to 2026-01-09/);
  assert.deepEqual(s.calls.reads, ['Trade Licence 2026.pdf'], 'only the current issue is read');
  assert.match(await chunksOf(old.id), /Earlier issue[\s\S]*not the current issue/);

  // Nothing changed: nothing fetched or read again.
  const again = saifsys([licence({ versions: [version()] })], { files: { 1: 'x', '1/1': 'y' } });
  assert.deepEqual(await syncCompanyDocs(again), { added: 0, updated: 0, renewed: 0, removed: 0, superseded: 0 });
  assert.deepEqual(again.calls.files, []);
});

test('renewed in saifsys: the copy Reem had becomes the earlier issue and the new one is current', async () => {
  await office();
  await syncCompanyDocs(saifsys([licence({ issued_at: '2025-01-10', expires_at: '2026-01-09', file_key: 'tl_2025.pdf', file_name: 'TL 2025.pdf', updated_at: '2025-01-12 10:00:00' })],
    { files: { 1: 'licence 2025 text' } }));
  const [before] = await docs();

  const s = saifsys([licence({ versions: [version({ file_key: 'tl_2025.pdf' })] })], { files: { 1: 'licence 2026 text' } });
  const r = await syncCompanyDocs(s);
  assert.equal(r.renewed, 1);
  assert.equal(r.added, 1);
  assert.deepEqual(s.calls.files, ['1'], 'the old file is not fetched again');
  const [old, cur] = await docs();
  assert.equal(old.id, before.id, 'the same Shelf file, now the earlier issue');
  assert.equal(readFileSync(old.path, 'utf8'), 'licence 2025 text');
  assert.equal(old.superseded_by, cur.id);
  assert.equal(cur.expires_on, '2027-01-09');
  assert.match(await chunksOf(cur.id), /licence 2026 text/);
  assert.doesNotMatch(await chunksOf(old.id), /Current issue/);
});

test('a new file saved over the live one is fetched and read again; a details change is not', async () => {
  await office();
  await syncCompanyDocs(saifsys([licence()], { files: { 1: 'first text' } }));
  const [doc] = await docs();

  const edited = saifsys([licence({ file_key: 'tl_fixed.pdf', updated_at: '2026-11-02 09:00:00' })], { files: { 1: 'fixed text' } });
  assert.equal((await syncCompanyDocs(edited)).updated, 1);
  assert.deepEqual(edited.calls.reads, ['Trade Licence 2026.pdf']);
  assert.equal(readFileSync((await docs())[0].path, 'utf8'), 'fixed text');
  assert.match(await chunksOf(doc.id), /fixed text/);
  assert.doesNotMatch(await chunksOf(doc.id), /first text/);

  // Someone in Reem corrected the expiry: a later details change in saifsys keeps it.
  await db.prepare("UPDATE documents SET expires_on = '2027-02-01', expiry_confirmed_by = (SELECT id FROM users LIMIT 1) WHERE id = ?").run(doc.id);
  const details = saifsys([licence({ file_key: 'tl_fixed.pdf', number: '999', expires_at: '2027-01-30', updated_at: '2026-11-03 09:00:00' })], { files: {} });
  assert.equal((await syncCompanyDocs(details)).updated, 1);
  assert.deepEqual(details.calls.files, [], 'no fetch');
  assert.deepEqual(details.calls.reads, [], 'no reading');
  const [after] = await docs();
  assert.equal(after.expires_on, '2027-02-01', 'the date corrected in Reem stays');
  assert.match(after.summary, /Number 999/);
  assert.match(await chunksOf(doc.id), /Number 999[\s\S]*fixed text/, 'the new details over the text already read');
});

test('two live trade licences for one company: the one that runs out last is current; Other papers are never compared', async () => {
  await office();
  const s = saifsys([
    licence({ id: 1, expires_at: '2026-01-09', file_key: 'a' }),
    licence({ id: 2, expires_at: '2027-01-09', file_key: 'b' }),
    licence({ id: 3, company_id: 2, company_name: 'Ain Al Reem Properties', expires_at: '2026-05-01', file_key: 'c' }),
    licence({ id: 4, type: 'other', title: 'Chamber', expires_at: '2026-01-01', file_key: 'd' }),
    licence({ id: 5, type: 'other', title: 'Insurance', expires_at: '2027-01-01', file_key: 'e' }),
  ], { files: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' } });
  const r = await syncCompanyDocs(s);
  assert.equal(r.superseded, 1);
  const [a, b, c, d, e] = await docs();
  assert.equal(a.superseded_by, b.id);
  assert.equal(b.superseded_by, null);
  assert.equal(c.superseded_by, null, 'another company');
  assert.equal(d.superseded_by, null);
  assert.equal(e.superseded_by, null);
  assert.equal(d.title, 'Chamber – Saif Holding LLC');

  // The later one deleted in saifsys: the earlier one is current again.
  await syncCompanyDocs(saifsys([licence({ id: 1, expires_at: '2026-01-09', file_key: 'a' })], { files: {} }));
  assert.equal((await docs())[0].superseded_by, null);
});

test('deleted in saifsys: hidden from the Shelf and the chat after a clean run, never after a failed one', async () => {
  const { boss } = await office();
  const two = [licence({ id: 1, file_key: 'a' }), licence({ id: 2, type: 'moa', expires_at: null, file_key: 'b' })];
  await syncCompanyDocs(saifsys(two, { files: { 1: 'a', 2: 'b' } }));

  // saifsys stops answering on the second page: nothing is hidden.
  await assert.rejects(syncCompanyDocs(saifsys([two[0], licence({ id: 3, file_key: 'c' })], { per: 1, failPage: true })));
  // One document fails (its new file cannot be fetched): nothing is hidden either.
  await syncCompanyDocs(saifsys([licence({ id: 1, file_key: 'new', updated_at: 'later' })], { files: {} }));
  assert.equal((await docs()).filter((d) => d.status === 'removed').length, 0);

  const r = await syncCompanyDocs(saifsys([two[0]], { files: { 1: 'a' } }));
  assert.equal(r.removed, 1);
  const [, moa] = await docs();
  assert.equal(moa.status, 'removed');
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(boss);
  assert.ok(!(await readableDocuments(user)).some((d) => d.id === moa.id), 'not on the Shelf');
});

test('a hand-uploaded licence of the same company and type that runs out earlier is marked old', async () => {
  const { boss } = await office();
  const type = await db.prepare("SELECT t.id, t.category_id FROM document_types t WHERE t.label = 'Trade Licence'").get();
  const add = (subject, expires) => db.prepare(`INSERT INTO documents (user_id, name, title, status, category_id, type_id, subject, expires_on)
    VALUES (?, 'tl.pdf', 'Trade licence', 'ready', ?, ?, ?, ?) RETURNING id`).run(boss, type.category_id, type.id, subject, expires);
  const { id: older } = await add('  saif holding   llc ', '2026-01-09');
  const { id: other } = await add('Another Company', '2025-01-01');
  const { id: later } = await add('Saif Holding LLC', '2028-01-01');
  await syncCompanyDocs(saifsys([licence()], { files: { 1: 'x' } }));
  const by = new Map((await docs()).map((d) => [d.id, d]));
  const cur = [...by.values()].find((d) => d.title === 'Trade Licence – Saif Holding LLC');
  assert.equal(by.get(older).superseded_by, cur.id);
  assert.equal(by.get(other).superseded_by, null, 'another company is left alone');
  assert.equal(by.get(later).superseded_by, null, 'one that runs out later is left alone');
});

test('internal users read company documents; external users do not', async () => {
  await office();
  await syncCompanyDocs(saifsys([licence()], { files: { 1: 'x' } }));
  const staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  const outsiderId = await makeUser('Outsider');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(outsiderId);
  const outsider = await db.prepare('SELECT * FROM users WHERE id = ?').get(outsiderId);
  outsider.ownFilesOnly = await onlyPrivateAgents(outsider);
  assert.equal(outsider.ownFilesOnly, true);

  assert.equal((await readableDocuments(staff)).length, 1);
  assert.equal((await readableDocuments(outsider)).length, 0);
  const scope = retrievalScope(staff.id);
  assert.equal((await db.prepare(`SELECT COUNT(*)::int n FROM chunks t WHERE ${scope.sql}`).get(...scope.params)).n > 0, true);
  const out = agentScope(outsider);
  assert.equal((await db.prepare(`SELECT COUNT(*)::int n FROM chunks t WHERE ${out.sql}`).get(...out.params)).n, 0);
});

test('the chat answers from the current issue: old ones stay out of recall and are marked OLD in search', async () => {
  await office();
  const staff = await db.prepare('SELECT * FROM users WHERE id = ?').get(await makeUser('Staff'));
  await syncCompanyDocs(saifsys([licence({ versions: [version()] })], { files: { 1: 'licence 2026', '1/1': 'licence 2025' } }));
  const [old, cur] = await docs();

  const scope = currentOnly(agentScope(staff));
  const ids = (await db.prepare(`SELECT DISTINCT t.document_id FROM chunks t WHERE ${scope.sql}`).all(...scope.params)).map((r) => r.document_id);
  assert.deepEqual(ids, [cur.id], 'recall reads only the current issue');

  const found = await searchFiles(staff, 'trade licence Saif Holding');
  const lines = found.split('\n').filter((l) => /^(OLD|#)/.test(l));
  assert.match(lines[0], new RegExp(`^#${cur.id} `), 'current first');
  assert.match(lines[0], /from saifsys/);
  assert.match(found, new RegExp(`OLD - replaced by #${cur.id}: #${old.id} `));
  assert.match(found, /answer from the current one/);

  const catalog = await libraryCatalog(staff);
  assert.equal(catalog.total, 1, 'the library list in the prompt leaves the old one out');
});

test('nothing happens without a master to own the files', async () => {
  await reset();
  await cats.seedCategories();
  const r = await syncCompanyDocs(saifsys([licence()]));
  assert.equal(r.skipped, 'no master account');
  assert.equal((await docs()).length, 0);
});
