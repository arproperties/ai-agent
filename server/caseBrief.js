// The case brief: one short note per person and case of what has been settled so far.
//
// Work on one case is spread over many chats, and each new chat started from nothing. So
// after a case chat goes quiet, the fast model reads what was said since it last looked and
// suggests an updated brief. Nothing goes into the brief until the person approves it (or
// edits it and approves): it is handed to every later chat on the case as fact, so a wrong
// guess would be repeated everywhere. One suggestion waits per case; a newer chat builds on
// it rather than piling a second one beside it.
//
// The first runs go back over every case chat there already is, oldest first, a few a tick.
import { db, tx } from './db.js';
import { ask } from './ai.js';
import { billAs } from './billing.js';
import { caseKey } from './caseMatch.js';
import { transcript } from './chatRecap.js';

const QUIET = 15 * 60;    // seconds since a chat's last change before it is read
const WINDOW = 120;       // newest unread messages read from one chat at a time
const PER_TICK = 5;       // chats read per tick, so going back over old chats is spread out
const EVERY = 10 * 60_000;
const FIRST = 2 * 60_000;
const NO_CHANGE = 'NO CHANGE';

export const keyOf = (primary) => primary.key || caseKey(primary.number);

const SYSTEM = `You keep the brief for one legal case: the short notes a lawyer reads before picking the case up again.
You are given the current brief (it may be empty) and a part of a conversation about the case. Write the whole updated brief.
- Keep everything in the current brief that is still true. Change what the conversation corrects. Add what it settles.
- Report only what the conversation actually says. Never invent a name, number, date, amount or decision. Keep every one that is there.
- Other cases mentioned in the conversation are references, not this case: leave their facts out.
- Attached files appear as [Attached: name]. You cannot see inside them, so never guess at their contents.
Plain Markdown, no preamble, these headings with short bullets, leaving out a heading with nothing under it:
**Parties**, **Facts**, **Decisions**, **Deadlines**, **Open questions**.
Write in the language the conversation is written in. Never exceed 400 words.
If the conversation adds nothing new about this case, reply with exactly: ${NO_CHANGE}`;

/** The paid call. Taken as an argument below so a test can watch when it is and is not made. */
const askDraft = (number, brief, text) =>
  ask(`CASE: ${number}\n\nCURRENT BRIEF:\n${brief || '(empty)'}\n\nCONVERSATION:\n${text}`, { system: SYSTEM, maxTokens: 1200 });

