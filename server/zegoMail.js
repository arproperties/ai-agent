import { Router } from 'express';
import { simpleParser } from 'mailparser';
import { db } from './db.js';
import { isMaster } from './access.js';
import { encrypt } from './secrets.js';
import { withMailbox } from './imap.js';
import { todayHere } from './leasingRegion.js';
import { parseReport, matchPayouts, recordPayouts } from './zego.js';

// Zego's payments report, picked up from the Gmail it is emailed to, so nobody downloads and
// uploads it. The Gmail is connected here only, for this alone (a Google app password, kept
// encrypted), and only read: nothing is ever sent from it.
//
// Once a week by itself (startZegoMail), or when someone presses "Sync now", the report emails
// since the last good run are read: each PDF or CSV attached goes through the same reading and
// matching as an upload (server/zego.js), and the payments matched for sure are put on their
// leases. Anything not sure (no lease yet, an unknown name, a payment that looks typed in by
// hand already) is left on no lease, for a person to place from the payout's list. A report
// read twice records nothing twice (Trans #), so the runs may overlap.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FIRST_LOOK = 35 * DAY; // the first run looks back about a month
const OVERLAP = 3 * DAY; // later runs look back a little before the last good one, in case a report came late
const MAX_EMAILS = 50;

const account = (row) => ({ host: 'imap.gmail.com', port: 993, username: row.email, password_enc: row.password_enc, sender: row.sender });

// ---------- reading the mailbox (tests put their own in place) ----------

/** The mailbox's "All Mail" (reports filed away by a Gmail filter are found too), else the inbox. */
async function allMail(c) {
  const boxes = await c.list();
  return boxes.find((b) => b.specialUse === '\\All')?.path || 'INBOX';
}

let mail = {
  /** Signs in and out, or throws why it could not. */
  check: (acc) => withMailbox(acc, async () => true),
  /** The emails from the sender since the date, oldest first, with their attachments. */
  reports: (acc, since) => withMailbox(acc, async (c) => {
    const lock = await c.getMailboxLock(await allMail(c), { readOnly: true });
    try {
      const uids = ((await c.search({ since, from: acc.sender }, { uid: true })) || []).slice(-MAX_EMAILS);
      const out = [];
      for (const uid of uids) {
        const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
        const p = await simpleParser(m.source);
        out.push({
          subject: p.subject || '(no subject)', date: p.date ? p.date.toISOString() : null, text: p.text || '',
          attachments: (p.attachments || []).map((a) => ({ filename: a.filename || '', contentType: a.contentType || '', content: a.content })),
        });
      }
      return out;
    } finally { lock.release(); }
  }),
};
export const useMail = (m) => { mail = { ...mail, ...m }; };

// ---------- the connection ----------

const row = () => db.prepare('SELECT * FROM zego_mailbox WHERE id = 1').get();

/** Where the Gmail stands, never with its password. */
export async function mailboxState() {
  const r = await row();
  if (!r) return { connected: false, running };
  return {
    connected: true, email: r.email, sender: r.sender, auto: r.auto, running,
    last_run_at: r.last_run_at, last_ok_at: r.last_ok_at, last_result: r.last_result, next_run_at: r.auto ? nextRun(r)?.toISOString() : null,
  };
}

/**
 * Connects the Gmail, or changes it. A new password is tried before it is kept, so a wrong one
 * is told at once. Without one, the saved password stays (to switch the weekly run on or off).
 */
