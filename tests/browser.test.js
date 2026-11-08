import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { needsOk } from '../server/browser/guard.js';
import { setSettings } from '../server/browser/settings.js';
import { openTask, pageOf, endTask, closeAll, recoverAtBoot, getTask, answer, ownerOf } from '../server/browser/engine.js';
import { saveLogin, listLogins, fillLogin, hostOf } from '../server/browser/logins.js';
import { snapshot } from '../server/browser/snapshot.js';
import { browserKit } from '../server/browser/kit.js';

// Reem's browser. The guard is plain words; the rest runs a real Chromium against small
// pages served here, never a real website.

const hasChrome = existsSync(chromium.executablePath());
const skip = hasChrome ? false : 'Chromium is not installed (npx playwright install chromium)';

const PAGES = {
  '/form': `<form onsubmit="event.preventDefault();document.body.insertAdjacentHTML('beforeend','<p>Sent!</p>')">
      <label for="q">Your name</label><input id="q" name="q">
      <select id="c" aria-label="City"><option>Dubai</option><option>Sharjah</option></select>
      <button type="button" onclick="document.body.insertAdjacentHTML('beforeend','<p>Found 3 results</p>')">Search</button>
      <button type="submit">Submit enquiry</button></form>`,
  '/login': `<form onsubmit="event.preventDefault();document.cookie='sid=SECRET-COOKIE-123';document.body.innerHTML='<p>Welcome back</p>'">
      <input type="email" name="user" placeholder="Email"><input type="password" name="pass"><button>Log in</button></form>`,
  '/pay': '<input autocomplete="cc-number" name="card"><button>Continue</button>',
  '/long': `<p>${'word '.repeat(5000)}</p>`,
};
let server; let base;
let boss; let other;

