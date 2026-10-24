import { Router } from 'express';
import { db } from './db.js';
import { requireMaster } from './auth.js';

// The company's real mailboxes. Reem used to guess an address from a name ("accounts" →
// account@…), and a guessed address on our own domain bounces or, worse, reaches nobody
// without anyone noticing. The list goes to the agent, and a draft to one of our domains that
// is not on it is refused with the nearest real addresses, so a guess is caught before the
// user ever sees it.
//
// Two halves: the mailboxes written below, and the ones the master added since (the
// company_addresses table) - from Settings → Address book, or from chat through an
// Add/Cancel card when Reem meets an address it does not know. Only the master adds: a
// typo saved here becomes a "real" address for everyone.

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

const BUILT_IN = new Set([...PEOPLE, ...SHARED]);
let added = []; // the master's, as last read from company_addresses

const norm = (a) => String(a ?? '').trim().toLowerCase();
const domainOf = (a) => String(a).split('@')[1] || '';
const localOf = (a) => String(a).split('@')[0];
const all = () => [...BUILT_IN, ...added];

/** Reads the master's additions again. Cheap; called before every check and every prompt. */
export async function loadAddresses() {
  added = (await db.prepare('SELECT email FROM company_addresses ORDER BY email').all()).map((r) => r.email);
}

/** True for an address on one of our own domains (where a guess can be checked). */
export const isCompanyAddress = (a) => COMPANY_DOMAINS.includes(domainOf(norm(a)));

/** True when the address is a real company mailbox. */
export const isKnown = (a) => BUILT_IN.has(norm(a)) || added.includes(norm(a));

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
  const want = localOf(norm(address));
  // A name that is the start of a real one (or the other way round) beats a near spelling.
  const starts = all().filter((a) => localOf(a).startsWith(want) || want.startsWith(localOf(a)));
  if (starts.length) return starts.slice(0, max);
  return all()
    .map((a) => ({ a, d: distance(want, localOf(a)) }))
    .filter((x) => x.d <= Math.max(2, want.length / 3))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.a);
}

/**
 * Throws when any address is on our own domain but is not a real mailbox, naming the
 * nearest real ones so the agent can correct itself or ask. canAdd: the user is the master,
 * who can put a right-but-missing address in the address book from chat.
 */
export async function checkAddresses(list, { canAdd = false } = {}) {
  await loadAddresses();
  const wrong = (list || []).filter((a) => isCompanyAddress(a) && !isKnown(a));
  if (!wrong.length) return;
  throw new Error(wrong.map((a) => {
    const near = nearest(a);
    return `${a} is not in the company address book.` + (near.length ? ` Did you mean ${near.join(' or ')}?` : '');
  }).join(' ') + ' Use an address from <company_addresses> exactly, or ask the user which one they mean. ' +
    (canAdd
      ? 'If the user says the address is right, call add_company_address with it: a card with Add and Cancel appears, and the draft is written once they tap Add.'
      : 'If the user says the address is right, tell them only the master can add a new address to the address book, so they should ask the master to add it.'));
}

/** The list as the agent sees it. Call loadAddresses first. */
export const addressPrompt = () =>
  '<company_addresses>\nThe only real company mailboxes. When the user names a person or a department ' +
  '("email accounts", "send to Rona", "copy legal"), use the address from this list exactly; never build one from a name. ' +
  'If more than one could fit, or none does, ask which one they mean.\n' +
  `People: ${PEOPLE.join(', ')}\nShared: ${SHARED.join(', ')}` +
  (added.length ? `\nAdded by the master: ${added.join(', ')}` : '') + '\n</company_addresses>';

// ---------- adding and removing ----------

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const NOW = 'extract(epoch from now())::bigint';

function cleanNew(raw) {
  const email = norm(raw);
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/.test(email)) throw bad(`"${raw}" is not an email address.`);
  if (!isCompanyAddress(email)) {
    throw bad(`${email} is not on ${COMPANY_DOMAINS.join(' or ')}. Outside addresses are never checked, so it can be used as it is - nothing to add.`);
  }
  return email;
}

export async function listAddresses() {
  await loadAddresses();
  const rows = await db.prepare('SELECT id, email, created_at FROM company_addresses ORDER BY email').all();
  return {
    builtIn: [...BUILT_IN].sort(),
    added: rows,
  };
}

export async function addAddress(master, raw) {
  await loadAddresses();
  const email = cleanNew(raw);
  if (isKnown(email)) throw bad(`${email} is already in the address book.`, 409);
  const row = await db.prepare(`INSERT INTO company_addresses (email, added_by) VALUES (?, ?)
      ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at`).get(email, master.id);
  if (!row) throw bad(`${email} is already in the address book.`, 409);
  await loadAddresses();
  return row;
}

