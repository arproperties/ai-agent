// The one line to saifsys — the company system at saifholdinggroup.com/sys.
//
// Riley only asks; saifsys answers through its own small door, api/jarvis/v1, which is
// read-only and locked with a shared key (SAIFSYS_API_KEY here, JARVIS_API_KEY there).
// Like the saifsys launcher, the door is split by module (?module=ars) and each module
// file there has a matching file here.

const BASE = () => (process.env.SAIFSYS_URL || 'https://saifholdinggroup.com/sys').replace(/\/+$/, '');
const KEY = () => process.env.SAIFSYS_API_KEY || '';
export const saifsysConfigured = () => !!KEY();

const TIMEOUT = 15_000;
export const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** Today's date in Dubai as YYYY-MM-DD — the server runs on UTC. */
export const dubaiDate = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
export const dubaiHour = (at = Date.now()) => Number(new Date(at).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }));

/** One call through the door: a module, an action in it, and params for the query string. */
export async function askSaifsys(module, action, params = {}) {
  if (!saifsysConfigured()) throw bad('saifsys is not connected yet: SAIFSYS_API_KEY is missing from .env.', 503);
  const url = new URL(`${BASE()}/api/jarvis/v1/`);
  url.searchParams.set('module', module);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Jarvis-Key': KEY(), Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw bad(`saifsys did not answer (${e.name}: ${e.message}).`, 502);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw bad(`saifsys said: ${body?.error?.message || `HTTP ${res.status}`}`, res.status === 400 ? 400 : 502);
  return body;
}

/**
 * A file through the same door (a job photo, a voice note): the saifsys answer as it
 * comes, body unread, so the caller can pass it straight on. `range` is the browser's
 * own Range header, which a video player needs honoured.
 */
export async function fileFromSaifsys(module, action, params = {}, range) {
  if (!saifsysConfigured()) throw bad('saifsys is not connected yet: SAIFSYS_API_KEY is missing from .env.', 503);
  const url = new URL(`${BASE()}/api/jarvis/v1/`);
  url.searchParams.set('module', module);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Jarvis-Key': KEY(), ...(range ? { Range: range } : {}) }, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw bad(`saifsys did not answer (${e.name}: ${e.message}).`, 502);
  }
  if (!res.ok) throw bad('That file could not be found.', 404);
  return res;
}

// ---------- the door for actions ----------

// Doing things in saifsys goes through a second door, api/jarvis/v1/act.php, with its own
// key (SAIFSYS_ACTION_KEY here, JARVIS_ACTION_KEY there): the read key alone can never
// change anything. Every call names who is acting by their verified company email.
const ACTION_KEY = () => process.env.SAIFSYS_ACTION_KEY || '';
export const saifsysActionsConfigured = () => !!ACTION_KEY();
const ACT_TIMEOUT = 30_000;

/**
 * One action. A saifsys refusal comes back as an Error carrying its code (and, for a
 * changed price, the new quote), so the caller can tell "no" from "did not answer".
 */
export async function actSaifsys(module, action, body) {
  if (!saifsysActionsConfigured()) throw bad('Creating in saifsys is not switched on yet: SAIFSYS_ACTION_KEY is missing from .env.', 503);
  const url = new URL(`${BASE()}/api/jarvis/v1/act.php`);
  url.searchParams.set('module', module);
  url.searchParams.set('action', action);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Jarvis-Action-Key': ACTION_KEY(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ACT_TIMEOUT),
    });
  } catch (e) {
    throw Object.assign(bad(`saifsys did not answer (${e.name}: ${e.message}).`, 502), { code: 'no_answer' });
  }
  const answer = await res.json().catch(() => null);
  if (!res.ok || !answer?.ok) {
    const err = answer?.error || {};
    throw Object.assign(bad(err.message || `saifsys said HTTP ${res.status}`, res.status >= 500 ? 502 : 400),
      { code: err.code || (answer ? 'refused' : 'no_answer'), quote: err.quote });
  }
  return answer;
}
