import { Router } from 'express';
import { db, tx } from '../db.js';
import { isMaster } from '../access.js';
import { imapAccount } from '../imap.js';
import { outlookAccount } from '../outlook.js';
import { askSaifsys, actSaifsys, saifsysActionsConfigured, bad } from './client.js';

// Creating an ARS booking from chat. Matches api/jarvis/v1/modules/ars_booking.php.
//
// Reem only ever PROPOSES a booking, like an email draft or a reminder for others:
//   1. ars_quote_booking asks saifsys what it would charge. Reem tells the person the
//      price and asks whether they want a different price, and VAT or no VAT.
//   2. ars_propose_booking, once they have answered, gets saifsys's price again and puts
//      a card in the chat with Create and Cancel. Nothing exists in saifsys yet.
//   3. Create on the card is the only thing that makes the booking. saifsys checks the
//      unit is still free with it locked, and that the total is still the one on the
//      card; if the price moved, nothing is made and the card shows the new one.
//
// Who may: the master, and the people ticked for it (saifsys_action_access). And the
// person must have connected their company mailbox, whose address is the email on their
// saifsys profile — connecting it took the mailbox password, so it proves who they are,
// and saifsys records the booking under that user. No match, no booking.
//
// Past (historical) stays are the master's alone.

export const CREATE_BOOKING = 'ars_create_booking';
export const ACTIONS = [{ key: CREATE_BOOKING, module: 'ars', label: 'Create ARS bookings' }];

// ---------- who may ----------

export async function mayAct(user, action) {
  if (isMaster(user)) return true;
  return !!(await db.prepare('SELECT 1 FROM saifsys_action_access WHERE user_id = ? AND action = ?').get(user.id, action));
}

export async function actionKeys(userId) {
  return (await db.prepare('SELECT action FROM saifsys_action_access WHERE user_id = ?').all(userId)).map((r) => r.action);
}

