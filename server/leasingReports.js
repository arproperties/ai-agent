import { Router } from 'express';
import { db } from './db.js';
import { snapshot, bookingRef, dayNo, total, todayHere, isDate, bad, dueName, METHODS, AGING } from './leasing.js';
import { region, dayOf, cash } from './leasingRegion.js';

// Leasing reports. Each one is the same shape, so the screen draws, exports and prints any
// of them the same way: { title, subtitle, columns, rows, total, summary }.
//   columns: { key, label, kind } where kind is text | money | int | date.
//   total:   the figures for the bottom row, by column key.
//   summary: a few headline figures shown above the table.
//   currency: what the amounts are in.
// All of them read snapshot() in leasing.js, so a report and the overview never disagree.

const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', every_6_months: 'Every 6 months', yearly: 'Yearly', upfront: 'All upfront' };
const STATUS = { occupied: 'Occupied', ending: 'Ending soon', overdue: 'Overdue', vacant: 'Vacant', blocked: 'Blocked' };
const METHOD = Object.fromEntries(METHODS);
const col = (key, label, kind = 'text') => ({ key, label, kind });
const PLACE = [col('company', 'Company'), col('building', 'Building'), col('unit_no', 'Unit')];
const fig = (label, value, kind = 'money') => ({ label, value, kind });

/** Every unit: who is in it, on what terms, and what they owe. */
function rentRoll(s) {
  const rows = s.rows.map((u) => {
    const b = s.bookingOf.get(u.booking_id);
    return { company: u.company, building: u.building, unit_no: u.unit_no, type: u.type, status: STATUS[u.status], tenant: u.tenant, phone: b?.tenant_phone,
      rent: u.rent ?? null, frequency: b && FREQ[b.payment_frequency], start_date: b?.start_date, end_date: b?.end_date, contract_no: b?.contract_no, owed: u.owed ?? null, booking_id: u.booking_id };
  });
  const open = rows.filter((r) => r.status !== 'Blocked').length;
  const taken = rows.filter((r) => r.tenant).length;
  // The rows are the units as they stand, so what a tenant who has left still owes is on none of them.
  const gone = total([total(s.overdue, (o) => o.owed), -total(rows, (r) => r.owed || 0)], (x) => x);
  return {
    title: 'Rent roll',
    columns: [...PLACE, col('type', 'Type'), col('status', 'Status'), col('tenant', 'Tenant'), col('phone', 'Phone'), col('rent', 'Rent / month', 'money'),
      col('frequency', 'Paid'), col('start_date', 'From', 'date'), col('end_date', 'To', 'date'), col('contract_no', 'Contract no.'), col('owed', 'Overdue', 'money')],
    rows,
    total: { rent: total(rows, (r) => r.rent || 0), owed: total(rows, (r) => r.owed || 0) },
    summary: [fig('Units', rows.length, 'int'), fig('Let', taken, 'int'), fig('Vacant', rows.filter((r) => r.status === 'Vacant').length, 'int'),
      fig('Occupancy', open ? `${Math.round((taken / open) * 100)}%` : '0%', 'text'), fig('Rent roll / month', total(rows, (r) => r.rent || 0)),
      ...(gone > 0 ? [fig('Owed by tenants who left', gone)] : [])],
  };
}

/** What each tenant owes, by how long each unpaid amount has been waiting. */
function aging(s) {
  const by = new Map();
  for (const p of s.dues) {
    if (!p.left || p.due >= s.today) continue;
    const age = s.T - dayNo(p.due);
    const b = s.bookingOf.get(p.booking_id);
    const r = by.get(p.booking_id) || by.set(p.booking_id, { tenant: p.tenant, tenant_id: b.tenant_id, phone: b.tenant_phone, company: p.company, building: p.building, unit_no: p.unit_no,
      b0: 0, b1: 0, b2: 0, b3: 0, owed: 0, days: 0, booking_id: p.booking_id }).get(p.booking_id);
    const band = `b${AGING.findIndex(([, from, to]) => age >= from && age <= to)}`;
    r[band] = total([r[band], p.left], (x) => x);
    r.owed = total([r.owed, p.left], (x) => x);
    r.days = Math.max(r.days, age);
  }
  const rows = [...by.values()].sort((a, b) => b.owed - a.owed);
  const sums = Object.fromEntries(['b0', 'b1', 'b2', 'b3', 'owed'].map((k) => [k, total(rows, (r) => r[k])]));
  return {
    title: 'Overdue by age',
    columns: [col('tenant', 'Tenant'), col('phone', 'Phone'), ...PLACE, ...AGING.map(([label], i) => col(`b${i}`, label, 'money')), col('owed', 'Total owed', 'money'), col('days', 'Days late', 'int')],
    rows, total: sums,
    summary: [fig('Total overdue', sums.owed), fig('Tenants behind', new Set(rows.map((r) => r.tenant_id)).size, 'int'), ...AGING.map(([label], i) => fig(label, sums[`b${i}`]))],
  };
}

