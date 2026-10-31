import { Router } from 'express';
import { db, tx } from './db.js';
import { isMaster, projectRole, projectsOf } from './access.js';
import { sendPush } from './push.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// Projects: a building job (the JVC school), recorded from chat by the people on site.
//
// The store keeper sends Reem a photo of a delivery and the material; Reem gets a card
// ready with the item, the quantity and the checks for that kind of material. Every check
// ticked: Accept, and it goes into stock. Anything not ticked: Send to manager, and a
// manager (office staff) decides from a push - Accept with note, or Reject. Material
// given out and each day's manpower are typed in chat the same way and confirmed on a card.
//
// Nothing is written from the chat itself: every tool only gets a card ready, and the tap
// on the card does it. The agent answers only from what was recorded here, and says so,
// because "not recorded" is the honest answer to most questions on a site where nothing
// was recorded before.
//
// Who: access.js projectRole - the master sees every project, a member their own.

const NOW = 'extract(epoch from now())::bigint';
const MAX_ROWS = 40; // trades in one day's manpower
const MAX_QUANTITY = 10_000_000;
const MAX_CHAT_LINES = 250;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const has = (text, part) => String(text).toLowerCase().includes(String(part ?? '').trim().toLowerCase());
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });

const canRecord = (role) => ['store', 'manager', 'master'].includes(role);
const canDecide = (role) => ['manager', 'master'].includes(role);

// What to look at when each kind of material arrives. Matched on the item's name; the first
// check is for every delivery. A photo cannot prove strength, so the certificates are asked
// for by name rather than guessed from a picture.
const CHECKS = [
  [/block/i, ['Right size and type', 'Few or no broken blocks', 'Approval / strength certificate', 'Made at least 28 days ago']],
  [/cement/i, ['Made in the last 3 months', 'No lumps', 'Bags not torn or wet']],
  [/steel|rebar|\bbar\b/i, ['Mill certificate', 'Right diameter', 'No heavy rust']],
  [/sand/i, ['Clean: no clay or rubbish', 'Right type of sand']],
];
const OTHER_CHECKS = ['Matches what was ordered', 'Not damaged'];
export const checksFor = (item, opening = false) => (opening ? ['Counted on site']
  : ['Quantity matches the delivery note', ...(CHECKS.find(([re]) => re.test(item))?.[1] || OTHER_CHECKS)]);

// ---------- reading ----------

/** The project and this person's place on it, or null when it is not theirs to see. */
async function projectFor(user, id) {
  const role = await projectRole(user, id);
  if (!role) return null;
  return { ...(await db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id))), role };
}

/** What is on site: in minus out, per item. */
export async function stockOf(projectId) {
  return db.prepare(`SELECT min(item) AS item, counted_in,
      sum(CASE WHEN kind = 'in' THEN quantity ELSE 0 END) AS received,
      sum(CASE WHEN kind = 'out' THEN quantity ELSE 0 END) AS given,
      sum(CASE WHEN kind IN ('in', 'count_up') THEN quantity ELSE -quantity END) AS on_site
    FROM project_moves WHERE project_id = ? GROUP BY lower(item), counted_in ORDER BY lower(min(item))`).all(projectId);
}

const onSite = async (projectId, item, countedIn) => Number((await db.prepare(`SELECT
    coalesce(sum(CASE WHEN kind IN ('in', 'count_up') THEN quantity ELSE -quantity END), 0) AS n
  FROM project_moves WHERE project_id = ? AND lower(item) = lower(?) AND counted_in = ?`).get(projectId, item, countedIn)).n);

/** The name already used for this item, so "hollow block 200mm" and "Hollow Block 200MM" are one line of stock. */
async function sameName(projectId, item) {
  const was = await db.prepare('SELECT item FROM project_moves WHERE project_id = ? AND lower(item) = lower(?) ORDER BY id LIMIT 1').get(projectId, item);
  return was?.item || item;
}

const floorOf = (p, v) => {
  const said = line(v, 40);
  return said ? (p.floors.find((f) => f.toLowerCase() === said.toLowerCase()) || said) : null;
};

