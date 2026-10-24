import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTerms } from '../server/renewalCompare.js';

const TODAY = '2026-10-24';
const detail = (salary) => ({ code: 'E00058', name: 'Adeela', salary: { basic: 800, allowance: 700, bonus: null, total: 1500, paid_by: 'WPS (Bank Transfer)', ...salary } });
const run = (over = {}) => ({ run_id: 173, period_from: '2026-08-26', period_to: '2026-09-25', payroll_type: 'wps', status: 'finalized', base_pay: 800, allowance: 700, bonus: 0, overtime: 0, net_pay: 1500, ...over });
const row = (r, field) => r.rows.find((x) => x.field === field);

test('same numbers, no flags', () => {
  const r = compareTerms(detail(), [run()], TODAY);
  assert.deepEqual(r.flags, []);
  const basic = row(r, 'basic');
  assert.deepEqual([basic.contract, basic.payroll, basic.flag], [800, 800, null]);
  assert.equal(basic.period, '2026-08-26 to 2026-09-25');
  assert.equal(basic.source, 'saifsys employee record · payroll run #173');
});

test('differs flags the component with the run\'s period', () => {
  const r = compareTerms(detail(), [run({ base_pay: 900 }), run({ run_id: 153, period_to: '2026-08-25' })], TODAY);
  const basic = row(r, 'basic');
  assert.equal(basic.flag, 'differs');
  assert.equal(basic.payroll, 900, 'the newest run');
  assert.deepEqual(r.flags, ['basic: contract 800, payroll 900 (2026-08-26 to 2026-09-25)', 'total: contract 1500, payroll 1600 (2026-08-26 to 2026-09-25)']);
  assert.equal(row(r, 'allowance').flag, null);
});

test('no payroll in 3 months is outdated', () => {
  const r = compareTerms(detail(), [run({ period_from: '2026-05-01', period_to: '2026-05-31' })], TODAY);
  assert.ok(r.rows.every((x) => x.field === 'total' || x.flag === 'outdated' || x.flag === 'missing' || x.flag === null));
  assert.equal(row(r, 'basic').flag, 'outdated');
  assert.match(r.flags.join('\n'), /No payroll since 2026-05-31/);
});

test('no payroll at all is flagged once', () => {
  const r = compareTerms(detail(), [], TODAY);
  assert.equal(row(r, 'basic').payroll, null);
  assert.equal(row(r, 'basic').flag, 'outdated');
  assert.deepEqual(r.flags, ['No payroll found for this employee']);
});

test('missing contract value is missing', () => {
  const r = compareTerms(detail({ allowance: null, total: 800 }), [run({ allowance: 0, net_pay: 800 })], TODAY);
  assert.equal(row(r, 'allowance').flag, 'missing');
  assert.match(r.flags.join('\n'), /allowance: not in the employee record/);
});

test('total that is not the sum is flagged', () => {
  const r = compareTerms(detail({ total: 1600 }), [run({ net_pay: 1500 })], TODAY);
  assert.equal(row(r, 'total').flag, 'total_mismatch');
  assert.match(r.flags.join('\n'), /total 1600 is not basic \+ allowance \+ bonus \(1500\)/);
});

test('cash vs WPS mismatch is flagged', () => {
  const r = compareTerms(detail(), [run({ payroll_type: 'cash' })], TODAY);
  const paid = row(r, 'paid_by');
  assert.deepEqual([paid.contract, paid.payroll, paid.flag], ['WPS', 'Cash', 'differs']);
});

test('no saifsys record at all: everything missing, nothing invented', () => {
  const r = compareTerms(null, [run()], TODAY);
  assert.ok(r.rows.filter((x) => x.field !== 'paid_by').every((x) => x.contract === null));
  assert.ok(r.flags.length > 0);
});
