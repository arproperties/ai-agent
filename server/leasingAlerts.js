import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { snapshot, dayNo, total, todayHere, bad, dueName, logEvent } from './leasing.js';
import { region, hourHere, dayOf, cash } from './leasingRegion.js';
import { usDate } from './usFormat.js';

// Leasing alerts: what needs somebody's attention today, and the buzz that says so.
//
// Two halves. openAlerts() is the list on the Alerts screen: worked out from the books every
// time it is asked for, so it is right whether or not anything was ever sent. runAlerts() is
// the phone: on the days a rule says so (3 days before, on the day, 1, 3 and 7 days after…)
// it sends one notice to whoever made the booking and to the master, and writes down that
// it did, so a restart never sends it twice. If the timer stops, the screen still works.
//
// The rules and the quiet hours are the master's to change (lease_settings, key 'alerts').

const DEFAULTS = {
  upcoming: { on: true, days: 3 },                       // a payment is coming up
  due: { on: true },                                     // a payment is due today
  overdue: { on: true, days: [1, 3, 7], every: 7 },      // days late to buzz on, then every so many
  ending: { on: true, lease: [90, 60, 30], short: [14, 3] }, // days before a lease or a short stay ends
  contract: { on: true, days: 3 },                       // confirmed this long with no contract
  eid: { on: true, days: 30 },                           // the tenant's ID expires within this
  summary: { on: true },                                 // the morning's one-line total, to the master
  quiet: { from: 22, to: 8 },                            // no buzz between these hours (the business's time zone)
  latefee: { on: false, days: 5, amount: 0, percent: 0 }, // a fee on rent still unpaid after the days of grace: fixed, a share of the rent, or both
  tenant: { on: false },                                 // email the tenant the reminder automatically, on the due day and the overdue days
};
export const RULES = ['overdue', 'due', 'upcoming', 'ending', 'contract', 'eid'];
const aed = (n) => cash(Math.round(n));
// Loaded when first needed, so the list and the rules still work where push was never set up.
const sendPush = (userIds, note) => import('./push.js').then((m) => m.sendPush(userIds, note));

export async function getSettings() {
  const row = await db.prepare("SELECT value FROM lease_settings WHERE key = 'alerts'").get();
  const saved = row ? JSON.parse(row.value) : {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { ...d, ...saved[k] }]));
}

const whole = (v, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw bad(`${name} must be a whole number from 0 to ${max}.`);
  return n;
};
/** "90, 60, 30" or [90, 60, 30] → the days, largest first, none twice. */
const dayList = (v, name) => {
  const out = [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/).filter(Boolean)).map((x) => whole(x, 365, name)))].sort((a, b) => b - a);
  if (!out.length || out.length > 8) throw bad(`${name}: give between one and eight days.`);
  return out;
};

export async function saveSettings(body = {}, today = todayHere()) {
  const now = await getSettings();
  const on = (k) => (body[k] && 'on' in body[k] ? !!body[k].on : now[k].on);
  const pick = (k, f, read) => (body[k] && f in body[k] ? read(body[k][f]) : now[k][f]);
  const fee = { on: on('latefee'), days: pick('latefee', 'days', (v) => whole(v, 60, 'Days of grace')), amount: pick('latefee', 'amount', (v) => whole(v, 1000000, 'The late fee')),
    percent: pick('latefee', 'percent', (v) => whole(v, 100, 'The share of the rent')) };
  if (fee.on && !(fee.amount > 0 || fee.percent > 0)) throw bad('Give the late fee an amount or a percent of the rent.');
  // Only rent falling due from the day the fee is switched on is charged.
  const since = fee.on ? (now.latefee.on && now.latefee.since) || today : null;
  const next = {
    latefee: { ...fee, ...(since ? { since } : {}) },
    tenant: { on: on('tenant') },
    upcoming: { on: on('upcoming'), days: pick('upcoming', 'days', (v) => whole(v, 60, 'Days before a payment')) },
    due: { on: on('due') },
    overdue: { on: on('overdue'), days: pick('overdue', 'days', (v) => dayList(v, 'Days late').reverse()), every: pick('overdue', 'every', (v) => Math.max(1, whole(v, 90, 'Repeat every'))) },
    ending: { on: on('ending'), lease: pick('ending', 'lease', (v) => dayList(v, 'Days before a lease ends')), short: pick('ending', 'short', (v) => dayList(v, 'Days before a short stay ends')) },
    contract: { on: on('contract'), days: pick('contract', 'days', (v) => whole(v, 60, 'Days without a contract')) },
    eid: { on: on('eid'), days: pick('eid', 'days', (v) => whole(v, 180, 'Days before the ID expires')) },
    summary: { on: on('summary') },
    quiet: { from: pick('quiet', 'from', (v) => whole(v, 23, 'Quiet from')), to: pick('quiet', 'to', (v) => whole(v, 23, 'Quiet until')) },
  };
  await db.prepare("INSERT INTO lease_settings (key, value) VALUES ('alerts', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").run(JSON.stringify(next));
  return next;
}

