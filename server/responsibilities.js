import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { sendPush } from './push.js';

// What each person is responsible for. The master writes them, in whatever words they
// like, from the person's page under People. Each person can read their own (never edit
// them), and their phone buzzes when one is added or changed, so a new duty is not
// something they find out about by accident.
//
// Reem reads them too (responsibilityKit below), so "who handles rent collection?" has
// an answer in chat, and the master can add, change or remove them from chat - always
// through a Save/Cancel card, never straight in.

const MAX_TITLE = 120;
const MAX_BODY = 20000;
const NOW = 'extract(epoch from now())::bigint';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function clean({ title, body }) {
  const out = {
    title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || null,
    body: String(body ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY),
  };
  if (!out.title && !out.body) throw bad('Write something first');
  return out;
}

const COLS = 'id, user_id, title, body, created_at, updated_at';

export const listFor = (userId) =>
  db.prepare(`SELECT ${COLS} FROM responsibilities WHERE user_id = ? ORDER BY id`).all(Number(userId));

/** The buzz on their phone. Not when the master writes their own - they know. */
function tell(master, userId, row, changed) {
  if (Number(userId) === master.id) return;
  const what = row.title || row.body.split('\n')[0];
  sendPush([Number(userId)], {
    title: changed ? 'A responsibility of yours was updated' : 'You have a new responsibility',
    body: what,
    url: '/?responsibilities=1',
    tag: `reem-resp-${row.id}`,
  }).catch((e) => console.warn('[responsibilities] push', e.message));
}

export async function addResponsibility(master, userId, input) {
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw bad('User not found', 404);
  const c = clean(input);
  const row = await db.prepare(`INSERT INTO responsibilities (user_id, title, body, created_by) VALUES (?, ?, ?, ?) RETURNING ${COLS}`)
    .get(target.id, c.title, c.body, master.id);
  tell(master, target.id, row, false);
  return row;
}

export async function updateResponsibility(master, id, input) {
  const c = clean(input);
  const row = await db.prepare(`UPDATE responsibilities SET title = ?, body = ?, updated_at = ${NOW} WHERE id = ? RETURNING ${COLS}`)
    .get(c.title, c.body, Number(id));
  if (!row) throw bad('Not found', 404);
  tell(master, row.user_id, row, true);
  return row;
}

export const deleteResponsibility = async (id) =>
  (await db.prepare('DELETE FROM responsibilities WHERE id = ?').run(Number(id))).changes > 0;

// ---------- proposals from chat ----------
//
// The master can say "give Rona rent collection: …" in chat. Reem never writes it
// straight in: it is proposed, a card appears with Save and Cancel, and only Save
// changes the list - a misheard name is caught on the card, not on Rona's phone.

/** "Rona", "rona@…", "me" → one active person. Unclear or unknown names are errors that list who there is. */
export async function findPerson(masterId, raw) {
  const want = String(raw || '').trim().toLowerCase();
  const pool = await db.prepare('SELECT id, name, email FROM users WHERE NOT disabled ORDER BY lower(name)').all();
  if (['me', 'myself', 'my', 'mine'].includes(want)) return pool.find((u) => u.id === masterId) || null;
  if (!want) throw bad('Say who it is for.');
  const tiers = [
    (u) => u.name.toLowerCase() === want,
    (u) => u.name.toLowerCase().split(/\s+/).includes(want),
    (u) => u.email.toLowerCase() === want || u.email.toLowerCase().split('@')[0] === want,
    (u) => u.name.toLowerCase().includes(want),
  ];
  for (const fits of tiers) {
    const hits = pool.filter(fits);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw bad(`"${raw}" could be ${hits.map((u) => u.name).join(' or ')}. Ask which one.`);
  }
  throw bad(`Nobody called "${raw}" uses Reem. The people are: ${pool.map((u) => u.name).join(', ')}.`);
}

export async function getProposal(masterId, id) {
  return db.prepare(`SELECT p.id, p.conversation_id, p.action, p.user_id, u.name AS person, p.responsibility_id,
      p.title, p.body, p.status, p.result_id, p.decided_at, p.created_at,
      r.title AS old_title, r.body AS old_body
    FROM responsibility_proposals p JOIN users u ON u.id = p.user_id
    LEFT JOIN responsibilities r ON r.id = p.responsibility_id
    WHERE p.id = ? AND p.master_id = ?`).get(Number(id), masterId);
}

