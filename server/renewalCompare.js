// A renewal's terms against what payroll actually paid, component by component: the
// employee's record in saifsys (basic, allowance, bonus, total, WPS or cash) beside the newest
// finalized payroll run. Each row says where both values came from and for which period, and
// is flagged when they differ, one is missing, the payroll is old, or the record's total is not
// its own sum. Reem flags; HR decides. Pure: no I/O.

const OUTDATED_DAYS = 90;
const DAY = 86400000;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const paidBy = (s) => (s == null ? null : /wps/i.test(s) ? 'WPS' : /cash/i.test(s) ? 'Cash' : String(s));

export function compareTerms(detail, payrollItems = [], today) {
  const s = detail?.salary || {};
  const latest = [...payrollItems].sort((a, b) => String(b.period_to).localeCompare(String(a.period_to)))[0] || null;
  const age = latest ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest.period_to}T00:00:00Z`)) / DAY : Infinity;
  const old = age > OUTDATED_DAYS;
  const period = latest ? `${latest.period_from} to ${latest.period_to}` : null;
  const source = `saifsys employee record${latest ? ` · payroll run #${latest.run_id}` : ''}`;

  const contract = { basic: num(s.basic), allowance: num(s.allowance), bonus: num(s.bonus) ?? (detail ? 0 : null) };
  const sum = contract.basic === null ? null : contract.basic + (contract.allowance ?? 0) + (contract.bonus ?? 0);
  const paid = latest && {
    basic: num(latest.base_pay), allowance: num(latest.allowance), bonus: num(latest.bonus) ?? 0,
  };
  const flags = [];
  const rows = [];

  for (const field of ['basic', 'allowance', 'bonus']) {
    const c = contract[field];
    const p = paid ? paid[field] : null;
    let flag = null;
    if (c === null) { flag = 'missing'; flags.push(`${field}: not in the employee record`); }
    else if (!latest || old) flag = 'outdated';
    else if (p !== c) { flag = 'differs'; flags.push(`${field}: contract ${c}, payroll ${p} (${period})`); }
    rows.push({ field, contract: c, payroll: p, period, source, flag });
  }

  const total = num(s.total);
  const paidTotal = paid ? paid.basic + paid.allowance + paid.bonus : null;
  let totalFlag = null;
  if (total === null) { totalFlag = 'missing'; flags.push('total: not in the employee record'); }
  else if (sum !== null && total !== sum) { totalFlag = 'total_mismatch'; flags.push(`total ${total} is not basic + allowance + bonus (${sum})`); }
  else if (!latest || old) totalFlag = 'outdated';
  else if (paidTotal !== total) { totalFlag = 'differs'; flags.push(`total: contract ${total}, payroll ${paidTotal} (${period})`); }
  rows.push({ field: 'total', contract: total, payroll: paidTotal, period, source, flag: totalFlag });

  const cWay = paidBy(s.paid_by);
  const pWay = latest ? paidBy(latest.payroll_type) : null;
  let wayFlag = null;
  if (cWay === null) wayFlag = 'missing';
  else if (!latest || old) wayFlag = 'outdated';
  else if (cWay !== pWay) { wayFlag = 'differs'; flags.push(`paid by: contract ${cWay}, payroll ${pWay} (${period})`); }
  rows.push({ field: 'paid_by', contract: cWay, payroll: pWay, period, source, flag: wayFlag });

  if (!latest) flags.push('No payroll found for this employee');
  else if (old) flags.push(`No payroll since ${latest.period_to}: the payroll values may be out of date`);
  if (!detail) flags.unshift('saifsys has no record for this employee');
  return { rows, flags };
}
