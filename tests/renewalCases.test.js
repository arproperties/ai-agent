import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');
const rc = await import('../server/renewalCases.js');

test.after(() => closeDb());

const TODAY = '2026-10-24';
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const STAFF = {
  'E-0042': { code: 'E-0042', name: 'Ahmed Khan', position: 'Clerk', location: 'Head office', status: 'Active', left: false, salary: { basic: 800, allowance: 700, bonus: null, total: 1500, paid_by: 'WPS (Bank Transfer)' } },
  'E-0500': { code: 'E-0500', name: 'Old Hand', status: 'Terminated', left: true, exit_date: '2026-09-30' },
};
// saifsys hr/employee, as the cases ask it.
const hr = async (module, action, { q }) => {
  assert.equal(`${module}/${action}`, 'hr/employee');
  return { ok: true, employee: STAFF[q] || null };
};
const down = async () => { throw Object.assign(new Error('saifsys did not answer'), { status: 502 }); };

async function office() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const hrUser = { id: await makeUser('Hr'), role: 'user' };
  const staff = { id: await makeUser('Staff'), role: 'user' };
  await cats.seedCategories();
  await setModuleAccess(hrUser.id, ['document_renewals']);
  return { boss, hrUser, staff };
}
const typeId = async (label) => (await db.prepare('SELECT id FROM document_types WHERE label = ?').get(label)).id;
async function doc(ownerId, { type = 'Labour Contract', code = 'E-0042', name = 'Ahmed Khan', expires = plus(50), confirmed = true, linked = true } = {}) {
  const id = await makeDoc(ownerId, null, `${type}.pdf`);
  const t = await typeId(type);
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
    employee_code = ?, employee_name = ?, expires_on = ?, expiry_confirmed_at = ?, link_confirmed_at = ? WHERE id = ?`)
    .run(t, t, code, name, expires, confirmed ? 1 : null, linked ? 1 : null, id);
  return id;
}
const open = () => db.prepare('SELECT * FROM renewal_cases WHERE closed_at IS NULL ORDER BY id').all();
const events = (caseId) => db.prepare('SELECT * FROM renewal_case_events WHERE case_id = ? ORDER BY id').all(caseId);

// ---------- cases from contracts (the daily scan) ----------

test('opens one case for a confirmed contract at 60 days', async () => {
  const { staff } = await office();
  const id = await doc(staff.id, { expires: plus(60) });
  await doc(staff.id, { code: 'E-0077', name: 'Sara', expires: plus(61) }); // not yet
  await doc(staff.id, { type: 'Residence Visa', expires: plus(10) }); // not a contract: alerts only
  const r = await rc.scanCases({ today: TODAY, ask: hr });
  assert.equal(r.opened, 1);
  const [c] = await open();
  assert.equal(c.document_id, id);
  assert.equal(c.employee_code, 'E-0042');
  assert.equal(c.status, 'open');
  assert.equal(c.ends_on, plus(60));
  assert.equal((await events(c.id))[0].kind, 'opened');
});

test('unconfirmed contract opens nothing', async () => {
  const { staff } = await office();
  await doc(staff.id, { confirmed: false });
  await doc(staff.id, { code: 'E-0077', linked: false });
  assert.equal((await rc.scanCases({ today: TODAY, ask: hr })).opened, 0);
});

test('does not open twice', async () => {
  const { staff } = await office();
  await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  await rc.scanCases({ today: TODAY, ask: hr });
  assert.equal((await open()).length, 1);
});

test('newer contract moves the open case', async () => {
  const { staff } = await office();
  const old = await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  const renewed = await doc(staff.id, { expires: plus(400) });
  await db.prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(renewed, old);
  const r = await rc.scanCases({ today: TODAY, ask: hr });
  assert.equal(r.moved, 1);
  const [c] = await open();
  assert.equal(c.document_id, renewed);
  assert.equal(c.ends_on, plus(400));
  assert.ok((await events(c.id)).some((e) => e.kind === 'moved'));
});

test('employee who left closes the case, and opens none', async () => {
  const { staff } = await office();
  await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  await doc(staff.id, { code: 'E-0500', name: 'Old Hand' });
  STAFF['E-0042'].left = true; STAFF['E-0042'].exit_date = '2026-10-20';
  try {
    const r = await rc.scanCases({ today: TODAY, ask: hr });
    assert.equal(r.closed, 1);
    assert.equal((await open()).length, 0);
    const c = await db.prepare('SELECT * FROM renewal_cases').get();
    assert.equal(c.closed_note, 'Left in saifsys on 2026-10-20');
  } finally { STAFF['E-0042'].left = false; delete STAFF['E-0042'].exit_date; }
});

test('saifsys error leaves cases untouched', async () => {
  const { staff } = await office();
  await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  await doc(staff.id, { code: 'E-0077', name: 'Sara' });
  const r = await rc.scanCases({ today: TODAY, ask: down });
  assert.deepEqual([r.opened, r.closed], [0, 0], 'nothing opened or closed on a guess');
  assert.equal((await open()).length, 1);
});

// ---------- the admin's Renew / Cancel on any document ----------

test('the admin starts a renewal or a cancellation on any document', async () => {
  const { hrUser, staff } = await office();
  const visa = await doc(staff.id, { type: 'Residence Visa', expires: plus(200) });
  const c = await rc.startCase(hrUser, visa, 'renew');
  assert.equal(c.status, 'renew_review');
  assert.equal(c.kind, 'renew');
  assert.equal(c.owner_id, hrUser.id);
  const ev = await events(c.id);
  assert.deepEqual(ev.map((e) => [e.kind, e.user_id]), [['opened', hrUser.id], ['decision', hrUser.id]]);
  await assert.rejects(rc.startCase(hrUser, visa, 'cancel'), (e) => e.status === 409, 'one open case per document');
  const eid = await doc(staff.id, { type: 'Emirates ID', expires: plus(200) });
  assert.equal((await rc.startCase(hrUser, eid, 'cancel')).status, 'cancel_review');
});

test('only the master and module holders start a case, on a file they can see', async () => {
  const { staff } = await office();
  const visa = await doc(staff.id, { type: 'Residence Visa' });
  await assert.rejects(rc.startCase(staff, visa, 'renew'), (e) => e.status === 403, 'the uploader without the module');
  const personal = await makeDoc(staff.id, null, 'notes.pdf');
  const { boss } = { boss: { id: (await db.prepare("SELECT id FROM users WHERE role = 'master'").get()).id, role: 'master' } };
  await assert.rejects(rc.startCase(boss, personal, 'renew'), (e) => e.status === 400, 'a personal file has nothing to renew here');
  await assert.rejects(rc.startCase(boss, visa, 'shred'), (e) => e.status === 400);
});

test('a decision on an open case is recorded with who made it', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  const [c] = await open();
  await rc.decide(hrUser, c.id, { choice: 'needs_review', note: 'Waiting for the manager' });
  let now = await rc.getCase(hrUser, c.id);
  assert.equal(now.status, 'needs_review');
  await rc.decide(hrUser, c.id, { choice: 'cancel', note: 'Not renewing' });
  now = await rc.getCase(hrUser, c.id);
  assert.equal(now.status, 'cancel_review');
  assert.equal(now.kind, 'cancel');
  const d = (await events(c.id)).filter((e) => e.kind === 'decision');
  assert.deepEqual(d.map((e) => [e.user_id, e.detail.choice]), [[hrUser.id, 'needs_review'], [hrUser.id, 'cancel']]);
  await assert.rejects(rc.decide(hrUser, c.id, { choice: 'approve' }), (e) => e.status === 400);
});

test('pause and resume keep where the case was', async () => {
  const { hrUser, staff } = await office();
  const visa = await doc(staff.id, { type: 'Residence Visa' });
  const c = await rc.startCase(hrUser, visa, 'renew');
  await rc.pause(hrUser, c.id, { reason: 'Passport with the embassy' });
  let now = await rc.getCase(hrUser, c.id);
  assert.equal(now.status, 'paused');
  assert.equal(now.paused_reason, 'Passport with the embassy');
  await rc.resume(hrUser, c.id);
  now = await rc.getCase(hrUser, c.id);
  assert.equal(now.status, 'renew_review');
  assert.equal(now.paused_reason, null);
});

test('out of scope closes the case with the reason', async () => {
  const { hrUser, staff } = await office();
  await doc(staff.id);
  await rc.scanCases({ today: TODAY, ask: hr });
  const [c] = await open();
  await rc.outOfScope(hrUser, c.id, { reason: 'Contractor, not staff' });
  const now = await rc.getCase(hrUser, c.id);
  assert.ok(now.closed_at);
  assert.equal(now.closed_note, 'Out of scope: Contractor, not staff');
  assert.equal((await rc.scanCases({ today: TODAY, ask: hr })).opened, 0, 'the scan does not reopen it');
});

test('someone without the module sees no case', async () => {
  const { hrUser, staff } = await office();
  const visa = await doc(staff.id, { type: 'Residence Visa' });
  const c = await rc.startCase(hrUser, visa, 'renew');
  await assert.rejects(rc.getCase(staff, c.id), (e) => e.status === 404);
  assert.deepEqual(await rc.listCases(staff), []);
  assert.equal((await rc.listCases(hrUser)).length, 1);
});