/** Money received between two dates, with how and for which building. */
function collections(s, { from, to }) {
  const start = isDate(from || '') ? from : `${s.today.slice(0, 7)}-01`;
  const end = isDate(to || '') ? to : s.today;
  if (end < start) throw bad('The end date is before the start date.');
  const got = s.pays.filter((p) => p.received_on >= start && p.received_on <= end).map((p) => ({
    received_on: p.received_on, ...s.where(s.bookingOf.get(p.booking_id)), what: dueName(p), method: METHOD[p.method], reference: p.reference, amount: p.amount, tax: p.tax, recorded_by: p.added_by,
  }));
  // The tax in what came in, shown only where some booking is taxed.
  const tax = total(got, (r) => r.tax);
  const taxName = region().tax_name;
  // A deposit given back in these dates is money out: a line of its own, with a minus.
  const back = s.refunds.filter((r) => r.on >= start && r.on <= end).map(({ on, amount, note, ...who }) => ({ received_on: on, ...who, what: 'Deposit returned', reference: note, amount: -amount }));
  const rows = [...got, ...back].sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  const groups = (key) => [...new Set(got.map((r) => r[key]))].map((k) => fig(k, total(got.filter((r) => r[key] === k))));
  return {
    title: 'Collections', period: `${start} to ${end}`, from: start, to: end,
    columns: [col('received_on', 'Received', 'date'), col('tenant', 'Tenant'), ...PLACE, col('what', 'For'), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount', 'money'),
      ...(tax ? [col('tax', `Of which ${taxName}`, 'money')] : []), col('recorded_by', 'Recorded by')],
    rows, total: { amount: total(rows), ...(tax ? { tax } : {}) },
    summary: [fig('Collected', total(got)), ...(tax ? [fig(`${taxName} collected`, tax)] : []), fig('Payments', got.length, 'int'),
      ...(back.length ? [fig('Deposits returned', -total(back)), fig('Net', total(rows))] : []), ...groups('method'), ...groups('building')],
  };
}

/** Leases that end within so many days, and whether each is already let again. */
function expiring(s, { days }) {
  const within = [30, 60, 90].includes(Number(days)) ? Number(days) : 90;
  const rows = s.rows.filter((u) => u.days_left <= within).sort((a, b) => a.days_left - b.days_left).map((u) => {
    const b = s.bookingOf.get(u.booking_id);
    return { tenant: u.tenant, phone: b.tenant_phone, company: u.company, building: u.building, unit_no: u.unit_no, kind: b.type === 'lease' ? 'Lease' : 'Short stay',
      end_date: b.end_date, days_left: u.days_left, rent: u.rent, renewal: u.renewal, booking_id: u.booking_id };
  });
  const open = rows.filter((r) => r.renewal === 'Not renewed');
  return {
    title: 'Expiring leases', period: `next ${within} days`, days: within,
    columns: [col('tenant', 'Tenant'), col('phone', 'Phone'), ...PLACE, col('kind', 'Type'), col('end_date', 'Ends', 'date'), col('days_left', 'Days left', 'int'), col('rent', 'Rent / month', 'money'), col('renewal', 'Renewal')],
    rows, total: { rent: total(rows, (r) => r.rent) },
    summary: [fig('Ending', rows.length, 'int'), fig('Not renewed', open.length, 'int'), fig('Rent at risk / month', total(open, (r) => r.rent))],
  };
}

