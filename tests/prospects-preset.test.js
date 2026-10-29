import test from 'node:test';
import assert from 'node:assert/strict';
import { leasePreset } from '../client/src/lib/prospects.js';

test('Make lease starts the lease form from everything the prospect has', () => {
  assert.deepEqual(leasePreset({ id: 7, full_name: 'Sara', phone: '(409) 555-0101', email: 'sara@example.com', company_id: 1, building_id: 2, unit_id: 3,
    move_in_date: '2026-12-01', source: 'Zillow', status: 'applied', notes: 'Has a cat' }), {
    prospect_id: 7, company_id: '1', building_id: '2', unit_id: 3, start_date: '2026-12-01', source: 'Zillow',
    tenant: { full_name: 'Sara', phone: '(409) 555-0101', email: 'sara@example.com' },
  });
});

test('a prospect who wants no unit in particular still fills in who they are', () => {
  assert.deepEqual(leasePreset({ id: 8, full_name: 'Omar', phone: null, email: 'omar@example.com', company_id: null, building_id: null, unit_id: null, move_in_date: null, source: null }), {
    prospect_id: 8, company_id: '', building_id: '', unit_id: '', start_date: '', source: '',
    tenant: { full_name: 'Omar', phone: '', email: 'omar@example.com' },
  });
});
