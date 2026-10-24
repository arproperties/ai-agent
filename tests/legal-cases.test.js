import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess, userModules } = await import('../server/modules.js');
const L = await import('../server/legalCases.js');

test.after(() => closeDb());

const pushes = [];
let clock = Date.parse('2026-10-24T08:00:00Z');
L.useForTests({ push: async (ids, msg) => { pushes.push({ ids, ...msg }); }, now: () => clock });
const day = (ymd) => { clock = Date.parse(`${ymd}T08:00:00Z`); };

async function people() {
  await reset();
  pushes.length = 0;
  day('2026-10-24');
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const clerk = { id: await makeUser('Clerk'), role: 'user' };
  const lawyer = { id: await makeUser('Lawyer'), role: 'user' };
  await setModuleAccess(clerk.id, ['legal']);
  await setModuleAccess(lawyer.id, ['legal']);
  return { boss, clerk, lawyer };
}
const typeId = async (name) => (await db.prepare('SELECT id FROM legal_case_types WHERE name = ?').get(name)).id;
const pdf = (name = 'voucher.pdf') => ({ originalname: name, mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not really') });

/** Walk a case from its start up to (not through) the settlement decision. */
async function toSettlement(user, c) {
  c = await L.completeStage(user, c.id, { stage: 'initial_cooling', values: c.steps.initial_cooling });
  c = await L.completeStage(user, c.id, { stage: 'legal_notice', values: { notice_date: '2026-10-25', reference: 'LN-1' } });
  return L.completeStage(user, c.id, { stage: 'legal_cooling', values: c.steps.legal_cooling });
}

test('a case is numbered, typed, and starts in the initial cooling period from the settings', async () => {
  const { clerk } = await people();
  await assert.rejects(L.createCase(clerk, { title: 'x' }), /case type/);
  await L.saveSettings({ initial_days: 10, legal_days: 30, warn_days: 3, max_file_mb: 15, deciders: [] });
  const c = await L.createCase(clerk, { type_id: await typeId('Cheque Bounce'), party_name: 'Ali Hassan', building: 'Ayla Residence', unit: '507' });
  assert.equal(c.number, 'LC-2026-0001');
  assert.equal(c.type, 'Cheque Bounce');
  assert.equal(c.title, 'Cheque Bounce - Ali Hassan');
  assert.equal(c.stage, 'initial_cooling');
  assert.equal(c.status, 'open');
  assert.deepEqual([c.steps.initial_cooling.start, c.steps.initial_cooling.end], ['2026-10-24', '2026-11-03']);
  assert.equal(c.period, 'active');
  const second = await L.createCase(clerk, { type_id: await typeId('Damage'), title: 'Broken door' });
  assert.equal(second.number, 'LC-2026-0002');
  assert.equal(second.title, 'Broken door');
  assert.deepEqual(c.events.map((e) => e.kind).sort(), ['created', 'stage']);
});

test('a stage is completed only with its required fields, and only the stage the case is in', async () => {
  const { clerk } = await people();
  let c = await L.createCase(clerk, { type_id: await typeId('Damage') });
  c = await L.completeStage(clerk, c.id, { stage: 'initial_cooling', values: c.steps.initial_cooling });
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'legal_notice', values: { notice_date: '2026-10-25' } }), /Notice reference/);
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'initial_cooling', values: {} }), (e) => e.status === 409);
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'legal_notice', values: { notice_date: '25/10', reference: 'x' } }), /must be a date/);
  c = await L.completeStage(clerk, c.id, { stage: 'legal_notice', values: { notice_date: '2026-10-25', reference: 'LN-7' } });
  assert.equal(c.stage, 'legal_cooling');
  assert.equal(c.steps.legal_notice.reference, 'LN-7');
  assert.equal(c.steps.legal_cooling.end, '2026-11-23', 'thirty days, the default');
  assert.equal(c.periods.initial_cooling, 'completed');
});

