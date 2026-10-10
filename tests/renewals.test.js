import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, addDocument } from '../server/properties.js';
import { listAlerts } from '../server/leasingAlerts.js';
import * as R from '../server/renewals.js';

test.after(() => closeDb());

const AT = '2026-10-10';
const pdf = { buffer: Buffer.from('%PDF-1.4 policy'), originalname: 'fire-policy.pdf', mimetype: 'application/pdf' };
const DETAILS = { insurer: 'Orient Insurance', premium: 'USD 18,400', sum_insured: 'USD 12,500,000', deductible: 'USD 5,000', cover: 'Building and common areas' };

// Tower's fire insurance, with Orient, expires on 2027-01-08: inside its window on 2026-10-10.
async function tower() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower', address: '1 Main St', city: 'Austin', emirate: 'TX' }, c.id);
  const policy = await addDocument({ building_id: b.id, title: 'Fire insurance', number: 'PAR/4471', expiry_date: '2027-01-08', renew_by: 'quotes', details: DETAILS }, pdf, master);
  return { master, c, b, policy };
}
const docAlerts = async (day) => (await listAlerts({}, day)).filter((a) => a.rule === 'document');
const row = (v) => v.suppliers.map((s) => [s.name, s.email, s.email_confirmed, s.is_current, s.state]);

test('a renewal is a case on one document: its current insurer listed, suppliers found and added, closed by the renewed copy or by not renewing', async () => {
  const { master, b, policy } = await tower();
  const r = await R.startRenewal(policy.id, master);
  assert.deepEqual([r.status, r.document.title, r.document.where, r.document.details.insurer], ['open', 'Fire insurance', 'Tower', 'Orient Insurance']);
  assert.deepEqual(row(r), [['Orient Insurance', null, false, true, 'listed']], 'the insurer on the policy, its address not yet known');
  assert.equal((await R.startRenewal(policy.id, master)).id, r.id, 'started twice, it is the same case');
  await assert.rejects(R.startRenewal(999, master), /Not found/);

  // Found on the web: shown, and nothing kept until a person adds it. One already listed, and junk, are left out.
  const search = async () => `Here they are:\n${JSON.stringify([{ name: 'Chubb', website: 'https://chubb.com', email: 'quotes@chubb.com', kind: 'insurer', why: 'Insures commercial buildings in Texas' },
    { name: 'orient insurance', email: 'x@orient.com' }, { nope: 1 }])}`;
  const found = await R.findSuppliers(r.id, { search });
  assert.deepEqual(found.found.map((s) => [s.name, s.email, s.why]), [['Chubb', 'quotes@chubb.com', 'Insures commercial buildings in Texas']]);
  assert.equal((await R.listSuppliers()).length, 1, 'nothing found is kept yet');
  assert.deepEqual(await R.findSuppliers(r.id, { search: async () => { throw new Error('offline'); } }), { known: [], found: [], failed: true });

  // Added by a person: an address they give is one they have confirmed.
  const orient = r.suppliers[0];
  await assert.rejects(R.addSuppliers(r.id, [{ name: 'X', email: 'nope' }]), /valid email/);
  let v = await R.addSuppliers(r.id, [{ name: 'Chubb', email: ' Quotes@Chubb.com ', website: 'https://chubb.com', found_by: 'search' },
    { supplier_id: orient.supplier_id, email: 'renewals@orient.com' }, { name: 'Marsh' }]);
  assert.deepEqual(row(v), [['Orient Insurance', 'renewals@orient.com', true, true, 'listed'], ['Chubb', 'quotes@chubb.com', true, false, 'listed'], ['Marsh', null, false, false, 'listed']]);
  v = await R.removeSupplier(r.id, v.suppliers[2].supplier_id);
  assert.equal(v.suppliers.length, 2);
  assert.equal((await R.listSuppliers()).length, 3, 'taken off this renewal, still on the list for the next');

  // The alert says a renewal is under way, and opens it.
  const [a] = await docAlerts(AT);
  assert.deepEqual([a.renewal_id, a.detail], [r.id, 'Tower · 01/08/2027 · renewing: 0 asked, 0 quotes in']);

  // Not renewing: the case closes and the document stops asking.
  await assert.rejects(R.closeRenewal(r.id, 'maybe'), /not renewing or cancelled/);
  assert.equal((await R.closeRenewal(r.id, 'not_renewing')).status, 'not_renewing');
  assert.deepEqual(await docAlerts(AT), []);

  // Started again, it asks again, and the suppliers kept from before are offered first.
  const again = await R.startRenewal(policy.id, master);
  assert.notEqual(again.id, r.id);
  assert.equal((await docAlerts(AT)).length, 1);
  assert.deepEqual((await R.findSuppliers(again.id, { search: async () => '[]' })).known.map((s) => s.name), ['Chubb', 'Marsh']);

  // The renewed copy is filed: the case is done.
  await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  assert.equal((await R.getRenewal(again.id)).status, 'renewed');
  assert.equal((await R.listRenewals()).length, 0, 'none open');
});