const dayOf = (v) => {
  const d = line(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= dubaiDate() ? d : dubaiDate();
};

const proposalRow = (id) => db.prepare(`SELECT pp.*, p.name AS project, u.name AS by_name, d.name AS decided_name
  FROM project_proposals pp JOIN projects p ON p.id = pp.project_id
  LEFT JOIN users u ON u.id = pp.user_id LEFT JOIN users d ON d.id = pp.decided_by
  WHERE pp.id = ?`).get(Number(id) || 0);

/** A card as the app shows it, for this person: what they may do on it comes with it. */
async function card(user, p) {
  const role = await projectRole(user, p.project_id);
  const mine = p.user_id === user.id;
  const d = p.data;
  return {
    id: p.id, kind: p.kind, status: p.status, project: { id: p.project_id, name: p.project },
    data: d, failed: p.failed, note: p.note, by: p.by_name, decided_by: p.decided_name, created_at: p.created_at,
    on_site: d.item ? await onSite(p.project_id, d.item, d.counted_in) : null,
    can: {
      act: p.status === 'pending' && (mine || canDecide(role)),
      decide: p.status === 'sent' && canDecide(role),
    },
  };
}

/** A card, if this person may see it: whoever made it, and anyone on its project. */
export async function getProposal(user, id) {
  const p = await proposalRow(id);
  if (!p || (p.user_id !== user.id && !(await projectRole(user, p.project_id)))) return null;
  return card(user, p);
}

/** The project's screen: stock, the deliveries waiting for a manager, and what moved lately. */
export async function getProject(user, id) {
  const p = await projectFor(user, id);
  if (!p) return null;
  const waiting = await db.prepare(`SELECT id FROM project_proposals WHERE project_id = ? AND status = 'sent' ORDER BY id`).all(p.id);
  const members = await db.prepare(`SELECT m.user_id, m.role, u.name FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? ORDER BY m.role, u.name`).all(p.id);
  const moves = await db.prepare(`SELECT m.id, m.kind, m.item, m.counted_in, m.quantity, m.floor, m.supplier, m.party, m.day, m.note, m.at, u.name AS by_name
    FROM project_moves m LEFT JOIN users u ON u.id = m.by_user WHERE m.project_id = ? ORDER BY m.day DESC, m.id DESC LIMIT 300`).all(p.id);
  const rejected = await db.prepare(`SELECT id FROM project_proposals WHERE project_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 50`).all(p.id);
  return {
    project: { id: p.id, name: p.name, floors: p.floors, agent_id: p.agent_id }, role: p.role, members,
    stock: await stockOf(p.id),
    waiting: await Promise.all(waiting.map((r) => getProposal(user, r.id))),
    rejected: await Promise.all(rejected.map((r) => getProposal(user, r.id))),
    moves,
  };
}

/** Manpower day by day, newest first: { day, rows: [{ trade, subcontractor, count }], total }. */
export async function manpowerOf(user, id, { from, to } = {}) {
  const p = await projectFor(user, id);
  if (!p) return null;
  const rows = await db.prepare(`SELECT day, trade, subcontractor, count, floor FROM project_manpower
    WHERE project_id = ? AND day >= ? AND day <= ? ORDER BY day DESC, subcontractor, trade`)
    .all(p.id, line(from, 10) || '0000-00-00', line(to, 10) || '9999-99-99');
  const days = new Map();
  for (const r of rows) {
    const d = days.get(r.day) || { day: r.day, rows: [], total: 0 };
    d.rows.push(r);
    d.total += r.count;
    days.set(r.day, d);
  }
  return [...days.values()];
}

// ---------- the master sets a project up ----------

const ROLES = ['store', 'manager'];

/** Make or change a project: name, floors, the agent that speaks for it, and its people. The master only. */
export async function saveProject(user, id, body = {}) {
  if (!isMaster(user)) throw bad('Only the master sets up projects.', 403);
  const name = line(body.name, 120);
  if (!name) throw bad('Give the project a name.');
  const floors = [...new Set((Array.isArray(body.floors) ? body.floors : []).map((f) => line(f, 40)).filter(Boolean))].slice(0, 40);
  const agentId = Number(body.agent_id) || null;
  if (agentId && !(await db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId))) throw bad('That agent no longer exists.');
  const members = (Array.isArray(body.members) ? body.members : []).map((m) => ({ user_id: Number(m.user_id) || 0, role: m.role }));
  if (members.some((m) => !m.user_id || !ROLES.includes(m.role))) throw bad('Each person needs a role: store keeper or manager.');
  for (const m of members) {
    const u = await db.prepare('SELECT external FROM users WHERE id = ?').get(m.user_id);
    if (!u) throw bad('One of those people no longer has an account.');
    if (u.external) throw bad('Someone from outside the company cannot be on a project.');
  }
  return tx(async () => {
    let pid = Number(id) || 0;
    if (pid) {
      const { changes } = await db.prepare(`UPDATE projects SET name = ?, agent_id = ?${floors.length ? ', floors = ?::jsonb' : ''} WHERE id = ?`)
        .run(...[name, agentId, ...(floors.length ? [JSON.stringify(floors)] : []), pid]);
      if (!changes) return null;
    } else {
      pid = (await db.prepare(`INSERT INTO projects (name, agent_id, created_by${floors.length ? ', floors' : ''})
        VALUES (?, ?, ?${floors.length ? ', ?::jsonb' : ''}) RETURNING id`).run(...[name, agentId, user.id, ...(floors.length ? [JSON.stringify(floors)] : [])])).id;
    }
    await db.prepare('DELETE FROM project_members WHERE project_id = ?').run(pid);
    for (const m of new Map(members.map((x) => [x.user_id, x])).values()) {
      await db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(pid, m.user_id, m.role);
    }
    return getProject(user, pid);
  });
}

// ---------- cards from chat ----------

