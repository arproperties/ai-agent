import { Router } from 'express';
import { db } from './db.js';

// The to-do list: one per user, each item with an optional reminder.
//
// A reminder here is a TIME, not a delivery. Nothing is emailed and nothing is pushed.
// When the time arrives the todo becomes due, and due work surfaces the way expiring
// paperwork already does — a count on the menu and a line on the first screen. That is
// deliberate: it needs no scheduler, no SMTP and no notification permission, so it cannot
// quietly stop working, and it cannot spend money while nobody is looking.

const MAX_TEXT = 300;
const MAX_NOTES = 2000;
const NOW = 'extract(epoch from now())::bigint';

// A reminder written without a timezone is read as Gulf Standard Time, not as the
// server's own clock: the user is in the UAE and the live server runs on UTC, so "9am"
// taken locally would land at 1pm for them. The app's own picker sends epoch seconds and
// never comes through here; this is for the ISO strings agents write.
const UAE_OFFSET = '+04:00';
const MORNING = 'T09:00:00'; // a bare date means that morning, not midnight

/** Epoch seconds from whatever the caller had: a number, an ISO string, or a bare date. */
export function remindAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    // Seconds, not milliseconds — a JS timestamp pasted in would land in the year 56000.
    return n > 1e11 ? Math.round(n / 1000) : n;
  }
  const text = String(value).trim();
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}${MORNING}` : text;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(dated) ? dated : `${dated}${UAE_OFFSET}`;
  const ms = Date.parse(zoned);
  if (Number.isNaN(ms)) throw bad(`"${value}" is not a date and time I can read. Use YYYY-MM-DDTHH:MM+04:00.`);
  return Math.round(ms / 1000);
}

const SELECT = `SELECT t.*, a.name agent_name, d.title doc_title, d.name doc_name
  FROM todos t
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN documents d ON d.id = t.document_id AND d.user_id = t.user_id`;

export const todoOut = ({ user_id, ...t }) => t;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (n, lo, hi, dflt) => Math.min(Math.max(Number(n) || dflt, lo), hi);

/** done: false = still to do, true = the finished ones. */
export function listTodos(userId, { done = false, limit = 200 } = {}) {
  // Two orderings, two cached statements. Open items lead with whatever is due soonest
  // and end with the ones carrying no reminder at all; finished ones are newest-first,
  // because the only reason to look at them is "what did I just tick off".
  const order = done ? 't.done_at DESC NULLS LAST, t.id DESC' : 't.remind_at ASC NULLS LAST, t.id DESC';
  return db.prepare(`${SELECT} WHERE t.user_id = ? AND t.done = ? ORDER BY ${order} LIMIT ?`)
    .all(userId, done, clamp(limit, 1, 500, 200));
}

/** Open todos whose reminder time has arrived — what the badge counts and the chat line shows. */
export function dueTodos(userId, limit = 100) {
  return db.prepare(`${SELECT} WHERE t.user_id = ? AND NOT t.done
      AND t.remind_at IS NOT NULL AND t.remind_at <= ${NOW}
    ORDER BY t.remind_at ASC LIMIT ?`).all(userId, clamp(limit, 1, 500, 100));
}

export const getTodo = (userId, id) => db.prepare(`${SELECT} WHERE t.id = ? AND t.user_id = ?`).get(Number(id), userId);

export async function createTodo(userId, { text, notes, remind_at, agentId = null, conversationId = null, documentId = null }) {
  const body = clean(text, MAX_TEXT);
  if (!body) throw bad('A todo needs something to do');
  // A document id is only honoured when it is this user's own; anything else is dropped
  // rather than refused, because the todo is still worth keeping without the link.
  const doc = documentId && await db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(Number(documentId), userId);
  const { id } = await db.prepare(`INSERT INTO todos (user_id, agent_id, conversation_id, document_id, text, notes, remind_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(userId, agentId, conversationId, doc?.id ?? null, body, clean(notes, MAX_NOTES) || null, remindAt(remind_at));
  return getTodo(userId, id);
}