/** Empty units, how long each has stood empty, and the next booking if there is one. */
function vacancy(s) {
  const rows = s.rows.filter((u) => u.status === 'vacant').map((u) => {
    const next = s.confirmed.find((b) => b.unit_id === u.unit_id && b.start_date > s.today);
    return { company: u.company, building: u.building, unit_no: u.unit_no, type: u.type, floor: u.floor, vacant_since: u.vacant_since, days_vacant: u.days_vacant,
      next_from: next?.start_date, next_tenant: next?.tenant };
  }).sort((a, b) => (b.days_vacant ?? Infinity) - (a.days_vacant ?? Infinity));
  const known = rows.filter((r) => r.days_vacant != null);
  return {
    title: 'Vacant units',
    columns: [...PLACE, col('type', 'Type'), col('floor', 'Floor'), col('vacant_since', 'Empty since', 'date'), col('days_vacant', 'Days empty', 'int'), col('next_from', 'Next booking', 'date'), col('next_tenant', 'Next tenant')],
    rows, total: {},
    summary: [fig('Vacant', rows.length, 'int'), fig('Never let', rows.length - known.length, 'int'), fig('Blocked', s.rows.filter((u) => u.status === 'blocked').length, 'int'),
      fig('Average days empty', known.length ? Math.round(known.reduce((t, r) => t + r.days_vacant, 0) / known.length) : 0, 'int')],
  };
}

