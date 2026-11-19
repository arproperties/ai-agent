import { db } from './db.js';
import { claude } from './ai.js';
import { looseJson } from './files.js';
import { sendPush } from './push.js';
import { billAs } from './billing.js';
import { saifsysKit } from './saifsys/index.js';
import { leaseKit } from './leases.js';
import { EMAIL_READ_TOOLS } from './email.js';
import { imapAccount, imapTools } from './imap.js';
import { ADVISOR_MODEL } from './config.js';
import { dubaiDate, dubaiHour } from './saifsys/client.js';

// Watchers: the second kind of Autonomous Agent (server/reportChecks.js is the first, which reads
// work reports as they arrive). A watcher runs on a schedule - every day, every week, every month
// at an hour - and looks things up itself with the same READ-ONLY tools a chat has: the master's
// mailbox, saifsys and the leases. It is given the master's sentence ("every morning, tell me which
// tenant emails have no reply after 24 hours"), what it found last time, and today's date, and it
// answers with what is new. The master is buzzed only when there is something.
//
// It can find and read; it cannot send, book, change or delete anything: the kits below are the
// reading ones only (no email write tools, no saifsys actions), so it is not a matter of asking it
// nicely.

const RUN_MODEL = ADVISOR_MODEL;
const MAX_ROUNDS = 6;
// One tool's answer, so a big mailbox listing does not swamp the run. Every round re-sends all of
// it, so this is most of what a run costs.
const MAX_TOOL_TEXT = 8_000;
export const SOURCES = ['email', 'saifsys', 'leases'];
export const CADENCES = ['daily', 'weekly', 'monthly'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const masterUser = () => db.prepare("SELECT * FROM users WHERE role = 'master' AND NOT disabled ORDER BY id LIMIT 1").get();
const masters = async () => (await db.prepare("SELECT id FROM users WHERE role = 'master' AND NOT disabled").all()).map((u) => u.id);

/** The master's mailbox, reading only. */
async function emailKit(user) {
  if (!(await imapAccount(user.id))) return null;
  return {
    definitions: EMAIL_READ_TOOLS,
    run: async (block) => {
      try {
        const fn = imapTools[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(user.id, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

/** The reading tools for these sources, as the master sees them. Missing ones are listed, not faked. */
export async function kitsFor(sources, user) {
  const want = new Set(sources);
  const made = {
    email: want.has('email') ? await emailKit(user) : null,
    saifsys: want.has('saifsys') ? await saifsysKit(user) : null,
    leases: want.has('leases') ? await leaseKit(user) : null,
  };
  const kits = Object.values(made).filter(Boolean);
  const missing = [...want].filter((s) => !made[s]);
  return { kits, missing };
}

const RUN_SYSTEM = `You are one of Reem's Autonomous Agents for a property and construction company in Dubai. You work alone in the
background: nobody is reading as you go. You are given your job in the owner's words, today's date, what you found last time, and
tools that only READ (email, saifsys, leases). Use them to do the job: look things up, read what you need, then stop.

Report only what the owner needs to know now: new things, and things still open from last time. Be specific: names, units,
dates, amounts, email subjects. Write dates and times in Dubai time (UTC+4), e.g. "18 Nov 16:35". Do not invent anything the tools did not show; if a tool failed, say so in one finding.
When you are done, reply with ONLY JSON:
{"headline": "one short line for a phone notification, at most 100 characters",
 "findings": [{"title": "at most 10 words", "detail": "one or two sentences", "level": "high" | "normal"}],
 "nothing_new": true or false}
"nothing_new" is true when there is nothing worth a notification; findings may then be empty.`;

const text = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

// Each round re-sends the whole run; marking its newest tool answers lets the next round read all
// of that back from the cache at a tenth of the price (as chat.js withCacheMark does). The first
// live run without it cost about $0.40 for 8 rounds. Not on the first round, and never on an
// assistant turn, whose last block can be thinking.
function cacheMarked(convo) {
  const last = convo.at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content) || !last.content.length) return convo;
  const content = [...last.content];
  content[content.length - 1] = { ...content.at(-1), cache_control: { type: 'ephemeral' } };
  return [...convo.slice(0, -1), { ...last, content }];
}

/**
 * One run of a watcher: the tool loop, its answer kept in report_agent_runs, and a buzz when
 * there is something. `client` is swapped in tests.
 */
// Its cost is noted against the agent ("agent 7"), so its page can say what it cost this month.
export const costNote = (id) => `agent ${id}`;

export function runWatcher(agent, opts = {}) {
  return billAs({ job: 'report_checks', note: costNote(agent.id) }, () => run(agent, opts));
}

async function run(agent, { client = claude, pusher = sendPush, now = Date.now(), user, quiet = false, kits: given } = {}) {
  const who = user || await masterUser();
  if (!who) throw new Error('There is no master to work for');
  const { kits, missing } = given ? { kits: given, missing: [] } : await kitsFor(agent.sources || [], who);
  const last = await db.prepare(`SELECT ran_at, headline, findings FROM report_agent_runs WHERE type_id = ? AND error IS NULL
    ORDER BY id DESC LIMIT 1`).get(agent.id);
  const today = dubaiDate(now);
  const prompt = [
    `Your job: ${agent.brief || agent.name}`,
    `Today is ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]} ${today} (Dubai), ${String(dubaiHour(now)).padStart(2, '0')}:00.`,
    last ? `Last time (${dubaiDate(Number(last.ran_at) * 1000)}) you found: ${JSON.stringify({ headline: last.headline, findings: last.findings }).slice(0, 4000)}`
      : 'This is your first run.',
    missing.length ? `Not available to you right now: ${missing.join(', ')} (not connected). Say so if your job needs it.` : '',
  ].filter(Boolean).join('\n');

  const tools = kits.flatMap((k) => k.definitions);
  const kitFor = (name) => kits.find((k) => k.definitions.some((d) => d.name === name));
  const convo = [{ role: 'user', content: prompt }];
  let answer = '';
  let used = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const final = round === MAX_ROUNDS - 1;
    // The tools stay the same every round: the model's thinking is tied to the tools it was given,
    // and the API refuses a later round with a different list (seen on live, 2026-11-19). The last
    // round is told in words to answer instead.
    if (final && round > 0) convo.at(-1).content.push({ type: 'text', text: 'This is your last step: use no more tools. Reply with the JSON now, with what you have.' });
    const res = await client.messages.create({
      model: RUN_MODEL, max_tokens: 6000,
      system: [{ type: 'text', text: RUN_SYSTEM, cache_control: { type: 'ephemeral' } }],
      ...(tools.length ? { tools } : {}),
      messages: cacheMarked(convo),
    });
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (!calls.length || final) { answer = text(res); break; }
    used += calls.length;
    convo.push({ role: 'assistant', content: res.content });
    const results = await Promise.all(calls.map(async (b) => {
      const r = await (kitFor(b.name)?.run(b) ?? { type: 'tool_result', tool_use_id: b.id, content: 'Unknown tool', is_error: true });
      return { ...r, content: String(r.content ?? '').slice(0, MAX_TOOL_TEXT) };
    }));
    convo.push({ role: 'user', content: results });
  }

  let r;
  try { r = looseJson(answer); } catch { r = { headline: answer.replace(/\s+/g, ' ').trim().slice(0, 100) || 'The agent gave no answer', findings: [], nothing_new: false }; }
  const findings = (Array.isArray(r.findings) ? r.findings : []).slice(0, 30).map((f) => ({
    title: String(f?.title || '').trim().slice(0, 120), detail: String(f?.detail || '').trim().slice(0, 1200), level: f?.level === 'high' ? 'high' : 'normal',
  })).filter((f) => f.title || f.detail);
  const headline = String(r.headline || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const nothing = r.nothing_new === true && !findings.some((f) => f.level === 'high');
  const { id } = await db.prepare(`INSERT INTO report_agent_runs (type_id, ran_at, headline, findings, nothing_new, tools_used)
    VALUES (?, ?, ?, ?::jsonb, ?, ?) RETURNING id`).run(agent.id, Math.floor(now / 1000), headline, JSON.stringify(findings), nothing, used);
  if (!nothing && !quiet) {
    await pusher(await masters(), { title: agent.name, body: headline || `${findings.length} things to look at`, url: `/?reportchecks=agent-${agent.id}`, tag: `agent-${agent.id}` });
  }
  return { id, headline, findings, nothing_new: nothing, tools_used: used };
}

/** A failed run is kept too, so the page says why there was nothing. */
async function keepError(agent, e, now) {
  await db.prepare('INSERT INTO report_agent_runs (type_id, ran_at, error) VALUES (?, ?, ?)').run(agent.id, Math.floor(now / 1000), String(e.message || e).slice(0, 500));
}

/** A run that keeps its failure on the agent's page instead of throwing. */
export async function runSafely(agent, opts = {}) {
  try { return await runWatcher(agent, opts); } catch (e) {
    console.error('[autonomous agents]', agent.name, e.message);
    await keepError(agent, e, opts.now ?? Date.now()).catch(() => {});
    return null;
  }
}

/** Which run a moment belongs to: one per day, per week (its weekday) or per month (the 1st). Null when not due. */
export function slotOf(agent, now = Date.now()) {
  const today = dubaiDate(now);
  if (dubaiHour(now) < agent.run_hour) return null;
  if (agent.cadence === 'weekly' && new Date(`${today}T00:00:00Z`).getUTCDay() !== agent.run_weekday) return null;
  if (agent.cadence === 'monthly' && today.slice(8) !== '01') return null;
  return agent.cadence === 'monthly' ? today.slice(0, 7) : today;
}

/** Every watcher whose time has come, once per slot. */
export async function watchWatchers({ now = Date.now(), run = runWatcher } = {}) {
  const agents = await db.prepare(`SELECT id, name, brief, sources, cadence, run_hour, run_weekday FROM report_types
    WHERE active AND kind = 'watch' ORDER BY id`).all();
  const done = [];
  for (const a of agents) {
    const slot = slotOf(a, now);
    if (!slot) continue;
    const mark = await db.prepare('INSERT INTO report_check_marks (key) VALUES (?) ON CONFLICT DO NOTHING RETURNING key').get(`run:${a.id}:${slot}`);
    if (!mark) continue;
    try { done.push(await run(a, { now })); } catch (e) {
      console.error('[autonomous agents]', a.name, e.message);
      await keepError(a, e, now).catch(() => {});
    }
  }
  return done;
}

/** What this agent's runs cost since the 1st of this month, in dollars. */
export async function costThisMonth(typeId, now = Date.now()) {
  const first = Math.floor(Date.parse(`${dubaiDate(now).slice(0, 7)}-01T00:00:00+04:00`) / 1000);
  const r = await db.prepare('SELECT coalesce(sum(usd), 0) usd FROM ai_costs WHERE note = ? AND at >= ?').get(costNote(Number(typeId) || 0), first);
  return Math.round(Number(r.usd) * 100) / 100;
}

export const listRuns = (typeId, limit = 30) => db.prepare(`SELECT id, ran_at, headline, findings, nothing_new, tools_used, error
  FROM report_agent_runs WHERE type_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?`).all(Number(typeId) || 0, Math.min(Number(limit) || 30, 100));
