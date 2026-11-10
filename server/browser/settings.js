import { db } from '../db.js';

// Settings → Browser, the master's switches (never .env, so they can be flipped from the
// app). The browser starts off: nothing opens a website until the master turns it on.

const DEFAULTS = { enabled: false, max_steps: 40 };
export const STEP_CHOICES = [20, 40, 60];

export async function getSettings() {
  const row = await db.prepare('SELECT data FROM browser_settings WHERE id = 1').get();
  return { ...DEFAULTS, ...(row?.data || {}) };
}

export async function setSettings(patch = {}) {
  const now = await getSettings();
  const next = { ...now };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.max_steps !== undefined) {
    const n = Number(patch.max_steps);
    if (!STEP_CHOICES.includes(n)) throw Object.assign(new Error(`Steps per job is one of ${STEP_CHOICES.join(', ')}.`), { status: 400 });
    next.max_steps = n;
  }
  await db.prepare(`INSERT INTO browser_settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`).run(JSON.stringify(next));
  return next;
}