/** The approved brief and the suggestion waiting on it, for one person's case. */
export async function briefOf(userId, key) {
  const [brief, suggestion] = await Promise.all([
    db.prepare('SELECT body, updated_at FROM case_briefs WHERE user_id = ? AND case_key = ?').get(userId, key),
    db.prepare(`SELECT id, body, conversation_id, created_at FROM case_brief_suggestions
      WHERE user_id = ? AND case_key = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(userId, key),
  ]);
  return { brief: brief || null, suggestion: suggestion || null };
}

/**
 * Reads what one case chat has said since it was last read and leaves a suggestion when it
 * changes the brief. The chat is marked read either way, so it is not paid for twice.
 * Returns the suggestion's id, or null when there was nothing new.
 */
export async function draftFor(conv, { userName = 'The user', summarise = askDraft } = {}) {
  const primary = conv.primary_case;
  const key = keyOf(primary);
  const rows = (await db.prepare(`SELECT m.id, m.role, m.content, m.files, a.name agent_name
    FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
    WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ${WINDOW}`).all(conv.id, conv.brief_upto || 0)).reverse();
  if (!rows.length) return null;
  const upto = rows[rows.length - 1].id;
  const { brief, suggestion } = await briefOf(conv.user_id, key);
  const out = String(await summarise(primary.number, suggestion?.body || brief?.body || '', transcript(rows, userName)) || '').trim();
  return tx(async () => {
    await db.prepare('UPDATE conversations SET brief_upto = ? WHERE id = ?').run(upto, conv.id);
    if (!out || out.toUpperCase().startsWith(NO_CHANGE)) return null;
    // The newer suggestion already holds the older one: it was written on top of it.
    await db.prepare(`UPDATE case_brief_suggestions SET status = 'replaced', decided_at = extract(epoch from now())
      WHERE user_id = ? AND case_key = ? AND status = 'pending'`).run(conv.user_id, key);
    const { id } = await db.prepare(`INSERT INTO case_brief_suggestions (user_id, case_key, case_number, conversation_id, body)
      VALUES (?, ?, ?, ?, ?) RETURNING id`).run(conv.user_id, key, primary.number, conv.id, out);
    return id;
  });
}

/** The case chats that have gone quiet with something unread, for those who have Primary case. */
export async function quietChats(now = Math.floor(Date.now() / 1000), limit = PER_TICK) {
  return db.prepare(`SELECT c.id, c.user_id, c.primary_case, c.brief_upto, u.name user_name FROM conversations c
    JOIN users u ON u.id = c.user_id
    WHERE c.primary_case IS NOT NULL AND coalesce(c.updated_at, 0) < ?
      AND (u.role = 'master' OR EXISTS (SELECT 1 FROM module_access ma WHERE ma.user_id = u.id AND ma.module = 'case_focus'))
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.id > coalesce(c.brief_upto, 0))
    ORDER BY c.updated_at NULLS FIRST, c.id LIMIT ${Number(limit)}`).all(now - QUIET);
}

export async function draftQuiet(deps = {}) {
  let drafted = 0;
  for (const c of await quietChats(deps.now, deps.limit)) {
    await billAs({ userId: c.user_id, job: 'cases', note: `Case brief for ${c.primary_case.number}` },
      () => draftFor(c, { userName: c.user_name, ...deps }))
      .then((id) => { if (id) drafted++; })
      .catch((e) => console.warn(`[case-brief] chat ${c.id}:`, e.message));
  }
  return drafted;
}

/** Approves the waiting suggestion, as it is or as the person edited it. */
export async function approve(userId, key, suggestionId, body) {
  return tx(async () => {
    const s = await db.prepare(`SELECT id, case_number, body FROM case_brief_suggestions
      WHERE id = ? AND user_id = ? AND case_key = ? AND status = 'pending'`).get(Number(suggestionId) || 0, userId, key);
    if (!s) return null;
    const text = String(body ?? s.body).trim().slice(0, 8000);
    await saveBrief(userId, key, s.case_number, text);
    await db.prepare(`UPDATE case_brief_suggestions SET status = 'approved', decided_at = extract(epoch from now()) WHERE id = ?`).run(s.id);
    return briefOf(userId, key);
  });
}

export async function dismiss(userId, key, suggestionId) {
  const r = await db.prepare(`UPDATE case_brief_suggestions SET status = 'dismissed', decided_at = extract(epoch from now())
    WHERE id = ? AND user_id = ? AND case_key = ? AND status = 'pending'`).run(Number(suggestionId) || 0, userId, key);
  return r.changes ? briefOf(userId, key) : null;
}

/** The person writing the brief themselves. */
export async function saveBrief(userId, key, number, body) {
  await db.prepare(`INSERT INTO case_briefs (user_id, case_key, case_number, body, updated_at)
    VALUES (?, ?, ?, ?, extract(epoch from now())) ON CONFLICT (user_id, case_key)
    DO UPDATE SET body = EXCLUDED.body, case_number = EXCLUDED.case_number, updated_at = EXCLUDED.updated_at`)
    .run(userId, key, String(number).slice(0, 100), String(body).trim().slice(0, 8000));
}

let timer = null;
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try { await draftQuiet(); } catch (e) { console.warn('[case-brief]', e.message); } finally { busy = false; }
}
export function startCaseBriefs() {
  if (timer) return;
  timer = setInterval(tick, EVERY);
  setTimeout(tick, FIRST);
}