async function chatPhoto(userId, conversationId, name) {
  const want = line(name, 200).toLowerCase();
  const doc = await db.prepare(`SELECT id, name, mime FROM documents WHERE user_id = ? AND path IS NOT NULL AND lower(name) = ?
    ORDER BY (conversation_id IS NOT DISTINCT FROM ?) DESC, id DESC LIMIT 1`).get(userId, want, conversationId);
  if (!doc) throw bad(`There is no picture called "${name}" in this chat. Use the name from its <image name="…" /> tag, or leave it out.`);
  if (!PHOTO_TYPES.has(doc.mime)) throw bad(`${doc.name} is not a picture (JPG or PNG). Leave it out.`);
  return doc.id;
}

const amountOf = (v) => {
  const n = Math.round(Number(v) * 1000) / 1000;
  if (!(n > 0) || n > MAX_QUANTITY) throw bad('Give the quantity as a number above 0. If the user did not say it and it cannot be read, ask.');
  return n;
};

async function recorder(user, input, agentId) {
  const p = await pickProject(user, input.project, agentId);
  if (!canRecord(p.role)) throw bad(`This user is not the store keeper or a manager on ${p.name}, so they cannot record for it.`);
  return p;
}

async function saveCard(user, p, kind, data, conversationId) {
  const { id } = await db.prepare('INSERT INTO project_proposals (project_id, user_id, conversation_id, kind, data) VALUES (?, ?, ?, ?, ?::jsonb) RETURNING id')
    .run(p.id, user.id, conversationId || null, kind, JSON.stringify(data));
  return getProposal(user, id);
}

/** A delivery, ready on a card with its checks. Nothing goes into stock until Accept. */
export async function proposeDelivery(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await recorder(user, input, agentId);
  const item = await sameName(p.id, line(input.item, 80));
  if (!item) throw bad('Say what material came.');
  const opening = !!input.opening;
  const photos = [];
  for (const name of (Array.isArray(input.photos) ? input.photos : []).slice(0, 8)) photos.push(await chatPhoto(user.id, conversationId, name));
  return saveCard(user, p, 'delivery', {
    item, quantity: amountOf(input.quantity), counted_in: line(input.counted_in, 20) || 'pcs',
    supplier: opening ? 'Already on site' : line(input.supplier, 80) || null,
    delivery_note: line(input.delivery_note, 40) || null,
    day: dayOf(input.date), floor: floorOf(p, input.floor), notes: line(input.notes, 400) || null,
    photos, opening, checks: checksFor(item, opening),
  }, conversationId);
}

/** Material given out, ready on a card. */
export async function proposeOut(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await recorder(user, input, agentId);
  const item = await sameName(p.id, line(input.item, 80));
  if (!item) throw bad('Say what material was given out.');
  return saveCard(user, p, 'out', {
    item, quantity: amountOf(input.quantity), counted_in: line(input.counted_in, 20) || 'pcs',
    floor: floorOf(p, input.floor), party: line(input.given_to, 80) || null, day: dayOf(input.date), notes: line(input.notes, 400) || null,
  }, conversationId);
}

/** A day's manpower, ready on a card. Confirming it replaces anything already sent for that day. */
export async function proposeManpower(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await recorder(user, input, agentId);
  const rows = (Array.isArray(input.rows) ? input.rows : []).map((r) => ({
    trade: line(r?.trade, 60), count: Math.round(Number(r?.count)), subcontractor: line(r?.subcontractor, 80),
  })).filter((r) => r.trade && r.count > 0 && r.count < 10_000).slice(0, MAX_ROWS);
  if (!rows.length) throw bad('Say how many of each trade worked, e.g. "8 masons, 15 helpers".');
  const day = dayOf(input.date);
  const already = (await db.prepare('SELECT count(*)::int AS n FROM project_manpower WHERE project_id = ? AND day = ?').get(p.id, day)).n > 0;
  return saveCard(user, p, 'manpower', { day, rows, floor: floorOf(p, input.floor), notes: line(input.notes, 400) || null, replaces: already }, conversationId);
}

/**
 * A count of what is left, ready on a card. The store keeper counts a pile when it is small;
 * confirming it puts the record right by the difference.
 */
export async function proposeCount(user, input, { conversationId = null, agentId = null } = {}) {
  const p = await recorder(user, input, agentId);
  const item = await sameName(p.id, line(input.item, 80));
  if (!item) throw bad('Say what was counted.');
  const counted = Math.round(Number(input.counted) * 1000) / 1000;
  if (!(counted >= 0) || counted > MAX_QUANTITY) throw bad('Give the count as a number (0 if none is left).');
  return saveCard(user, p, 'count', {
    item, counted, counted_in: line(input.counted_in, 20) || 'pcs', day: dayOf(input.date), notes: line(input.notes, 400) || null,
  }, conversationId);
}

// ---------- the taps on a card ----------

/** Moves a card from one status to the next, once: the status is the lock, so a double tap does it once. */
async function step(p, from, to, extra = {}) {
  const keys = Object.keys(extra);
  const { changes } = await db.prepare(`UPDATE project_proposals SET status = ?, decided_at = ${NOW}${keys.map((k) => `, ${k} = ?`).join('')}
    WHERE id = ? AND status = ?`).run(to, ...keys.map((k) => extra[k]), p.id, from);
  if (!changes) throw bad('This was already decided.', 409);
}

