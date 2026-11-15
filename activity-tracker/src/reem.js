// Talking to Reem's door (server/tracker.js on the Reem side). Two calls, both with the
// PC's own key in a header. A 401 means the key is not paired any more: the sheet shows that
// and the app stops retrying, because no number of retries will fix it.

/** Reem does not know this PC: the key was deleted or never existed. */
export class PairingError extends Error {}

const TIMEOUT_MS = 10_000;

async function post(url, key, path, body) {
  let res;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/api/from-tracker/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tracker-Key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Reem could not be reached: ${e.cause?.message || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new PairingError(data.error || 'This PC is not paired with Reem');
  if (!res.ok) throw new Error(data.error || `Reem answered ${res.status}`);
  return data;
}

/** Who this PC belongs to and when its day ends, straight after pairing and at each start. */
export const hello = (url, key) => post(url, key, 'hello', {});

/** One day's summary (see summary.js). Resolves to Reem's { ok, day_end }. */
export const sendDay = (url, key, day) => post(url, key, 'day', day);
