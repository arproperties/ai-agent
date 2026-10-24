import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
function saifsys(docs, { per = 500, files = {} } = {}) {
  const calls = { pages: 0, files: [] };
  return {
    calls,
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
  const r = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  assert.deepEqual(r, { added: 3, updated: 0, files: 0, superseded: 0 });
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
  await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  const again = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  assert.deepEqual(again, { added: 0, updated: 0, files: 0, superseded: 0 });
  assert.equal((await docs()).length, 2);
});

test('every page is read', async () => {
  await office();
  const s = saifsys(Array.from({ length: 5 }, (_, i) => row({ id: i + 1, employee_code: `E0${i}` })), { per: 2 });
  const r = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  assert.equal(r.added, 5);
  assert.equal(s.calls.pages, 3);
});

test('the file comes along when saifsys has it, and later if it arrives later', async () => {
  await office();
  const first = saifsys([row({ has_file: true, file_name: 'passport.pdf' }), row({ id: 2, type: 'Visa' })], { files: { 1: '%PDF passport' } });
  const r = await syncSaifsysDocs({ lookup: first.lookup, fetchFile: first.fetchFile });
  assert.equal(r.files, 1);
  let [p, v] = await docs();
  assert.ok(existsSync(p.path));
  assert.equal(readFileSync(p.path, 'utf8'), '%PDF passport');
  assert.equal(p.name, 'passport.pdf');
  assert.equal(p.mime, 'application/pdf');
  assert.equal(v.path, null);
  // The visa's file is uploaded in saifsys afterwards.
  const later = saifsys([row({ has_file: true, file_name: 'passport.pdf' }), row({ id: 2, type: 'Visa', has_file: true, file_name: 'visa.jpg', updated_at: '2026-10-24 09:00:00' })], { files: { 1: '%PDF passport', 2: 'visa' } });
  const r2 = await syncSaifsysDocs({ lookup: later.lookup, fetchFile: later.fetchFile });
  assert.equal(r2.files, 1);
  assert.deepEqual(later.calls.files, [2], 'a file already brought is not fetched again');
  [p, v] = await docs();
  assert.equal(readFileSync(v.path, 'utf8'), 'visa');
});

test('a file saifsys cannot give is tried again next time, without failing the rest', async () => {
  await office();
  const s = saifsys([row({ has_file: true }), row({ id: 2 })], { files: {} });
  const r = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  assert.equal(r.added, 2);
  assert.equal(r.files, 0);
  const s2 = saifsys([row({ has_file: true }), row({ id: 2 })], { files: { 1: 'ok now' } });
  assert.equal((await syncSaifsysDocs({ lookup: s2.lookup, fetchFile: s2.fetchFile })).files, 1);
});

test('a date changed in saifsys is taken, unless someone in Reem has set it since', async () => {
  const { boss } = await office();
  const s = saifsys([row(), row({ id: 2, type: 'Visa', expires_at: '2026-11-01' })]);
  await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  const [, visa] = await docs();
  await db.prepare('UPDATE documents SET expires_on = ?, expiry_confirmed_by = ? WHERE id = ?').run('2028-11-01', boss, visa.id);
  const s2 = saifsys([row({ expires_at: '2031-01-01', updated_at: '2026-10-24 10:00:00' }), row({ id: 2, type: 'Visa', expires_at: '2027-11-01', updated_at: '2026-10-24 10:00:00' })]);
  const r = await syncSaifsysDocs({ lookup: s2.lookup, fetchFile: s2.fetchFile });
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
  const r = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
  assert.equal(r.superseded, 1);
  const [old, renewed, visa, other] = await docs();
  assert.equal(old.superseded_by, renewed.id);
  assert.equal(renewed.superseded_by, null);
  assert.equal(visa.superseded_by, null, 'another kind is not a renewal of it');
  assert.equal(other.superseded_by, null, 'another person\'s is not either');
});

test('no master: nothing to file it under, nothing done', async () => {
  await reset();
  await cats.seedCategories();
  const s = saifsys([row()]);
  const r = await syncSaifsysDocs({ lookup: s.lookup, fetchFile: s.fetchFile });
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