export async function saveMailbox(body = {}, by) {
  const old = await row();
  const email = String(body.email ?? old?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter the Gmail address the Zego reports come to.');
  const sender = String(body.sender ?? old?.sender ?? 'zego').trim().slice(0, 100) || 'zego';
  const auto = body.auto === undefined ? old?.auto ?? true : body.auto === true || body.auto === 'true';
  const password = String(body.app_password ?? '').replace(/\s+/g, '');
  if (!password && (!old || email !== old.email)) throw bad('Enter the Gmail app password (16 letters, from the Google account\'s security settings).');
  const password_enc = password ? encrypt(password) : old.password_enc;
  if (password) {
    try { await mail.check(account({ email, password_enc, sender })); } catch (e) {
      throw bad(/wrong email or password|authenticat/i.test(e.message)
        ? 'Gmail refused the sign-in. Check the address, and use an app password (not the normal Gmail password), with 2-Step Verification on.'
        : e.message.replace(/^Email: /, ''));
    }
  }
  await db.prepare(`INSERT INTO zego_mailbox (id, email, password_enc, sender, auto, created_by) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password_enc = EXCLUDED.password_enc, sender = EXCLUDED.sender, auto = EXCLUDED.auto`)
    .run(email, password_enc, sender, auto, by ?? null);
  return mailboxState();
}

export async function removeMailbox() {
  await db.prepare('DELETE FROM zego_mailbox WHERE id = 1').run();
  return mailboxState();
}

// ---------- a run ----------

let running = false;

/** Reads the report emails since the last good run and records what is sure. The result is kept, to show. */
export async function syncMail({ by = null, today = todayHere(), now = new Date() } = {}) {
  const acc = await row();
  if (!acc) throw bad('Connect the Gmail that gets Zego\'s reports first.', 409);
  if (running) throw bad('A sync is running already. Try again in a minute.', 409);
  running = true;
  const since = new Date(acc.last_ok_at ? new Date(acc.last_ok_at).getTime() - OVERLAP : now.getTime() - FIRST_LOOK);
  const result = { at: now.toISOString(), by_hand: !!by, emails: 0, reports: 0, recorded: 0, already: 0, left: 0, failed: [], notes: [] };
  try {
    const emails = await mail.reports(account(acc), since);
    result.emails = emails.length;
    for (const e of emails) {
      const files = e.attachments.filter((a) => /\.(pdf|csv)$/i.test(a.filename) || /pdf|csv/i.test(a.contentType));
      if (!files.length) {
        result.notes.push(`"${e.subject}"${e.date ? ` (${e.date.slice(0, 10)})` : ''} has no PDF or CSV attached${/https?:\/\//.test(e.text) ? ', only a link' : ''}: it was not read.`);
        continue;
      }
      for (const f of files) {
        try {
          const payouts = await matchPayouts(await parseReport({ buffer: f.content, originalname: f.filename, mimetype: f.contentType }));
          const r = await recordPayouts(payouts, { fileName: f.filename, by, today });
          result.reports++;
          result.recorded += r.recorded;
          result.already += r.already;
          result.left += r.skipped + r.failed.length;
          result.failed.push(...r.failed);
        } catch (err) {
          if (!err.status) throw err;
          result.notes.push(`${f.filename || 'An attachment'} in "${e.subject}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    result.error = String(err.message || err).replace(/^Email: /, '');
  } finally {
    running = false;
  }
  await db.prepare('UPDATE zego_mailbox SET last_run_at = ?, last_ok_at = coalesce(?, last_ok_at), last_result = ? WHERE id = 1')
    .run(now.toISOString(), result.error ? null : now.toISOString(), JSON.stringify(result));
  return result;
}

/** When the weekly run is next due: a week after the last run, or a day after one that failed. */
export function nextRun(r) {
  if (!r?.auto) return null;
  if (!r.last_run_at) return new Date(0);
  return new Date(new Date(r.last_run_at).getTime() + (r.last_result?.error ? DAY : WEEK));
}

/** Runs the weekly sync when it is due; checked every hour. */
export async function runIfDue(now = new Date()) {
  const r = await row();
  const at = nextRun(r);
  if (!at || at > now || running) return null;
  return syncMail({ now });
}

// ---------- routes (under /api/accounts/zego, beside the upload's) ----------

const masterOnly = (req, res, next) => (isMaster(req.user) ? next() : res.status(403).json({ error: 'Only the master connects the Gmail.' }));
export const zegoMailRoutes = Router();
zegoMailRoutes.get('/mailbox', async (req, res) => res.json(await mailboxState()));
zegoMailRoutes.put('/mailbox', masterOnly, async (req, res) => res.json(await saveMailbox(req.body, req.user.id)));
zegoMailRoutes.delete('/mailbox', masterOnly, async (req, res) => res.json(await removeMailbox()));
zegoMailRoutes.post('/sync', async (req, res) => res.json(await syncMail({ by: req.user.id })));

export function startZegoMail() {
  const tick = () => runIfDue().then((r) => r && console.log(`[zego-mail] ${r.error ? `failed: ${r.error}` : `${r.recorded} payment(s) recorded, ${r.left} left for a person`}`))
    .catch((e) => console.error('[zego-mail]', e.message));
  tick();
  return setInterval(tick, 60 * 60_000);
}