/** Replaces the person's set of actions, so the caller sends the end state. */
export async function setActions(userId, wanted) {
  const keys = [...new Set(Array.isArray(wanted) ? wanted : [])];
  const unknown = keys.find((k) => !ACTIONS.some((a) => a.key === k));
  if (unknown) throw bad(`Unknown action: ${unknown}`);
  await tx(async () => {
    await db.prepare('DELETE FROM saifsys_action_access WHERE user_id = ?').run(userId);
    for (const k of keys) await db.prepare('INSERT INTO saifsys_action_access (user_id, action) VALUES (?, ?)').run(userId, k);
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The company email this person has PROVED is theirs: the IMAP login name (the mailbox
 * accepted its password) or the Outlook account Microsoft signed them into. The typed
 * "email" field of an IMAP account is not proof on its own, so a login name that is not
 * an address does not count.
 */
export async function verifiedEmail(userId) {
  const imap = await imapAccount(userId);
  const login = String(imap?.username || '').trim().toLowerCase();
  if (EMAIL.test(login)) return login;
  const outlook = await outlookAccount(userId);
  const address = String(outlook?.email || '').trim().toLowerCase();
  return EMAIL.test(address) ? address : null;
}

const NO_EMAIL = 'To create bookings, connect your company email in Reem first: open the Workspace menu → Email. ' +
  'It has to be the same email that is on your saifsys profile.';

async function actingEmail(userId) {
  const email = await verifiedEmail(userId);
  if (!email) throw Object.assign(bad(NO_EMAIL, 403), { code: 'no_email' });
  return email;
}

/** saifsys's refusals the person can fix, in words they can act on. */
function explain(e, email) {
  if (e.code === 'no_saifsys_user') {
    return `Your connected email (${email}) is not on your saifsys profile. Add it there (saifsys → Profile → Email), then try again.`;
  }
  if (e.code === 'email_not_unique') return `${e.message} Ask the saifsys admin to fix the duplicate email.`;
  return e.message;
}

// ---------- the request ----------

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "204", "Ayla 204" → the unit's id, through the read door. Ambiguity is an error, so Reem asks. */
async function findUnit(input) {
  if (input.unit_id) return Number(input.unit_id);
  const q = String(input.unit || '').trim();
  if (!q) throw bad('Say which unit.');
  const a = await askSaifsys('ars', 'unit', { q });
  if (a.unit) return a.unit.unit_id;
  const units = a.units || [];
  const exact = units.filter((u) => String(u.unit).toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0].unit_id;
  if (!units.length) throw bad(`No ARS unit matches "${q}".`);
  throw bad(`"${q}" could be ${units.slice(0, 10).map((u) => `${u.building} ${u.unit}`).join(', ')}. Ask which one.`);
}

/** The guest's id, or the new guest's details. */
async function findGuest(input) {
  if (input.guest_id) return { guest_id: Number(input.guest_id) };
  if (input.new_guest?.first_name) return { new_guest: input.new_guest };
  const q = String(input.guest || '').trim();
  if (!q) throw bad('Say who the guest is.');
  const a = await askSaifsys('ars', 'guest', { q });
  if (a.guest) return { guest_id: a.guest.guest_id };
  if (!a.matches?.length) {
    throw bad(`No ARS guest matches "${q}". To add them as a new guest, ask for their first and last name and phone ` +
      '(email and nationality if they have them) and pass new_guest.');
  }
  throw bad(`"${q}" could be ${a.matches.slice(0, 10).map((g) => `${g.name} (${g.phone || 'no phone'}, guest_id ${g.guest_id})`).join('; ')}. Ask which one.`);
}

/** What goes to saifsys: the agent's input with unit and guest resolved. */
async function resolve(user, input) {
  if (!ISO.test(input.check_in || '') || !ISO.test(input.check_out || '')) throw bad('check_in and check_out must be YYYY-MM-DD.');
  if (input.historical && !isMaster(user)) throw bad('Only the admin can add past (historical) bookings.', 403);
  const body = {
    unit_id: await findUnit(input),
    ...(await findGuest(input)),
    check_in: input.check_in,
    check_out: input.check_out,
    num_guests: input.num_guests || 1,
    pricing_mode: input.pricing_mode || 'nightly',
    rate: input.rate ?? null,
    total: input.total ?? null,
    vat_mode: input.vat_mode || 'exclusive',
    discount: input.discount || null,
    deposit: input.deposit || 0,
    special_requests: input.special_requests || '',
    internal_notes: input.internal_notes || '',
  };
  if (input.historical) Object.assign(body, { historical: true, historical_status: input.historical_status || 'confirmed' });
  return body;
}

const money = (n, cur = 'AED') => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const VAT = { exclusive: 'VAT on top', inclusive: 'VAT included', none: 'no VAT' };

function quoteLine(q) {
  const p = q.price;
  const rate = p.pricing_mode === 'nightly' ? `${money(p.rate, p.currency)}/night${p.custom_rate ? ' (custom rate)' : ''}`
    : p.pricing_mode === 'monthly_package' ? 'monthly package' : 'fixed total';
  return `${q.unit.building} unit ${q.unit.unit}, ${q.guest.name}${q.guest.new ? ' (new guest)' : ''}, ${q.check_in} → ${q.check_out} ` +
    `(${q.nights} night${q.nights > 1 ? 's' : ''}, ${q.num_guests} guest${q.num_guests > 1 ? 's' : ''}): ${rate}, ${VAT[p.vat_mode]}` +
    `${p.vat_amount ? ` (${money(p.vat_amount, p.currency)} at ${p.vat_rate}%)` : ''}${p.discount ? `, discount ${money(p.discount, p.currency)}` : ''}` +
    ` = total ${money(p.total, p.currency)}.` +
    ` The unit's own rate is ${money(q.unit.nightly_rate, p.currency)}/night.` +
    (q.deposit ? ` Deposit ${money(q.deposit, p.currency)}.` : '') +
    (q.warnings?.length ? ` Warning: ${q.warnings.join(' ')}` : '');
}

// ---------- cards ----------

export async function getRequest(userId, id) {
  return db.prepare('SELECT * FROM ars_booking_requests WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

const cardOut = ({ input, ...r }) => r; // the card needs the quote and the outcome, not the raw input

export async function proposeBooking(user, input, conversationId = null) {
  const email = await actingEmail(user.id);
  const body = await resolve(user, input);
  let quote;
  try {
    ({ quote } = await actSaifsys('ars_booking', 'quote', { email, ...body }));
  } catch (e) {
    throw Object.assign(bad(explain(e, email), e.status), { code: e.code });
  }
  const { id } = await db.prepare(`INSERT INTO ars_booking_requests (user_id, conversation_id, input, quote)
      VALUES (?, ?, ?, ?) RETURNING id`).run(user.id, conversationId, JSON.stringify(body), JSON.stringify(quote));
  return getRequest(user.id, id);
}

/**
 * The person's tap. The move from pending to creating is the lock: a second tap, or a
 * second device, finds it no longer pending and makes nothing.
 */
export async function decideBooking(user, id, create) {
  const r = await getRequest(user.id, id);
  if (!r) return null;
  if (r.status !== 'pending') throw bad(`This booking has already been ${r.status}.`, 409);
  if (!create) {
    await db.prepare(`UPDATE ars_booking_requests SET status = 'cancelled', decided_at = extract(epoch from now())::bigint WHERE id = ? AND status = 'pending'`).run(r.id);
    return getRequest(user.id, id);
  }
  // Checked again at the tap: the tick can be taken away, or the mailbox disconnected, after the card appeared.
  if (!(await mayAct(user, CREATE_BOOKING))) throw bad('You are not allowed to create ARS bookings any more.', 403);
  if (r.input.historical && !isMaster(user)) throw bad('Only the admin can add past (historical) bookings.', 403);
  const email = await actingEmail(user.id);
  const claimed = await db.prepare(`UPDATE ars_booking_requests SET status = 'creating' WHERE id = ? AND status = 'pending' RETURNING id`).get(r.id);
  if (!claimed) throw bad('This booking is already being created.', 409);

  const finish = (fields) => db.prepare(`UPDATE ars_booking_requests SET status = ?, result = ?, error = ?, note = ?, quote = COALESCE(?, quote),
      decided_at = extract(epoch from now())::bigint WHERE id = ?`)
    .run(fields.status, fields.result ? JSON.stringify(fields.result) : null, fields.error ?? null, fields.note ?? null,
      fields.quote ? JSON.stringify(fields.quote) : null, r.id);
  try {
    const { booking } = await actSaifsys('ars_booking', 'create', { email, ...r.input, expected_total: r.quote.price.total });
    await finish({ status: 'created', result: booking });
  } catch (e) {
    if (e.code === 'price_changed' && e.quote) {
      // Back to pending with the new price on the card: the person decides again.
      await db.prepare(`UPDATE ars_booking_requests SET status = 'pending', quote = ?, note = ? WHERE id = ?`)
        .run(JSON.stringify(e.quote), 'The price changed in saifsys. Check the new total, then tap Create again.', r.id);
    } else if (e.code === 'no_answer') {
      await finish({ status: 'failed', error: 'saifsys did not answer, so it is not known whether the booking was made. Check in saifsys before trying again.' });
    } else {
      await finish({ status: 'failed', error: explain(e, email) });
    }
  }
  return getRequest(user.id, id);
}

// ---------- chat tools ----------

const DATE = { type: 'string', description: 'YYYY-MM-DD.' };
const BOOKING_INPUT = {
  unit: { type: 'string', description: 'Unit number, e.g. "204", or building and unit. Or pass unit_id from an earlier lookup.' },
  unit_id: { type: 'integer' },
  guest: { type: 'string', description: 'Existing guest\'s name or phone. Or pass guest_id from an earlier lookup.' },
  guest_id: { type: 'integer' },
  new_guest: {
    type: 'object', description: 'A guest who is not in ARS yet. first_name and last_name are required; ask for the phone too.',
    properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, nationality: { type: 'string' } },
  },
  check_in: { ...DATE, description: 'Arrival day, YYYY-MM-DD.' },
  check_out: { ...DATE, description: 'The day they leave, YYYY-MM-DD.' },
  num_guests: { type: 'integer' },
  pricing_mode: { type: 'string', enum: ['nightly', 'monthly_package', 'manual_total'], description: 'nightly (default); monthly_package for the unit\'s monthly rate; manual_total for a fixed amount for the whole stay.' },
  rate: { type: 'number', description: 'A nightly rate the user gave instead of the unit\'s own (nightly only).' },
  total: { type: 'number', description: 'The whole stay\'s amount, for manual_total.' },
  vat_mode: { type: 'string', enum: ['exclusive', 'inclusive', 'none'], description: 'exclusive = VAT added on top, inclusive = VAT inside the price, none = no VAT.' },
  discount: { type: 'object', properties: { type: { type: 'string', enum: ['percentage', 'fixed'] }, value: { type: 'number' } } },
  deposit: { type: 'number', description: 'Security deposit, if the user asks for one.' },
  special_requests: { type: 'string' },
  internal_notes: { type: 'string' },
};
const HISTORICAL = {
  historical: { type: 'boolean', description: 'A past stay being recorded after the fact. Admin only.' },
  historical_status: { type: 'string', enum: ['confirmed', 'checked_in', 'checked_out', 'completed'] },
};

function definitions(user) {
  const props = { ...BOOKING_INPUT, ...(isMaster(user) ? HISTORICAL : {}) };
  const required = ['check_in', 'check_out'];
  return [
    {
      name: 'ars_quote_booking',
      description: 'Step 1 of creating an ARS booking: ask saifsys what it would charge for a stay, and check the unit is free. Saves nothing. ' +
        'Always call this first with the unit\'s own price (no rate, no vat_mode). Then tell the user the unit\'s price and the total, ' +
        'and ask BOTH: do they want a different price, and should it be with VAT or no VAT? Wait for their answer.',
      input_schema: { type: 'object', properties: props, required },
    },
    {
      name: 'ars_propose_booking',
      description: 'Step 2: put the booking card in the chat, with Create and Cancel. Only after ars_quote_booking AND after the user has answered ' +
        'both questions (price, and VAT or no VAT) — pass their answer as rate / total / pricing_mode and vat_mode. ' +
        'This does NOT create the booking: nothing exists in saifsys until the user taps Create on the card. ' +
        'Say in one short line that it is ready for them to check and tap Create. Never say it has been booked.',
      input_schema: { type: 'object', properties: { ...props, vat_mode: { ...props.vat_mode } }, required: [...required, 'vat_mode'] },
    },
  ];
}

const STATUS = { ars_quote_booking: 'Getting the price from saifsys…', ars_propose_booking: 'Getting the booking ready…' };

/** Same shape as the other kits. null when this person may not create bookings. */
export async function bookingKit(user, ctx = {}) {
  if (!saifsysActionsConfigured() || !(await mayAct(user, CREATE_BOOKING))) return null;
  const handlers = {
    ars_quote_booking: async (input) => {
      const email = await actingEmail(user.id);
      const body = await resolve(user, input);
      try {
        const { quote } = await actSaifsys('ars_booking', 'quote', { email, ...body });
        return `saifsys price: ${quoteLine(quote)} It starts as ${quote.starts_as}` +
          `${quote.pending_expiry_hours ? ` and expires after ${quote.pending_expiry_hours} hours unless confirmed in saifsys` : ''}. ` +
          'Now tell the user this price and ask: a different price? With VAT or no VAT?';
      } catch (e) {
        throw new Error(explain(e, email));
      }
    },
    ars_propose_booking: async (input) => {
      const r = await proposeBooking(user, input, ctx.conversationId);
      ctx.onCard?.(cardOut(r));
      return `Card #${r.id} is in the chat: ${quoteLine(r.quote)} It is NOT created yet — the user must tap Create on the card. Never say it is booked.`;
    },
  };
  return {
    definitions: definitions(user),
    status: (name) => STATUS[name] || null,
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}

// ---------- routes ----------

export const bookingRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'Booking not found' });

// The cards in one chat, oldest first, whatever became of them.
bookingRoutes.get('/', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ars_booking_requests WHERE user_id = ? AND conversation_id = ? ORDER BY id')
    .all(req.user.id, Number(req.query.conversation) || 0);
  res.json(rows.map(cardOut));
}));
bookingRoutes.post('/:id/create', wrap(async (req, res) => {
  const r = await decideBooking(req.user, req.params.id, true);
  r ? res.json(cardOut(r)) : gone(res);
}));
bookingRoutes.post('/:id/cancel', wrap(async (req, res) => {
  const r = await decideBooking(req.user, req.params.id, false);
  r ? res.json(cardOut(r)) : gone(res);
}));
