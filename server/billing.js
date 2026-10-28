import { AsyncLocalStorage } from 'node:async_hooks';
import { Router } from 'express';
import { db } from './db.js';
import { ADVISOR_MODEL } from './config.js';

// Billing, the master's alone: what every AI call cost, who it was for and what it was doing.
//
// Every Claude call goes through the one client in ai.js, and every voice and picture call
// through the helpers beside it, so the counting happens there and nowhere else: watch()
// wraps the client, and the voice helpers call recordOpenAI(). Who and what come from the
// request (or the background job) the call was made in, carried by AsyncLocalStorage, so no
// feature has to pass them down.
//
// The price is worked out from the token counts in each answer, the same counts Anthropic
// bills on, at the list prices below. Voice and pictures are OpenAI's, priced by minute,
// character or picture: those are close estimates.

export const AED = 3.6725; // the dirham is pegged to the dollar

// US dollars per million tokens. Cache writes cost 1.25x input (2x for the 1-hour kind).
// Matched by the start of the model id, so a dated id finds its row.
export const CLAUDE_PRICES = [
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', about: 'The cheap one: Auto answers with it', input: 0.10, output: 0.50, read: 0.01,
    long: { over: 100_000, input: 0.50, output: 2.50, read: 0.05 } },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', about: 'Quick small jobs: titles, sorting, short replies', input: 1, output: 5, read: 0.10 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', about: 'The careful helper Auto asks when a question is hard; it also writes the master\'s Auto answers', input: 2, output: 10, read: 0.20 },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', about: 'Reading PDFs, renewals and other work kept as fact', input: 2, output: 10, read: 0.20 },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', about: 'The smartest', input: 4, output: 20, read: 0.20 },
  { id: 'claude-opus-5', name: 'Opus 5', about: 'The smartest (older)', input: 5, output: 25, read: 0.50 },
];
export const WEB_SEARCH_USD = 10 / 1000; // per search

// OpenAI: per minute of audio, per character read aloud, per picture.
export const OPENAI_PRICES = [
  { id: 'gpt-4o-mini-transcribe', name: 'Voice to text', about: 'Voice notes, Transcribe, the translator', perMinute: 0.003 },
  { id: 'gpt-4o-transcribe-diarize', name: 'Meetings (who said what)', about: 'Recorded meetings', perMinute: 0.006 },
  { id: 'whisper-1', name: 'Word timing', about: 'Highlighting words as a reply is read aloud', perMinute: 0.006 },
  { id: 'gpt-4o-mini-tts', name: 'Read aloud', about: 'Reem speaking a reply', perChar: 0.015 / 900 }, // ~900 characters a minute
  { id: 'gpt-image', name: 'Pictures', about: 'Pictures for /explain, /breakdown, /explore', perPicture: 0.063 },
];

// What a call was doing, from the address it came in on. Background jobs say it themselves.
export const JOBS = {
  chat: { name: 'Chat', about: 'Questions people type to Reem, and what Reem learns from them' },
  files: { name: 'Reading files', about: 'Files uploaded to the Shelf or a chat: Reem reads, sorts and names them' },
  renewals: { name: 'Lease renewals', about: 'Reading tenant replies, writing offers, checking papers' },
  tenantcare: { name: 'Tenant care', about: 'The tenant inbox: reading emails and writing the replies' },
  mail: { name: 'Email', about: 'Mail routing, the shared inbox and drafting emails' },
  messenger: { name: 'Team chat', about: 'Tidying, summing up and passing on messages between people' },
  meetings: { name: 'Meetings', about: 'Who said what, and the summary' },
  transcribe: { name: 'Transcribe', about: 'Recordings turned into text' },
  voice: { name: 'Voice', about: 'Voice notes typed out, and replies read aloud' },
  translate: { name: 'Live Translator', about: 'Two people, two languages' },
  pictures: { name: 'Pictures', about: 'Pictures drawn for a chat' },
  buildings: { name: 'Buildings', about: 'Building jobs and inventory' },
  checklists: { name: 'Checklists', about: 'Making the points of a job' },
  notices: { name: 'Tenant notices', about: 'Writing notices to tenants' },
  setup: { name: 'Setting up', about: 'Making agents and other setup' },
  cases: { name: 'Case deadlines', about: "Reading a case's files and emails for its legal dates" },
  other: { name: 'Other', about: 'Anything else' },
};