before(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Test</title><body>${body || 'Not found'}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await closeAll(); server.close(); await closeDb(); });
beforeEach(async () => {
  await closeAll();
  await reset();
  boss = { id: await makeUser('Boss'), role: 'master', name: 'Boss' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  other = { id: await makeUser('Other'), role: 'user', name: 'Other' };
  await setSettings({ enabled: true });
});

// ---------- the guard ----------

for (const label of ['Submit', 'Pay now', 'Confirm', 'Send', 'Delete', 'Sign', 'Apply', 'Register', 'I agree', 'Accept', 'إرسال', 'تأكيد', 'دفع', 'سداد', 'حذف', 'تقديم']) {
  test(`"${label}" needs the person's OK`, () => assert.equal(needsOk({ label, url: 'https://x.ae/a' }).ok, false));
}
for (const label of ['Search', 'Calculate', 'Next page', 'Login', 'Log in', 'Show results', 'بحث', 'Apply filters']) {
  test(`"${label}" doesn't`, () => assert.equal(needsOk({ label, url: 'https://x.ae/a', isFormSubmit: true }).ok, true));
}
test('any button on a page with card fields needs OK', () => assert.equal(needsOk({ label: 'Continue', pageHasCardFields: true }).ok, false));
test('a payment page needs OK', () => assert.equal(needsOk({ label: 'Continue', url: 'https://pay.example.com/checkout' }).ok, false));
test('an unnamed button that sends a form needs OK', () => assert.equal(needsOk({ label: '', isFormSubmit: true }).ok, false));

// ---------- the engine ----------

test('switched off in Settings: no browser', { skip }, async () => {
  await setSettings({ enabled: false });
  await assert.rejects(openTask(boss, { conversationId: 1 }), { status: 403 });
});

test('one job per person: another chat waits with a 409, the same chat carries on', { skip }, async () => {
  const a = await openTask(boss, { conversationId: 1 });
  assert.equal((await openTask(boss, { conversationId: 1 })).id, a.id);
  await assert.rejects(openTask(boss, { conversationId: 2 }), { status: 409 });
});

test('two people get separate windows; cookies are kept between jobs, encrypted', { skip }, async () => {
  const a = await openTask(boss, { conversationId: 1 });
  await pageOf(a.id).goto(`${base}/login`);
  await pageOf(a.id).locator('input[type=email]').fill('b@x.ae');
  await pageOf(a.id).locator('input[type=password]').fill('pw');
  await pageOf(a.id).locator('button').click();
  await endTask(a.id, 'done');
  const row = await db.prepare('SELECT state FROM browser_sessions WHERE user_id = ?').get(boss.id);
  assert.ok(row && !row.state.includes('SECRET-COOKIE-123'), 'stored encrypted');

  const again = await openTask(boss, { conversationId: 1 });
  await pageOf(again.id).goto(`${base}/form`);
  assert.match(await pageOf(again.id).evaluate(() => document.cookie), /SECRET-COOKIE-123/);
  const b = await openTask(other, { conversationId: 9 });
  await pageOf(b.id).goto(`${base}/form`);
  assert.equal(await pageOf(b.id).evaluate(() => document.cookie), '');
});

test('only the owner can answer a job', { skip }, async () => {
  const a = await openTask(boss, { conversationId: 1 });
  assert.equal(ownerOf(a.id), boss.id);
  await assert.rejects(answer(a.id, other, { ok: true }), { status: 404 });
});

test('a restart marks open jobs stopped', { skip }, async () => {
  const a = await openTask(boss, { conversationId: 1 });
  await recoverAtBoot();
  assert.equal((await getTask(a.id)).status, 'stopped');
});

// ---------- the page as Reem reads it ----------

test('the page is read as numbered things to use, passwords hidden', { skip }, async () => {
  const a = await openTask(boss, { conversationId: 1 });
  const p = pageOf(a.id);
  await p.goto(`${base}/login`);
  await p.locator('input[type=password]').fill('hunter2');
  const s = await snapshot(p);
  assert.match(s.text, /\[1\] field \(email\) "Email"/);
  assert.match(s.text, /\[2\] \[password field\] "pass" \(filled\)/);
  assert.match(s.text, /\[3\] button "Log in"/);
  assert.ok(!s.text.includes('hunter2'));
  await p.goto(`${base}/pay`);
  assert.equal((await snapshot(p)).hasCardFields, true);
  await p.goto(`${base}/long`);
  assert.match((await snapshot(p)).text, /page continues, scroll to see more$/);
});

// ---------- saved logins ----------

test('a login is filled only on its own site, and its password is never given back', { skip }, async () => {
  await saveLogin(boss, { label: 'Test site', url: `${base}/login`, username: 'b@x.ae', password: 'hunter2' });
  const [l] = await listLogins(boss);
  assert.equal(l.host, '127.0.0.1');
  assert.ok(!JSON.stringify(l).includes('hunter2'));
  const stored = await db.prepare('SELECT secret FROM browser_logins WHERE id = ?').get(l.id);
  assert.ok(!stored.secret.includes('hunter2'));
  assert.deepEqual(await listLogins(other), [], 'another person sees none');

  const a = await openTask(boss, { conversationId: 1 });
  const p = pageOf(a.id);
  await p.goto(`${base}/login`);
  assert.equal(await fillLogin(boss, p, l.id), 'filled');
  await p.waitForSelector('text=Welcome back');
  await assert.rejects(fillLogin(other, p, l.id), { status: 404 });
  assert.equal(hostOf('https://www.rdc.gov.ae/x'), 'rdc.gov.ae');
});

// ---------- the chat tools ----------

const call = (kit, name, input) => kit.run({ id: 't1', name, input });

test('the tools are there only with the Browser module and the switch on', { skip }, async () => {
  assert.equal(await browserKit(other, { conversationId: 1, onCard: () => {} }), null, 'no module');
  await setSettings({ enabled: false });
  assert.equal(await browserKit(boss, { conversationId: 1, onCard: () => {} }), null, 'switched off');
});

test('Reem fills a form and searches, but Submit waits for the person: OK presses it', { skip }, async () => {
  const cards = [];
  const kit = await browserKit(boss, { conversationId: 1, onCard: (t) => cards.push(t) });
  let r = await call(kit, 'browser_open', { url: `${base}/form`, goal: 'Send an enquiry' });
  assert.ok(!r.is_error, r.content);
  assert.equal(cards[0].goal, 'Send an enquiry');
  r = await call(kit, 'browser_act', { actions: [{ ref: 1, do: 'type', value: 'Francis' }, { ref: 2, do: 'choose', value: 'Sharjah' }, { ref: 3, do: 'click' }, { ref: 4, do: 'click' }] });
  assert.match(r.content, /Found 3 results/);
  assert.match(r.content, /Not clicked: \[4\] "Submit enquiry" needs the person's OK/);
  assert.doesNotMatch(r.content, /Sent!/);

  const task = cards.at(-1).id;
  const waiting = call(kit, 'browser_confirm', { ref: 4, what: 'Send the enquiry' });
  while ((await getTask(task)).status !== 'waiting_ok') await new Promise((s) => setTimeout(s, 50));
  assert.equal((await getTask(task)).ask.what, 'Send the enquiry');
  await answer(task, boss, { ok: true });
  assert.match((await waiting).content, /Sent!/);
});

test('No means the button is not pressed', { skip }, async () => {
  const cards = [];
  const kit = await browserKit(boss, { conversationId: 1, onCard: (t) => cards.push(t) });
  await call(kit, 'browser_open', { url: `${base}/form` });
  const waiting = call(kit, 'browser_confirm', { ref: 4, what: 'Send the enquiry' });
  while ((await getTask(cards.at(-1).id)).status !== 'waiting_ok') await new Promise((s) => setTimeout(s, 50));
  await answer(cards.at(-1).id, boss, { ok: false });
  assert.match((await waiting).content, /said No/);
  assert.doesNotMatch((await call(kit, 'browser_look', {})).content, /Sent!/);
});

test('Reem never types a password, and a login result never holds it', { skip }, async () => {
  await saveLogin(boss, { label: 'Test site', url: base, username: 'b@x.ae', password: 'hunter2' });
  const kit = await browserKit(boss, { conversationId: 1, onCard: () => {} });
  const opened = await call(kit, 'browser_open', { url: `${base}/login` });
  assert.match(opened.content, /Saved logins for this site .*"Test site" \(b@x\.ae\)/);
  const typed = await call(kit, 'browser_act', { actions: [{ ref: 2, do: 'type', value: 'guess' }] });
  assert.match(typed.content, /Passwords are never typed by you/);
  const [l] = await listLogins(boss);
  const r = await call(kit, 'browser_login', { login_id: l.id });
  assert.match(r.content, /Logged in\./);
  assert.ok(!r.content.includes('hunter2'));
});

test('the step limit stops the job', { skip }, async () => {
  await setSettings({ max_steps: 20 });
  const kit = await browserKit(boss, { conversationId: 1, onCard: () => {} });
  await call(kit, 'browser_open', { url: `${base}/form` });
  await db.prepare('UPDATE browser_tasks SET steps = 20').run();
  const r = await call(kit, 'browser_look', {});
  assert.equal(r.is_error, true);
  assert.match(r.content, /Step limit reached/);
});
