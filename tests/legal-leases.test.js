import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess } = await import('../server/modules.js');
const L = await import('../server/legalCases.js');
const X = await import('../server/legalLease.js');
const { checks } = await import('../server/legalChecks.js');

test.after(() => closeDb());

let clock = Date.parse('2026-10-28T08:00:00Z');
L.useForTests({ push: async () => {}, now: () => clock });

/** A lease file as saifsys's legal.php sends it. */
const file = (over = {}) => ({
  lease: { id: 77, number: 'L-2025-077', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', annual_rent: 80000, security_deposit: 4000, ejari_number: 'EJ-1', ...over.lease },
  building: 'Ayla Residence', unit: '507', unit_type: '1BR',
  tenant: { name: 'Ali Hassan', email: 'ali@example.com', phone: '+971500000000', ...over.tenant },
  money: { outstanding: 20000, overdue: 20000, overdue_count: 1, oldest_overdue_date: '2026-07-01', penalties: 500, open_charges: [], ...over.money },
  payments: [], cheques: over.cheques ?? [{ number: '000123', date: '2026-07-01', amount: 20000, status: 'bounced', bounced_date: '2026-07-03', bounced_reason: 'Insufficient funds' }],
  deposit: { amount: 4000, settled_at: null }, ejari: over.ejari === undefined ? { number: 'EJ-1', expiry_date: '2026-12-31' } : over.ejari,
  violations: [], move_out_notices: [], renewal: over.renewal ?? null, other_leases: [], saifsys_legal: over.saifsys_legal ?? {},
});

const asked = [];
let saifsysUp = true;
let leaseNow = file();
X.useForTests({
  configured: () => true,
  now: () => clock,
  ask: async (module, action, params) => {
    asked.push({ module, action, params });
    if (!saifsysUp) throw Object.assign(new Error('saifsys did not answer'), { status: 502 });
    if (action === 'lease') return { ok: true, lease: { ...leaseNow, lease: { ...leaseNow.lease, id: Number(params.id) } } };
    if (action === 'leases') return { ok: true, leases: [{ lease_id: 77, tenant: 'Ali Hassan', building: 'Ayla Residence', unit: '507' }] };
    if (action === 'at_risk') return { ok: true, leases: [{ lease_id: 77, tenant: 'Ali Hassan', bounced: 1 }, { lease_id: 90, tenant: 'Sara', bounced: 0, overdue: 9000 }] };
    throw new Error('unknown');
  },
  advise: async ({ facts }) => ({ summary: `read ${facts.length} chars`, position: 'fair', positionWhy: 'x', wrong: [], next: [{ step: 'Serve the notice', who: 'lawyer', by: null, why: 'y' }], options: [], missing: [], questions: [], model: 'test' }),
});

async function setup() {
  await reset();
  asked.length = 0;
  saifsysUp = true;
  leaseNow = file();
  clock = Date.parse('2026-10-28T08:00:00Z');
  const clerk = { id: await makeUser('Clerk'), role: 'user', name: 'Clerk' };
  await setModuleAccess(clerk.id, ['legal']);
  const type = (await db.prepare(`SELECT id FROM legal_case_types WHERE name = 'Cheque Bounce'`).get()).id;
  return { clerk, type };
}

test('linking a lease keeps its file, fills only the empty details, and goes on the timeline', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type, title: 'Bounced July cheque', building: 'Ayla Residence' });
  const now = await X.linkLease(clerk, c.id, 77);
  assert.equal(now.lease.leaseId, 77);
  assert.equal(now.lease.data.tenant.name, 'Ali Hassan');
  const after = await L.caseDetail(c.id);
  assert.equal(after.title, 'Bounced July cheque', 'a filled-in detail is never overwritten');
  assert.deepEqual([after.party, after.unit, after.contractRef, after.partyEmail], ['Ali Hassan', '507', 'L-2025-077', 'ali@example.com']);
  assert.ok(after.events.some((e) => /Lease linked from saifsys: L-2025-077/.test(e.title)));
  assert.ok(now.checks.some((x) => x.key === 'bounced' && x.level === 'bad'));
  assert.ok(now.checks.some((x) => x.key === 'deposit'));
});

test('when saifsys is away the last copy stays and the error is said', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  saifsysUp = false;
  clock += 2 * 60 * 60_000;
  const now = await X.insight(c.id);
  assert.match(now.lease.error, /did not answer/);
  assert.equal(now.lease.data.lease.number, 'L-2025-077');
});

test('a fresh lease is not fetched again on every open', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  const before = asked.length;
  await X.insight(c.id);
  assert.equal(asked.length, before);
  clock += 31 * 60_000;
  await X.insight(c.id);
  assert.equal(asked.length, before + 1);
});

