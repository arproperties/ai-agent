// What needs attention on a legal case, from the case itself and the lease file saifsys
// gave for it (server/legalLease.js). Plain rules, no AI: each is a fact the lawyer can
// check in saifsys, so a wrong answer here is a wrong row there, never a guess.
//
// Each check: { key, level, text }. level is bad (stops or weakens the case), warn (to sort
// out before the next step) or info (worth knowing for the decision). The words say what is
// true and what to do about it; nothing here says what the law is.

const aed = (n) => `AED ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 1));
const sameish = (a, b) => { const x = words(a); return [...words(b)].some((w) => x.has(w)); };
const unitKey = (u) => String(u || '').toLowerCase().replace(/^(unit|flat|apt|shop|office)\s*/i, '').replace(/[^a-z0-9]/g, '');

const BOUNCED = ['bounced', 'legal_escalated'];
const OPEN_SAIFSYS_CASE = ['draft', 'open', 'notice_sent', 'filed', 'in_hearing', 'judgment', 'execution'];

/**
 * c: the case as caseDetail() gives it (steps, stage, files, updatedAt...).
 * lease: the lease file, or null when none is linked. on: today in Dubai, YYYY-MM-DD.
 */
export function checks(c, lease, on) {
  const out = [];
  const add = (key, level, text) => out.push({ key, level, text });
  const open = c.stage !== 'closed';

  // ---- the case's own flow ----
  if (open && c.overdue && c.due) add('period_overdue', 'bad', `${c.stageLabel} ended ${plural(days(c.due, on), 'day')} ago (${c.due}). Move the case on, or note why it waits.`);
  if (open && c.stage === 'legal_notice' && c.files && !c.files.some((f) => f.stage === 'legal_notice')) {
    add('notice_missing', 'warn', 'No legal notice is on the case yet. Upload the notice as served, with proof of delivery.');
  }
  if (open && c.updatedAt) {
    const idle = days(new Date(c.updatedAt * 1000).toISOString().slice(0, 10), on);
    if (idle >= 14) add('idle', 'warn', `Nothing has changed on this case for ${idle} days.`);
  }
  if (!open) return out;

  if (!lease) {
    add('no_lease', 'info', 'No lease is linked. Link the lease from saifsys so Reem can check rent, cheques and Ejari.');
    return out;
  }

  const L = lease.lease || {};
  const t = lease.tenant || {};
  const m = lease.money || {};

  // ---- the case against the lease: are we talking about the same tenancy? ----
  if (c.party && t.name && !sameish(c.party, t.name)) add('party_mismatch', 'warn', `The case names "${c.party}" but the lease tenant is "${t.name}". Check who the case is against.`);
  if (c.unit && lease.unit && unitKey(c.unit) !== unitKey(lease.unit)) add('unit_mismatch', 'warn', `The case says unit ${c.unit} but the lease is for unit ${lease.unit}.`);
  if (c.building && lease.building && !sameish(c.building, lease.building)) add('building_mismatch', 'warn', `The case says ${c.building} but the lease is in ${lease.building}.`);

  // ---- money ----
  const bounced = (lease.cheques || []).filter((q) => BOUNCED.includes(q.status));
  if (bounced.length) {
    const sum = bounced.reduce((s, q) => s + Number(q.amount || 0), 0);
    add('bounced', 'bad', `${plural(bounced.length, 'bounced cheque')} in saifsys, ${aed(sum)}: ${bounced.map((q) => `#${q.number || '?'} of ${q.date || '?'}${q.bounced_date ? `, bounced ${q.bounced_date}` : ''}`).join('; ')}. Keep the bank's return memo for each.`);
  } else if (/cheque/i.test(c.type || '')) {
    add('no_bounce', 'warn', 'This is a cheque bounce case, but saifsys shows no bounced cheque on this lease. Check the cheque is recorded as bounced in saifsys.');
  }
  if (Number(m.overdue) > 0) {
    const since = m.oldest_overdue_date;
    add('overdue', Number(m.overdue) >= Number(L.annual_rent || Infinity) / 4 || (since && days(since, on) >= 60) ? 'bad' : 'warn',
      `${aed(m.overdue)} rent overdue${since ? ` since ${since} (${days(since, on)} days)` : ''}${m.overdue_count ? `, ${plural(m.overdue_count, 'payment')}` : ''}.`);
  }
  if (Number(m.penalties) > 0) add('penalties', 'info', `${aed(m.penalties)} of penalties charged in saifsys on this lease.`);
  if (!(Number(m.outstanding) > 0) && !(Number(m.overdue) > 0) && !bounced.length && /cheque|rent|payment|recovery/i.test(c.type || '')) {
    add('nothing_owed', 'warn', 'saifsys shows nothing owed on this lease now. Check whether it was paid, and if so settle or close the case.');
  }
  const deposit = Number(lease.deposit?.amount ?? L.security_deposit ?? 0);
  if (deposit > 0 && Number(m.outstanding) > 0 && !lease.deposit?.settled_at) {
    add('deposit', 'info', `A security deposit of ${aed(deposit)} is held. It could cover ${aed(Math.min(deposit, Number(m.outstanding)))} of the ${aed(m.outstanding)} owed.`);
  }

  // ---- papers a filing needs ----
  const ej = lease.ejari || {};
  const ejNumber = ej.number || L.ejari_number;
  if (!ejNumber) add('no_ejari', 'bad', 'No Ejari registration is recorded in saifsys for this lease. A rental dispute filing asks for it: register it or find the certificate first.');
  else if (ej.expiry_date && ej.expiry_date < on && L.status === 'active') add('ejari_expired', 'warn', `The Ejari (${ejNumber}) expired on ${ej.expiry_date} while the lease is still active.`);
  if (!t.email && !t.phone) add('no_contact', 'warn', 'saifsys has no email or phone for the tenant. A notice will need another way to reach them (registered post, courier, notary).');
  else if (!t.email) add('no_email', 'info', 'saifsys has no email for the tenant: a notice by email is not possible.');

  // ---- the tenancy's state ----
  if (['expired', 'terminated'].includes(L.status) && !L.move_out_date) {
    add('ended_not_out', 'warn', `The lease is ${L.status} (ended ${L.end_date || '?'}) but no move-out is recorded. Confirm whether the tenant is still in the unit.`);
  } else if (L.status === 'active' && L.end_date) {
    const left = days(on, L.end_date);
    if (left >= 0 && left <= 90) add('ending_soon', 'info', `The lease ends on ${L.end_date}, in ${left} days. Its end may be quicker than a case.`);
  }
  if (lease.renewal) add('renewal_running', 'warn', `A renewal is open in saifsys for this lease (${lease.renewal}). Decide whether to stop it before taking action.`);
  const moveOut = (lease.move_out_notices || []).find((n) => n.status !== 'cancelled');
  if (moveOut) add('move_out', 'info', `A ${moveOut.type || ''} move-out notice is recorded: given ${moveOut.notice_date}, leaving ${moveOut.move_out_date}.`.replace('A  ', 'A '));
  const issues = (lease.violations || []).filter((v) => !['resolved', 'closed'].includes(v.status));
  if (issues.length) add('violations', 'info', `${plural(issues.length, 'open violation or complaint', 'open violations or complaints')} on record: ${issues.slice(0, 3).map((v) => v.title).join('; ')}.`);

  // ---- what saifsys's own legal desk already has ----
  const sl = lease.saifsys_legal || {};
  const theirs = (sl.cases || []).filter((x) => OPEN_SAIFSYS_CASE.includes(x.status));
  if (theirs.length) add('saifsys_case', 'warn', `saifsys's legal desk also has ${theirs.map((x) => `${x.number} (${x.status.replace(/_/g, ' ')})`).join(', ')} on this lease. Keep it to one file per dispute.`);
  const notices = (sl.notices || []).filter((n) => n.delivery_status && n.delivery_status !== 'draft');
  if (notices.length && !c.steps?.legal_notice?.done_at) {
    const n = notices[0];
    add('saifsys_notice', 'info', `saifsys shows a ${String(n.type || 'legal').replace(/_/g, ' ')} notice${n.reference ? ` ${n.reference}` : ''} issued ${n.issue_date || ''} (${n.delivery_status}). It may serve as this case's legal notice.`);
  }
  const hearing = (sl.hearings || []).find((h) => h.status === 'scheduled' && h.date >= on);
  if (hearing) add('hearing', 'warn', `A ${hearing.type || 'hearing'} is scheduled in saifsys on ${hearing.date}${hearing.title ? `: ${hearing.title}` : ''}.`);

  return out;
}

const ORDER = { bad: 0, warn: 1, info: 2 };
export const sorted = (list) => [...list].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
