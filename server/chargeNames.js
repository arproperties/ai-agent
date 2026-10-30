// The lease's own charge names: the three rents and the security deposit. The form knows a line is rent or the
// deposit by its name, so these are picked from the list, never typed; a name typed that is one of them, or a typo
// of one ("Rnet", "Securty deposit"), is refused, so it cannot slip in as an ordinary charge (Francis, 2026-10-30).
// Shared by the lease form (client) and the services list (server). Pure: no database.

// On a split lease "Rent" is the tenant's part; "Rent – Tenant" was the same thing under a second name, so it is
// gone from the list and read as "Rent" (Francis, 2026-10-30).
export const RENT_NAMES = ['Rent', 'Rent – HUD/Agency'];
export const DEPOSIT_NAME = 'Security deposit';
const FIXED = [...RENT_NAMES, DEPOSIT_NAME];
const OLD = { renttenant: 'Rent' };

/** Letters and digits only, lower case: "RENT - hud/agency" and "Rent – HUD/Agency" are the same name. */
const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The fixed name `name` is, however it was typed, or null. */
export const fixedName = (name) => FIXED.find((f) => key(f) === key(name)) || OLD[key(name)] || null;

/** How many letters to add, drop or change to turn a into b. */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The fixed name `name` looks like without being it (a typo, or a name starting with it), or null.
    "Pet Rent", "Washer Dryer Rental" and "Mailbox Key Deposit" are ordinary charges and stay free. */
export function lookalike(name) {
  if (fixedName(name)) return null;
  const k = key(name), words = String(name ?? '').trim().toLowerCase();
  if (!k) return null;
  if (/^secur\w*\s*dep/.test(words) || distance(k, key(DEPOSIT_NAME)) <= 2) return DEPOSIT_NAME;
  // A typo of one: two letters off at most. A typo of the short "Rent" must start with r, or "Pet" would be one.
  const near = RENT_NAMES.find((f) => distance(k, key(f)) <= 2 && (f !== 'Rent' || k[0] === 'r'));
  if (near) return near;
  if (/^rent\b/.test(words)) return /hud|agency/.test(words) ? RENT_NAMES[1] : RENT_NAMES[0];
  return null;
}
