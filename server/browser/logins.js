import { db } from '../db.js';
import { encrypt, decrypt } from '../secrets.js';

// A person's logins for websites, typed once in Settings → Browser. The password is kept
// encrypted and only ever typed into a page of the same website: never shown back, never
// given to the AI, never in a log. Each person sees and uses only their own.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** "https://www.rdc.gov.ae/login" → "rdc.gov.ae". */
export function hostOf(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { throw bad('That doesn\'t look like a website address.'); }
}

/** The page is on the login's site (or one of its subdomains, like login.site.ae). */
export const sameSite = (pageUrl, host) => {
  let h;
  try { h = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return h === host || h.endsWith(`.${host}`);
};

export const listLogins = (user) => db.prepare('SELECT id, label, host, username, created_at FROM browser_logins WHERE user_id = ? ORDER BY label, id').all(user.id);

export async function saveLogin(user, { label, url, username, password } = {}) {
  const host = hostOf(url);
  if (!String(username || '').trim()) throw bad('Type the username.');
  if (!String(password || '')) throw bad('Type the password.');
  await db.prepare(`INSERT INTO browser_logins (user_id, label, host, username, secret) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, host, username) DO UPDATE SET label = EXCLUDED.label, secret = EXCLUDED.secret`)
    .run(user.id, String(label || '').trim() || host, host, String(username).trim(), encrypt(String(password)));
  return listLogins(user);
}

export async function removeLogin(user, id) {
  await db.prepare('DELETE FROM browser_logins WHERE id = ? AND user_id = ?').run(Number(id), user.id);
  return listLogins(user);
}

/** The person's logins for the site this page is on: what the AI is told (never the password). */
export async function loginsFor(user, pageUrl) {
  return (await listLogins(user)).filter((l) => sameSite(pageUrl, l.host));
}

/**
 * Types the saved login into the page: 'filled', 'wrong_site' or 'no_fields'. Then it
 * presses Enter in the password field, which is how nearly every login form sends.
 */
export async function fillLogin(user, page, loginId) {
  const l = await db.prepare('SELECT * FROM browser_logins WHERE id = ? AND user_id = ?').get(Number(loginId), user.id);
  if (!l) throw bad('That login isn\'t one of yours.', 404);
  if (!sameSite(page.url(), l.host)) return 'wrong_site';
  const pass = page.locator('input[type=password]:visible').first();
  if (!(await pass.count())) return 'no_fields';
  // The username box: the visible text/email field just before the password one.
  const userBox = await pass.evaluateHandle((p) => {
    const all = [...document.querySelectorAll('input')].filter((i) => /^(text|email|tel|)$/i.test(i.type || '') && i.offsetParent !== null);
    const before = all.filter((i) => i.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.at(-1) || null;
  });
  const el = userBox.asElement();
  if (el) await el.fill(l.username);
  await pass.fill(decrypt(l.secret));
  await pass.press('Enter');
  return 'filled';
}