const PATHS = [
  [/^\/(chat|conversations|messages|memories|suggestions|team-reminders|responsibilities|replies|address-book)\b/, 'chat'],
  [/^\/(documents|imports|file-access)\b/, 'files'],
  [/^\/lease-renewals\b/, 'renewals'],
  [/^\/case-focus\b/, 'cases'],
  [/^\/tenant-care\b/, 'tenantcare'],
  [/^\/(mail-routing|shared-inbox|email|imap|outlook)\b/, 'mail'],
  [/^\/messenger\b/, 'messenger'],
  [/^\/meetings\b/, 'meetings'],
  [/^\/transcripts\b/, 'transcribe'],
  [/^\/voice\b/, 'voice'],
  [/^\/translate\b/, 'translate'],
  [/^\/pictures\b/, 'pictures'],
  [/^\/(buildings|inventory)\b/, 'buildings'],
  [/^\/checklists\b/, 'checklists'],
  [/^\/notices\b/, 'notices'],
  [/^\/(agents|admin|modules)\b/, 'setup'],
];
export const jobOfPath = (path) => PATHS.find(([re]) => re.test(path))?.[1] || 'other';

// ---------- who and what ----------

const ctx = new AsyncLocalStorage();

/** Run fn as work for this person and job: { userId, job, note }. Missing parts carry over. */
export function billAs(who, fn) {
  return ctx.run({ ...ctx.getStore(), ...who }, fn);
}

/** Who the work in progress is for (null for background work nobody asked for in person). */
export const billedUserId = () => ctx.getStore()?.userId ?? null;

/** A few words saying what this call was for, shown beside its price (a question, a file name). */
export function billNote(note) {
  const s = ctx.getStore();
  if (s) s.note = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Express: every signed-in request is billed to its person, as the job its address names. */
export function billingContext(req, res, next) {
  ctx.run({ userId: req.user?.id ?? null, job: jobOfPath(req.path), note: null }, next);
}

// ---------- pricing ----------

const claudePrice = (model) => CLAUDE_PRICES.find((p) => String(model).startsWith(p.id));

/** Dollars for one model's share of a call. */
export function claudeCost(model, u) {
  const p = claudePrice(model);
  if (!p) return 0;
  const writes5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const writes1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const writes = u.cache_creation_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + writes + (u.cache_read_input_tokens || 0);
  const r = p.long && prompt > p.long.over ? p.long : p;
  return ((u.input_tokens || 0) * r.input
    + (writes5 ?? writes - writes1h) * r.input * 1.25 + writes1h * r.input * 2
    + (u.cache_read_input_tokens || 0) * r.read
    + (u.output_tokens || 0) * r.output) / 1e6;
}

// Each model that worked on one answer: the answer's own model, plus the advisor Auto asks.
// When the answer lists its parts (usage.iterations), they are the bill; otherwise the top line.
function shares(msg) {
  const u = msg.usage || {};
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  const by = new Map();
  for (const it of parts) {
    const model = it.model || (String(it.type || '').startsWith('advisor') ? ADVISOR_MODEL : msg.model);
    const s = by.get(model) || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, usd: 0 };
    s.input_tokens += it.input_tokens || 0;
    s.output_tokens += it.output_tokens || 0;
    s.cache_read_input_tokens += it.cache_read_input_tokens || 0;
    s.cache_creation_input_tokens += it.cache_creation_input_tokens || 0;
    s.usd += claudeCost(model, it);
    by.set(model, s);
  }
  return by;
}

