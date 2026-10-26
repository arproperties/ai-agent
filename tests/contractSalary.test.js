import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const cats = await import('../server/docCategories.js');
const { compareWithContract } = await import('../server/renewalCompare.js');
const { contractSalary } = await import('../server/documentRenewals.js');

test.after(() => closeDb());

const record = { basic: 2000, allowance: 3000, total: 5000 };
const read = (over) => ({ basic: 2000, allowance: 3000, total: 5000, confidence: 'high', ...over });

test('the employee record beside what the contract says, flagged where they differ', () => {
  const r = compareWithContract(record, read({ allowance: 2500, total: 4500 }));
  assert.deepEqual(r.rows.map((x) => [x.field, x.company, x.contract, x.flag]), [
    ['basic', 2000, 2000, null], ['allowance', 3000, 2500, 'differs'], ['total', 5000, 4500, 'differs'],
  ]);
  assert.equal(r.flags.length, 2);
});

test('a total the contract does not print is its basic plus allowance', () => {
  assert.equal(compareWithContract(record, read({ total: null })).rows[2].contract, 5000);
});

test('what the contract does not show is missing, not a difference; an unsure read is said', () => {
  const r = compareWithContract(record, read({ allowance: null, total: null, confidence: 'low' }));
  assert.equal(r.rows[1].flag, 'missing');
  assert.match(r.flags[0], /not sure/);
});

test('the contract is read once and kept, and read again only when its file changes', async () => {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  await cats.seedCategories();
  const id = await makeDoc(boss.id, null, 'contract.pdf');
  const path = join(mkdtempSync(join(tmpdir(), 'cs-')), 'c.pdf');
  writeFileSync(path, '%PDF contract');
  await db.prepare(`UPDATE documents SET type_id = (SELECT id FROM document_types WHERE label = 'Labour Contract'),
      category_id = (SELECT category_id FROM document_types WHERE label = 'Labour Contract'),
      employee_code = 'E-0042', employee_name = 'Ahmed', expires_on = '2026-12-01', path = ?, mime = 'application/pdf', hash = 'h1' WHERE id = ?`).run(path, id);
  let reads = 0;
  const deps = {
    salary: async (code) => { assert.equal(code, 'E-0042'); return record; },
    fetch: async (user, docId) => db.prepare('SELECT * FROM documents WHERE id = ?').get(docId),
    read: async ({ mime, data }) => { reads++; assert.equal(mime, 'application/pdf'); assert.ok(data); return read({ allowance: 2800, total: 4800 }); },
  };
  const a = await contractSalary(boss, 'E-0042', deps);
  assert.equal(a.rows[1].contract, 2800);
  assert.equal(a.document.id, id);
  await contractSalary(boss, 'E-0042', deps);
  assert.equal(reads, 1, 'kept');
  await db.prepare(`UPDATE documents SET hash = 'h2' WHERE id = ?`).run(id);
  await contractSalary(boss, 'E-0042', deps);
  assert.equal(reads, 2, 'a new file is read again');
});

test('no labour contract on file is said plainly', async () => {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  await cats.seedCategories();
  await assert.rejects(contractSalary(boss, 'E-0042', { salary: async () => null }), /No labour contract/);
});

test('the company salary comes from the saifsys HR API, for that one employee', async () => {
  const { hrSalary } = await import('../server/saifsysDocSync.js');
  let seen;
  const fetch = async (url, opts) => {
    seen = { url: String(url), key: opts.headers['X-HR-Key'] };
    return new Response(JSON.stringify({ ok: true, employees: [{ code: 'E00056', basic: 1000, allowance: 1150, bonus: 0, total: 2150, payment_label: 'WPS (Bank Transfer)' }] }));
  };
  const s = await hrSalary('E00056', { base: 'http://hr.example/api/hr/v1/index.php', key: 'k', fetch });
  assert.deepEqual(s, { basic: 1000, allowance: 1150, bonus: 0, total: 2150, paid_by: 'WPS (Bank Transfer)' });
  assert.match(seen.url, /action=salaries/);
  assert.match(seen.url, /code=E00056/);
  assert.equal(seen.key, 'k');
});
