import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = ''; // nothing here may reach the real saifsys
const { setModuleAccess } = await import('../server/modules.js');
const cats = await import('../server/docCategories.js');
const rc = await import('../server/renewalCases.js');
const { renewalFeed } = await import('../server/documentRenewals.js');

test.after(() => closeDb());

async function office() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master', name: 'Boss' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const staff = { id: await makeUser('Staff'), role: 'user' };
  const outsider = { id: await makeUser('Outsider'), role: 'user' };
  const pro = await makeUser('Pro Person');
  await cats.seedCategories();
  await setModuleAccess(staff.id, ['document_renewals']);
  const doc = async (type, { code = 'E-0042', name = 'Ahmed Khan' } = {}) => {
    const id = await makeDoc(boss.id, null, `${type}.pdf`);
    await db.prepare(`UPDATE documents SET type_id = (SELECT id FROM document_types WHERE label = ?), category_id = (SELECT category_id FROM document_types WHERE label = ?),
        employee_code = ?, employee_name = ?, expires_on = '2026-12-01', expiry_confirmed_at = 1, link_confirmed_at = 1 WHERE id = ?`).run(type, type, code, name, id);
    return id;
  };
  return { boss, staff, outsider, pro, doc };
}

test('only what was sent: the email (to whom, by whom) and the hand-off to the PRO, newest first', async () => {
  const { boss, pro, doc } = await office();
  const renew = await rc.startCase(boss, await doc('Labour Contract'), 'renew');
  const end = await rc.startCase(boss, await doc('Labour Contract', { code: 'E-0077', name: 'Sara' }), 'cancel');
  await rc.pause(boss, renew.id, { reason: 'not a send' }); // not shown
  await rc.event(renew.id, boss.id, 'emailed', { to: ['ahmed@example.com'], cc: ['hr@example.com'] });
  await rc.event(end.id, boss.id, 'emailed', { to: ['sara@example.com'], cc: [] });
  await rc.event(renew.id, boss.id, 'task', { assignee_id: pro });
  const { items } = await renewalFeed(boss);
  assert.deepEqual(items.map((i) => i.title), [
    'Renewal given to the PRO Pro Person to do',
    'Termination email sent to sara@example.com',
    'Renewal email sent to ahmed@example.com (cc hr@example.com)',
  ]);
  assert.equal(items[2].by, 'Boss');
  assert.equal(items[2].employee_name, 'Ahmed Khan');
  assert.ok(items[2].at > 0);
});

test('only someone with Document Renewals sees it', async () => {
  const { staff, outsider, boss, doc } = await office();
  const c = await rc.startCase(boss, await doc('Labour Contract'), 'renew');
  await rc.event(c.id, boss.id, 'emailed', { to: ['a@example.com'] });
  assert.equal((await renewalFeed(staff)).items.length, 1, 'a module holder');
  await assert.rejects(renewalFeed(outsider), /Document Renewals/);
});
