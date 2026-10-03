import { timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

// The door saifsys comes in by.
//
// Reem keeps the inventory - the tables, the rules, who keeps which building. saifsys only
// shows it: its Building Inventory screens are drawn there and every read and every change
// is a call to here, so there is one list and nothing is stored twice.
//
// Locked with a shared key: SAIFSYS_DOOR_KEY in .env here, REEM_DOOR_KEY in saifsys's
// includes/config.php. Empty or missing = the door answers 503 and lets nobody in.
//
// Every request says who is at the screen by their HR employee code (X-Saifsys-Employee),
// and the Reem account is the one the master linked to that code (server/hrLinks.js).
// Not by email on purpose: a saifsys user can type any email on their own profile, but
// only HR gives an employee code and only the master links one. From there on the
// request is that Reem account's, with exactly what it may do when signed in here.

const KEY = () => process.env.SAIFSYS_DOOR_KEY || '';
const tidy = (code) => String(code ?? '').trim().toUpperCase().slice(0, 40);

function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Reem account linked to this employee code, or null. */
export const personFromSaifsys = async (code) => (tidy(code)
  ? (await db.prepare('SELECT u.* FROM hr_links l JOIN users u ON u.id = l.user_id WHERE upper(l.employee_code) = ?').get(tidy(code))) || null
  : null);

/** Mount in front of a router: checks the key, then makes the request that person's. */
export function fromSaifsys(req, res, next) {
  if (!KEY()) return res.status(503).json({ error: 'The saifsys door is not switched on yet: SAIFSYS_DOOR_KEY is missing from .env.' });
  if (!sameKey(req.get('X-Saifsys-Key'), KEY())) return res.status(401).json({ error: 'Not authorised' });
  const code = tidy(req.get('X-Saifsys-Employee'));
  if (!code) return res.status(403).json({ error: 'Your saifsys login has no employee record, so Reem cannot tell who you are.', code: 'no_employee' });
  personFromSaifsys(code).then((user) => {
    if (!user) {
      return res.status(403).json({ error: `Reem has no account linked to employee ${code}. The master links it in Reem: People → the person → HR link.`, code: 'not_linked' });
    }
    if (user.disabled) return res.status(403).json({ error: 'This Reem account has been disabled', code: 'disabled' });
    req.user = user;
    next();
  }, next);
}
