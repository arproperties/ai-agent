// The company's real mailboxes. Reem used to guess an address from a name ("accounts" →
// account@…), and a guessed address on our own domain bounces or, worse, reaches nobody
// without anyone noticing. The list goes to the agent, and a draft to one of our domains that
// is not on it is refused with the nearest real addresses, so a guess is caught before the
// user ever sees it. A mailbox added or closed in Titan is added or removed here.

export const COMPANY_DOMAINS = ['ainalreempro.com', 'madaralwadi.com'];

export const PEOPLE = [
  'amran@ainalreempro.com', 'francis@ainalreempro.com', 'francisca@ainalreempro.com',
  'gillani@ainalreempro.com', 'glenda@ainalreempro.com', 'grace@ainalreempro.com',
  'ihtisham@ainalreempro.com', 'jacob@ainalreempro.com', 'jessalyn@ainalreempro.com',
  'mohamed@ainalreempro.com', 'rona@ainalreempro.com', 'saba@ainalreempro.com',
  'said@ainalreempro.com', 'shrin@ainalreempro.com', 'tauqeer@madaralwadi.com',
];

export const SHARED = [
  'parkplace.watch@ainalreempro.com', 'ayla.watch@ainalreempro.com', 'heroeszone@ainalreempro.com',
  'support@ainalreempro.com', 'it@ainalreempro.com', 'hr@ainalreempro.com', 'legal@ainalreempro.com',
  'accounts@ainalreempro.com', 'maintenance@ainalreempro.com', 'info@ainalreempro.com',
  'tenantcare@ainalreempro.com',
];

const ALL = new Set([...PEOPLE, ...SHARED]);

const domainOf = (a) => String(a).split('@')[1] || '';
const localOf = (a) => String(a).split('@')[0];

/** True for an address on one of our own domains (where a guess can be checked). */
export const isCompanyAddress = (a) => COMPANY_DOMAINS.includes(domainOf(String(a).trim().toLowerCase()));

/** True when the address is a real company mailbox. */
export const isKnown = (a) => ALL.has(String(a).trim().toLowerCase());

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** The real mailboxes nearest to a wrong one: account@ → accounts@, mohammed@ → mohamed@. */
export function nearest(address, max = 3) {
  const want = localOf(String(address).trim().toLowerCase());
  // A name that is the start of a real one (or the other way round) beats a near spelling.
  const starts = [...ALL].filter((a) => localOf(a).startsWith(want) || want.startsWith(localOf(a)));
  if (starts.length) return starts.slice(0, max);
  return [...ALL]
    .map((a) => ({ a, d: distance(want, localOf(a)) }))
    .filter((x) => x.d <= Math.max(2, want.length / 3))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.a);
}

/**
 * Throws when any address is on our own domain but is not a real mailbox, naming the
 * nearest real ones so the agent can correct itself or ask.
 */
export function checkAddresses(list) {
  const wrong = (list || []).filter((a) => isCompanyAddress(a) && !isKnown(a));
  if (!wrong.length) return;
  throw new Error(wrong.map((a) => {
    const near = nearest(a);
    return `${a} is not a company mailbox.` + (near.length ? ` Did you mean ${near.join(' or ')}?` : '');
  }).join(' ') + ' Use an address from <company_addresses> exactly, or ask the user which one they mean.');
}

/** The list as the agent sees it. */
export const addressPrompt = () =>
  '<company_addresses>\nThe only real company mailboxes. When the user names a person or a department ' +
  '("email accounts", "send to Rona", "copy legal"), use the address from this list exactly; never build one from a name. ' +
  'If more than one could fit, or none does, ask which one they mean.\n' +
  `People: ${PEOPLE.join(', ')}\nShared: ${SHARED.join(', ')}\n</company_addresses>`;