/** Only the fields actually present are touched, so a tick never wipes a reminder. */
export async function updateTodo(userId, id, patch) {
  const t = await getTodo(userId, id);
  if (!t) return null;
  const text = 'text' in patch ? clean(patch.text, MAX_TEXT) || t.text : t.text;
  const notes = 'notes' in patch ? clean(patch.notes, MAX_NOTES) || null : t.notes;
  const remind = 'remind_at' in patch ? remindAt(patch.remind_at) : t.remind_at;
  const done = 'done' in patch ? !!patch.done : t.done;
  // done_at is the moment it was ticked, not the moment it was last edited, so re-opening
  // clears it — otherwise a reopened todo would sort among the finished ones by a stale time.
  await db.prepare(`UPDATE todos SET text = ?, notes = ?, remind_at = ?, done = ?,
      done_at = CASE WHEN ? THEN COALESCE(done_at, ${NOW}) ELSE NULL END, updated_at = ${NOW}
    WHERE id = ? AND user_id = ?`).run(text, notes, remind, done, done, t.id, userId);
  return getTodo(userId, id);
}

export const deleteTodo = async (userId, id) =>
  (await db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(Number(id), userId)).changes > 0;

// ---------- how a todo reads back to an agent ----------

// Absolute dates, never "in 3 days": the agent is told the current time once, at the top
// of the turn, and a relative phrase computed here would drift against it.
const stamp = (secs) => new Date(secs * 1000).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function line(t, now) {
  const bits = [`#${t.id}`, t.text];
  if (t.remind_at) bits.push(t.done ? `(was due ${stamp(t.remind_at)})` : t.remind_at <= now ? `— DUE since ${stamp(t.remind_at)}` : `— due ${stamp(t.remind_at)}`);
  if (t.notes) bits.push(`\n    ${t.notes}`);
  if (t.doc_title || t.doc_name) bits.push(`[file: ${t.doc_title || t.doc_name}]`);
  return `- ${bits.join(' ')}`;
}

export const TODO_TOOLS = [
  {
    name: 'add_todo',
    description: "Write something down on the user's to-do list. Use this whenever they ask you to remember to do something, " +
      'ask to be reminded, or say they need to do something later. Tell them in your reply that you have added it. ' +
      'The reminder is optional — leave remind_at out unless a time was actually meant.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The task, in the user\'s own words, short and actionable. E.g. "Renew the trade licence".' },
        remind_at: {
          type: 'string',
          description: 'Optional. When it should come up, as ISO 8601 WITH the UAE offset, e.g. "2026-10-05T09:00:00+04:00". ' +
            'Work it out from the current date and time given to you. A bare date like "2026-10-05" means 9am that morning. Omit it if no time was meant.',
        },
        notes: { type: 'string', description: 'Optional detail worth keeping — a reference number, an address, what it is for.' },
        document_id: { type: 'integer', description: "Optional: the id of a file in the user's library this is about, e.g. the licence being renewed." },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_todos',
    description: "Read back the user's to-do list. Use it when they ask what is on their list, what is outstanding, " +
      'what is due, or before saying anything about what they still have to do. Returns each todo with its id.',
    input_schema: {
      type: 'object',
      properties: {
        due_only: { type: 'boolean', description: 'Only the ones whose reminder time has already arrived. Default false.' },
        include_done: { type: 'boolean', description: 'Also list what has been ticked off. Default false.' },
      },
    },
  },
  {
    name: 'complete_todo',
    description: 'Tick a todo off as done, by the id list_todos or add_todo gave you. Only when the user says it is finished. ' +
      'It is not deleted and the user can re-open it, so this is safe to undo.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'reschedule_todo',
    description: 'Move a todo\'s reminder to a different time, or remove the reminder while keeping the todo. ' +
      'Use it for "push that to next week" or "actually, no rush on that".',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        remind_at: { type: 'string', description: 'The new time, ISO 8601 with the UAE offset. Send an empty string to drop the reminder and leave the todo open.' },
      },
      required: ['id', 'remind_at'],
    },
  },
];

/** The label the chat screen shows while one of these runs; null for a tool that is not ours. */
export function todoStatus(name) {
  switch (name) {
    case 'add_todo': return 'Adding to your list…';
    case 'list_todos': return 'Checking your to-do list…';
    case 'complete_todo': return 'Ticking that off…';
    case 'reschedule_todo': return 'Moving that reminder…';
    default: return null;
  }
}

