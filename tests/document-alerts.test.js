import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, setBuildingStaff, addDocument, addDoc, updateDoc, removeDoc } from '../server/properties.js';
import { listAlerts, runAlerts, saveSettings, getSettings } from '../server/leasingAlerts.js';

test.after(() => closeDb());

// Tower's fire insurance expires on 2027-01-08: 90 days after 2026-10-10, the day its window opens.
async function tower() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const staff = await makeUser('Staff');
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower' }, c.id);
  const u = await create('unit', { unit_no: '101' }, b.id);
  await setBuildingStaff(b.id, [staff]);
  const policy = await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2027-01-08' });
  return { master, staff, c, b, u, policy };
}
const docs = async (day, q = {}) => (await listAlerts(q, day)).filter((a) => a.rule === 'document');

test('a document is on the alerts from the day its renewal window opens until a renewed copy is filed', async () => {
  const { c, b, policy } = await tower();
  assert.deepEqual(await docs('2026-10-09'), []);
  const [open] = await docs('2026-10-10');
  assert.deepEqual([open.key, open.level, open.fires, open.title, open.detail, open.open, open.document_id],
    [`document:${policy.id}`, 'info', true, 'Fire insurance expires in 90 days', 'Tower · 01/08/2027', 'documents', policy.id]);

  const at = async (day) => { const [a] = await docs(day); return [a.level, a.fires, a.title]; };
  assert.deepEqual(await at('2026-10-11'), ['info', false, 'Fire insurance expires in 89 days']);
  assert.deepEqual(await at('2026-11-09'), ['info', true, 'Fire insurance expires in 60 days']);
  assert.deepEqual(await at('2026-12-09'), ['warn', true, 'Fire insurance expires in 30 days']);
  assert.deepEqual(await at('2027-01-01'), ['warn', true, 'Fire insurance expires in 7 days']);
  assert.deepEqual(await at('2027-01-07'), ['warn', false, 'Fire insurance expires in 1 day']);
  assert.deepEqual(await at('2027-01-08'), ['bad', true, 'Fire insurance expires today']);
  assert.deepEqual(await at('2027-01-10'), ['bad', false, 'Fire insurance has expired']);
  assert.deepEqual(await at('2027-01-15'), ['bad', true, 'Fire insurance has expired']);

  assert.equal((await docs('2026-10-10', { company_id: c.id })).length, 1);
  assert.equal((await docs('2026-10-10', { building_id: b.id + 1 })).length, 0);

  // Its own window: thirty days, so nothing until then, and that day it buzzes.
  await updateDoc(policy.id, { renew_days: 30 });
  assert.deepEqual(await docs('2026-10-10'), []);
  assert.deepEqual(await at('2026-12-09'), ['warn', true, 'Fire insurance expires in 30 days']);

  // The renewed copy closes it; taken away again, the old copy decides once more.
  const renewed = await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  assert.deepEqual(await docs('2027-01-15'), []);
  await removeDoc(renewed.id);
  assert.equal((await docs('2027-01-15'))[0].key, `document:${policy.id}`);

  // The master's rule: its days, and whether it is on at all.
  assert.deepEqual((await getSettings()).document, { on: true, days: [60, 30, 7], every: 7 });
  await assert.rejects(saveSettings({ document: { days: '' } }), /between one and eight/);
  assert.deepEqual((await saveSettings({ document: { days: '14, 45', every: 3 } })).document, { on: true, days: [45, 14], every: 3 });
  assert.deepEqual(await at('2027-01-11'), ['bad', true, 'Fire insurance has expired']);
  await saveSettings({ document: { on: false } });
  assert.deepEqual(await docs('2027-01-15'), []);
});

test("who is told about a document: the building's staff and the master, once a day, and at once when nobody has been", async () => {
  const { master, staff, c, u } = await tower();
  const byUser = (sent) => sent.sort((x, y) => x.user_id - y.user_id);
  assert.deepEqual(await runAlerts('2026-10-10', 23), [], 'nothing goes out in the quiet hours');
  const note = { title: 'Fire insurance expires in 90 days', body: 'Tower · 01/08/2027' };
  assert.deepEqual(byUser(await runAlerts('2026-10-10', 9)), [{ user_id: master, ...note }, { user_id: staff, ...note }]);
  assert.deepEqual(await runAlerts('2026-10-10', 10), [], 'the same day again sends nothing');
  assert.deepEqual(await runAlerts('2026-10-11', 9), [], 'and nothing more until one of its days');

  // Filed when already expired, or already inside the window: nobody has been told, so it goes that morning.
  // A company's document is the master's alone; a unit's goes to its building's staff too.
  await addDoc(c.id, { title: 'Trade License', expiry_date: '2026-10-25' });
  await addDocument({ unit_id: u.id, title: 'Gas certificate', expiry_date: '2026-10-01' });
  assert.deepEqual(byUser(await runAlerts('2026-10-12', 9)), [
    { user_id: master, title: 'Gas certificate has expired', body: 'Unit 101, Tower · 10/01/2026 — and 1 more' },
    { user_id: staff, title: 'Gas certificate has expired', body: 'Unit 101, Tower · 10/01/2026' },
  ]);
  assert.deepEqual(await runAlerts('2026-10-13', 9), [], 'told once, they wait for its next day');
});