const moveIn = (p, by, note) => db.prepare(`INSERT INTO project_moves (project_id, proposal_id, kind, item, counted_in, quantity, floor, supplier, day, note, by_user)
  VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.project_id, p.id, p.data.item, p.data.counted_in, p.data.quantity, p.data.floor, p.data.supplier, p.data.day,
  [p.data.notes, note].filter(Boolean).join(' · ') || null, by);

async function loaded(user, id, kind) {
  const p = await proposalRow(id);
  if (!p || (p.user_id !== user.id && !(await projectRole(user, p.project_id)))) return null;
  if (kind && p.kind !== kind) throw bad('That is not what this card is for.');
  return p;
}

/** Accept a delivery: only when every check was ticked. Anything else goes to a manager. */
export async function acceptDelivery(user, id, { passed = [] } = {}) {
  const p = await loaded(user, id, 'delivery');
  if (!p) return null;
  if (p.user_id !== user.id && !canDecide(await projectRole(user, p.project_id))) throw bad('Only whoever recorded this, or a manager, can accept it.', 403);
  const missing = p.data.checks.filter((c) => !passed.includes(c));
  if (missing.length) throw bad(`Not every check passed (${missing.join(', ')}). Send it to the manager instead.`);
  await tx(async () => {
    await step(p, 'pending', 'accepted', { decided_by: user.id });
    await moveIn(p, user.id);
  });
  return getProposal(user, id);
}

/** A delivery that failed a check goes to the project's managers, with what failed. */
export async function sendToManager(user, id, { passed = [], note = '' } = {}, push = sendPush) {
  const p = await loaded(user, id, 'delivery');
  if (!p) return null;
  if (p.user_id !== user.id) throw bad('Only whoever recorded this can send it on.', 403);
  const failed = p.data.checks.filter((c) => !passed.includes(c));
  const said = line(note, 400);
  if (!failed.length && !said) throw bad('Every check passed: tap Accept. To send it anyway, say what is wrong in the note.');
  await step(p, 'pending', 'sent', { failed: JSON.stringify(failed), note: said || null });
  let managers = (await db.prepare(`SELECT user_id FROM project_members WHERE project_id = ? AND role = 'manager'`).all(p.project_id)).map((r) => r.user_id);
  if (!managers.length) managers = (await db.prepare(`SELECT id AS user_id FROM users WHERE role = 'master'`).all()).map((r) => r.user_id);
  const d = p.data;
  push(managers, {
    title: `${p.project}: a delivery needs you`,
    body: `${num(d.quantity)} ${d.counted_in} ${d.item}${d.supplier ? ` from ${d.supplier}` : ''}. ${failed.length ? `Failed: ${failed.join(', ')}.` : ''} ${said}`.trim(),
    url: `/?projects=${p.project_id}`, tag: `project-delivery-${p.id}`,
  }).catch(() => {});
  return getProposal(user, id);
}

/** A manager's answer on a delivery sent to them: accept (with a note) or reject. */
export async function decideDelivery(user, id, { verdict, note = '' } = {}, push = sendPush) {
  const p = await loaded(user, id, 'delivery');
  if (!p) return null;
  if (!canDecide(await projectRole(user, p.project_id))) throw bad('Only a manager on this project decides this.', 403);
  if (!['accept', 'reject'].includes(verdict)) throw bad('Accept or reject?');
  const said = line(note, 400);
  if (verdict === 'reject' && !said) throw bad('Say why it is rejected, for the supplier and the store keeper.');
  const note2 = [p.note, said].filter(Boolean).join(' · ') || null;
  await tx(async () => {
    await step(p, 'sent', verdict === 'accept' ? 'accepted_note' : 'rejected', { decided_by: user.id, note: note2 });
    if (verdict === 'accept') await moveIn(p, user.id, said || null);
  });
  const d = p.data;
  if (p.user_id !== user.id) {
    push([p.user_id], {
      title: `${p.project}: delivery ${verdict === 'accept' ? 'accepted' : 'rejected'}`,
      body: `${num(d.quantity)} ${d.counted_in} ${d.item}${d.supplier ? ` from ${d.supplier}` : ''}${said ? `: ${said}` : ''}`,
      url: `/?projects=${p.project_id}`, tag: `project-delivery-${p.id}`,
    }).catch(() => {});
  }
  return getProposal(user, id);
}

/** Confirm material given out, or a day's manpower. */
export async function confirmCard(user, id) {
  const p = await loaded(user, id);
  if (!p) return null;
  if (p.kind === 'delivery') throw bad('A delivery is accepted or sent to the manager, not confirmed.');
  if (p.user_id !== user.id && !canDecide(await projectRole(user, p.project_id))) throw bad('Only whoever recorded this, or a manager, can confirm it.', 403);
  const d = p.data;
  await tx(async () => {
    await step(p, 'pending', 'confirmed', { decided_by: user.id });
    if (p.kind === 'count') {
      // The difference from the record at the moment of Confirm, not when the card was made.
      const diff = Math.round((d.counted - await onSite(p.project_id, d.item, d.counted_in)) * 1000) / 1000;
      if (diff) {
        await db.prepare(`INSERT INTO project_moves (project_id, proposal_id, kind, item, counted_in, quantity, day, note, by_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.project_id, p.id, diff > 0 ? 'count_up' : 'count_down', d.item, d.counted_in, Math.abs(diff), d.day,
          [`Counted ${num(d.counted)} on site`, d.notes].filter(Boolean).join(' · '), user.id);
      }
    } else if (p.kind === 'out') {
      await db.prepare(`INSERT INTO project_moves (project_id, proposal_id, kind, item, counted_in, quantity, floor, party, day, note, by_user)
        VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.project_id, p.id, d.item, d.counted_in, d.quantity, d.floor, d.party, d.day, d.notes, user.id);
    } else {
      await db.prepare('DELETE FROM project_manpower WHERE project_id = ? AND day = ?').run(p.project_id, d.day);
      for (const r of d.rows) {
        await db.prepare('INSERT INTO project_manpower (project_id, day, trade, subcontractor, count, floor, by_user) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(p.project_id, d.day, r.trade, r.subcontractor || '', r.count, d.floor, user.id);
      }
    }
  });
  return getProposal(user, id);
}

/** Cancel a card still waiting on its first tap. */
export async function cancelCard(user, id) {
  const p = await loaded(user, id);
  if (!p) return null;
  if (p.user_id !== user.id && !canDecide(await projectRole(user, p.project_id))) throw bad('Only whoever recorded this, or a manager, can cancel it.', 403);
  await step(p, 'pending', 'cancelled', { decided_by: user.id });
  return getProposal(user, id);
}

// ---------- Reem in chat ----------

/** The project a chat means: the one named, else the one this agent speaks for, else their only one. */
async function pickProject(user, name, agentId) {
  const mine = await projectsOf(user);
  if (!mine.length) throw bad('This user is on no project.');
  if (line(name, 120)) {
    const hits = mine.filter((p) => has(p.name, name));
    if (hits.length === 1) return hits[0];
    throw bad(hits.length ? `Which project? "${name}" could be ${hits.map((p) => p.name).join(', ')}. Ask which one.`
      : `No project of this user matches "${name}". Theirs: ${mine.map((p) => p.name).join(', ')}.`);
  }
  const spoken = mine.find((p) => agentId && p.agent_id === agentId);
  if (spoken) return spoken;
  if (mine.length === 1) return mine[0];
  throw bad(`Which project? This user is on ${mine.map((p) => p.name).join(', ')}. Ask which one.`);
}

const since = async (projectId) => (await db.prepare(`SELECT least((SELECT min(day) FROM project_moves WHERE project_id = ?),
  (SELECT min(day) FROM project_manpower WHERE project_id = ?)) AS d`).get(projectId, projectId)).d;

const NOT_BEFORE = (from) => (from
  ? `Recording in Reem started on ${from}. Anything before that, or never recorded, is not in these numbers - say so rather than guessing. ` +
    'Material that was already on site then is only in stock once it has been counted (COUNT lines); a stock below zero means old material was given out and not yet counted.'
  : 'Nothing has been recorded for this project yet. Say so plainly; do not estimate from files or guess.');

async function statusForChat(user, input, agentId) {
  const p = await pickProject(user, input.project, agentId);
  const stock = await stockOf(p.id);
  const waiting = await db.prepare(`SELECT data, failed, note FROM project_proposals WHERE project_id = ? AND status = 'sent' ORDER BY id`).all(p.id);
  const week = await db.prepare(`SELECT day, sum(count)::int AS n FROM project_manpower WHERE project_id = ? AND day > ? GROUP BY day ORDER BY day DESC`)
    .all(p.id, dubaiDate(Date.now() - 7 * 86400_000));
  const today = dubaiDate();
  return [
    `Project: ${p.name} (this user is ${p.role === 'store' ? 'the store keeper' : p.role === 'manager' ? 'a manager' : 'the master'}). Floors: ${p.floors.join(', ')}. Today: ${today}.`,
    NOT_BEFORE(await since(p.id)),
    '',
    'On site now (received minus given out):',
    ...(stock.length ? stock.map((s) => `  - ${s.item}: ${num(s.on_site)} ${s.counted_in} (received ${num(s.received)}, given out ${num(s.given)})`) : ['  nothing recorded']),
    '',
    `Deliveries waiting for a manager: ${waiting.length}`,
    ...waiting.map((w) => `  - ${num(w.data.quantity)} ${w.data.counted_in} ${w.data.item}${w.data.supplier ? ` from ${w.data.supplier}` : ''}; failed: ${(w.failed || []).join(', ') || '-'}${w.note ? `; note: ${w.note}` : ''}`),
    '',
    `Manpower, last 7 days: ${week.length ? week.map((w) => `${w.day}: ${w.n}`).join(', ') : 'none sent'}${week.some((w) => w.day === today) ? '' : ' (today not sent yet)'}`,
  ].join('\n');
}

async function recordsForChat(user, input, agentId) {
  const p = await pickProject(user, input.project, agentId);
  const from = line(input.from, 10) || '0000-00-00';
  const to = line(input.to, 10) || '9999-99-99';
  const what = input.what || 'all';
  const out = [NOT_BEFORE(await since(p.id)), ''];
  const keep = (r) => (!input.item || has(r.item, input.item)) && (!input.floor || has(r.floor || '', input.floor)) && (!input.supplier || has(r.supplier || '', input.supplier));

  if (['all', 'deliveries', 'given_out'].includes(what)) {
    const kinds = what === 'deliveries' ? ['in'] : what === 'given_out' ? ['out'] : ['in', 'out', 'count_up', 'count_down'];
    const rows = (await db.prepare(`SELECT * FROM project_moves WHERE project_id = ? AND day >= ? AND day <= ? AND kind = ANY(?::text[]) ORDER BY day, id`)
      .all(p.id, from, to, kinds)).filter(keep);
    const totals = new Map();
    for (const r of rows) {
      const k = `${{ in: 'Received', out: 'Given out', count_up: 'Count found more', count_down: 'Count found less' }[r.kind]}: ${r.item} (${r.counted_in})`;
      totals.set(k, (totals.get(k) || 0) + Number(r.quantity));
    }
    out.push(`Material moves (${rows.length}):`,
      ...rows.map((r) => `  ${r.day} ${{ in: 'IN ', out: 'OUT', count_up: 'COUNT +', count_down: 'COUNT -' }[r.kind]} ${num(r.quantity)} ${r.counted_in} ${r.item}${r.floor ? ` [${r.floor}]` : ''}` +
        `${r.supplier ? ` from ${r.supplier}` : ''}${r.party ? ` to ${r.party}` : ''}${r.note ? ` - ${r.note}` : ''}`),
      'Totals:', ...(totals.size ? [...totals].map(([k, n]) => `  ${k}: ${num(n)}`) : ['  none']), '');
  }
  if (['all', 'rejected'].includes(what)) {
    const rows = (await db.prepare(`SELECT data, failed, note FROM project_proposals WHERE project_id = ? AND kind = 'delivery' AND status = 'rejected' ORDER BY id`).all(p.id))
      .map((r) => ({ ...r.data, failed: r.failed, why: r.note })).filter((r) => r.day >= from && r.day <= to && keep(r));
    out.push(`Rejected deliveries (${rows.length}):`, ...rows.map((r) => `  ${r.day} ${num(r.quantity)} ${r.counted_in} ${r.item}${r.supplier ? ` from ${r.supplier}` : ''}` +
      `; failed: ${(r.failed || []).join(', ') || '-'}${r.why ? `; why: ${r.why}` : ''}`), '');
  }
  if (['all', 'manpower'].includes(what)) {
    const days = await manpowerOf(user, p.id, { from: input.from, to: input.to });
    const byTrade = new Map();
    for (const d of days) for (const r of d.rows) byTrade.set(r.trade, (byTrade.get(r.trade) || 0) + r.count);
    out.push(`Manpower (${days.length} days sent):`,
      ...days.map((d) => `  ${d.day}: ${d.rows.map((r) => `${r.count} ${r.trade}${r.subcontractor ? ` (${r.subcontractor})` : ''}`).join(', ')} = ${d.total}`),
      'Person-days by trade:', ...(byTrade.size ? [...byTrade].map(([t, n]) => `  ${t}: ${n}`) : ['  none']));
  }
  const lines = out.join('\n').split('\n');
  return lines.length > MAX_CHAT_LINES ? `${lines.slice(0, MAX_CHAT_LINES).join('\n')}\n(cut short: ask for fewer days, one item or one floor)` : lines.join('\n');
}

const PROJECT = { type: 'string', description: 'The project name, or part of it. Leave out unless the user names one: the chat\'s own project is used.' };
const DATE = { type: 'string', description: 'YYYY-MM-DD, only when the user says a day other than today.' };

const DEFS = {
  status: {
    name: 'project_status',
    description: 'A building project as recorded in Reem now: material on site (received minus given out), deliveries waiting for a manager, and manpower of the last 7 days. ' +
      'Use for "what is on site?", "how much cement is left?", "anything waiting for me?". Answer only from what it returns.',
    input_schema: { type: 'object', properties: { project: PROJECT } },
  },
  records: {
    name: 'project_records',
    description: 'The recorded history of a building project: deliveries received, material given out, rejected deliveries, and daily manpower, with totals. ' +
      'Use for "how many blocks were delivered?", "what went to the basement?", "how many helpers worked last week?", "which deliveries were rejected?". ' +
      'Every filter is optional. Answer only from what it returns: if something was not recorded, say "not recorded in Reem" - never estimate it from files or guess.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        what: { type: 'string', enum: ['all', 'deliveries', 'given_out', 'rejected', 'manpower'] },
        item: { type: 'string', description: 'Part of a material name, e.g. "block".' },
        floor: { type: 'string' },
        supplier: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
  delivery: {
    name: 'log_delivery',
    description: 'Get a delivery that arrived on site ready on a card, with the quality checks for that material. ' +
      'Use when the store keeper sends a photo of a delivery note or of material that arrived, or types "20 bags cement came from X". ' +
      'Read the supplier, item, quantity, unit and delivery note number from the photo; if the quantity cannot be read and was not said, ask. ' +
      'One call per material: a note with blocks and cement is two calls. Reuse the names already in stock (project_status) for the same material. ' +
      'For the count of what is already on site on the first day, set opening. ' +
      'This only shows a card: nothing is in stock until they tick the checks and tap Accept, or a manager accepts it. Never say it was recorded. ' +
      'If you see a problem in the photo (broken blocks, torn bags, rust), put it in notes.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        item: { type: 'string', description: 'Short and plain, with the size: "Hollow block 200mm", "Solid block 100mm", "Cement OPC", "Black sand", "Rebar 16mm".' },
        quantity: { type: 'number' },
        counted_in: { type: 'string', description: 'pcs, bags, tons, kg, m3, loads, rolls… Default pcs.' },
        supplier: { type: 'string' },
        delivery_note: { type: 'string', description: 'The delivery note or DO number, if readable.' },
        floor: { type: 'string', description: 'The floor it is for, if said.' },
        date: DATE,
        notes: { type: 'string' },
        photos: { type: 'array', items: { type: 'string' }, description: 'Names of the pictures attached to this message (from their <image name="…" /> tags).' },
        opening: { type: 'boolean', description: 'True only for counting what was already on site before recording started.' },
      },
      required: ['item', 'quantity'],
    },
  },
  out: {
    name: 'log_material_out',
    description: 'Get material given out from the store ready on a card: "gave 900 blocks to the GF masons", "10 bags cement to the plaster team for 1st floor". ' +
      'One call per material. Reuse the names already in stock. This only shows a card: nothing is taken off stock until they tap Confirm. Never say it was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        item: { type: 'string' },
        quantity: { type: 'number' },
        counted_in: { type: 'string', description: 'The same unit the stock uses for it. Default pcs.' },
        floor: { type: 'string' },
        given_to: { type: 'string', description: 'The team, subcontractor or person it went to.' },
        date: DATE,
        notes: { type: 'string' },
      },
      required: ['item', 'quantity'],
    },
  },
  count: {
    name: 'log_count',
    description: 'Get a count of what is left on site ready on a card: "cement left: 6 bags", "only 2 pallets of 200mm blocks left, about 200". ' +
      'Confirming it sets the stock of that item to the count, by recording the difference. Use the name already in stock for it. ' +
      'This is how material that was on site before recording started gets into the numbers, so suggest it when a stock is below zero or looks wrong. ' +
      'This only shows a card: nothing changes until they tap Confirm. Never say it was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        item: { type: 'string' },
        counted: { type: 'number', description: 'How many are left now. 0 if none.' },
        counted_in: { type: 'string', description: 'The same unit the stock uses for it. Default pcs.' },
        date: DATE,
        notes: { type: 'string' },
      },
      required: ['item', 'counted'],
    },
  },
  manpower: {
    name: 'log_manpower',
    description: 'Get a day\'s manpower on site ready on a card: how many of each trade worked, e.g. "8 masons, 15 helpers, 2 steel fixers", optionally per subcontractor. ' +
      'Counts, not names. One call covers the whole day; a second report of the same day replaces the first once confirmed. ' +
      'This only shows a card: nothing is recorded until they tap Confirm. Never say it was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        project: PROJECT,
        date: DATE,
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { trade: { type: 'string', description: 'Plural, plain: "Masons", "Helpers", "Steel fixers".' }, count: { type: 'integer' }, subcontractor: { type: 'string' } },
            required: ['trade', 'count'],
          },
        },
        floor: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['rows'],
    },
  },
};

const READY = ' NOT recorded yet - tell the user in one short line to check the card';

/**
 * The project tools, same shape as inventoryKit(). Only for people on a project; the
 * recording tools only for the store keeper, managers and the master.
 * ctx: { conversationId, agentId, onCard }.
 */
export async function projectKit(user, ctx = {}) {
  const mine = await projectsOf(user);
  const records = mine.some((p) => canRecord(p.role));
  const opts = { conversationId: ctx.conversationId, agentId: ctx.agentId };
  const shown = (c) => { ctx.onCard?.(c); return c; };
  const handlers = mine.length ? {
    project_status: (input) => statusForChat(user, input, ctx.agentId),
    project_records: (input) => recordsForChat(user, input, ctx.agentId),
    ...(records && {
      log_delivery: async (input) => {
        const c = shown(await proposeDelivery(user, input, opts));
        return `Card #${c.id}: ${num(c.data.quantity)} ${c.data.counted_in} ${c.data.item}${c.data.supplier ? ` from ${c.data.supplier}` : ''} for ${c.project.name}. ` +
          `Checks on it: ${c.data.checks.join('; ')}.${READY}, tick each check that is fine, and tap Accept - or Send to manager if any is not.`;
      },
      log_material_out: async (input) => {
        const c = shown(await proposeOut(user, input, opts));
        const short = c.on_site < c.data.quantity;
        return `Card #${c.id}: ${num(c.data.quantity)} ${c.data.counted_in} ${c.data.item} out${c.data.party ? ` to ${c.data.party}` : ''}. ` +
          `Recorded on site now: ${num(c.on_site)}${short ? ' - LESS than this; mention it (a delivery may not have been recorded)' : ''}.${READY} and tap Confirm.`;
      },
      log_count: async (input) => {
        const c = shown(await proposeCount(user, input, opts));
        return `Card #${c.id}: counted ${num(c.data.counted)} ${c.data.counted_in} ${c.data.item}; the record says ${num(c.on_site)}.${READY} and tap Confirm.`;
      },
      log_manpower: async (input) => {
        const c = shown(await proposeManpower(user, input, opts));
        const total = c.data.rows.reduce((n, r) => n + r.count, 0);
        return `Card #${c.id}: ${total} people on ${c.data.day}.${c.data.replaces ? ' This day was already sent; confirming replaces it.' : ''}${READY} and tap Confirm.`;
      },
    }),
  } : {};
  return {
    definitions: Object.values(DEFS).filter((d) => handlers[d.name]),
    status: (name) => (name.startsWith('log_') ? 'Getting the card ready…' : 'Looking at the project records…'),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- the 5 pm manpower reminder ----------

/** Once a Dubai day, from 5 pm: the store keeper of a project with no manpower sent for today gets a push. */
export async function remindManpower(push = sendPush, at = Date.now()) {
  if (dubaiHour(at) < 17 || dubaiHour(at) >= 22) return 0;
  const today = dubaiDate(at);
  const due = await db.prepare(`SELECT p.id, p.name FROM projects p
    WHERE p.reminded_on IS DISTINCT FROM ?
      AND NOT EXISTS (SELECT 1 FROM project_manpower m WHERE m.project_id = p.id AND m.day = ?)`).all(today, today);
  let n = 0;
  for (const p of due) {
    const { changes } = await db.prepare('UPDATE projects SET reminded_on = ? WHERE id = ? AND reminded_on IS DISTINCT FROM ?').run(today, p.id, today);
    if (!changes) continue;
    const store = (await db.prepare(`SELECT user_id FROM project_members WHERE project_id = ? AND role = 'store'`).all(p.id)).map((r) => r.user_id);
    if (!store.length) continue;
    await push(store, { title: `${p.name}: today's manpower`, body: 'Not sent yet. Tell Reem in a chat, e.g. "8 masons, 15 helpers, 2 steel fixers".', url: '/', tag: `project-manpower-${p.id}` }).catch(() => {});
    n++;
  }
  return n;
}

export function startProjects() {
  const tick = () => remindManpower().catch((e) => console.error('[projects]', e.message));
  setInterval(tick, 10 * 60_000).unref();
  tick();
}

// ---------- routes ----------

export const projectRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, row) => (row ? res.json(row) : res.status(404).json({ error: 'Not found' }));