/** One tenant's account: every rent, deposit or charge due up to today and every payment, with the running balance. */
async function statement(s, { tenant_id }) {
  const t = await db.prepare('SELECT id, full_name, phone, email FROM lease_tenants WHERE id = ?').get(Number(tenant_id) || 0);
  if (!t) throw bad('Choose a tenant.');
  const mine = (p) => s.bookingOf.get(p.booking_id).tenant_id === t.id;
  const ref = (p) => bookingRef(s.bookingOf.get(p.booking_id));
  const lines = [
    ...s.dues.filter((p) => mine(p) && p.amount > 0 && p.due <= s.today).map((p) => ({ date: p.due, order: 0, description: `${p.name} due · Unit ${p.unit_no}, ${p.building}`, ref: ref(p), charge: p.amount, payment: null })),
    ...s.pays.filter(mine).map((p) => { const w = s.where(s.bookingOf.get(p.booking_id));
      return { date: p.received_on, order: 1, description: `Payment · ${METHOD[p.method]}${p.reference ? ` ${p.reference}` : ''} · Unit ${w.unit_no}, ${w.building}`, ref: ref(p), charge: null, payment: p.amount }; }),
    // The deposit given back: written down so the account tells the whole story; it changes no balance.
    ...s.refunds.filter(mine).map((r) => ({ date: r.on, order: 2, description: `Security deposit returned · ${cash(r.amount)}${r.note ? ` · ${r.note}` : ''} · Unit ${r.unit_no}, ${r.building}`, ref: ref(r), charge: null, payment: null })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  let balance = 0;
  const rows = lines.map(({ order, ...l }) => { balance = total([balance, l.charge || 0, -(l.payment || 0)], (x) => x); return { ...l, balance }; });
  const next = s.dues.find((p) => mine(p) && p.left > 0 && p.due > s.today);
  return {
    title: `Statement · ${t.full_name}`, period: `to ${s.today}`, tenant: [t.full_name, t.phone, t.email].filter(Boolean).join(' · '),
    columns: [col('date', 'Date', 'date'), col('description', 'Details'), col('ref', 'Booking'), col('charge', 'Due', 'money'), col('payment', 'Paid', 'money'), col('balance', 'Balance', 'money')],
    rows, total: { charge: total(rows, (r) => r.charge || 0), payment: total(rows, (r) => r.payment || 0), balance },
    summary: [fig('Due to date', total(rows, (r) => r.charge || 0)), fig('Paid', total(rows, (r) => r.payment || 0)), fig('Balance owed', balance),
      ...(next ? [fig(`Next due ${next.due}`, next.left)] : [])],
  };
}

/**
 * One day, start to finish: the money that came in, what fell due, who moved in or out,
 * and the bookings made or cancelled. `day` defaults to today.
 */
async function daily(s, { day }) {
  const on = isDate(day || '') ? day : s.today;
  if (on > s.today) throw bad('That day has not happened yet.');
  const of = (b) => s.where(b);
  const cancelled = (await db.prepare("SELECT booking_id, detail, created_at FROM lease_events WHERE kind = 'cancelled' ORDER BY id").all())
    .filter((e) => s.bookingOf.has(e.booking_id) && dayOf(e.created_at) === on);
  const paid = s.pays.filter((p) => p.received_on === on);
  const due = s.dues.filter((p) => p.due === on);
  const made = s.bookings.filter((b) => dayOf(b.created_at) === on);
  const back = s.refunds.filter((r) => r.on === on);
  const rows = [
    ...paid.map((p) => ({ what: 'Payment received', ...of(s.bookingOf.get(p.booking_id)), detail: [dueName(p), METHOD[p.method], p.reference].filter(Boolean).join(' · '), amount: p.amount, by: p.added_by })),
    ...due.map((p) => ({ what: p.left ? 'Due, not paid' : 'Due, paid', ...of(s.bookingOf.get(p.booking_id)), detail: p.name, amount: p.amount })),
    ...s.confirmed.filter((b) => b.start_date === on).map((b) => ({ what: 'Move-in', ...of(b), detail: `until ${b.end_date}` })),
    ...s.confirmed.filter((b) => b.end_date === on).map((b) => ({ what: 'Move-out', ...of(b), detail: `since ${b.start_date}` })),
    ...made.map((b) => ({ what: b.status === 'draft' ? 'Booking drafted' : 'Booking made', ...of(b), detail: `${b.start_date} to ${b.end_date}`, amount: Number(b.rent_amount), by: b.added_by })),
    ...cancelled.map((e) => ({ what: 'Booking cancelled', ...of(s.bookingOf.get(e.booking_id)), detail: e.detail })),
    ...back.map(({ on: day, amount, note, ...who }) => ({ what: 'Deposit returned', ...who, detail: note, amount: -amount })),
  ];
  return {
    title: 'Daily report', period: on, day: on,
    columns: [col('what', 'What'), col('tenant', 'Tenant'), ...PLACE, col('detail', 'Details'), col('amount', 'Amount', 'money'), col('by', 'By')],
    rows, total: {},
    summary: [fig('Collected', total(paid)), fig('Payments', paid.length, 'int'), fig('Fell due', total(due)), fig('Of that, unpaid', total(due, (p) => p.left)),
      fig('Move-ins', s.confirmed.filter((b) => b.start_date === on).length, 'int'), fig('Move-outs', s.confirmed.filter((b) => b.end_date === on).length, 'int'),
      fig('Bookings made', made.length, 'int'), fig('Cancelled', cancelled.length, 'int'), ...(back.length ? [fig('Deposits returned', total(back))] : []),
      ...(on === s.today ? [fig('Overdue in all', total(s.overdue, (o) => o.owed)), fig('Vacant units', s.rows.filter((u) => u.status === 'vacant').length, 'int')] : [])],
  };
}

export const REPORTS = { daily, 'rent-roll': rentRoll, aging, collections, expiring, vacancy, statement };

/** One report, for one company, one building, or everything (the statement is one tenant, everywhere). */
export async function report(name, q = {}, today = todayHere()) {
  const make = REPORTS[name];
  if (!make) throw bad('No such report', 404);
  const s = await snapshot(name === 'statement' ? {} : q, today);
  const out = await make(s, q);
  const scope = name === 'statement' ? out.tenant
    : q.building_id ? s.list.map((b) => `${b.name}, ${b.company}`).join('') : q.company_id ? s.list[0]?.company || '' : 'All companies';
  return { name, generated: today, currency: region().currency, subtitle: [scope, out.period].filter(Boolean).join(' · '), ...out };
}

export const reportRoutes = Router();
reportRoutes.get('/:name', (req, res, next) => report(req.params.name, req.query).then((r) => res.json(r)).catch(next));