export async function propose(master, { action, person, id, title, body, append, conversationId = null }) {
  let userId;
  let rid = null;
  let c = { title: null, body: '' };
  if (action === 'add') {
    const who = await findPerson(master.id, person);
    userId = who.id;
    c = clean({ title, body });
  } else {
    const old = await db.prepare('SELECT * FROM responsibilities WHERE id = ?').get(Number(id) || 0);
    if (!old) throw bad(`There is no responsibility #${id}. Call team_responsibilities for the ids.`);
    userId = old.user_id;
    rid = old.id;
    if (action === 'edit') {
      const nextBody = [body ?? old.body, append].filter((x) => x != null && String(x).trim()).join('\n');
      c = clean({ title: title ?? old.title, body: nextBody });
    }
  }
  const { id: pid } = await db.prepare(`INSERT INTO responsibility_proposals
      (master_id, conversation_id, action, user_id, responsibility_id, title, body) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(master.id, conversationId, action, userId, rid, c.title, c.body);
  return getProposal(master.id, pid);
}

/** Save or Cancel on the card. The status change is the lock, so a double tap writes once. */
export async function decide(master, id, save) {
  const p = await getProposal(master.id, id);
  if (!p) return null;
  if (p.status !== 'pending') throw bad(`This was already ${p.status}.`, 409);
  const { changes } = await db.prepare(`UPDATE responsibility_proposals SET status = ?, decided_at = ${NOW} WHERE id = ? AND status = 'pending'`)
    .run(save ? 'saved' : 'cancelled', p.id);
  if (!changes) throw bad('This was already decided.', 409);
  if (save) {
    try {
      let resultId = p.responsibility_id;
      if (p.action === 'add') resultId = (await addResponsibility(master, p.user_id, p)).id;
      else if (p.action === 'edit') {
        if (!p.responsibility_id) throw bad('That responsibility has since been deleted.', 409);
        await updateResponsibility(master, p.responsibility_id, p);
      } else if (p.responsibility_id) await deleteResponsibility(p.responsibility_id);
      await db.prepare('UPDATE responsibility_proposals SET result_id = ? WHERE id = ?').run(resultId, p.id);
    } catch (e) {
      await db.prepare(`UPDATE responsibility_proposals SET status = 'pending', decided_at = NULL WHERE id = ?`).run(p.id);
      throw e;
    }
  }
  return getProposal(master.id, id);
}

// ---------- chat tools ----------

const PER_ITEM = 1500; // a long one is cut in the tool result, never in the table
const PER_CALL = 24000;

const DEFS = {
  team_responsibilities: {
    name: 'team_responsibilities',
    description: 'What each person in the team is responsible for, as written by the owner. Use for "who handles X?", ' +
      '"what is Rona responsible for?", "what are my responsibilities?", or to pick the right person before reminding someone. ' +
      'Leave person empty to get everyone.',
    input_schema: {
      type: 'object',
      properties: { person: { type: 'string', description: 'Optional. A name, part of a name, or "me" for the user.' } },
    },
  },
  assign_responsibility: {
    name: 'assign_responsibility',
    description: 'Give a person a new responsibility ("give Rona rent collection: chase late payers by the 5th"). ' +
      'This does NOT save it: a card with Save and Cancel appears in the chat. Say in one short line that it is ready to save. ' +
      'Keep the user\'s own words in body; do not shorten or rewrite them. If a name is unclear the tool says so - ask, do not guess.',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Who it is for: a name, or "me".' },
        title: { type: 'string', description: 'A few words, e.g. "Rent collection". Optional.' },
        body: { type: 'string', description: 'The details, as long as needed, in the user\'s words.' },
      },
      required: ['person'],
    },
  },
  change_responsibility: {
    name: 'change_responsibility',
    description: 'Change an existing responsibility by id (get ids from team_responsibilities). Use append to add a line to what is there, ' +
      'or body to replace the details. Not saved until the user taps Save on the card.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string', description: 'Optional new title.' },
        body: { type: 'string', description: 'Optional: the whole new details, replacing the old.' },
        append: { type: 'string', description: 'Optional: text added on a new line at the end.' },
      },
      required: ['id'],
    },
  },
  remove_responsibility: {
    name: 'remove_responsibility',
    description: 'Remove a responsibility by id (get ids from team_responsibilities). Not removed until the user taps Save on the card.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
};

const STATUS = {
  team_responsibilities: 'Checking who is responsible…',
  assign_responsibility: 'Getting it ready…',
  change_responsibility: 'Getting the change ready…',
  remove_responsibility: 'Getting it ready…',
};

async function directory(user, person) {
  const want = String(person || '').trim().toLowerCase();
  const rows = await db.prepare(`
    SELECT r.id, u.id AS uid, u.name, r.title, r.body FROM responsibilities r
    JOIN users u ON u.id = r.user_id
    WHERE NOT u.disabled ORDER BY lower(u.name), r.id`).all();
  const mine = ['me', 'my', 'mine'].includes(want);
  const picked = rows.filter((r) => (mine ? r.uid === user.id : !want || r.name.toLowerCase().includes(want)));
  if (!picked.length) {
    return rows.length ? `Nothing written down for ${mine ? 'the user' : `"${person}"`}.` : 'No responsibilities have been written down for anyone yet.';
  }
  const master = user.role === 'master'; // only the master needs ids, to change them
  const people = new Map();
  for (const r of picked) {
    const text = [r.title, r.body.length > PER_ITEM ? `${r.body.slice(0, PER_ITEM)}…` : r.body].filter(Boolean).join(': ');
    people.set(r.name, [...(people.get(r.name) || []), `- ${master ? `#${r.id} ` : ''}${text}`]);
  }
  return [...people].map(([name, lines]) => `${name}${picked.find((r) => r.name === name).uid === user.id ? ' (the user)' : ''}:\n${lines.join('\n')}`)
    .join('\n\n').slice(0, PER_CALL);
}

/**
 * Everyone may read the directory - the point is knowing who to go to. Only the master
 * gets the three tools that change it, and those only ever propose.
 * ctx: { conversationId, onCard } - onCard puts the Save/Cancel card in front of them.
 */
export function responsibilityKit(user, ctx = {}) {
  const master = user.role === 'master';
  const ready = (p) => {
    ctx.onCard?.(p);
    return `Ready as card #${p.id} for ${p.person}. It is NOT saved yet - tell the user to tap Save on the card. Never say it is saved.`;
  };
  const handlers = {
    team_responsibilities: (input) => directory(user, input.person),
    ...(master && {
      assign_responsibility: async (input) => ready(await propose(user, { action: 'add', ...input, conversationId: ctx.conversationId })),
      change_responsibility: async (input) => ready(await propose(user, { action: 'edit', ...input, conversationId: ctx.conversationId })),
      remove_responsibility: async (input) => ready(await propose(user, { action: 'remove', id: input.id, conversationId: ctx.conversationId })),
    }),
  };
  return {
    definitions: Object.keys(handlers).map((n) => DEFS[n]),
    status: (name) => STATUS[name] || null,
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

// ---------- routes ----------

export const responsibilityRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// My own - read only.
responsibilityRoutes.get('/mine', wrap(async (req, res) => res.json(await listFor(req.user.id))));

// The master's side: anyone's, and the only way to change them.
responsibilityRoutes.get('/user/:id', requireMaster, wrap(async (req, res) => res.json(await listFor(req.params.id))));
responsibilityRoutes.post('/user/:id', requireMaster, wrap(async (req, res) => res.json(await addResponsibility(req.user, req.params.id, req.body || {}))));
// Cards from chat. Before the '/:id' routes, so "proposals" is never read as an id.
responsibilityRoutes.get('/proposals', requireMaster, wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id FROM responsibility_proposals WHERE master_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(await Promise.all(rows.map((r) => getProposal(req.user.id, r.id))));
}));
for (const [path, save] of [['save', true], ['cancel', false]]) {
  responsibilityRoutes.post(`/proposals/:id/${path}`, requireMaster, wrap(async (req, res) => {
    const p = await decide(req.user, req.params.id, save);
    p ? res.json(p) : res.status(404).json({ error: 'Not found' });
  }));
}
responsibilityRoutes.put('/:id', requireMaster, wrap(async (req, res) => res.json(await updateResponsibility(req.user, req.params.id, req.body || {}))));
responsibilityRoutes.delete('/:id', requireMaster, wrap(async (req, res) => {
  (await deleteResponsibility(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));
