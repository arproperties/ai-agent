import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.SAIFSYS_API_KEY = 'test-read'; // never used: saifsys is stubbed below
const L = await import('../server/leases.js');

test.after(() => closeDb());

// Leases, one place for all of Reem (server/leases.js): who may read them, the lease file with
// the earlier leases on the same unit, and the same in chat.

const FILE = {
  building: 'PARK PLACE', unit: '610', unit_type: '1br', tenant: { name: 'Mohamed Saeed', email: 't@mail.com' },
  lease: { id: 294, number: 'L-294', status: 'active', start_date: '2025-11-01', end_date: '2026-10-31', annual_rent: 36000, installments: 4,
    chiller_fee: 3500, admin_fee: 1500, parking_fee: 0, store_fee: 0, service_charge_monthly: 0, security_deposit: 2000, payment_method: 'cheque' },
  money: { as_of: '2026-11-13', outstanding: 9000, rent_outstanding: 9000, penalties: 0 },
  cheques: [{ date: '2025-11-01', amount: 9000, status: 'cleared' }, { date: '2026-02-01', amount: 9000, status: 'bounced', bounced_reason: 'Insufficient funds' }],
  ejari: { number: 'EJ-1' }, saifsys_legal: { cases: [] }, other_leases: [],
};
const SEARCH = [
  { lease_id: 294, building: 'PARK PLACE', unit: '610', start_date: '2025-11-01', end_date: '2026-10-31', tenant: 'Mohamed Saeed', status: 'active' },
  { lease_id: 120, building: 'PARK PLACE', unit: '610', start_date: '2024-11-01', end_date: '2025-10-31', tenant: 'Mohamed Saeed', status: 'renewed' },
  { lease_id: 77, building: 'PARK PLACE', unit: '6101', start_date: '2023-01-01', end_date: '2023-12-31', tenant: 'Someone', status: 'ended' },
];
let calls;
const stub = () => {
  calls = [];
  L.useForTests({
    configured: () => true,
    ask: async (module, action, params) => {
      calls.push(`${module}/${action}`);
      if (action === 'leases') return { leases: SEARCH };
      if (action === 'lease') return { lease: params.id === 294 ? FILE : { ...FILE, lease: { ...FILE.lease, id: params.id } } };
      throw new Error(`unexpected ${module}/${action}`);
    },
  });
};

test('who may read leases: the master, saifsys Real Estate, Lease renewals; never someone external or without either', async () => {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const estate = { id: await makeUser('Estate') };
  await db.prepare(`INSERT INTO saifsys_access (user_id, module) VALUES (?, 'realestate')`).run(estate.id);
  const renewals = { id: await makeUser('Renewals') };
  await db.prepare(`INSERT INTO module_access (user_id, module) VALUES (?, 'renewals')`).run(renewals.id);
  const plain = { id: await makeUser('Plain') };
  const outsider = { id: await makeUser('Outsider'), external: true };
  await db.prepare(`UPDATE users SET external = true WHERE id = ?`).run(outsider.id);
  await db.prepare(`INSERT INTO module_access (user_id, module) VALUES (?, 'renewals')`).run(outsider.id);

  assert.equal(await L.mayReadLeases(boss), true);
  assert.equal(await L.mayReadLeases(estate), true);
  assert.equal(await L.mayReadLeases(renewals), true);
  assert.equal(await L.mayReadLeases(plain), false);
  assert.equal(await L.mayReadLeases(outsider), false, 'external, whatever is ticked');
  stub();
  assert.ok(await L.leaseKit(renewals));
  assert.equal(await L.leaseKit(plain), null, 'no lease tools in their chat');
});

test('the lease file: everything saifsys gives, and the earlier leases on the same unit only', async () => {
  stub();
  const f = await L.leaseFile(294, { fresh: true });
  assert.equal(f.lease.chiller_fee, 3500);
  assert.deepEqual(f.earlier.map((e) => e.lease_id), [120], 'not itself, and not unit 6101');
  const again = calls.length;
  await L.leaseFile(294);
  assert.equal(calls.length, again, 'read again within five minutes: not fetched');
  const text = L.leaseText(f);
  assert.match(text, /AED 36,000 a year, 4 cheques/);
  assert.match(text, /chiller fee AED 3,500; admin fee AED 1,500; security deposit AED 2,000/);
  assert.match(text, /2026-02-01 AED 9,000 bounced \(Insufficient funds\)/);
  assert.match(text, /Owed as of 2026-11-13: AED 9,000/);
  assert.match(text, /Earlier leases on this unit: lease 120/);
  await assert.rejects(L.searchLeases('a'), /at least 2 characters/);
});

test('in chat: search, then the file of any lease, last year\'s too', async () => {
  stub();
  const kit = await L.leaseKit({ id: 1, role: 'master' });
  assert.deepEqual(kit.definitions.map((d) => d.name), ['lease_search', 'lease_file']);
  const found = JSON.parse((await kit.run({ id: 'a', name: 'lease_search', input: { q: 'park place 610' } })).content);
  assert.equal(found.leases.length, 3);
  const old = JSON.parse((await kit.run({ id: 'b', name: 'lease_file', input: { lease_id: 120 } })).content);
  assert.equal(old.lease.id, 120);
  const wrong = await kit.run({ id: 'c', name: 'lease_file', input: {} });
  assert.equal(wrong.is_error, true);
});