// There is deliberately no delete tool. Completing is reversible and shows what happened;
// an agent that can erase a row can erase the evidence of having erased it.
const handlers = {
  add_todo: async (userId, ctx, input) => {
    const t = await createTodo(userId, {
      text: input.text, notes: input.notes, remind_at: input.remind_at,
      agentId: ctx.agentId, conversationId: ctx.conversationId, documentId: input.document_id,
    });
    const when = t.remind_at ? ` It will come up on ${stamp(t.remind_at)}.` : ' No reminder was set, so it just sits on the list.';
    return `Added as todo #${t.id}: "${t.text}".${when} It is on their list in the app — Jarvis cannot notify them elsewhere, so tell them it is waiting there rather than promising an alert.`;
  },

  list_todos: async (userId, ctx, input) => {
    const now = Math.floor(Date.now() / 1000);
    const open = input.due_only ? await dueTodos(userId) : await listTodos(userId, { done: false });
    const done = input.include_done ? await listTodos(userId, { done: true, limit: 20 }) : [];
    if (!open.length && !done.length) return input.due_only ? 'Nothing is due right now.' : 'Their to-do list is empty.';
    const parts = [];
    if (open.length) parts.push(`${input.due_only ? 'Due now' : 'Still to do'} (${open.length}):\n${open.map((t) => line(t, now)).join('\n')}`);
    else if (!input.due_only) parts.push('Nothing is outstanding.');
    if (done.length) parts.push(`Recently done (${done.length}):\n${done.map((t) => line(t, now)).join('\n')}`);
    return parts.join('\n\n');
  },

  complete_todo: async (userId, ctx, input) => {
    const t = await updateTodo(userId, input.id, { done: true });
    if (!t) throw new Error(`There is no todo #${input.id} on this list. Call list_todos to see the ids.`);
    return `Ticked off #${t.id}: "${t.text}".`;
  },

  reschedule_todo: async (userId, ctx, input) => {
    const t = await updateTodo(userId, input.id, { remind_at: input.remind_at });
    if (!t) throw new Error(`There is no todo #${input.id} on this list. Call list_todos to see the ids.`);
    return t.remind_at
      ? `#${t.id} ("${t.text}") will now come up on ${stamp(t.remind_at)}.`
      : `#${t.id} ("${t.text}") no longer has a reminder. It stays on the list.`;
  },
};

/**
 * The todo tools, in the same shape connectedMailbox() returns, so chat.js can hold a
 * list of toolkits and not care which one a call belongs to.
 * ctx: { agentId, conversationId } — so a todo remembers who raised it and where.
 */
export function todoKit(userId, ctx = {}) {
  return {
    definitions: TODO_TOOLS,
    status: (name) => todoStatus(name),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(userId, ctx, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const todoRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'Todo not found' });

// ?done=1 for the finished ones. The app asks for both and keeps them in one screen.
todoRoutes.get('/', wrap(async (req, res) => {
  res.json((await listTodos(req.user.id, { done: req.query.done === '1' })).map(todoOut));
}));
// Above nothing else, but kept first on principle: a later '/:id' must not swallow it.
todoRoutes.get('/due', wrap(async (req, res) => {
  res.json((await dueTodos(req.user.id)).map(todoOut));
}));
// agent_id is not accepted from the browser: it records which agent raised a todo, and
// only the chat tools are in a position to know that honestly.
todoRoutes.post('/', wrap(async (req, res) => {
  res.json(todoOut(await createTodo(req.user.id, {
    text: req.body.text, notes: req.body.notes, remind_at: req.body.remind_at, documentId: req.body.document_id,
  })));
}));
todoRoutes.patch('/:id', wrap(async (req, res) => {
  const t = await updateTodo(req.user.id, req.params.id, req.body);
  t ? res.json(todoOut(t)) : gone(res);
}));
todoRoutes.delete('/:id', wrap(async (req, res) => {
  (await deleteTodo(req.user.id, req.params.id)) ? res.json({ ok: true }) : gone(res);
}));
