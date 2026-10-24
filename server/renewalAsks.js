import { Router } from 'express';
import { db } from './db.js';
import { isMaster } from './access.js';
import { needsModule } from './modules.js';
import { draft, send, buzz, aed } from './leaseRenewals.js';

// Ask the boss: a person writes a renewal offer (rent, cheques, charges, the email) and, in
// place of sending it, asks the master to OK it. The master gets a buzz, opens it, may change
// it, and sends it (Approve & send) or says no with a note. Nothing reaches the tenant before.
// One offer per lease waits at a time; while it waits only a master can start that renewal.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const secs = () => Math.floor(Date.now() / 1000);
const masters = async () => (await db.prepare(`SELECT id FROM users WHERE NOT disabled AND role = 'master'`).all()).map((u) => u.id);

const ROW = (a) => a && {
  id: a.id, lease_id: a.lease_id, end_date: a.end_date, building: a.lease.building, unit: a.lease.unit, tenant: a.lease.tenant,
  ask: a.ask, text: a.text, status: a.status, note: a.note || null,
  asked_by: a.asked_by, asked_by_name: a.asked_by_name || null, asked_at: Number(a.asked_at), decided_at: a.decided_at ? Number(a.decided_at) : null,
};
const get = async (id) => ROW(await db.prepare(`SELECT a.*, u.name AS asked_by_name FROM lease_renewal_asks a LEFT JOIN users u ON u.id = a.asked_by WHERE a.id = ?`).get(Number(id) || 0));

/** What the asked figures are, for the start step: only the parts the person chose. */
const askOf = (b) => ({ rent: Number(b.rent), cheques: Number(b.cheques), ...(b.fees ? { fees: b.fees } : {}) });

/** The offers waiting, and the asker's own answered in the last week (to see the boss's no). */
export async function listAsks(user) {
  const rows = await db.prepare(`SELECT a.*, u.name AS asked_by_name FROM lease_renewal_asks a LEFT JOIN users u ON u.id = a.asked_by
    WHERE a.status = 'waiting' OR (a.asked_by = ? AND a.status = 'declined' AND a.decided_at > ?) ORDER BY a.id`).all(user.id, secs() - 7 * 86400);
  return rows.map(ROW);
}

/** A person asks the boss to OK the offer they wrote. */
export async function askBoss(user, body) {
  const ask = askOf(body.ask || {});
  const text = String(body.text || '').trim();
  if (!text) throw bad('Write the offer first.');
  const d = await draft(user, { action: 'start', lease_id: body.lease_id, ...ask }); // the lease is still due and not started
  const due = d.lease;
  if (await db.prepare(`SELECT 1 FROM lease_renewal_asks WHERE lease_id = ? AND end_date = ? AND status = 'waiting'`).get(due.lease_id, due.end_date)) {
    throw bad('This offer is already waiting for the boss.', 409);
  }
  const { id } = await db.prepare(`INSERT INTO lease_renewal_asks (lease_id, end_date, lease, ask, text, asked_by, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(due.lease_id, due.end_date, JSON.stringify(due), JSON.stringify(ask), text, user.id, secs());
  buzz((await masters()).filter((m) => m !== user.id), {
    title: `${due.building} ${due.unit}`, body: `${user.name || 'Someone'} asks you to OK the renewal offer: ${aed(d.rent)} a year`, url: '/?renewals=1', tag: `renewal-ask-${id}`,
  });
  return get(id);
}

/** The boss sends it, as it was asked or as they changed it. */
export async function approve(user, id, body) {
  if (!isMaster(user)) throw bad('Only the boss can OK this.', 403);
  const a = await get(id);
  if (!a || a.status !== 'waiting') throw bad('This offer is no longer waiting.', 409);
  const ask = body.ask ? askOf(body.ask) : a.ask;
  const r = await send(user, { action: 'start', lease_id: a.lease_id, ...ask, text: String(body.text || '').trim() || a.text });
  await db.prepare(`UPDATE lease_renewal_asks SET status = 'sent', decided_by = ?, decided_at = ? WHERE id = ?`).run(user.id, secs(), a.id); // send() settles it too
  if (a.asked_by && a.asked_by !== user.id) buzz([a.asked_by], { title: `${a.building} ${a.unit}`, body: 'The boss OK\'d the renewal offer and it was sent.', url: `/?renewals=${r.id}`, tag: `renewal-ask-${a.id}` });
  return r;
}

/** The boss says no, with a note for the person. */
export async function decline(user, id, note) {
  if (!isMaster(user)) throw bad('Only the boss can answer this.', 403);
  const a = await get(id);
  if (!a || a.status !== 'waiting') throw bad('This offer is no longer waiting.', 409);
  const why = String(note || '').trim().slice(0, 1000);
  await db.prepare(`UPDATE lease_renewal_asks SET status = 'declined', note = ?, decided_by = ?, decided_at = ? WHERE id = ?`).run(why || null, user.id, secs(), a.id);
  if (a.asked_by && a.asked_by !== user.id) buzz([a.asked_by], { title: `${a.building} ${a.unit}`, body: `The boss did not OK the renewal offer${why ? `: ${why}` : '.'}`, url: '/?renewals=1', tag: `renewal-ask-${a.id}` });
  return get(a.id);
}

/** The person who asked (or a master) takes it back. */
export async function cancel(user, id) {
  const a = await get(id);
  if (!a || !['waiting', 'declined'].includes(a.status)) throw bad('This offer is no longer waiting.', 409);
  if (a.asked_by !== user.id && !isMaster(user)) throw bad('Only the person who asked can take it back.', 403);
  await db.prepare(`UPDATE lease_renewal_asks SET status = 'cancelled', decided_at = COALESCE(decided_at, ?) WHERE id = ?`).run(secs(), a.id);
  return get(a.id);
}

export const renewalAskRoutes = Router();
renewalAskRoutes.use(needsModule('renewals'));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
renewalAskRoutes.get('/', wrap(async (req, res) => { res.json(await listAsks(req.user)); }));
renewalAskRoutes.post('/', wrap(async (req, res) => { res.json(await askBoss(req.user, req.body || {})); }));
renewalAskRoutes.post('/:id/approve', wrap(async (req, res) => { const r = await approve(req.user, req.params.id, req.body || {}); res.json({ id: r.id }); }));
renewalAskRoutes.post('/:id/decline', wrap(async (req, res) => { res.json(await decline(req.user, req.params.id, req.body?.note)); }));
renewalAskRoutes.post('/:id/cancel', wrap(async (req, res) => { res.json(await cancel(req.user, req.params.id)); }));
