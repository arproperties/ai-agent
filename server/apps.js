import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { ImapFlow } from 'imapflow';
import { db } from './db.js';
import { requireMaster } from './auth.js';
import { seal, unseal } from './aiKeys.js';

// Apps: mailboxes the master connects to Claude.ai (or any other AI) as a custom
// connector, set up from Settings → Apps instead of .env.
//
// The connector itself is a separate small server on the same machine (the
// aol-connector repo, pm2 aol-connector, port 3002), so a fault in it never takes Reem
// down. nginx sends https://<site>/aol-mcp/<token> to it; it asks Reem here, over the
// machine's own loopback, which mailbox that token opens. So the link is the key: anyone
// holding it can read and send that mail, and "New link" here kills the old one at once.
//
// The app password is stored sealed (aiKeys.js), and only goes back out through the
// loopback door below, never to the browser.

export const APPS = {
  aol: { name: 'AOL Mail', imap: 'imap.aol.com', path: '/aol-mcp/' },
};

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const appOf = (key) => {
  if (!APPS[key]) throw bad('Unknown app', 404);
  return key;
};
const newToken = () => randomBytes(24).toString('base64url');

/** Log in to the mailbox, so a wrong password is caught here and not later in Claude. */
async function checkLogin(app, email, password) {
  const client = new ImapFlow({ host: APPS[app].imap, port: 993, secure: true, auth: { user: email, pass: password }, logger: false });
  try {
    await client.connect();
  } catch (e) {
    if (e?.authenticationFailed || /auth|login|credential/i.test(`${e?.responseText || ''} ${e?.message || ''}`)) {
      throw bad(`${APPS[app].name} turned down this email and app password. Use an app password, not your normal password.`);
    }
    throw bad(`Could not reach ${APPS[app].name} to check the login: ${e.message}`);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** What the screen shows for each app: the email and the connector path, never the password. */
export async function listApps() {
  const rows = await db.prepare('SELECT app, email, secret, token, set_at FROM app_connectors').all();
  return Object.entries(APPS).map(([key, a]) => {
    const r = rows.find((x) => x.app === key);
    return {
      key,
      name: a.name,
      account: r ? {
        email: r.email,
        setAt: Number(r.set_at),
        link: `${a.path}${r.token}`, // the browser puts its own origin in front
        unreadable: !unseal(r.secret), // sealed on another server: set it again here
      } : null,
    };
  });
}

/** Save (or change) the login. The link stays the same, so Claude keeps working. */
export async function setApp(master, app, { email, password } = {}, { check = true } = {}) {
  appOf(app);
  const mail = String(email || '').trim().toLowerCase();
  const pass = String(password || '').replace(/\s+/g, ''); // app passwords are often shown in groups of four
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw bad('That is not an email address');
  if (pass.length < 8) throw bad('Type the app password');
  if (check) await checkLogin(app, mail, pass);
  // A changed login keeps its token, so the link already in Claude goes on working.
  await db.prepare(`INSERT INTO app_connectors (app, email, secret, token, set_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (app) DO UPDATE SET email = EXCLUDED.email, secret = EXCLUDED.secret, set_by = EXCLUDED.set_by,
      set_at = extract(epoch from now())::bigint`)
    .run(app, mail, seal(pass), newToken(), master.id);
  return listApps();
}

/** A new link: the old one stops working at once (re-add the connector in Claude). */
export async function newLink(app) {
  const r = await db.prepare('UPDATE app_connectors SET token = ? WHERE app = ?').run(newToken(), appOf(app));
  if (!r.changes) throw bad('Connect the mailbox first');
  return listApps();
}

export async function removeApp(app) {
  await db.prepare('DELETE FROM app_connectors WHERE app = ?').run(appOf(app));
  return listApps();
}

/** The login behind a link, for the connector. Null when the link is wrong or old. */
export async function loginFor(app, token) {
  if (!APPS[app] || !token) return null;
  const r = await db.prepare('SELECT email, secret FROM app_connectors WHERE app = ? AND token = ?').get(app, String(token));
  const password = r && unseal(r.secret);
  return password ? { email: r.email, password } : null;
}

// ---------- routes ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The master's screen.
export const appRoutes = Router();
appRoutes.use(requireMaster);
appRoutes.get('/', wrap(async (req, res) => res.json(await listApps())));
appRoutes.put('/:app', wrap(async (req, res) => res.json(await setApp(req.user, req.params.app, req.body))));
appRoutes.post('/:app/new-link', wrap(async (req, res) => res.json(await newLink(req.params.app))));
appRoutes.delete('/:app', wrap(async (req, res) => res.json(await removeApp(req.params.app))));

// The connector's door. Only from this machine itself, and not through nginx (which runs
// here too, so it is also loopback, but always adds X-Forwarded-For): from the internet
// this answers 404 like any unknown path.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const fromLoopback = (req) => LOOPBACK.has(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'];

export const connectorRoutes = Router();
connectorRoutes.get('/:app/:token', wrap(async (req, res) => {
  if (!fromLoopback(req)) return res.status(404).json({ error: 'Not found' });
  const login = await loginFor(req.params.app, req.params.token);
  if (!login) return res.status(404).json({ error: 'Not found' });
  res.json(login);
}));