/** Whether `hour` (0–23, where the business is) falls in the quiet hours. The same hour twice means never quiet. */
export const isQuiet = ({ from, to }, hour) => (from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to);

/**
 * Everything that needs attention on `s.today`, most pressing first. Each has:
 *   rule, key (rule:id, what the sent-once log is kept against), level (bad | warn | info),
 *   title, detail, the booking and place it is about, `open` (which screen deals with it:
 *   pay | docs | booking | tenants), `owner` (who made the booking), and `fires`: whether
 *   today is one of the days this rule buzzes a phone.
 */
export async function openAlerts(s, cfg) {
  const out = [];
  // Who hears of it: whoever made the booking and whoever looks after its building (and the master, always).
  const add = (rule, id, b, a) => { const w = s.where(b); out.push({ rule, key: `${rule}:${id}`, ...w, owner: b.created_by, staff: s.staffOf.get(w.building_id) || [], ...a }); };
  const unit = (p) => `Unit ${p.unit_no}, ${p.building}`;

  if (cfg.overdue.on) {
    const last = Math.max(...cfg.overdue.days);
    for (const o of s.overdue) {
      const d = o.days_overdue;
      add('overdue', o.booking_id, s.bookingOf.get(o.booking_id), { level: 'bad', open: 'pay', amount: o.owed, days: d,
        title: `${o.tenant} owes ${aed(o.owed)}`, detail: `${unit(o)} · ${d} day${d === 1 ? '' : 's'} late`,
        fires: cfg.overdue.days.includes(d) || (d > last && (d - last) % cfg.overdue.every === 0) });
    }
  }
  for (const p of s.dues) {
    const inDays = dayNo(p.due) - s.T;
    if (!p.left || inDays < 0) continue;
    const b = s.bookingOf.get(p.booking_id);
    if (inDays === 0 && cfg.due.on) add('due', p.id, b, { level: 'warn', open: 'pay', amount: p.left, days: 0, title: `${p.tenant}: ${aed(p.left)} is due today`, detail: unit(p), fires: true });
    else if (inDays > 0 && inDays <= cfg.upcoming.days && cfg.upcoming.on) {
      add('upcoming', p.id, b, { level: 'info', open: 'pay', amount: p.left, days: inDays,
        title: `${p.tenant}: ${aed(p.left)} is due ${inDays === 1 ? 'tomorrow' : `in ${inDays} days`}`, detail: `${unit(p)} · ${p.due}`, fires: inDays === cfg.upcoming.days });
    }
  }
  if (cfg.ending.on) {
    for (const u of s.rows) {
      if (u.days_left == null || u.renewal !== 'Not renewed') continue;
      const b = s.bookingOf.get(u.booking_id);
      const days = b.type === 'lease' ? cfg.ending.lease : cfg.ending.short;
      if (u.days_left > Math.max(...days)) continue;
      add('ending', b.id, b, { level: u.days_left <= 30 ? 'warn' : 'info', open: 'booking', days: u.days_left, amount: u.rent,
        title: `${u.tenant}'s ${b.type === 'lease' ? 'lease' : 'stay'} ends ${u.days_left === 0 ? 'today' : `in ${u.days_left} day${u.days_left === 1 ? '' : 's'}`}`,
        detail: `${unit(u)} · ends ${b.end_date} · not renewed`, fires: days.includes(u.days_left) });
    }
  }
  if (cfg.contract.on) {
    for (const b of s.confirmed) {
      const age = s.T - dayNo(dayOf(b.created_at));
      if (b.end_date < s.today || b.has_contract || age < cfg.contract.days) continue;
      add('contract', b.id, b, { level: 'warn', open: 'docs', days: age, title: `${b.tenant}: no contract on file`,
        detail: `${unit(s.where(b))} · confirmed ${age} day${age === 1 ? '' : 's'} ago`, fires: age === cfg.contract.days });
    }
  }
  if (cfg.eid.on) {
    const ids = await db.prepare("SELECT id, to_char(emirates_id_expiry, 'YYYY-MM-DD') AS expiry FROM lease_tenants WHERE emirates_id_expiry IS NOT NULL").all();
    const expiry = new Map(ids.map((t) => [t.id, t.expiry]));
    const seen = new Set();
    for (const b of s.confirmed) {
      const on = expiry.get(b.tenant_id);
      if (b.end_date < s.today || !on || seen.has(b.tenant_id)) continue;
      const left = dayNo(on) - s.T;
      if (left > cfg.eid.days) continue;
      seen.add(b.tenant_id);
      add('eid', b.tenant_id, b, { level: left < 0 ? 'bad' : 'warn', open: 'tenants', days: left,
        title: left < 0 ? `${b.tenant}'s ID has expired` : `${b.tenant}'s ID expires ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}`,
        detail: `${unit(s.where(b))} · ${on}`, fires: left === cfg.eid.days });
    }
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || RULES.indexOf(a.rule) - RULES.indexOf(b.rule) || (b.amount || 0) - (a.amount || 0));
}

