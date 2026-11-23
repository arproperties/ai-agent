import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const cats = await import('../server/docCategories.js');
const { syncSaifsysDocs, SAIFSYS_TYPES } = await import('../server/saifsysDocSync.js');

test.after(() => closeDb());

const row = (over) => ({
  id: 1, employee_code: 'E00007', employee_name: 'Sohail Khan', employee_left: false, type: 'Passport', number: 'P1234567',
  issued_at: '2020-01-01', expires_at: '2030-01-01', notes: null, has_file: false, file_name: null, updated_at: '2026-01-02 06:01:46', ...over,
});
// saifsys's hr_docs door, as a fake: pages of `per`, and the files it holds.
// Files go to a folder of the test's own, and "reading" one gives its bytes as text: no AI, no real uploads.
const UPLOADS = mkdtempSync(join(tmpdir(), 'reem-hr-docs-'));
function saifsys(docs, { per = 500, files = {} } = {}) {
  const calls = { pages: 0, files: [], read: [] };
  return {
    calls,
    uploadDir: UPLOADS,
    read: async ({ buffer, name }) => { calls.read.push(name); return buffer.toString(); },
    lookup: async (module, action, { after_id = 0, limit }) => {
      assert.equal(module, 'hr_docs');
      assert.equal(action, 'documents');
      calls.pages++;
      const rest = docs.filter((d) => d.id > Number(after_id));
      const page = rest.slice(0, per);
      return { ok: true, documents: page, next_after_id: rest.length > per ? page.at(-1).id : null };
    },
    fetchFile: async (id) => {
      calls.files.push(id);
      if (!files[id]) throw Object.assign(new Error('That file could not be found.'), { status: 404 });
      return { buffer: Buffer.from(files[id]), mime: 'application/pdf' };
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
const docs = () => db.prepare(`SELECT d.*, t.label AS type FROM documents d LEFT JOIN document_types t ON t.id = d.type_id ORDER BY d.id`).all();

test('saifsys types map onto the Employee Documents types', () => {
  assert.deepEqual(SAIFSYS_TYPES, {
    Passport: 'Passport', 'National ID': 'Emirates ID', Visa: 'Residence Visa', LaborCard: 'Labour Card', Contract: 'Labour Contract',
  });
});

test('each saifsys document becomes a Shelf file filed under its employee', async () => {
  const { boss } = await office();
  const s = saifsys([row(), row({ id: 2, type: 'National ID', number: '784-1990', expires_at: '2027-02-01' }), row({ id: 3, type: 'Something odd', expires_at: null })]);
  const r = await syncSaifsysDocs(s);
  assert.deepEqual(r, { added: 3, updated: 0, superseded: 0, removed: 0, read: 0, waiting: 0 });
  const [p, eid, odd] = await docs();
  assert.equal(p.user_id, boss, 'the master\'s file');
  assert.equal(p.type, 'Passport');
  assert.equal(eid.type, 'Emirates ID');
  assert.equal(odd.type, 'Other employee document', 'an unknown kind is kept, as Other');
  assert.equal(p.employee_code, 'E00007');
  assert.equal(p.employee_name, 'Sohail Khan');
  assert.equal(p.expires_on, '2030-01-01');
  assert.ok(p.expiry_confirmed_at, 'a person typed the date in saifsys: confirmed');
  assert.equal(p.expiry_confirmed_by, null, 'by saifsys, not by anyone in Reem');
  assert.ok(p.link_confirmed_at);
  assert.equal(p.title, 'Passport – Sohail Khan');
  assert.equal(p.folder, 'HR & Employees');
  assert.equal(p.status, 'ready');
  assert.match(p.summary, /saifsys/);
  assert.match(p.summary, /P1234567/, 'the number, for whoever renews it');
  assert.equal(p.path, null, 'no file in saifsys yet');
});

test('running it again adds nothing', async () => {
  await office();
  const s = saifsys([row(), row({ id: 2 })]);
  await syncSaifsysDocs(s);
  const again = await syncSaifsysDocs(s);
  assert.deepEqual(again, { added: 0, updated: 0, superseded: 0, removed: 0, read: 0, waiting: 0 });
  assert.equal((await docs()).length, 2);
});

test('two runs at once add each document once', async () => {
  await office();
  const list = Array.from({ length: 30 }, (_, i) => row({ id: i + 1, employee_code: `E0${i}` }));
  const a = saifsys(list);
  const b = saifsys(list);
  await Promise.all([syncSaifsysDocs(a), syncSaifsysDocs(b)]);
  assert.equal((await docs()).length, 30);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM saifsys_doc_links').get()).n, 30);
});

test('every page is read', async () => {
  await office();
  const s = saifsys(Array.from({ length: 5 }, (_, i) => row({ id: i + 1, employee_code: `E0${i}` })), { per: 2 });
  const r = await syncSaifsysDocs(s);
  assert.equal(r.added, 5);
  assert.equal(s.calls.pages, 3);
});

test('the current file of a document is fetched and read, once, with saifsys\'s details on top', async () => {
  await office();
  const s = saifsys([row({ has_file: true, file_name: 'passport_1.pdf' }), row({ id: 2, type: 'Visa' })], { files: { 1: 'Nationality: India' } });
  const r = await syncSaifsysDocs(s);
  assert.equal(r.read, 1);
  assert.equal(r.waiting, 0);
  assert.deepEqual(s.calls.files, [1], 'a document with no file in saifsys is not asked for');
  const [p, visa] = await docs();
  assert.ok(p.path && existsSync(p.path));
  assert.equal(visa.path, null);
  const text = (await db.prepare('SELECT text FROM chunks WHERE document_id = ?').all(p.id)).map((c) => c.text).join(' ');
  assert.match(text, /Passport of Sohail Khan \(E00007\), from saifsys/);
  assert.match(text, /Number P1234567/);
  assert.match(text, /Nationality: India/);

  await syncSaifsysDocs(s);
  assert.deepEqual(s.calls.files, [1], 'read once: the same file is not fetched again');
});

test('a new file under the same saifsys record is read again, though updated_at did not change', async () => {
  await office();
  await syncSaifsysDocs(saifsys([row({ has_file: true, file_name: 'passport_1.pdf' })], { files: { 1: 'old scan' } }));
  const s = saifsys([row({ has_file: true, file_name: 'passport_2.pdf' })], { files: { 1: 'renewed scan' } });
  const r = await syncSaifsysDocs(s);
  assert.equal(r.updated, 0, 'saifsys did not say it changed');
  assert.equal(r.read, 1);
  const [p] = await docs();
  assert.equal(readFileSync(p.path, 'utf8'), 'renewed scan');
  const text = (await db.prepare('SELECT text FROM chunks WHERE document_id = ?').all(p.id)).map((c) => c.text).join(' ');
  assert.match(text, /renewed scan/);
  assert.doesNotMatch(text, /old scan/);
});

test('a few files a run: changed ones first, then current staff, then what runs out soonest', async () => {
  await office();
  const files = { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' };
  const list = [
    row({ id: 1, employee_code: 'E1', has_file: true, file_name: 'f1', expires_at: '2028-01-01' }),
    row({ id: 2, employee_code: 'E2', has_file: true, file_name: 'f2', expires_at: '2027-01-01' }),
    row({ id: 3, employee_code: 'E3', has_file: true, file_name: 'f3', expires_at: '2026-12-01', employee_left: true }),
    row({ id: 4, employee_code: 'E4', has_file: true, file_name: 'f4', expires_at: '2029-01-01' }),
  ];
  const first = saifsys(list, { files });
  assert.equal((await syncSaifsysDocs({ ...first, readLimit: 2 })).waiting, 2);
  assert.deepEqual(first.calls.files, [2, 1], 'current staff, soonest expiry first');

  // Document 2 gets a new file: it goes ahead of the two still waiting.
  const renewed = list.map((d) => (d.id === 2 ? { ...d, file_name: 'f2-new' } : d));
  const next = saifsys(renewed, { files });
  await syncSaifsysDocs({ ...next, readLimit: 1 });
  assert.deepEqual(next.calls.files, [2]);

  const last = saifsys(renewed, { files });
  assert.equal((await syncSaifsysDocs({ ...last, readLimit: 5 })).waiting, 0);
  assert.deepEqual(last.calls.files, [4, 3], 'someone who has left comes last');
});

test('an older issue is not read, only the current one', async () => {
  await office();
  const s = saifsys([
    row({ id: 1, has_file: true, file_name: 'old.pdf', expires_at: '2024-01-01' }),
    row({ id: 2, has_file: true, file_name: 'new.pdf', expires_at: '2034-01-01' }),
  ], { files: { 1: 'old', 2: 'new' } });
  await syncSaifsysDocs(s);
  assert.deepEqual(s.calls.files, [2]);
});

test('a document deleted in saifsys is hidden after a clean run, and comes back if saifsys lists it again', async () => {
  await office();
  await syncSaifsysDocs(saifsys([row(), row({ id: 2, type: 'Visa' })]));
  const r = await syncSaifsysDocs(saifsys([row()]));
  assert.equal(r.removed, 1);
  assert.deepEqual((await docs()).map((d) => d.status), ['ready', 'removed']);
  await syncSaifsysDocs(saifsys([row(), row({ id: 2, type: 'Visa' })]));
  assert.deepEqual((await docs()).map((d) => d.status), ['ready', 'ready']);
});

test('a run that fails, or that lists nothing or far fewer, hides nothing', async () => {
  await office();
  const many = Array.from({ length: 30 }, (_, i) => row({ id: i + 1, employee_code: `E${i + 1}` }));
  await syncSaifsysDocs(saifsys(many));
  const broken = saifsys(many, { per: 10 });
  const lookup = broken.lookup;
  broken.lookup = async (m, a, p) => { if (Number(p.after_id) > 0) throw new Error('saifsys is down'); return lookup(m, a, p); };
  await assert.rejects(syncSaifsysDocs(broken));
  assert.equal((await syncSaifsysDocs(saifsys([]))).removed, 0, 'an empty answer is not "everything was deleted"');
  assert.equal((await syncSaifsysDocs(saifsys(many.slice(0, 2)))).removed, 0, 'too many at once');
  assert.ok((await docs()).every((d) => d.status === 'ready'));
});

test('whether saifsys holds a file is kept, and follows saifsys when that changes', async () => {
  await office();
  const has = async () => (await db.prepare('SELECT saifsys_id, saifsys_has_file FROM saifsys_doc_links ORDER BY saifsys_id').all()).map((l) => l.saifsys_has_file);
  const s = saifsys([row({ has_file: true }), row({ id: 2 })], { files: { 1: 'x' } });
  await syncSaifsysDocs(s);
  assert.deepEqual(await has(), [true, false]);
  const s2 = saifsys([row({ has_file: true }), row({ id: 2, has_file: true })], { files: { 1: 'x', 2: 'y' } });
  await syncSaifsysDocs(s2);
  assert.deepEqual(await has(), [true, true], 'the file uploaded in saifsys later');
});

test('a date changed in saifsys is taken, unless someone in Reem has set it since', async () => {
  const { boss } = await office();
  const s = saifsys([row(), row({ id: 2, type: 'Visa', expires_at: '2026-11-01' })]);
  await syncSaifsysDocs(s);
  const [, visa] = await docs();
  await db.prepare('UPDATE documents SET expires_on = ?, expiry_confirmed_by = ? WHERE id = ?').run('2028-11-01', boss, visa.id);
  const s2 = saifsys([row({ expires_at: '2031-01-01', updated_at: '2026-10-24 10:00:00' }), row({ id: 2, type: 'Visa', expires_at: '2027-11-01', updated_at: '2026-10-24 10:00:00' })]);
  const r = await syncSaifsysDocs(s2);
  assert.equal(r.updated, 2);
  const [p, v] = await docs();
  assert.equal(p.expires_on, '2031-01-01');
  assert.equal(v.expires_on, '2028-11-01', 'Reem\'s own correction stands');
});

test('an older document of the same kind for the same person stops alerting', async () => {
  await office();
  const s = saifsys([
    row({ id: 1, expires_at: '2026-08-14' }),
    row({ id: 2, expires_at: '2036-08-12' }),
    row({ id: 3, type: 'Visa', expires_at: '2026-11-01' }),
    row({ id: 4, employee_code: 'E00018', employee_name: 'Sohaib', expires_at: '2025-01-01' }),
  ]);
  const r = await syncSaifsysDocs(s);
  assert.equal(r.superseded, 1);
  const [old, renewed, visa, other] = await docs();
  assert.equal(old.superseded_by, renewed.id);
  assert.equal(renewed.superseded_by, null);
  assert.equal(visa.superseded_by, null, 'another kind is not a renewal of it');
  assert.equal(other.superseded_by, null, 'another person\'s is not either');
});

test('opening a document fetches its file from saifsys there and then', async () => {
  const { boss } = await office();
  const { fileFor } = await import('../server/saifsysDocSync.js');
  const s = saifsys([row()], { files: {} });
  await syncSaifsysDocs(s);
  const [p] = await docs();
  const master = { id: boss, role: 'master' };
  await assert.rejects(fileFor(master, p.id, { fetchFile: s.fetchFile }), (e) => e.status === 404 && /saifsys has no file/.test(e.message));
  const now = saifsys([row()], { files: { 1: '%PDF arrived' } });
  const got = await fileFor(master, p.id, { fetchFile: now.fetchFile });
  assert.equal(readFileSync(got.path, 'utf8'), '%PDF arrived');
  await fileFor(master, p.id, { fetchFile: now.fetchFile });
  assert.deepEqual(now.calls.files, [1], 'kept: the second open does not ask saifsys again');
});

test('nobody fetches a file they may not read', async () => {
  await office();
  const { fileFor } = await import('../server/saifsysDocSync.js');
  const outsider = await makeUser('Outsider');
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(outsider);
  const s = saifsys([row()], { files: { 1: 'x' } });
  await syncSaifsysDocs(s);
  const [p] = await docs();
  await assert.rejects(fileFor({ id: outsider, role: 'user', external: true }, p.id, { fetchFile: s.fetchFile }), (e) => e.status === 404);
  assert.deepEqual(s.calls.files, [], 'saifsys is not even asked');
});

test('everyone inside the company reads the saifsys copies; nobody external; hand-uploaded ones stay private', async () => {
  const { boss } = await office();
  const { shelfKit } = await import('../server/shelf.js');
  const user = async (name, external = false) => {
    const id = await makeUser(name);
    if (external) await db.prepare('UPDATE users SET external = true WHERE id = ?').run(id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  };
  const staff = await user('Cleaner');
  const outsider = await user('Outsider', true);
  await syncSaifsysDocs(saifsys([row({ has_file: true, file_name: 'p.pdf' })], { files: { 1: 'Passport of Sohail Khan, nationality India' } }));
  // A passport uploaded by hand into the same category, and shared by the master before it was filed.
  const cat = await db.prepare("SELECT t.id, t.category_id FROM document_types t WHERE t.label = 'Passport'").get();
  const { id: hand } = await db.prepare(`INSERT INTO documents (user_id, name, title, status, shared, category_id, type_id)
    VALUES (?, 'r.pdf', 'Passport – Rahul Nair', 'ready', true, ?, ?) RETURNING id`).run(boss, cat.category_id, cat.id);
  await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, true)').run(boss, hand, '[Passport – Rahul Nair] nationality India');

  const search = async (u, q) => (await shelfKit(u).run({ id: 't', name: 'search_files', input: { query: q } })).content;
  const [copy] = await docs();
  assert.match(await search(staff, 'Sohail passport'), new RegExp(`#${copy.id} `), 'staff without Document Renewals find it');
  assert.match(await search(staff, 'nationality India'), new RegExp(`#${copy.id} `), 'by what is written in it too');
  assert.doesNotMatch(await search(staff, 'Rahul passport'), new RegExp(`#${hand} `), 'the hand-uploaded passport stays private');
  assert.doesNotMatch(await search(outsider, 'Sohail passport'), new RegExp(`#${copy.id} `), 'nobody external');
});

// ---------- saifsys's HR API (api/hr/v1), the other way in ----------

const hrPage = (page, pages, docs) => ({ ok: true, page, pages, limit: 100, documents: docs });
const hrDoc = (over = {}) => ({
  employee: { id: 56, code: 'E00056', name: 'Abdul Karim Jan Khan', status: 'Active', company: 'Madar' },
  id: 226, type: 'Passport', number: 'BS4951402', issued_at: '2021-12-21', expires_at: '2026-12-20', days_left: 57, notes: null,
  has_file: true, file_name: 'doc_56_1775644097.pdf', file_url: 'x', uploaded_at: '2026-04-08 10:28:17', updated_at: null, ...over,
});
// A fake fetch for the HR API and the address it sends a file on to.
function hrServer({ pages, file = null }) {
  const seen = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push({ url: String(url), key: opts.headers?.['X-HR-Key'] ?? null, redirect: opts.redirect });
    if (u.hostname === 'files.example') {
      return new Response(file, { status: file ? 200 : 404, headers: { 'Content-Type': 'application/pdf' } });
    }
    if (opts.headers?.['X-HR-Key'] !== 'k') return new Response('{"ok":false}', { status: 401 });
    if (u.searchParams.get('action') === 'documents') {
      return Response.json(pages[Number(u.searchParams.get('page') || 1) - 1]);
    }
    if (u.searchParams.get('action') === 'document_file') {
      return new Response(null, { status: 302, headers: { Location: `https://files.example/docs/${u.searchParams.get('id')}.pdf` } });
    }
    return new Response('', { status: 404 });
  };
  return { fetch, seen };
}

test('the HR API\'s pages read as saifsys documents', async () => {
  const { hrApiSource } = await import('../server/saifsysDocSync.js');
  const server = hrServer({ pages: [hrPage(1, 2, [hrDoc()]), hrPage(2, 2, [hrDoc({ id: 227, type: 'LaborCard', employee: { code: 'E00018', name: 'Sohaib', status: 'Terminated' }, has_file: false, file_name: null })])] });
  const src = hrApiSource({ base: 'http://hr.example/api/hr/v1/index.php', key: 'k', fetch: server.fetch });
  const first = await src.lookup('hr_docs', 'documents', { after_id: 0 });
  assert.deepEqual(first.documents[0], {
    id: 226, employee_code: 'E00056', employee_name: 'Abdul Karim Jan Khan', employee_left: false, type: 'Passport', number: 'BS4951402',
    issued_at: '2021-12-21', expires_at: '2026-12-20', notes: null, has_file: true, file_name: 'doc_56_1775644097.pdf', updated_at: '2026-04-08 10:28:17',
  });
  assert.equal(first.next_after_id, 1);
  const second = await src.lookup('hr_docs', 'documents', { after_id: first.next_after_id });
  assert.equal(second.documents[0].employee_left, true);
  assert.equal(second.next_after_id, null, 'the last page');
});

test('a file the HR API sends on elsewhere is fetched there, without the key', async () => {
  const { hrApiSource } = await import('../server/saifsysDocSync.js');
  const server = hrServer({ pages: [], file: '%PDF scan' });
  const src = hrApiSource({ base: 'http://hr.example/api/hr/v1/index.php', key: 'k', fetch: server.fetch });
  const f = await src.fetchFile(226);
  assert.equal(f.buffer.toString(), '%PDF scan');
  assert.equal(f.mime, 'application/pdf');
  const onward = server.seen.find((s) => s.url.startsWith('https://files.example'));
  assert.equal(onward.key, null, 'the HR key never goes to the file\'s address');
  assert.equal(server.seen[0].redirect, 'manual');
});

test('a file the HR API cannot give is an error, not an empty file', async () => {
  const { hrApiSource } = await import('../server/saifsysDocSync.js');
  const server = hrServer({ pages: [], file: null });
  const src = hrApiSource({ base: 'http://hr.example/api/hr/v1/index.php', key: 'k', fetch: server.fetch });
  await assert.rejects(src.fetchFile(226));
});

test('no master: nothing to file it under, nothing done', async () => {
  await reset();
  await cats.seedCategories();
  const s = saifsys([row()]);
  const r = await syncSaifsysDocs(s);
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 'no master account');
});

test('only the master starts a sync by hand', async () => {
  const { boss } = await office();
  const staff = await makeUser('Staff');
  const { syncNow } = await import('../server/saifsysDocSync.js');
  const s = saifsys([row()]);
  await assert.rejects(syncNow({ id: staff, role: 'user' }, s), (e) => e.status === 403);
  assert.equal((await syncNow({ id: boss, role: 'master' }, s)).added, 1);
});