// Cards from chat. Before the '/:id' routes, so "proposals" is never read as a project.
projectRoutes.get('/proposals', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM project_proposals WHERE user_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(await Promise.all(rows.map((r) => getProposal(req.user, r.id))));
}));
// A delivery's photo: for whoever made the card and anyone on the project, so the manager sees it too.
projectRoutes.get('/proposals/:id/photo/:doc', wrap(async (req, res) => {
  const p = await loaded(req.user, req.params.id);
  const docId = Number(req.params.doc) || 0;
  const doc = p?.data.photos?.includes(docId) && await db.prepare('SELECT mime, path FROM documents WHERE id = ? AND user_id = ? AND path IS NOT NULL').get(docId, p.user_id);
  if (!doc || !PHOTO_TYPES.has(doc.mime)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').type(doc.mime).sendFile(doc.path);
}));
projectRoutes.post('/proposals/:id/accept', wrap(async (req, res) => send(res, await acceptDelivery(req.user, req.params.id, req.body || {}))));
projectRoutes.post('/proposals/:id/send', wrap(async (req, res) => send(res, await sendToManager(req.user, req.params.id, req.body || {}))));
projectRoutes.post('/proposals/:id/decide', wrap(async (req, res) => send(res, await decideDelivery(req.user, req.params.id, req.body || {}))));
projectRoutes.post('/proposals/:id/confirm', wrap(async (req, res) => send(res, await confirmCard(req.user, req.params.id))));
projectRoutes.post('/proposals/:id/cancel', wrap(async (req, res) => send(res, await cancelCard(req.user, req.params.id))));

projectRoutes.get('/', wrap(async (req, res) => {
  res.json((await projectsOf(req.user)).map((p) => ({ id: p.id, name: p.name, role: p.role })));
}));
projectRoutes.post('/', wrap(async (req, res) => send(res, await saveProject(req.user, null, req.body))));
projectRoutes.put('/:id', wrap(async (req, res) => send(res, await saveProject(req.user, req.params.id, req.body))));
projectRoutes.get('/:id', wrap(async (req, res) => send(res, await getProject(req.user, req.params.id))));
projectRoutes.get('/:id/manpower', wrap(async (req, res) => send(res, await manpowerOf(req.user, req.params.id, req.query))));