/** The Alerts screen: what is open for one company, one building, or everything. */
export async function listAlerts(q = {}, today = todayHere()) {
  return openAlerts(await snapshot(q, today), await getSettings());
}

/**
 * Buzz the phones for what fires today. Each (person, alert, day) is written down before it
 * is sent, so this can run every few minutes and after every restart without repeating
 * itself. During quiet hours nothing is sent and nothing is written: it goes when they end.
 * Returns what was sent: [{ user_id, title, body }].
 */
export async function runAlerts(today = todayHere(), hour = hourHere(), { mail } = {}) {
  const cfg = await getSettings();
  if (isQuiet(cfg.quiet, hour)) return [];
  const s = await snapshot({}, today);
  const all = await openAlerts(s, cfg);
  const masters = (await db.prepare("SELECT id FROM users WHERE role = 'master'").all()).map((u) => u.id);
  const fresh = (userId, key) => db.prepare('INSERT INTO lease_alerts_sent (user_id, key, day) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(userId, key, today).then((r) => r.changes > 0);

  const byUser = new Map();
  const give = (userId, item) => byUser.set(userId, [...(byUser.get(userId) || []), item]);
  // Rent that is overdue and that this person has never been told about goes out now, whatever
  // day it is on: a tenancy brought in already late (the import), or one whose day to buzz
  // fell while the server was down. After that it keeps to the rule's days.
  const told = async (userId, key) => !!(await db.prepare('SELECT 1 FROM lease_alerts_sent WHERE user_id = ? AND key = ? LIMIT 1').get(userId, key));
  for (const a of all) {
    for (const userId of new Set([a.owner, ...a.staff, ...masters].filter(Boolean))) {
      const goes = a.fires || (a.rule === 'overdue' && !(await told(userId, a.key)));
      if (goes && await fresh(userId, a.key)) give(userId, a);
    }
  }
  // The morning total, for the master: what is due today and what is already late.
  const due = all.filter((a) => a.rule === 'due');
  const late = all.filter((a) => a.rule === 'overdue');
  if (cfg.summary.on && (due.length || late.length)) {
    const body = `Today: ${due.length} due (${aed(total(due))}), ${late.length} overdue (${aed(total(late))})`;
    for (const userId of masters) if (await fresh(userId, 'summary')) give(userId, { summary: true, title: 'Leasing today', detail: body });
  }

  const sent = [];
  for (const [user_id, items] of byUser) {
    // One notice per person: the morning total if they get one, otherwise the first alert and a count.
    const top = items.find((i) => i.summary) || items[0];
    const more = items.filter((i) => !i.summary).length - (top.summary ? 0 : 1);
    const note = { title: top.title, body: top.summary ? top.detail : more > 0 ? `${top.detail} — and ${more} more` : top.detail };
    sent.push({ user_id, ...note });
    await sendPush([user_id], { ...note, url: '/?leasing=alerts', tag: 'leasing-alerts' }).catch((e) => console.error('[leasing-alerts]', e.message));
  }
  if (cfg.tenant.on) await emailTenants(s, cfg, mail).catch((e) => console.error('[leasing-alerts] tenant email:', e.message));
  return sent;
}

/**
 * The reminder, emailed to the tenant without anybody pressing send: on the day a payment
 * is due, and on the days the overdue rule chases (1, 3, 7 days late, then every so many).
 * One email a booking a day at most, about its oldest unpaid amount, in the master's wording,
 * and written in the booking's history. A tenant with no email address gets nothing: WhatsApp
 * cannot be sent by a server, so that still takes a person.
 */
async function emailTenants(s, cfg, mail) {
  if (!mail) {
    const m = await import('./mailer.js');
    if (!m.mailReady()) return;
    mail = m.sendPlain;
  }
  const last = Math.max(...cfg.overdue.days);
  const oldest = new Map(); // booking → its oldest unpaid amount that has fallen due
  for (const p of s.dues) if (p.left && p.due <= s.today && !oldest.has(p.booking_id)) oldest.set(p.booking_id, p);
  for (const [bookingId, p] of oldest) {
    const b = s.bookingOf.get(bookingId);
    const d = s.T - dayNo(p.due);
    if (!b.tenant_email || !(d === 0 || cfg.overdue.days.includes(d) || (d > last && (d - last) % cfg.overdue.every === 0))) continue;
    const fresh = await db.prepare('INSERT INTO lease_tenant_notices (booking_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING').run(bookingId, s.today);
    if (!fresh.changes) continue;
    try {
      const r = await tenantReminder(p.id, s.today);
      await mail(b.tenant_email, r.subject, r.message);
      await logEvent(bookingId, 'reminder', 'Emailed to the tenant automatically', null);
    } catch (e) {
      // Not sent: forget that it was tried, so the next round tries again.
      await db.prepare('DELETE FROM lease_tenant_notices WHERE booking_id = ? AND day = ?').run(bookingId, s.today);
      throw e;
    }
  }
}


// ---------- reminders to the tenant ----------
//
// Nothing is sent to a tenant by the system. This writes the message, from wording the
// master sets, and hands back links that open WhatsApp or an email with it filled in; a
// person reads it and presses send. That it was sent is written in the booking's history.

const WORDING = {
  due: 'Dear {tenant}, a kind reminder that {what} of {amount} for unit {unit}, {building} is due on {due_date}. Thank you. {company}',
  overdue: 'Dear {tenant}, {what} of {amount} for unit {unit}, {building} was due on {due_date} and is now {days_late} days late. Kindly arrange payment, or call us if there is a problem. Thank you. {company}',
};

export async function getWording() {
  const row = await db.prepare("SELECT value FROM lease_settings WHERE key = 'reminder'").get();
  return { ...WORDING, ...(row ? JSON.parse(row.value) : {}) };
}

export async function saveWording(body = {}) {
  const next = await getWording();
  for (const k of Object.keys(WORDING)) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim();
    if (v.length < 20 || v.length > 1000) throw bad('A reminder is between 20 and 1,000 characters.');
    next[k] = v;
  }
  await db.prepare("INSERT INTO lease_settings (key, value) VALUES ('reminder', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").run(JSON.stringify(next));
  return next;
}

