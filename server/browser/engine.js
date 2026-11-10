import { chromium } from 'playwright';
import { db } from '../db.js';
import { encrypt, decrypt } from '../secrets.js';
import { getSettings } from './settings.js';

// The browser on the server. One Chromium for everyone, and a separate signed-in window
// (a "context") for each person: their cookies are kept, encrypted, between jobs, so a
// site they logged in to yesterday is still logged in today, and nobody else's job ever
// sees them. A job is a task: one tab, watched live from the chat.
//
// Frames: after every step, and every second while a person is needed, a picture of the
// page is kept in memory for the live window in the chat. Nothing of it is stored.

const VIEW = { width: 1280, height: 720 }; // 16:9, the shape of the live window in the chat
const IDLE = 5 * 60_000;      // a job nobody touches for 5 minutes is closed
const MAX_OPEN = 2;           // windows open at once on the server
const WAIT = 10 * 60_000;     // how long Reem waits for a person's tap
const OPEN = ['working', 'waiting_person', 'waiting_ok'];
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => Math.floor(D.now() / 1000);

const D = { launch: () => chromium.launch({ headless: true }), now: () => Date.now() };
export const useForTests = (over) => Object.assign(D, over);

let browser = null;
const live = new Map(); // taskId → { userId, context, page, jpeg, frameAt, step, ask, answer, idle, ticker }