// ---------- recording ----------

const unknownSeen = new Set();
async function save(who, row) {
  try {
    await db.prepare(`INSERT INTO ai_costs (user_id, job, note, provider, model, input_tokens, output_tokens, cache_read, cache_write, searches, units, usd, key_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(who?.userId ?? null, who?.job || 'other', who?.note || null, row.provider, row.model,
        row.input || 0, row.output || 0, row.read || 0, row.write || 0, row.searches || 0, row.units || 0, row.usd, who?.key || null);
  } catch (e) {
    console.warn('[billing] could not save a cost:', e.message);
  }
}

function recordClaude(who, msg) {
  if (!msg?.usage) return;
  const searches = msg.usage.server_tool_use?.web_search_requests || 0;
  let first = true;
  for (const [model, s] of shares(msg)) {
    if (!claudePrice(model) && !unknownSeen.has(model)) {
      unknownSeen.add(model);
      console.warn('[billing] no price for', model, '- add it to CLAUDE_PRICES in server/billing.js');
    }
    save(who, {
      provider: 'anthropic', model,
      input: s.input_tokens, output: s.output_tokens, read: s.cache_read_input_tokens, write: s.cache_creation_input_tokens,
      searches: first ? searches : 0,
      usd: s.usd + (first ? searches * WEB_SEARCH_USD : 0),
    });
    first = false;
  }
}

/**
 * A voice or picture call: minutes, characters or pictures, at OpenAI's price for that model.
 * key: which key paid ('own', 'company' or 'server', see aiKeys.js).
 */
export function recordOpenAI(model, { minutes = 0, chars = 0, pictures = 0 } = {}, key = null) {
  const p = OPENAI_PRICES.find((x) => String(model).startsWith(x.id));
  const usd = p ? minutes * (p.perMinute || 0) + chars * (p.perChar || 0) + pictures * (p.perPicture || 0) : 0;
  save({ ...ctx.getStore(), key }, { provider: 'openai', model, units: minutes || chars || pictures, usd });
}

/**
 * Count every call the Claude client makes from here on. Plain calls are counted when the
 * answer arrives; streamed ones when they finish, or with what had come when they are stopped
 * (a person leaving mid-answer still costs what was written). key: which key the client
 * holds ('own', 'company' or 'server', see aiKeys.js), noted beside each cost.
 */
export function watch(client, key = null) {
  const wrap = (target) => {
    const create = target.create.bind(target);
    target.create = (...args) => {
      const who = { ...ctx.getStore(), key };
      const p = create(...args);
      p.then((res) => { if (res?.usage) recordClaude(who, res); }, () => {});
      return p;
    };
    const stream = target.stream.bind(target);
    target.stream = (...args) => {
      const who = { ...ctx.getStore(), key };
      const s = stream(...args);
      let done = false;
      const once = (msg) => { if (!done && msg) { done = true; recordClaude(who, msg); } };
      s.on('finalMessage', once);
      s.on('abort', () => { try { once(s.currentMessage); } catch { /* nothing had come yet */ } });
      return s;
    };
  };
  wrap(client.messages);
  wrap(client.beta.messages);
  return client;
}

// ---------- the screen ----------

const DUBAI = "(to_timestamp(c.at) AT TIME ZONE 'Asia/Dubai')";
const dayStart = (offsetDays = 0) => `extract(epoch from (date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') - interval '${offsetDays} days') AT TIME ZONE 'Asia/Dubai')::bigint`;
const monthStart = `extract(epoch from date_trunc('month', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai')::bigint`;
const RANGES = { today: dayStart(0), week: dayStart(6), month: monthStart, d30: dayStart(29) };

const num = (x) => Number(x) || 0;
const shape = (r) => ({ ...r, usd: num(r.usd), calls: num(r.calls), input: num(r.input), output: num(r.output), searches: num(r.searches) });

export const billingRoutes = Router();
const wrapR = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

billingRoutes.get('/', wrapR(async (req, res) => {
  const from = RANGES[req.query.range] || RANGES.week;
  const totals = await db.prepare(`SELECT
      COALESCE(SUM(usd) FILTER (WHERE at >= ${RANGES.today}), 0) AS today,
      COALESCE(SUM(usd) FILTER (WHERE at >= ${dayStart(1)} AND at < ${RANGES.today}), 0) AS yesterday,
      COALESCE(SUM(usd) FILTER (WHERE at >= ${RANGES.week}), 0) AS week,
      COALESCE(SUM(usd) FILTER (WHERE at >= ${RANGES.month}), 0) AS month,
      MIN(at) AS since
    FROM ai_costs`).get();
  const people = await db.prepare(`SELECT c.user_id AS id, u.name, u.email, SUM(c.usd) AS usd, COUNT(*) AS calls
    FROM ai_costs c LEFT JOIN users u ON u.id = c.user_id WHERE c.at >= ${from}
    GROUP BY c.user_id, u.name, u.email ORDER BY usd DESC`).all();
  const jobs = await db.prepare(`SELECT job, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_costs c WHERE c.at >= ${from} GROUP BY job ORDER BY usd DESC`).all();
  const models = await db.prepare(`SELECT provider, model, SUM(usd) AS usd, COUNT(*) AS calls, SUM(input_tokens + cache_read + cache_write) AS input,
      SUM(output_tokens) AS output, SUM(searches) AS searches
    FROM ai_costs c WHERE c.at >= ${from} GROUP BY provider, model ORDER BY usd DESC`).all();
  const days = await db.prepare(`SELECT to_char(${DUBAI}, 'YYYY-MM-DD') AS day, SUM(usd) AS usd, COUNT(*) AS calls
    FROM ai_costs c WHERE c.at >= ${RANGES.d30} GROUP BY 1 ORDER BY 1`).all();
  res.json({
    aed: AED,
    totals: { today: num(totals.today), yesterday: num(totals.yesterday), week: num(totals.week), month: num(totals.month), since: totals.since ? Number(totals.since) : null },
    people: people.map(shape),
    jobs: jobs.map((j) => ({ ...shape(j), name: JOBS[j.job]?.name || j.job, about: JOBS[j.job]?.about || '' })),
    models: models.map((m) => {
      const p = m.provider === 'anthropic' ? claudePrice(m.model) : OPENAI_PRICES.find((x) => m.model.startsWith(x.id));
      return { ...shape(m), name: p?.name || m.model, about: p?.about || '' };
    }),
    days: days.map(shape),
    prices: { claude: CLAUDE_PRICES, openai: OPENAI_PRICES, webSearch: WEB_SEARCH_USD },
  });
}));

// One person's calls (or the background's: user=none), newest first.
billingRoutes.get('/calls', wrapR(async (req, res) => {
  const from = RANGES[req.query.range] || RANGES.week;
  const none = req.query.user === 'none';
  const user = Number(req.query.user);
  const where = [`c.at >= ${from}`];
  const args = [];
  if (none) where.push('c.user_id IS NULL');
  else if (user) { where.push('c.user_id = ?'); args.push(user); }
  if (req.query.job) { where.push('c.job = ?'); args.push(String(req.query.job)); }
  const rows = await db.prepare(`SELECT c.id, c.at, c.job, c.note, c.provider, c.model, c.key_source, c.input_tokens + c.cache_read + c.cache_write AS input,
      c.output_tokens AS output, c.searches, c.units, c.usd
    FROM ai_costs c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 300`).all(...args);
  res.json(rows.map((r) => ({
    ...shape(r), at: Number(r.at), units: num(r.units),
    jobName: JOBS[r.job]?.name || r.job,
    modelName: (r.provider === 'anthropic' ? claudePrice(r.model) : OPENAI_PRICES.find((x) => r.model.startsWith(x.id)))?.name || r.model,
  })));
}));