/**
 * A phone number as WhatsApp wants it: digits only, country code first. A number written
 * the local way gets the business's country code: 050 123 4567 → 971501234567 in the UAE,
 * (415) 555-1234 → 14155551234 in America. One written with + or 00 already has its own.
 */
export function whatsappNumber(phone) {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  const code = region().phone_code;
  if (raw.startsWith('+')) { /* already international */ } else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `${code}${d.slice(1)}`;
  else if (d.length <= 10) d = `${code}${d}`;
  return d.length >= 10 ? d : null;
}

/** The reminder for one row of a booking's schedule: the words, and the links that open it ready to send. */
export async function tenantReminder(installmentId, today = todayHere()) {
  const i = await db.prepare(`SELECT i.id, i.booking_id, i.kind, i.label, i.amount, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
      (SELECT coalesce(sum(p.amount), 0) FROM lease_payments p WHERE p.installment_id = i.id) AS paid,
      t.full_name AS tenant, t.phone, t.email, u.unit_no, bl.name AS building, c.name AS company
    FROM lease_installments i JOIN lease_bookings b ON b.id = i.booking_id JOIN lease_tenants t ON t.id = b.tenant_id
    JOIN prop_units u ON u.id = b.unit_id JOIN prop_buildings bl ON bl.id = u.building_id JOIN prop_companies c ON c.id = bl.company_id
    WHERE i.id = ?`).get(Number(installmentId) || 0);
  if (!i) throw bad('Not found', 404);
  const left = Number(i.amount) - Number(i.paid);
  if (left <= 0.004) throw bad('This one is already paid in full.', 409);
  const late = dayNo(today) - dayNo(i.due_date);
  const words = { tenant: i.tenant, what: dueName(i).toLowerCase(), amount: aed(left), unit: i.unit_no, building: i.building, company: i.company,
    due_date: usDate(i.due_date), days_late: Math.max(0, late) };
  const message = (await getWording())[late > 0 ? 'overdue' : 'due'].replace(/\{(\w+)\}/g, (all, k) => (k in words ? words[k] : all));
  const subject = `${late > 0 ? 'Overdue' : 'Reminder'}: ${dueName(i).toLowerCase()} for unit ${i.unit_no}, ${i.building}`;
  const number = whatsappNumber(i.phone);
  return { booking_id: i.booking_id, tenant: i.tenant, phone: i.phone, email: i.email, subject, message,
    whatsapp: number && `https://wa.me/${number}?text=${encodeURIComponent(message)}`,
    mailto: i.email && `mailto:${i.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` };
}