async function chrome() {
  if (browser?.isConnected()) return browser;
  browser = await D.launch();
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

const ROW = (r) => r && { ...r, ask: live.get(r.id)?.ask || null, step: live.get(r.id)?.step || null, frameAt: live.get(r.id)?.frameAt || null, history: live.get(r.id)?.history || [] };
export const getTask = async (id) => ROW(await db.prepare('SELECT * FROM browser_tasks WHERE id = ?').get(Number(id)));

/** What the chat card shows. */
export const taskOut = (t) => t && {
  id: t.id, status: t.status, goal: t.goal, url: t.url, steps: t.steps, note: t.note, ask: t.ask, step: t.step,
  frameAt: t.frameAt, history: t.history || [], live: live.has(t.id), createdAt: t.created_at, updatedAt: t.updated_at,
};

async function update(id, patch) {
  const keys = Object.keys(patch);
  await db.prepare(`UPDATE browser_tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), now(), id);
  return getTask(id);
}

/** The person's open job in this chat, or a new one. One at a time per person. */
export async function openTask(user, { conversationId = null, goal = '' } = {}) {
  if (!(await getSettings()).enabled) throw bad('The browser is switched off. The master can turn it on in Settings → Browser.', 403);
  const open = await db.prepare(`SELECT * FROM browser_tasks WHERE user_id = ? AND status IN ('working', 'waiting_person', 'waiting_ok') ORDER BY id DESC LIMIT 1`).get(user.id);
  if (open && live.has(open.id)) {
    if ((open.conversation_id ?? null) === (conversationId ?? null)) return getTask(open.id);
    throw bad('Reem is still using the browser for you in another chat. Stop that one first.', 409);
  }
  if (open) await update(open.id, { status: 'stopped', note: 'Closed' }); // its window is gone
  if (live.size >= MAX_OPEN) throw bad('The browser is busy with other jobs right now. Try again in a minute.', 429);
  const saved = await db.prepare('SELECT state FROM browser_sessions WHERE user_id = ?').get(user.id);
  let storageState;
  try { storageState = saved ? JSON.parse(decrypt(saved.state)) : undefined; } catch { storageState = undefined; }
  const context = await (await chrome()).newContext({ viewport: VIEW, storageState, locale: 'en-US', timezoneId: 'Asia/Dubai', acceptDownloads: true });
  const page = await context.newPage();
  const made = await db.prepare(`INSERT INTO browser_tasks (user_id, conversation_id, status, goal) VALUES (?, ?, 'working', ?) RETURNING id`)
    .get(user.id, conversationId, String(goal || '').slice(0, 500));
  const t = { userId: user.id, context, page, jpeg: null, frameAt: null, step: 'Opening the browser', ask: null, answer: null, idle: null, ticker: null };
  live.set(made.id, t);
  // A site that opens a new window (a login popup, a PDF): the job carries on in it.
  context.on('page', (p) => { t.page = p; p.on('close', () => { if (t.page === p) t.page = context.pages().at(-1) || null; }); });
  touch(made.id);
  return getTask(made.id);
}

export const pageOf = (id) => {
  const t = live.get(Number(id));
  if (!t?.page) throw bad('This browser window is closed. Ask again to open it.', 410);
  return t.page;
};
export const ownerOf = (id) => live.get(Number(id))?.userId ?? null;

function touch(id) {
  const t = live.get(id);
  if (!t) return;
  clearTimeout(t.idle);
  t.idle = setTimeout(() => endTask(id, 'stopped', 'Closed after 5 minutes with nothing to do').catch(() => {}), IDLE);
  t.idle.unref?.();
}

/** A fresh picture of the page for the live window, with the step it shows. */
export async function frame(id, step) {
  const t = live.get(Number(id));
  if (!t?.page) return null;
  if (step && step !== t.step) {
    t.step = step;
    // The last few steps, for the card's list of what Reem has done.
    t.history = [...(t.history || []), { text: step, at: D.now() }].slice(-6);
  }
  try {
    t.jpeg = await t.page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 });
    t.frameAt = D.now();
  } catch { /* mid-navigation: the next frame catches up */ }
  return t.jpeg;
}
export const lastFrame = (id) => live.get(Number(id))?.jpeg || null;

/** Each step Reem takes: counted, the URL kept, a new frame. */
export async function stepped(id, step) {
  const t = live.get(id);
  if (!t) return;
  touch(id);
  await frame(id, step);
  await db.prepare('UPDATE browser_tasks SET steps = steps + 1, url = ?, updated_at = ? WHERE id = ?').run(t.page?.url() || null, now(), id);
}

/**
 * Wait for the person: 'ok' (a confirm card: { ok: true|false }) or 'person' (they do a
 * CAPTCHA, a code, a login; { done: true }). Frames keep coming while they work in the
 * window. Resolves with their answer, or null after 10 minutes.
 */
export async function waitForPerson(id, ask) {
  const t = live.get(id);
  if (!t) throw bad('This browser window is closed.', 410);
  t.ask = ask;
  await update(id, { status: ask.kind === 'ok' ? 'waiting_ok' : 'waiting_person' });
  clearTimeout(t.idle);
  t.ticker = setInterval(() => frame(id), 1000);
  try {
    return await new Promise((resolve) => {
      t.answer = resolve;
      setTimeout(() => resolve(null), WAIT).unref?.();
    });
  } finally {
    clearInterval(t.ticker);
    t.ask = null; t.answer = null;
    if (live.has(id)) { await update(id, { status: 'working' }); touch(id); }
  }
}

/** The person's tap on a card: OK / No, or Done. Only the job's owner. */
export async function answer(id, user, reply) {
  const t = live.get(Number(id));
  if (!t || t.userId !== user.id) throw bad('Not found', 404);
  if (!t.answer) throw bad('Reem is not waiting for an answer here.', 409);
  t.answer(reply);
}

/** The person working the page themselves from the live window (Take over). */
export async function personInput(id, user, { kind, x, y, text, key } = {}) {
  const t = live.get(Number(id));
  if (!t || t.userId !== user.id) throw bad('Not found', 404);
  const p = pageOf(id);
  if (kind === 'click') {
    const fx = Math.max(0, Math.min(1, Number(x))), fy = Math.max(0, Math.min(1, Number(y)));
    await p.mouse.click(Math.round(fx * VIEW.width), Math.round(fy * VIEW.height));
  } else if (kind === 'type') await p.keyboard.type(String(text || '').slice(0, 500));
  else if (kind === 'key' && /^(Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageDown|PageUp|Home|End)$/.test(key)) await p.keyboard.press(key);
  else if (kind === 'scroll') await p.mouse.wheel(0, Number(y) > 0 ? 500 : -500);
  else throw bad('Unknown input');
  touch(Number(id));
  await new Promise((r) => setTimeout(r, 300));
  await frame(Number(id));
}

/** The job ends: the person stays signed in for next time, and the window closes. */
export async function endTask(id, status, note = null) {
  id = Number(id);
  const t = live.get(id);
  live.delete(id);
  if (t) {
    clearTimeout(t.idle); clearInterval(t.ticker);
    t.answer?.(null);
    try {
      const state = await t.context.storageState();
      await db.prepare(`INSERT INTO browser_sessions (user_id, state, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`).run(t.userId, encrypt(JSON.stringify(state)), now());
    } catch { /* the window was already gone */ }
    await t.context.close().catch(() => {});
  }
  return update(id, { status, note });
}

/** Stop, from the card. Only the job's owner. */
export async function stopTask(id, user) {
  const r = await getTask(id);
  if (!r || r.user_id !== user.id) throw bad('Not found', 404);
  if (!OPEN.includes(r.status)) return r;
  return endTask(r.id, 'stopped', 'Stopped by you');
}

/** Reem restarted: the windows are gone, so open jobs are marked stopped. */
export async function recoverAtBoot() {
  await db.prepare(`UPDATE browser_tasks SET status = 'stopped', note = 'Reem restarted', updated_at = ? WHERE status IN ('working', 'waiting_person', 'waiting_ok')`).run(now());
}

/** For the tests: close everything. */
export async function closeAll() {
  for (const id of [...live.keys()]) await endTask(id, 'stopped', 'Closed');
  await browser?.close().catch(() => {});
  browser = null;
}