test('settlement is a decision for the master and the deciders only; settled goes to not proceeding and closes', async () => {
  const { boss, clerk, lawyer } = await people();
  let c = await toSettlement(clerk, await L.createCase(clerk, { type_id: await typeId('Rule Violation') }));
  assert.equal(c.stage, 'settlement');
  assert.ok(pushes.some((p) => p.ids.includes(boss.id) && /Settlement decision/.test(p.body)), 'the master hears a decision is needed');
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'settlement', values: { date: '2026-11-30' }, decision: 'settled' }), (e) => e.status === 403);
  await L.saveSettings({ initial_days: 7, legal_days: 30, warn_days: 3, max_file_mb: 15, deciders: [lawyer.id] });
  await assert.rejects(L.completeStage(lawyer, c.id, { stage: 'settlement', values: { date: '2026-11-30' }, decision: 'maybe' }), /Choose/);
  c = await L.completeStage(lawyer, c.id, { stage: 'settlement', values: { date: '2026-11-30', remarks: 'Paid in full' }, decision: 'settled' });
  assert.deepEqual([c.stage, c.status], ['not_proceeding', 'settled']);
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'not_proceeding', values: {} }), /Reason/);
  c = await L.completeStage(clerk, c.id, { stage: 'not_proceeding', values: { reason: 'Settled with the tenant' } });
  assert.deepEqual([c.stage, c.status, c.outcome, c.closedBy], ['closed', 'closed', 'Settled - not proceeding', 'Clerk']);
  assert.ok(c.closedAt);
  await assert.rejects(L.completeStage(boss, c.id, { stage: 'not_proceeding', values: { reason: 'x' } }), /closed/);
});

test('no settlement: proceeding, registration, the fee voucher (uploaded), then paid', async () => {
  const { boss, clerk } = await people();
  let c = await toSettlement(clerk, await L.createCase(clerk, { type_id: await typeId('Cheque Bounce') }));
  c = await L.completeStage(boss, c.id, { stage: 'settlement', values: { date: '2026-11-30' }, decision: 'no_settlement' });
  assert.deepEqual([c.stage, c.status], ['proceeding_1', 'proceeding']);
  c = await L.completeStage(clerk, c.id, { stage: 'proceeding_1', values: { date: '2026-12-01', reference: 'RDC-55', authority: 'RDC' } });
  c = await L.completeStage(clerk, c.id, { stage: 'gov_registration', values: { number: 'G-9', date: '2026-12-02' } });
  assert.equal(c.stage, 'fee_voucher');
  const values = { number: 'FV-1', date: '2026-12-03', amount: '1,250.50' };
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'fee_voucher', values }), /Upload the fee voucher/);
  c = await L.addFile(clerk, c.id, pdf());
  assert.equal(c.files[0].doc_type, 'Fee voucher');
  assert.ok(existsSync((await db.prepare('SELECT path FROM legal_case_files').get()).path));
  c = await L.completeStage(clerk, c.id, { stage: 'fee_voucher', values });
  assert.equal(c.steps.fee_voucher.amount, 1250.5);
  assert.equal(c.stage, 'case_status');
  c = await L.completeStage(boss, c.id, { stage: 'case_status', values: { date: '2027-01-10' }, decision: 'settled' });
  assert.deepEqual([c.stage, c.status], ['paid', 'settled']);
  c = await L.completeStage(clerk, c.id, { stage: 'paid', values: { date: '2027-01-15', amount: '20000' } });
  assert.deepEqual([c.stage, c.status, c.outcome], ['closed', 'paid', 'Settled after proceedings - paid']);
});