test('unlinking takes the lease away and says so on the timeline', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  const now = await X.unlinkLease(clerk, c.id);
  assert.equal(now.lease, null);
  assert.ok(now.checks.some((x) => x.key === 'no_lease'));
  assert.ok((await L.caseDetail(c.id)).events.some((e) => /Lease unlinked/.test(e.title)));
});

test('Ask Reem keeps the advice on the case and returns it', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  const now = await X.askAdvice(clerk, c.id);
  assert.equal(now.advice.position, 'fair');
  assert.equal((await X.insight(c.id)).advice.next[0].step, 'Serve the notice');
  const facts = X.factsOf(await L.caseDetail(c.id), leaseNow, now.checks);
  assert.match(facts, /Insufficient funds/);
  assert.match(facts, /\[bad\]/);
});

test('leases at risk say which already have an open case', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  const list = await X.atRisk(30);
  assert.equal(list.find((x) => x.lease_id === 77).case.number, c.number);
  assert.equal(list.find((x) => x.lease_id === 90).case, null);
});

test('the chat kit is only for people with Legal cases, never external users', async () => {
  const { clerk } = await setup();
  assert.ok(await X.legalKit(clerk));
  const other = { id: await makeUser('Other'), role: 'user' };
  assert.equal(await X.legalKit(other), null);
  const outsider = { id: await makeUser('Outsider'), role: 'user', external: true };
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(outsider.id);
  assert.equal(await X.legalKit(outsider), null);
});

test('the chat kit reads a case by its number with the lease and the checks', async () => {
  const { clerk, type } = await setup();
  const c = await L.createCase(clerk, { type_id: type });
  await X.linkLease(clerk, c.id, 77);
  const kit = await X.legalKit(clerk);
  const out = await kit.run({ id: 't1', name: 'legal_case', input: { number: c.number.slice(-4) } });
  assert.ok(!out.is_error, out.content);
  assert.match(out.content, /Ali Hassan/);
  assert.match(out.content, /bounced cheque/);
  const listed = JSON.parse((await kit.run({ id: 't2', name: 'legal_cases', input: {} })).content);
  assert.equal(listed.cases[0].leaseLinked, true);
});

// ---------- the checks, on their own ----------

const caseOf = (over = {}) => ({ stage: 'legal_notice', stageLabel: 'Legal notice', type: 'Cheque Bounce', party: 'Ali Hassan', building: 'Ayla Residence', unit: '507', files: [], steps: {}, updatedAt: Date.parse('2026-10-27T00:00:00Z') / 1000, ...over });
const keys = (list) => list.map((x) => x.key);

test('checks: mismatched party and unit, missing Ejari, no contact, renewal running', () => {
  const list = checks(caseOf({ party: 'Omar Khalid', unit: '508' }),
    file({ ejari: null, lease: { ejari_number: '' }, tenant: { email: '', phone: '' }, renewal: 'notice_sent' }), '2026-10-28');
  for (const k of ['party_mismatch', 'unit_mismatch', 'no_ejari', 'no_contact', 'renewal_running', 'notice_missing']) assert.ok(keys(list).includes(k), k);
});

test('checks: a cheque case with no bounced cheque, and nothing owed', () => {
  const list = checks(caseOf(), file({ cheques: [], money: { outstanding: 0, overdue: 0 } }), '2026-10-28');
  assert.ok(keys(list).includes('no_bounce'));
  assert.ok(keys(list).includes('nothing_owed'));
  assert.ok(!keys(list).includes('overdue'));
});

test('checks: unit "Unit 507" matches 507, an ended lease with no move-out, saifsys legal desk', () => {
  const list = checks(caseOf({ unit: 'Unit 507' }), file({
    lease: { status: 'expired', end_date: '2026-09-30' },
    saifsys_legal: { cases: [{ number: 'LEG-9', status: 'filed' }], notices: [{ type: 'demand_payment', reference: 'N-1', issue_date: '2026-09-01', delivery_status: 'delivered' }] },
  }), '2026-10-28');
  assert.ok(!keys(list).includes('unit_mismatch'));
  for (const k of ['ended_not_out', 'saifsys_case', 'saifsys_notice']) assert.ok(keys(list).includes(k), k);
});

test('checks: a closed case has nothing to sort out, and no lease asks for one', () => {
  assert.deepEqual(checks(caseOf({ stage: 'closed' }), file(), '2026-10-28'), []);
  assert.deepEqual(keys(checks(caseOf({ files: [{ stage: 'legal_notice' }] }), null, '2026-10-28')), ['no_lease']);
});
