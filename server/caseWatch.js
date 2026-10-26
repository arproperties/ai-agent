import { db } from './db.js';
import { billAs } from './billing.js';
import { refresh } from './caseFolders.js';

// The case folder watcher: every few minutes each tracked folder of an external user is
// brought up to date from its owner's mailbox. One folder failing (a password changed, the
// mailbox down) is written on that folder and the rest still get their mail.

const EVERY = 5 * 60_000;
const FIRST = 60_000;

/** deps: { mailbox, ask } - only tests pass them; the app uses the real ones. */
export async function lookAll(deps = {}) {
  const folders = await db.prepare(`SELECT f.id, u.id user_id, u.role, u.external FROM case_folders f
    JOIN users u ON u.id = f.user_id
    WHERE f.tracking AND u.external AND u.role IS DISTINCT FROM 'master' ORDER BY f.id`).all();
  let failed = 0;
  for (const f of folders) {
    const owner = { id: f.user_id, role: f.role, external: f.external };
    // What the AI costs for a folder is that person's, under Email in Billing.
    // refresh has already written last_error on the folder; the watcher only counts it.
    await billAs({ userId: owner.id, job: 'mail' }, () => refresh(owner, f.id, deps)).catch((e) => {
      failed++;
      console.warn(`[case-folders] folder ${f.id}:`, e.message);
    });
  }
  return { checked: folders.length, failed };
}

let timer = null;
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try { await lookAll(); } catch (e) { console.warn('[case-folders]', e.message); } finally { busy = false; }
}
export function startCaseFolders() {
  if (timer) return;
  timer = setInterval(tick, EVERY);
  setTimeout(tick, FIRST);
}
