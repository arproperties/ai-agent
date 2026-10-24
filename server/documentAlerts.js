import { db } from './db.js';
import { isMaster } from './access.js';
import { sendPush } from './push.js';
import { createTodo } from './todos.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// Expiry alerts for every Shelf file with a date: at 60, 30 and 14 days before (the
// master's settings), on the day after it runs out, then every 7 days until it is
// replaced or marked "Not renewing". An AI-read date nobody has confirmed asks to be
// confirmed instead of counting down.
//
// A categorised file (Employee / Company Documents...) goes to the master and the Document
// Renewals holders; a personal file to its owner only. Each alert is written down before it
// is sent, under a unique (document, step), so a restart or a second server never sends it
// twice. A push carries the kind, who or what it is for, the days and a link - never the
// file's contents. Many at once become one summary per person.

const DEFAULTS = { days: [60, 30, 14], overdue_every_days: 7, hour: 8 };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 86400000;
const toDate = (s) => Date.parse(`${s}T00:00:00Z`);
const shift = (s, n) => new Date(toDate(s) + n * DAY).toISOString().slice(0, 10);
const pretty = (s) => new Date(toDate(s)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

export async function alertSettings() {
  const r = await db.prepare('SELECT days, overdue_every_days, hour FROM document_alert_settings WHERE id = 1').get();
  return r ? { days: r.days, overdue_every_days: r.overdue_every_days, hour: r.hour } : { ...DEFAULTS };
}

export async function saveAlertSettings(user, { days, overdue_every_days, hour } = {}) {
  if (!isMaster(user)) throw bad('Only the master changes the alert days', 403);
  const now = await alertSettings();
  const list = days === undefined ? now.days
    : [...new Set((Array.isArray(days) ? days : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 365))].sort((a, b) => b - a);
  if (!list.length) throw bad('Give at least one number of days before expiry');
  const every = overdue_every_days === undefined ? now.overdue_every_days : Math.min(Math.max(Number(overdue_every_days) || 7, 1), 90);
  const at = hour === undefined ? now.hour : Math.min(Math.max(Number(hour) || 0, 0), 23);
  await db.prepare(`INSERT INTO document_alert_settings (id, days, overdue_every_days, hour) VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET days = EXCLUDED.days, overdue_every_days = EXCLUDED.overdue_every_days, hour = EXCLUDED.hour`)
    .run(list, every, at);
  return alertSettings();
}

/**
 * The one alert due today for this file, or null. Only the latest step: a file first seen
 * at 20 days gets the 30-day alert, not the 60 as well; one long expired is told once.
 */
export function dueStep(d, today, settings, sent) {
  if (!d.expires_on || d.not_renewing_at || d.superseded_by) return null;
  if (!d.expiry_confirmed_at) return sent.has('confirm') ? null : 'confirm';
  const days = Math.round((toDate(d.expires_on) - toDate(today)) / DAY);
  let step = null;
  if (days < 0) {
    const k = Math.floor(-days / settings.overdue_every_days);
    step = !sent.has('expired') ? 'expired' : k >= 1 ? `overdue:${shift(d.expires_on, k * settings.overdue_every_days)}` : null;
  } else {
    const t = [...settings.days].sort((a, b) => a - b).find((n) => days <= n);
    step = t ? `d${t}` : null;
  }
  return step && !sent.has(step) ? step : null;
}

/** Who hears about a file: see the top of this file. */
export async function recipientsFor(d) {
  const owner = await db.prepare('SELECT id, external FROM users WHERE id = ?').get(d.user_id);
  if (!d.category_id || owner?.external) return owner ? [owner.id] : [];
  const rows = await db.prepare(`SELECT id FROM users WHERE role = 'master' AND NOT external
    UNION SELECT u.id FROM module_access ma JOIN users u ON u.id = ma.user_id
      WHERE ma.module = 'document_renewals' AND NOT u.external ORDER BY 1`).all();
  return rows.map((r) => r.id);
}

// What one alert says.
function message(d, step, today) {
  const who = d.employee_name || d.subject;
  const title = d.type ? (who ? `${d.type} – ${who}` : d.type) : (d.title || d.name);
  const days = Math.round((toDate(d.expires_on) - toDate(today)) / DAY);
  const body = step === 'confirm' ? `Is ${pretty(d.expires_on)} the right expiry date? Confirm it`
    : days < 0 ? `Expired ${-days} day${days === -1 ? '' : 's'} ago (${pretty(d.expires_on)})`
      : days === 0 ? `Runs out today (${pretty(d.expires_on)})`
        : `Runs out in ${days} day${days === 1 ? '' : 's'} (${pretty(d.expires_on)})`;
  const url = !d.category_id ? '/' : d.employee_code ? `/?docrenewals=${encodeURIComponent(d.employee_code)}` : '/?docrenewals=1';
  return { title, body, url, tag: `expiry-${d.id}` };
}
const bucket = (step) => (step === 'confirm' ? 'to confirm' : step === 'expired' || step.startsWith('overdue') ? 'expired'
  : `due within ${step.slice(1)} days`);

/**
 * One day's alerts. Returns how many were sent. `push` and `todo` are sendPush and
 * createTodo, replaceable for tests.
 */
export async function alertOnce({ today = dubaiDate(), push = sendPush, todo = createTodo } = {}) {
  const settings = await alertSettings();
  const files = await db.prepare(`SELECT d.*, t.label AS type FROM documents d LEFT JOIN document_types t ON t.id = d.type_id
    WHERE d.expires_on IS NOT NULL AND d.status = 'ready' AND d.kind IS DISTINCT FROM 'fact'
      AND d.superseded_by IS NULL AND d.not_renewing_at IS NULL`).all();
  const sentBefore = await db.prepare('SELECT document_id, step FROM document_alerts WHERE document_id = ANY(?::int[])').all(files.map((f) => f.id));
  const sentOf = new Map();
  for (const r of sentBefore) sentOf.set(r.document_id, (sentOf.get(r.document_id) || new Set()).add(r.step));

  // Written down first: whoever writes it sends it, so nothing goes out twice.
  const due = [];
  for (const d of files) {
    const step = dueStep(d, today, settings, sentOf.get(d.id) || new Set());
    if (!step) continue;
    const to = await recipientsFor(d);
    if (!to.length) continue;
    const mine = await db.prepare(`INSERT INTO document_alerts (document_id, step, sent_to) VALUES (?, ?, ?)
      ON CONFLICT (document_id, step) DO NOTHING RETURNING id`).get(d.id, step, to);
    if (mine) due.push({ d, step, to });
  }

  // Per person: up to 3 alerts one by one, more as one summary. The same push to several
  // people goes once to all of them.
  const byPerson = new Map();
  for (const a of due) for (const uid of a.to) byPerson.set(uid, [...(byPerson.get(uid) || []), a]);
  const outgoing = new Map();
  const send = (uid, msg) => {
    const key = JSON.stringify(msg);
    outgoing.set(key, { msg, ids: [...(outgoing.get(key)?.ids || []), uid] });
  };
  for (const [uid, list] of byPerson) {
    if (list.length <= 3) { for (const a of list) send(uid, message(a.d, a.step, today)); continue; }
    const counts = {};
    for (const a of list) counts[bucket(a.step)] = (counts[bucket(a.step)] || 0) + 1;
    const order = ['expired', ...settings.days.slice().sort((x, y) => x - y).map((n) => `due within ${n} days`), 'to confirm'];
    send(uid, {
      title: `${list.length} documents need attention`,
      body: order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', '),
      url: '/?docrenewals=1',
      tag: 'expiry-summary',
    });
  }
  for (const { msg, ids } of outgoing.values()) await push(ids, msg);

  // The last countdown step is also a to-do for each person told, linked to the file.
  const last = `d${Math.min(...settings.days)}`;
  for (const a of due.filter((x) => x.step === last)) {
    const who = a.d.employee_name || a.d.subject;
    const text = `Renew the ${a.d.type || a.d.title || 'document'}${who ? ` of ${who}` : ''} (runs out ${pretty(a.d.expires_on)})`;
    for (const uid of a.to) await todo(uid, { text, documentId: a.d.id }).catch((e) => console.error('[document-alerts] to-do:', e.message));
  }
  return due.length;
}

/** Hourly; acts once a day at the settings' hour, Dubai time. */
export function startDocumentAlerts() {
  let lastDay = null;
  const tick = async () => {
    const today = dubaiDate();
    if (lastDay === today || dubaiHour() < (await alertSettings()).hour) return;
    lastDay = today;
    const n = await alertOnce({ today });
    if (n) console.log(`[document-alerts] ${n} alerts sent`);
  };
  const run = () => tick().catch((e) => console.error('[document-alerts]', e.message));
  setTimeout(run, 90_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