/** Write in the booking's history that the tenant was reminded, and how. */
export async function noteReminder(installmentId, channel, by) {
  const r = await tenantReminder(installmentId);
  const how = { whatsapp: 'WhatsApp', email: 'email', copy: 'copied message' }[channel];
  if (!how) throw bad('Unknown channel');
  await logEvent(r.booking_id, 'reminder', `Tenant reminded by ${how}`, by);
  return { ok: true };
}

let timer = null;
/** Checks every ten minutes. The rules are about days, so this only decides how soon after the quiet hours the morning's notices go. */
export function startLeasingAlerts() {
  if (timer) return;
  const tick = () => runAlerts().catch((e) => console.error('[leasing-alerts]', e.message));
  timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  tick();
}

// ---------- routes ----------

export const alertRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

alertRoutes.get('/', wrap(async (req, res) => res.json({ alerts: await listAlerts(req.query), settings: await getSettings(), wording: await getWording(), master: req.user.role === 'master' })));
alertRoutes.put('/wording', requireMaster, wrap(async (req, res) => res.json(await saveWording(req.body))));
alertRoutes.get('/reminder/:id', wrap(async (req, res) => res.json(await tenantReminder(req.params.id))));
alertRoutes.post('/reminder/:id', wrap(async (req, res) => res.json(await noteReminder(req.params.id, req.body?.channel, req.user.id))));
// For the sidebar's badges: how many of each kind are open, and `count`, how many of them are pressing (not just coming up).
alertRoutes.get('/count', wrap(async (req, res) => {
  const all = await listAlerts();
  res.json({ count: all.filter((a) => a.level !== 'info').length, rules: Object.fromEntries(RULES.map((r) => [r, all.filter((a) => a.rule === r).length])) });
}));
alertRoutes.put('/settings', requireMaster, wrap(async (req, res) => res.json(await saveSettings(req.body))));
