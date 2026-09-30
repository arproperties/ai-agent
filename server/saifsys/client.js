// The one line to saifsys — the company system at saifholdinggroup.com/sys.
//
// Jarvis only asks; saifsys answers through its own small door, api/jarvis/v1, which is
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