export async function removeAddress(id) {
  const { changes } = await db.prepare('DELETE FROM company_addresses WHERE id = ?').run(Number(id));
  await loadAddresses();
  return changes > 0;
}

// ---------- proposals from chat ----------
//
// Reem never adds an address straight in. It is proposed, a card appears with Add and
// Cancel, and only Add changes the book - a misheard address is caught on the card.

const PCOLS = 'id, conversation_id, email, status, decided_at, created_at';

export const getProposal = (masterId, id) =>
  db.prepare(`SELECT ${PCOLS} FROM address_proposals WHERE id = ? AND master_id = ?`).get(Number(id), masterId);

export async function propose(master, raw, conversationId = null) {
  await loadAddresses();
  const email = cleanNew(raw);
  if (isKnown(email)) throw bad(`${email} is already in the address book - go ahead and use it.`);
  return db.prepare(`INSERT INTO address_proposals (master_id, conversation_id, email) VALUES (?, ?, ?) RETURNING ${PCOLS}`)
    .get(master.id, conversationId, email);
}

/** Add or Cancel on the card. The status change is the lock, so a double tap adds once. */
export async function decide(master, id, add) {
  const p = await getProposal(master.id, id);
  if (!p) return null;
  if (p.status !== 'pending') throw bad(`This was already ${p.status}.`, 409);
  const { changes } = await db.prepare(`UPDATE address_proposals SET status = ?, decided_at = ${NOW} WHERE id = ? AND status = 'pending'`)
    .run(add ? 'added' : 'cancelled', p.id);
  if (!changes) throw bad('This was already decided.', 409);
  if (add) {
    // Added from the Settings page in the meantime is still a yes.
    await db.prepare('INSERT INTO company_addresses (email, added_by) VALUES (?, ?) ON CONFLICT (email) DO NOTHING').run(p.email, master.id);
    await loadAddresses();
  }
  return getProposal(master.id, id);
}

// ---------- chat tool ----------

const DEF = {
  name: 'add_company_address',
  description: 'Put a company email address (on ' + COMPANY_DOMAINS.join(' or ') + ') that is missing from <company_addresses> into the address book, ' +
    'after the user has said it is right. This does NOT add it: a card with Add and Cancel appears in the chat. ' +
    'Say in one short line that it is ready to add. When they tap Add the chat carries on by itself, so do not write the draft yet.',
  input_schema: {
    type: 'object',
    properties: { email: { type: 'string', description: 'The address exactly as the user gave it.' } },
    required: ['email'],
  },
};

/** The master only. ctx: { conversationId, onCard } - onCard puts the Add/Cancel card in front of them. */
export function addressKit(user, ctx = {}) {
  const master = user.role === 'master';
  return {
    definitions: master ? [DEF] : [],
    status: (name) => (name === DEF.name ? 'Getting it ready…' : null),
    run: async (block) => {
      try {
        if (!master || block.name !== DEF.name) throw new Error(`Unknown tool ${block.name}`);
        const p = await propose(user, block.input?.email, ctx.conversationId);
        ctx.onCard?.(p);
        return { type: 'tool_result', tool_use_id: block.id, content: `Ready as card #${p.id} for ${p.email}. It is NOT added yet - tell the user to tap Add on the card. Never say it is added.` };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes (all master only) ----------

export const addressRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
addressRoutes.use(requireMaster);

addressRoutes.get('/', wrap(async (req, res) => res.json(await listAddresses())));
addressRoutes.post('/', wrap(async (req, res) => res.json(await addAddress(req.user, req.body?.email))));
// Cards from chat. Before '/:id', so "proposals" is never read as an id.
addressRoutes.get('/proposals', wrap(async (req, res) => {
  res.json(await db.prepare(`SELECT ${PCOLS} FROM address_proposals WHERE master_id = ? AND conversation_id = ? ORDER BY id`)
    .all(req.user.id, Number(req.query.conversation) || 0));
}));
for (const [path, add] of [['add', true], ['cancel', false]]) {
  addressRoutes.post(`/proposals/:id/${path}`, wrap(async (req, res) => {
    const p = await decide(req.user, req.params.id, add);
    p ? res.json(p) : res.status(404).json({ error: 'Not found' });
  }));
}
addressRoutes.delete('/:id', wrap(async (req, res) => {
  (await removeAddress(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));