test('dismissed: appeal, proceeding #2 and the payment voucher, then closed - every stage kept', async () => {
  const { boss, clerk } = await people();
  let c = await toSettlement(clerk, await L.createCase(clerk, { type_id: await typeId('Unauthorized Use') }));
  c = await L.completeStage(boss, c.id, { stage: 'settlement', values: { date: '2026-11-30' }, decision: 'no_settlement' });
  c = await L.completeStage(clerk, c.id, { stage: 'proceeding_1', values: { date: '2026-12-01', reference: 'RDC-1' } });
  c = await L.completeStage(clerk, c.id, { stage: 'gov_registration', values: { number: 'G-1', date: '2026-12-02' } });
  await L.addFile(clerk, c.id, pdf());
  c = await L.completeStage(clerk, c.id, { stage: 'fee_voucher', values: { number: 'FV', date: '2026-12-03', amount: 500 } });
  c = await L.completeStage(boss, c.id, { stage: 'case_status', values: { date: '2027-01-10' }, decision: 'dismissed' });
  assert.deepEqual([c.stage, c.status], ['appeal', 'dismissed']);
  c = await L.completeStage(clerk, c.id, { stage: 'appeal', values: { date: '2027-01-12', reference: 'AP-3', reason: 'New evidence' } });
  assert.deepEqual([c.stage, c.status], ['proceeding_2', 'appealed']);
  c = await L.completeStage(clerk, c.id, { stage: 'proceeding_2', values: { date: '2027-02-01', reference: 'RDC-1-A' } });
  await assert.rejects(L.completeStage(clerk, c.id, { stage: 'payment_voucher', values: { number: 'PV', date: '2027-02-10', amount: 100 } }), /payment voucher/);
  await L.addFile(clerk, c.id, pdf('pv.pdf'));
  c = await L.completeStage(clerk, c.id, { stage: 'payment_voucher', values: { number: 'PV', date: '2027-02-10', amount: 100 } });
  assert.deepEqual([c.stage, c.status, c.outcome], ['closed', 'closed', 'Closed after appeal']);
  assert.equal(c.steps.proceeding_1.reference, 'RDC-1', 'proceeding #1 is still there beside the appeal and proceeding #2');
  assert.equal(c.steps.appeal.reference, 'AP-3');
  assert.equal(c.files.length, 2, 'no document is lost as the case moves on');
});

test('changes are on the timeline with before and after; assigning tells the person', async () => {
  const { clerk, lawyer } = await people();
  let c = await L.createCase(clerk, { type_id: await typeId('Damage'), priority: 'normal', party_name: 'A' });
  await assert.rejects(L.updateCase(clerk, c.id, { assigned_to: 99999 }), /Legal cases/);
  c = await L.updateCase(clerk, c.id, { priority: 'urgent', party_name: 'B', type_id: await typeId('Complaint'), assigned_to: lawyer.id });
  assert.deepEqual([c.priority, c.party, c.type, c.assigned.id], ['urgent', 'B', 'Complaint', lawyer.id]);
  const changed = c.events.find((e) => e.title.startsWith('Details changed'));
  assert.deepEqual(changed.data.changes.party_name, { before: 'A', after: 'B' });
  assert.ok(c.events.some((e) => e.title === 'Case type changed: Damage → Complaint'));
  assert.ok(c.events.some((e) => e.kind === 'assign' && e.title === 'Assigned to Lawyer'));
  assert.ok(pushes.some((p) => p.ids.includes(lawyer.id) && /assigned to you/.test(p.body)));
  c = await L.saveStage(clerk, c.id, { start: '2026-10-24', end: '2026-10-28' });
  assert.equal(c.steps.initial_cooling.end, '2026-10-28');
  assert.deepEqual(c.events.find((e) => e.title.includes('saved')).data.changes.end, { before: '2026-10-31', after: '2026-10-28' });
  await assert.rejects(L.saveStage(clerk, c.id, { start: '2026-10-24', end: '2026-10-01' }), /before the start/);
});

test('a cooling period: active, then an alert as it nears its end, then overdue - each alert once', async () => {
  const { boss, clerk, lawyer } = await people();
  const c = await L.createCase(clerk, { type_id: await typeId('Damage'), assigned_to: lawyer.id });
  pushes.length = 0;
  assert.equal(await L.alertPeriods(), 0, 'seven days away: nothing yet');
  day('2026-10-28');
  assert.equal(await L.alertPeriods(), 1);
  assert.deepEqual(pushes[0].ids.sort(), [boss.id, lawyer.id].sort());
  assert.match(pushes[0].body, /ends in 3 days/);
  assert.equal(await L.alertPeriods(), 0, 'the same alert does not go twice');
  day('2026-11-02');
  assert.equal(await L.alertPeriods(), 1);
  assert.match(pushes.at(-1).body, /overdue/);
  const list = await L.listCases();
  assert.equal(list[0].period, 'overdue');
  assert.equal(list[0].overdue, true);
  const csv = await L.report('overdue');
  assert.match(csv, new RegExp(`${c.number},.*,Initial cooling period,2026-10-31,2,Lawyer`));
});

