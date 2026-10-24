import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');
const rc = await import('../server/renewalCases.js');
const tasks = await import('../server/renewalTasks.js');

test.after(() => closeDb());

const TODAY = '2026-10-24';
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const quiet = async () => {};
const outbox = () => { const sent = []; return { sent, push: async (ids, m) => { sent.push({ ids: [...ids], ...m }); } }; };

async function approvedCase({ approve = true } = {}) {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const hr = { id: await makeUser('Hr'), role: 'user' };
  const pro = { id: await makeUser('Pro'), role: 'user' };
  const staff = { id: await makeUser('Staff'), role: 'user' };
  await cats.seedCategories();
  await setModuleAccess(hr.id, ['document_renewals']);
  await db.prepare('INSERT INTO doc_renewal_case_settings (id, pro_ids) VALUES (1, ?)').run([pro.id]);
  const t = (await db.prepare("SELECT id FROM document_types WHERE label = 'Residence Visa'").get()).id;
  const visa = await makeDoc(staff.id, null, 'visa.pdf');
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
    employee_code = 'E-0042', employee_name = 'Ahmed Khan', expires_on = ?, expiry_confirmed_at = 1, link_confirmed_at = 1 WHERE id = ?`).run(t, t, plus(20), visa);
  const other = await makeDoc(staff.id, null, 'other-visa.pdf');
  await db.prepare(`UPDATE documents SET type_id = ?, category_id = (SELECT category_id FROM document_types WHERE id = ?),
    employee_code = 'E-0077', employee_name = 'Sara', link_confirmed_at = 1 WHERE id = ?`).run(t, t, other);
  const c = await rc.startCase(hr, visa, 'renew');
  await rc.propose(hr, c.id, { mode: 'renew_document', terms: { expected_expiry: plus(750) } });
  await rc.submit(hr, c.id, { push: quiet });
  if (approve) await rc.approve(boss, c.id);
  return { boss, hr, pro, staff, c, visa, other };
}
const newTask = (by, c, pro, over = {}) => tasks.createTask(by, c.id, { assignee_id: pro.id, kind: 'visa_renewal', instructions: 'Renew at ICP', due_date: plus(7), ...over }, { push: quiet });

test('task before approval is refused', async () => {
  const { hr, pro, c } = await approvedCase({ approve: false });
  await assert.rejects(newTask(hr, c, pro), (e) => e.status === 400 && /approv/.test(e.message));
});

test('a task goes to a PRO, moves the case on and tells them without any document', async () => {
  const { hr, pro, c } = await approvedCase();
  const o = outbox();
  const t = await tasks.createTask(hr, c.id, { assignee_id: pro.id, kind: 'visa_renewal', instructions: 'Renew at ICP', due_date: plus(7) }, { push: o.push });
  assert.equal(t.status, 'open');
  assert.equal((await rc.getCase(hr, c.id)).status, 'with_pro');
  assert.deepEqual(o.sent[0].ids, [pro.id]);
  assert.equal(o.sent[0].url, `/?protask=${t.id}`);
  assert.doesNotMatch(JSON.stringify(o.sent[0]), /visa\.pdf|E-0042/, 'a link, not the papers');
  const staff = { id: await makeUser('Nobody'), role: 'user' };
  await assert.rejects(tasks.createTask(hr, c.id, { assignee_id: staff.id, kind: 'x', due_date: plus(7) }, { push: quiet }), (e) => e.status === 400, 'only a PRO from the settings');
});

test('PRO sees only their own task\'s case', async () => {
  const { hr, pro, c, visa, other } = await approvedCase();
  const t = await newTask(hr, c, pro);
  const mine = await tasks.myTasks(pro);
  assert.deepEqual(mine.map((x) => x.id), [t.id]);
  const view = await tasks.taskView(pro, t.id);
  assert.equal(view.case.employee_name, 'Ahmed Khan');
  assert.deepEqual(view.documents.map((d) => d.id), [visa], 'that employee\'s papers in the case');
  assert.ok(await tasks.taskFile(pro, t.id, visa));
  await assert.rejects(tasks.taskFile(pro, t.id, other), (e) => e.status === 404, 'not someone else\'s visa');
  await assert.rejects(rc.getCase(pro, c.id), (e) => e.status === 404, 'not the case page itself');
  const stranger = { id: await makeUser('Stranger'), role: 'user' };
  await assert.rejects(tasks.taskView(stranger, t.id), (e) => e.status === 404);
});

test('PRO loses file access when the task is done', async () => {
  const { hr, pro, c, visa } = await approvedCase();
  const t = await newTask(hr, c, pro);
  await tasks.finishTask(pro, t.id, { note: 'Submitted, new visa issued' }, { push: quiet });
  await assert.rejects(tasks.taskFile(pro, t.id, visa), (e) => e.status === 404);
  assert.equal((await rc.getCase(hr, c.id)).status, 'checking_documents', 'every task done: HR checks the papers');
});

test('the PRO uploads the issued papers onto the Shelf, linked to the case and unconfirmed', async () => {
  const { hr, pro, c } = await approvedCase();
  const t = await newTask(hr, c, pro);
  const f = { originalname: 'new-visa.pdf', mimetype: 'application/pdf', size: 9, buffer: Buffer.from('%PDF visa') };
  const d = await tasks.taskUpload(pro, t.id, f);
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(d.id);
  assert.equal(row.employee_code, 'E-0042');
  assert.equal(row.type_id, (await db.prepare('SELECT type_id FROM documents WHERE id = ?').get((await rc.getCase(hr, c.id)).document_id)).type_id);
  assert.equal(row.expiry_confirmed_at, null);
  assert.equal(row.link_confirmed_at, null);
  assert.deepEqual((await db.prepare('SELECT evidence FROM doc_renewal_case_tasks WHERE id = ?').get(t.id)).evidence.files, [d.id]);
  assert.ok((await tasks.taskView(pro, t.id)).documents.some((x) => x.id === d.id), 'the PRO sees what they uploaded');
});

test('blocked pauses the case and tells the owner', async () => {
  const { hr, pro, c } = await approvedCase();
  const t = await newTask(hr, c, pro);
  const o = outbox();
  await tasks.blockTask(pro, t.id, { reason: 'Passport expired, need it first' }, { push: o.push });
  const now = await rc.getCase(hr, c.id);
  assert.equal(now.status, 'paused');
  assert.match(now.paused_reason, /Passport expired/);
  assert.deepEqual(o.sent[0].ids, [hr.id]);
});

test('overdue task reminds the PRO, then the owner', async () => {
  const { hr, pro, c } = await approvedCase();
  const t = await newTask(hr, c, pro, { due_date: plus(-1) });
  let o = outbox();
  await tasks.remindOverdue({ today: TODAY, push: o.push });
  assert.deepEqual(o.sent.map((s) => s.ids), [[pro.id]], 'one day late: the PRO');
  o = outbox();
  await tasks.remindOverdue({ today: TODAY, push: o.push });
  assert.equal(o.sent.length, 0, 'once a day');
  o = outbox();
  await tasks.remindOverdue({ today: plus(3), push: o.push });
  assert.deepEqual(o.sent.map((s) => s.ids).sort(), [[pro.id], [hr.id]].sort(), 'four days late: the owner too');
  await tasks.finishTask(pro, t.id, {}, { push: quiet });
  o = outbox();
  await tasks.remindOverdue({ today: plus(5), push: o.push });
  assert.equal(o.sent.length, 0, 'done: no more');
});
