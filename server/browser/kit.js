import { db } from '../db.js';
import { saveUpload, processDocument } from '../files.js';
import { userModules } from '../modules.js';
import { getSettings } from './settings.js';
import { openTask, getTask, pageOf, stepped, frame, waitForPerson, endTask, taskOut } from './engine.js';
import { snapshot, refOf, describe, nameOf } from './snapshot.js';
import { needsOk } from './guard.js';
import { loginsFor, fillLogin } from './logins.js';

// Reem using a website from the chat. The agent reads the page as numbered lines
// (snapshot.js), acts on the numbers, and the person watches it live in the chat card.
// Three things are never the agent's: anything that can't be taken back (guard.js: the
// person taps OK first), a CAPTCHA / code / UAE Pass (the person does it in the window),
// and a password (typed by browser_login from the saved login, never seen).

const NOTE_MAX = 2000;
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const settle = (page) => page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}).then(() => page.waitForTimeout(600));

const RULES = 'Use the numbers from the latest page reading. Never try to solve or get around a CAPTCHA, a one-time code or UAE Pass: call browser_ask_person. Never type a password: use browser_login with a saved login, or ask the person to type it in the window. Say plainly what you did and what you saw.';

const TOOLS = [
  {
    name: 'browser_open',
    description: `Open a website in Reem's browser, which the person watches live in the chat. Use it when they ask you to do something on a website that has no other tool here (look something up, fill a form, download a file, work a portal). Returns the page as numbered lines. ${RULES}`,
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'The full address, e.g. https://www.example.com' },
      goal: { type: 'string', description: 'The job in a few words, shown on the card: "Find the opening hours"' },
    }, required: ['url'] },
  },
  {
    name: 'browser_look',
    description: 'Read the current page again (after waiting, scrolling, or when the person worked in the window). picture: true adds a screenshot, only when the words are not enough (a chart, a layout).',
    input_schema: { type: 'object', properties: { picture: { type: 'boolean' } } },
  },
  {
    name: 'browser_act',
    description: `Do up to 10 things on the page in a row, e.g. fill a form then press Search. Each: {ref, do, value}. do: click | type (replaces the field's text) | choose (a select's option, by its words) | check | press (a key: Enter, Tab, Escape, ArrowDown) | scroll (value "down" or "up"; ref not needed) | upload (value = a Shelf document id). A click that can't be taken back (submit, pay, send, delete, sign…) is NOT made: the list stops there and you must call browser_confirm. Returns the page after.`,
    input_schema: { type: 'object', properties: {
      actions: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
        ref: { type: 'integer' }, do: { type: 'string', enum: ['click', 'type', 'choose', 'check', 'press', 'scroll', 'upload'] }, value: { type: 'string' },
      }, required: ['do'] } },
    }, required: ['actions'] },
  },
  {
    name: 'browser_confirm',
    description: 'Ask the person before a click that can\'t be taken back. They see your question and tap OK or No on a card; on OK the click is made. what: one plain sentence of what pressing it does: "Send the enquiry form to Example Ltd".',
    input_schema: { type: 'object', properties: { ref: { type: 'integer' }, what: { type: 'string' } }, required: ['ref', 'what'] },
  },
  {
    name: 'browser_login',
    description: 'Log in with one of the person\'s saved logins for this site (their id comes with the page). You never see the password. If it doesn\'t work, call browser_ask_person.',
    input_schema: { type: 'object', properties: { login_id: { type: 'integer' } }, required: ['login_id'] },
  },
  {
    name: 'browser_ask_person',
    description: 'Hand the window to the person for a step only they can do: a CAPTCHA, a code sent to their phone, UAE Pass, a password that isn\'t saved, or a choice only they can make. why: what they need to do, in one short sentence. Returns once they tap Done.',
    input_schema: { type: 'object', properties: { why: { type: 'string' } }, required: ['why'] },
  },
  {
    name: 'browser_download',
    description: 'Click [ref] to download a file and put it on the person\'s Shelf. Returns the Shelf document.',
    input_schema: { type: 'object', properties: { ref: { type: 'integer' }, name: { type: 'string', description: 'A clear file name, if the site gives a poor one' } }, required: ['ref'] },
  },
  {
    name: 'browser_note',
    description: 'Save what you learned about how this website works (where things are, the steps of a job, what to avoid), so the next job here is quicker. Short and practical. Replaces the earlier note for this site.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'browser_done',
    description: 'The job is finished (or can\'t be done): close the window. summary: one line of what was done.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

const STATUS = {
  browser_open: (i) => `Opening ${hostOf(i.url) || 'the website'}…`,
  browser_look: () => 'Reading the page…',
  browser_act: () => 'Working on the page…',
  browser_confirm: () => 'Waiting for your OK…',
  browser_login: () => 'Logging in…',
  browser_ask_person: () => 'Waiting for you in the browser…',
  browser_download: () => 'Downloading…',
  browser_note: () => 'Noting how this site works…',
  browser_done: () => 'Closing the browser…',
};

/** The kit, for whoever has the Browser module while the master has it switched on. */
export async function browserKit(user, { conversationId, onCard }) {
  if (!(await userModules(user)).includes('browser')) return null;
  const settings = await getSettings();
  if (!settings.enabled) return null;
  let taskId = null;

  const current = async () => {
    if (!taskId) {
      const open = await db.prepare(`SELECT id FROM browser_tasks WHERE user_id = ? AND conversation_id IS NOT DISTINCT FROM ? AND status IN ('working', 'waiting_person', 'waiting_ok') ORDER BY id DESC LIMIT 1`).get(user.id, conversationId ?? null);
      taskId = open?.id || null;
    }
    if (!taskId) throw new Error('No website is open. Call browser_open first.');
    const t = await getTask(taskId);
    if (t.steps >= settings.max_steps) throw new Error(`Step limit reached (${settings.max_steps}). Tell the person what's done so far and stop; they can ask you to carry on.`);
    return t;
  };
  const card = async () => onCard(taskOut(await getTask(taskId)));
  const reading = async (page, extra = '') => {
    await settle(page);
    const s = await snapshot(page);
    const logins = await loginsFor(user, s.url);
    const saved = logins.length ? `\n\nSaved logins for this site (use browser_login): ${logins.map((l) => `id ${l.id} "${l.label}" (${l.username})`).join('; ')}` : '';
    return { s, text: `${extra}${extra ? '\n\n' : ''}${s.text}${saved}` };
  };

  const handlers = {
    async browser_open({ url, goal }) {
      let u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      const t = await openTask(user, { conversationId, goal: goal || hostOf(u) });
      taskId = t.id;
      await card();
      const page = pageOf(taskId);
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await stepped(taskId, `Opened ${hostOf(page.url())}`);
      const note = await db.prepare('SELECT notes FROM browser_site_notes WHERE host = ?').get(hostOf(page.url()));
      return (await reading(page, note ? `What you noted about this site before:\n${note.notes}` : '')).text;
    },

    async browser_look({ picture }) {
      await current();
      const page = pageOf(taskId);
      const { text } = await reading(page);
      await stepped(taskId, 'Reading the page');
      if (!picture) return text;
      const jpeg = await frame(taskId);
      return [{ type: 'text', text }, ...(jpeg ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }] : [])];
    },

    async browser_act({ actions = [] }) {
      await current();
      const page = pageOf(taskId);
      const done = [];
      let stopped = '';
      for (const a of actions.slice(0, 10)) {
        const el = a.ref ? refOf(page, a.ref) : null;
        if (a.do !== 'scroll' && !(el && await el.count())) { stopped = `[${a.ref}] isn't on the page any more: read it again.`; break; }
        // The step as the person reads it on the card: the field's own name, not its number.
        const nm = el ? await nameOf(page, a.ref) : '';
        const q = (s) => (s ? `"${s}"` : 'a field');
        let said = '';
        if (a.do === 'click') {
          const d = await describe(page, a.ref);
          const s = await snapshot(page); // fresh card-field check for the page as it is now
          const g = needsOk({ ...d, pageHasCardFields: s.hasCardFields, url: page.url() });
          if (!g.ok) { stopped = `Not clicked: [${a.ref}] "${d.label}" needs the person's OK (${g.why}). Call browser_confirm with ref ${a.ref}.`; break; }
          await el.click({ timeout: 10000 });
          await settle(page);
          done.push(`clicked [${a.ref}] "${d.label}"`);
          said = `Clicked ${q(d.label || nm)}`;
        } else if (a.do === 'type') {
          if (await el.evaluate((x) => x.type === 'password')) { stopped = 'Passwords are never typed by you: use browser_login or browser_ask_person.'; break; }
          await el.fill(String(a.value ?? ''), { timeout: 10000 });
          done.push(`typed into [${a.ref}]`);
          said = `Typed ${q(String(a.value ?? '').slice(0, 40))} into ${q(nm)}`;
        } else if (a.do === 'choose') {
          await el.selectOption({ label: String(a.value ?? '') }, { timeout: 10000 }).catch(() => el.selectOption(String(a.value ?? ''), { timeout: 10000 }));
          done.push(`chose "${a.value}" in [${a.ref}]`);
          said = `Chose ${q(a.value)}${nm ? ` in ${q(nm)}` : ''}`;
        } else if (a.do === 'check') {
          await el.check({ timeout: 10000 });
          done.push(`ticked [${a.ref}]`);
          said = `Ticked ${q(nm)}`;
        } else if (a.do === 'press') {
          const key = String(a.value || 'Enter');
          // Enter in a field sends its form: the same check as clicking the form's button.
          if (key === 'Enter') {
            const btn = await el.evaluate((x) => { const f = x.form; const b = f && f.querySelector('button[type=submit], input[type=submit], button:not([type])'); return b ? (b.value || b.innerText || '').trim() : null; });
            const g = btn !== null ? needsOk({ label: btn, isFormSubmit: true, url: page.url(), pageHasCardFields: (await snapshot(page)).hasCardFields }) : { ok: true };
            if (!g.ok) { stopped = `Not pressed: Enter here sends the form ("${btn}"), which needs the person's OK. Call browser_confirm on that button.`; break; }
          }
          await el.press(key);
          await settle(page);
          done.push(`pressed ${key} in [${a.ref}]`);
          said = `Pressed ${key}`;
        } else if (a.do === 'scroll') {
          await page.mouse.wheel(0, a.value === 'up' ? -700 : 700);
          await page.waitForTimeout(400);
          done.push(`scrolled ${a.value === 'up' ? 'up' : 'down'}`);
          said = `Scrolled ${a.value === 'up' ? 'up' : 'down'}`;
        } else if (a.do === 'upload') {
          const doc = await db.prepare('SELECT id, name, path FROM documents WHERE id = ? AND user_id = ?').get(Number(a.value), user.id);
          if (!doc?.path) { stopped = `Shelf document ${a.value} isn't one of the person's own files.`; break; }
          await el.setInputFiles(doc.path);
          done.push(`attached "${doc.name}" to [${a.ref}]`);
          said = `Attached ${q(doc.name)}`;
        }
        await stepped(taskId, said || done.at(-1));
      }
      const { text } = await reading(page);
      return `${done.length ? `Done: ${done.join('; ')}.` : 'Nothing done.'}${stopped ? `\n${stopped}` : ''}\n\n${text}`;
    },

    async browser_confirm({ ref, what }) {
      await current();
      const page = pageOf(taskId);
      const el = refOf(page, ref);
      if (!(await el.count())) return `[${ref}] isn't on the page any more: read it again.`;
      const d = await describe(page, ref);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await frame(taskId, `Waiting for your OK to press "${d.label}"`);
      const reply = await waitForPerson(taskId, { kind: 'ok', what: String(what || '').slice(0, 300), label: d.label, host: hostOf(page.url()) });
      if (!reply) return 'No answer from the person in 10 minutes: nothing was pressed. Tell them it is waiting.';
      if (!reply.ok) return `The person said No: "${d.label}" was not pressed. Ask them what they want instead.`;
      await el.click({ timeout: 10000 });
      await stepped(taskId, `Pressed "${d.label}" (you said OK)`);
      return `The person said OK and "${d.label}" was pressed.\n\n${(await reading(page)).text}`;
    },

    async browser_login({ login_id: id }) {
      await current();
      const page = pageOf(taskId);
      const r = await fillLogin(user, page, id);
      if (r === 'wrong_site') return 'That login is for another website: it was not used.';
      if (r === 'no_fields') return 'There is no password box on this page. Open the site\'s login page first.';
      await settle(page);
      await stepped(taskId, 'Logged in with your saved login');
      const { s, text } = await reading(page);
      const still = /\[password field\]/.test(s.text);
      return `${still ? 'Login didn\'t work: the password box is still there (maybe a wrong password or a CAPTCHA). Call browser_ask_person.' : 'Logged in.'}\n\n${text}`;
    },

    async browser_ask_person({ why }) {
      await current();
      const page = pageOf(taskId);
      const reply = await waitForPerson(taskId, { kind: 'person', why: String(why || '').slice(0, 300) });
      if (!reply) return 'The person didn\'t answer in 10 minutes. Tell them the window is waiting for them.';
      await stepped(taskId, 'You finished your part');
      return `The person says they are done.\n\n${(await reading(page)).text}`;
    },

    async browser_download({ ref, name }) {
      await current();
      const page = pageOf(taskId);
      const el = refOf(page, ref);
      if (!(await el.count())) return `[${ref}] isn't on the page any more: read it again.`;
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), el.click()]);
      const file = await dl.path();
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(file);
      const filename = String(name || dl.suggestedFilename() || 'download').replace(/[\\/:*?"<>|]+/g, '-');
      const mimetype = /\.pdf$/i.test(filename) ? 'application/pdf' : /\.png$/i.test(filename) ? 'image/png' : /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'application/octet-stream';
      const f = { buffer, originalname: filename, mimetype, size: buffer.length };
      const { doc, duplicate } = await saveUpload(user.id, null, f, conversationId);
      if (!duplicate) processDocument(doc, f, null);
      await stepped(taskId, `Downloaded "${filename}" to your Shelf`);
      return `${duplicate ? 'Already on the Shelf' : 'Put on the Shelf'}: "${doc.name}" (document id ${doc.id}).`;
    },

    async browser_note({ text }) {
      await current();
      const host = hostOf(pageOf(taskId).url());
      await db.prepare(`INSERT INTO browser_site_notes (host, notes, updated_at) VALUES (?, ?, extract(epoch from now())::bigint)
        ON CONFLICT (host) DO UPDATE SET notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at`).run(host, String(text || '').slice(0, NOTE_MAX));
      return `Noted for ${host}.`;
    },

    async browser_done({ summary }) {
      await current().catch(() => null);
      if (!taskId) return 'Nothing was open.';
      await endTask(taskId, 'done', String(summary || '').slice(0, 300));
      await card();
      return 'Closed.';
    },
  };

  return {
    browser: true,
    definitions: TOOLS,
    status: (name, input) => STATUS[name]?.(input || {}) || null,
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        const content = await fn(block.input || {});
        if (taskId && block.name !== 'browser_done') await card().catch(() => {});
        return { type: 'tool_result', tool_use_id: block.id, content };
      } catch (e) {
        if (taskId) await card().catch(() => {});
        return { type: 'tool_result', tool_use_id: block.id, content: String(e.message || e).slice(0, 500), is_error: true };
      }
    },
  };
}