test('documents: the right kinds, the size limit, only stages reached, and only the master removes one', async () => {
  const { boss, clerk } = await people();
  const c = await L.createCase(clerk, { type_id: await typeId('Damage') });
  await assert.rejects(L.addFile(clerk, c.id, { originalname: 'x.exe', mimetype: 'application/x-msdownload', buffer: Buffer.from('MZ') }), /cannot be kept/);
  await assert.rejects(L.addFile(clerk, c.id, pdf(), { stage: 'appeal' }), /not reached/);
  await L.saveSettings({ initial_days: 7, legal_days: 30, warn_days: 3, max_file_mb: 1, deciders: [] });
  await assert.rejects(L.addFile(clerk, c.id, { ...pdf(), buffer: Buffer.alloc(1024 * 1024 + 1) }), /larger than 1 MB/);
  let d = await L.addFile(clerk, c.id, pdf('photo.pdf'), { stage: 'case', docType: 'Photo of the damage' });
  assert.equal(d.files[0].doc_type, 'Photo of the damage');
  assert.equal(d.files[0].by, 'Clerk');
  await assert.rejects(L.removeFile(clerk, c.id, d.files[0].id), (e) => e.status === 403);
  d = await L.removeFile(boss, c.id, d.files[0].id);
  assert.equal(d.files.length, 0);
  assert.ok(d.events.some((e) => e.title === 'Photo of the damage removed: photo.pdf'), 'taking it away stays on the timeline');
});

test('case types: the master adds, renames and retires them; a retired one is not offered', async () => {
  await people();
  const { clerk } = await people();
  let types = await L.addType('Noise');
  const noise = types.find((t) => t.name === 'Noise');
  await assert.rejects(L.addType('noise'), /already there/);
  types = await L.changeType(noise.id, { active: false });
  await assert.rejects(L.createCase(clerk, { type_id: noise.id }), /case type/);
  types = await L.addType('Noise'); // brought back
  assert.equal(types.find((t) => t.name === 'Noise').active, true);
  await L.changeType(noise.id, { name: 'Noise complaint' });
  await db.prepare(`DELETE FROM legal_case_types WHERE name = 'Noise complaint'`).run();
});

test('reports come out as CSV with the case in them', async () => {
  const { boss, clerk } = await people();
  let c = await toSettlement(clerk, await L.createCase(clerk, { type_id: await typeId('Cheque Bounce'), party_name: 'Ali, "the tenant"' }));
  c = await L.completeStage(boss, c.id, { stage: 'settlement', values: { date: '2026-11-30', remarks: 'Refused' }, decision: 'no_settlement' });
  const reg = await L.report('register');
  assert.ok(reg.startsWith('﻿Case number,Type,Title'));
  assert.ok(reg.includes('"Cheque Bounce - Ali, ""the tenant"""'), 'commas and quotes are escaped');
  assert.match(await L.report('settlement'), /LC-2026-0001,Cheque Bounce,No settlement,2026-11-30,Refused/);
  await assert.rejects(L.report('nope'), (e) => e.status === 404);
});

test('legal is a company module: ticked like any other, never for someone external', async () => {
  const { clerk } = await people();
  assert.ok((await userModules(clerk)).includes('legal'));
  const ext = { id: await makeUser('Jeff'), role: 'user' };
  await db.prepare('UPDATE users SET external = true WHERE id = ?').run(ext.id);
  await assert.rejects(setModuleAccess(ext.id, ['legal']), /external/);
});
