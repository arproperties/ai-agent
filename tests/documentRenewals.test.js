import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess, needsModule } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');
const { docState, overview, employeeData, subjectData, unlinkedData } = await import('../server/documentRenewals.js');

test.after(() => closeDb());

const TODAY = '2026-10-24';
const ROSTER = [
  { id: 11, code: 'E-0042', name: 'Ahmed Khan', nickname: 'Ahmed', position: 'Clerk', company: 'AAR', department: 'Admin', status: 'active' },
  { id: 12, code: 'E-0077', name: 'Sara Lopez', nickname: '', position: 'Accountant', company: 'AAR', department: 'Finance', status: 'active' },
  { id: 13, code: 'E-0101', name: 'Ravi Nair', nickname: '', position: 'Driver', company: 'SHG', department: 'Ops', status: 'active' },
];
// saifsys hr/employees and hr/employee, as the screen asks them.
const hr = async (module, action, params) => {
  assert.equal(module, 'hr');
  if (action === 'employees') return { ok: true, employees: ROSTER };
  if (action === 'employee') return { ok: true, employee: ROSTER.find((e) => e.code === params.q) || null };
  throw new Error(`unexpected ${action}`);
};
const down = async () => { throw Object.assign(new Error('saifsys did not answer'), { status: 502 }); };

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
async function office() {
  await reset();
  const bossId = await makeUser('Boss');
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(bossId);
  const hrId = await makeUser('Hr');
  const staffId = await makeUser('Staff');
  await cats.seedCategories();
  await setModuleAccess(hrId, ['document_renewals']);
  return { boss: await userRow(bossId), hrUser: await userRow(hrId), staff: await userRow(staffId) };
}
const typeId = async (label) => (await db.prepare('SELECT id FROM document_types WHERE label = ?').get(label)).id;
async function doc(ownerId, type, { code = null, name = null, subject = null, expires = null, confirmed = true, linked = true, title = type } = {}) {
  const id = await makeDoc(ownerId, null, `${title}.pdf`);
  const t = await typeId(type);
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
      employee_code = ?, employee_name = ?, subject = ?, expires_on = ?,
      expiry_confirmed_at = ?, link_confirmed_at = ? WHERE id = ?`)
    .run(t, t, code, name, subject, expires, confirmed && expires ? 1 : null, linked && (code || subject) ? 1 : null, id);
  return id;
}

// ---------- the state of one document ----------

test('a document\'s state counts the days to its expiry', () => {
  const at = (expires_on, more = {}) => docState({ expires_on, expiry_confirmed_at: 1, link_confirmed_at: 1, employee_code: 'E', ...more }, TODAY);
  assert.equal(at('2026-10-20').step, 'expired');
  assert.equal(at('2026-10-20').days, -4);
  assert.equal(at('2026-10-24').step, 'd14', 'expires today: not yet expired');
  assert.equal(at('2026-11-07').step, 'd14');
  assert.equal(at('2026-11-08').step, 'd30');
  assert.equal(at('2026-12-23').step, 'd60');
  assert.equal(at('2026-12-24').step, 'later');
  assert.equal(at(null).step, 'no_date');
  assert.equal(at('2026-10-20', { not_renewing_at: 5 }).step, 'not_renewing', 'nobody will renew it: not an alert');
});

test('what a person still has to confirm is flagged', () => {
  const s = docState({ expires_on: '2027-01-01', expiry_confirmed_at: null, employee_code: 'E-0042', link_confirmed_at: null }, TODAY);
  assert.deepEqual(s.confirm, ['expiry', 'link']);
  assert.deepEqual(docState({ expires_on: null, employee_code: null, subject: null }, TODAY).confirm, [], 'nothing to confirm yet');
});

// ---------- the list ----------

test('the module is required', async () => {
  const { boss, hrUser, staff } = await office();
  const knock = (user) => new Promise((done) => {
    needsModule('document_renewals')({ user }, { status: (code) => ({ json: () => done(code) }) }, () => done('in'));
  });
  assert.equal(await knock(staff), 403);
  assert.equal(await knock(hrUser), 'in');
  assert.equal(await knock(boss), 'in');
});

test('every current employee is listed, with their documents and the worst of them', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id, 'Passport', { code: 'E-0042', name: 'Ahmed Khan', expires: '2029-01-01' });
  await doc(staff.id, 'Residence Visa', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-01' });
  await doc(staff.id, 'Passport', { code: 'E-0077', name: 'Sara Lopez', expires: '2026-10-01' });
  const o = await overview(hrUser, { lookup: hr, today: TODAY });
  assert.equal(o.saifsys, true);
  assert.deepEqual(o.employees.map((e) => e.name), ['Sara Lopez', 'Ahmed Khan', 'Ravi Nair'], 'the most urgent first, then by name');
  const ahmed = o.employees.find((e) => e.code === 'E-0042');
  assert.equal(ahmed.documents, 2);
  assert.equal(ahmed.worst, 'd14');
  assert.equal(ahmed.position, 'Clerk');
  assert.equal(o.employees.find((e) => e.code === 'E-0101').documents, 0, 'no documents yet: still listed, so HR sees who is missing papers');
  assert.equal(o.employees.find((e) => e.code === 'E-0077').worst, 'expired');
});

test('the alerts on top count what needs someone', async () => {
  const { hrUser, staff, boss } = await office();
  await doc(staff.id, 'Passport', { code: 'E-0077', name: 'Sara Lopez', expires: '2026-10-01' }); // expired
  await doc(staff.id, 'Residence Visa', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-01' }); // 14
  await doc(staff.id, 'Emirates ID', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-20', confirmed: false }); // 30, unconfirmed
  await doc(boss.id, 'Trade Licence', { subject: 'Ain Al Reem LLC', expires: '2026-12-20' }); // 60
  await doc(staff.id, 'Labour Contract', { expires: '2027-05-01' }); // nobody's: unlinked
  await doc(staff.id, 'Health Card', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-09-01', title: 'Old health card' });
  await db.prepare('UPDATE documents SET not_renewing_at = 1 WHERE name = ?').run('Old health card.pdf');
  const { alerts } = await overview(hrUser, { lookup: hr, today: TODAY });
  assert.deepEqual(alerts, { expired: 1, d14: 1, d30: 1, d60: 1, confirm: 1, unlinked: 1 });
});

test('each person carries their own counts, so a tap on an alert can filter the list', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id, 'Residence Visa', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-01' });
  await doc(staff.id, 'Emirates ID', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-02', confirmed: false });
  const ahmed = (await overview(hrUser, { lookup: hr, today: TODAY })).employees.find((e) => e.code === 'E-0042');
  assert.deepEqual(ahmed.steps, { d14: 2 });
  assert.equal(ahmed.confirm, 1);
});

test('the files nobody is linked to are listed on their own', async () => {
  const { hrUser, staff } = await office();
  const loose = await doc(staff.id, 'Labour Contract', { expires: '2027-05-01' });
  await doc(staff.id, 'Passport', { code: 'E-0042', name: 'Ahmed Khan', expires: '2029-01-01' });
  const d = await unlinkedData(hrUser, { today: TODAY });
  assert.deepEqual(d.documents.map((x) => x.id), [loose]);
});

test('a renewed document stops counting', async () => {
  const { hrUser, staff } = await office();
  const old = await doc(staff.id, 'Passport', { code: 'E-0077', name: 'Sara Lopez', expires: '2026-10-01' });
  const renewed = await doc(staff.id, 'Passport', { code: 'E-0077', name: 'Sara Lopez', expires: '2036-10-01' });
  await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(renewed, old);
  const o = await overview(hrUser, { lookup: hr, today: TODAY });
  assert.equal(o.alerts.expired, 0);
  assert.equal(o.employees.find((e) => e.code === 'E-0077').documents, 1);
});

test('company documents are grouped by what they are for', async () => {
  const { boss, hrUser } = await office();
  await doc(boss.id, 'Trade Licence', { subject: 'Ain Al Reem LLC', expires: '2026-12-20' });
  await doc(boss.id, 'Insurance Policy', { subject: 'Ain Al Reem LLC', expires: '2027-06-01' });
  await doc(boss.id, 'Vehicle Registration (Mulkiya)', { subject: 'Dubai A 12345', expires: '2026-10-10' });
  const o = await overview(hrUser, { lookup: hr, today: TODAY });
  assert.deepEqual(o.subjects.map((s) => [s.name, s.documents, s.worst]), [['Dubai A 12345', 1, 'expired'], ['Ain Al Reem LLC', 2, 'd60']]);
});

test('saifsys down still lists the employees who have documents', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id, 'Passport', { code: 'E-0042', name: 'Ahmed Khan', expires: '2029-01-01' });
  const o = await overview(hrUser, { lookup: down, today: TODAY });
  assert.equal(o.saifsys, false);
  assert.deepEqual(o.employees.map((e) => [e.code, e.name]), [['E-0042', 'Ahmed Khan']]);
});

test('someone who has left but still has documents is listed, marked as not current', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id, 'Residence Visa', { code: 'E-0500', name: 'Old Hand', expires: '2026-11-01' });
  const o = await overview(hrUser, { lookup: hr, today: TODAY });
  const old = o.employees.find((e) => e.code === 'E-0500');
  assert.equal(old.name, 'Old Hand');
  assert.equal(old.current, false);
  assert.equal(o.employees.find((e) => e.code === 'E-0042').current, true);
});

// ---------- one employee ----------

test('an employee\'s data: saifsys profile and their documents, soonest first', async () => {
  const { hrUser, staff } = await office();
  const passport = await doc(staff.id, 'Passport', { code: 'E-0042', name: 'Ahmed Khan', expires: '2029-01-01' });
  const visa = await doc(staff.id, 'Residence Visa', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-11-01', confirmed: false });
  await doc(staff.id, 'Passport', { code: 'E-0077', name: 'Sara Lopez', expires: '2026-10-01' });
  const d = await employeeData(hrUser, 'E-0042', { lookup: hr, today: TODAY });
  assert.equal(d.employee.name, 'Ahmed Khan');
  assert.equal(d.employee.position, 'Clerk');
  assert.deepEqual(d.documents.map((x) => x.id), [visa, passport]);
  const v = d.documents[0];
  assert.equal(v.type, 'Residence Visa');
  assert.equal(v.category, 'Employee Documents');
  assert.equal(v.state.step, 'd14');
  assert.deepEqual(v.state.confirm, ['expiry']);
  assert.equal(v.path, undefined, 'never the file\'s place on disk');
});

test('an employee saifsys does not know is still shown from their documents', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id, 'Passport', { code: 'E-0500', name: 'Old Hand', expires: '2029-01-01' });
  const d = await employeeData(hrUser, 'E-0500', { lookup: hr, today: TODAY });
  assert.equal(d.employee.name, 'Old Hand');
  assert.equal(d.employee.current, false);
  assert.equal(d.documents.length, 1);
});

test('a company subject\'s documents', async () => {
  const { boss, hrUser } = await office();
  const tl = await doc(boss.id, 'Trade Licence', { subject: 'Ain Al Reem LLC', expires: '2026-12-20' });
  await doc(boss.id, 'Trade Licence', { subject: 'Other Co', expires: '2026-12-20' });
  const d = await subjectData(hrUser, 'Ain Al Reem LLC', { today: TODAY });
  assert.deepEqual(d.documents.map((x) => x.id), [tl]);
});

test('only files the person may read are counted', async () => {
  const { staff } = await office();
  // Staff holds no module and owns no categorised files: an empty book, not someone else's.
  await doc((await makeUser('Other')), 'Passport', { code: 'E-0042', name: 'Ahmed Khan', expires: '2026-10-01' });
  const o = await overview(staff, { lookup: hr, today: TODAY });
  assert.equal(o.alerts.expired, 0);
});
