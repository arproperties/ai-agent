// WhatsApp from a chat: "message Ahmed on WhatsApp: the cheque is ready". Reem cannot send a
// WhatsApp message and never pretends to. What it does is open WhatsApp on the person's screen
// with the message already typed (a wa.me link, server/whatsappCore.js); they press send.
//
// A number is said once ("send hi to 971 54 438 7902, that's Ahmed") and kept per person, so
// the next time the name is enough. Without a number for that name the agent asks for it.
// The numbers are in a table and not in the chat memory: a number has to come back exactly,
// not as a model's recollection of it. Every query is scoped to the one person (user_id).
import { Router } from 'express';
import { db } from './db.js';
import { waNumber, whatsappUrl } from './whatsappCore.js';

const keyOf = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Remember whose number this is. The same name again replaces the number. Returns the contact. */
export async function saveContact(userId, name, phone) {
  const who = String(name || '').trim().replace(/\s+/g, ' ');
  if (!who) throw new Error('A name is needed to save a number.');
  const number = waNumber(phone);
  if (!number) throw new Error(`"${phone}" is not a number WhatsApp can open. Ask for the mobile number with its country code (a UAE mobile like 050 123 4567 needs none).`);
  await db.prepare(
    `INSERT INTO whatsapp_contacts (user_id, name, name_key, phone) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, name_key) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = extract(epoch from now())`,
  ).run(userId, who, keyOf(who), number);
  return { name: who, phone: number };
}

/** The person's saved contacts, by name. */
export const listContacts = (userId) =>
  db.prepare('SELECT name, phone FROM whatsapp_contacts WHERE user_id = ? ORDER BY name_key').all(userId);

/**
 * Who a name means: the exact name if there is one, else every saved name that contains it
 * ("Ahmed" finds "Ahmed Khan"). Possibly several: the caller asks which rather than guessing.
 */
export async function findContacts(userId, query) {
  const q = keyOf(query);
  if (!q) return [];
  const all = await db.prepare('SELECT name, name_key, phone FROM whatsapp_contacts WHERE user_id = ?').all(userId);
  const exact = all.filter((c) => c.name_key === q);
  return (exact.length ? exact : all.filter((c) => c.name_key.includes(q))).map(({ name, phone }) => ({ name, phone }));
}

/** Forget a saved number, by name. Returns whether there was one. */
export async function forgetContact(userId, name) {
  const { changes } = await db.prepare('DELETE FROM whatsapp_contacts WHERE user_id = ? AND name_key = ?').run(userId, keyOf(name));
  return changes > 0;
}

// ---------- the contacts screen ----------
//
// Settings → WhatsApp contacts: the same list the agents use, seen and edited by hand. Every
// query carries the person's user_id, so one person's list never shows or changes another's.

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

/** The person's saved contacts with their ids, for the screen. */
export const contactRows = (userId) =>
  db.prepare('SELECT id, name, phone FROM whatsapp_contacts WHERE user_id = ? ORDER BY name_key').all(userId);

/** Add a contact by hand. A name already saved is refused: edit that one instead. */
export async function addContact(userId, { name, phone }) {
  const who = cleanName(name);
  if (!who) throw bad('Write the name.');
  const number = waNumber(phone);
  if (!number) throw bad('That is not a number WhatsApp can open. Use the mobile number with its country code (a UAE mobile like 050 123 4567 needs none).');
  if (await db.prepare('SELECT 1 FROM whatsapp_contacts WHERE user_id = ? AND name_key = ?').get(userId, keyOf(who))) {
    throw bad(`${who} is already saved. Edit that one instead.`, 409);
  }
  const { id } = await db.prepare('INSERT INTO whatsapp_contacts (user_id, name, name_key, phone) VALUES (?, ?, ?, ?) RETURNING id')
    .run(userId, who, keyOf(who), number);
  return { id, name: who, phone: number };
}

/** Change a contact's name, number or both. Null when it is not this person's. */
export async function updateContact(userId, id, { name, phone }) {
  const row = await db.prepare('SELECT id, name, phone FROM whatsapp_contacts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  const who = name === undefined ? row.name : cleanName(name);
  if (!who) throw bad('Write the name.');
  let number = row.phone;
  if (phone !== undefined) {
    number = waNumber(phone);
    if (!number) throw bad('That is not a number WhatsApp can open. Use the mobile number with its country code (a UAE mobile like 050 123 4567 needs none).');
  }
  const clash = await db.prepare('SELECT id FROM whatsapp_contacts WHERE user_id = ? AND name_key = ? AND id <> ?').get(userId, keyOf(who), id);
  if (clash) throw bad(`${who} is already saved under another entry.`, 409);
  await db.prepare('UPDATE whatsapp_contacts SET name = ?, name_key = ?, phone = ?, updated_at = extract(epoch from now()) WHERE id = ? AND user_id = ?')
    .run(who, keyOf(who), number, id, userId);
  return { id: row.id, name: who, phone: number };
}

/** Delete a contact by id. False when it is not this person's. */
export async function deleteContact(userId, id) {
  const { changes } = await db.prepare('DELETE FROM whatsapp_contacts WHERE id = ? AND user_id = ?').run(id, userId);
  return changes > 0;
}

export const whatsappRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const gone = (res) => res.status(404).json({ error: 'That contact is not on your list.' });
whatsappRoutes.get('/', wrap(async (req, res) => { res.json(await contactRows(req.user.id)); }));
whatsappRoutes.post('/', wrap(async (req, res) => { res.json(await addContact(req.user.id, req.body || {})); }));
whatsappRoutes.patch('/:id', wrap(async (req, res) => {
  const c = await updateContact(req.user.id, Number(req.params.id), req.body || {});
  c ? res.json(c) : gone(res);
}));
whatsappRoutes.delete('/:id', wrap(async (req, res) => {
  (await deleteContact(req.user.id, Number(req.params.id))) ? res.json({ ok: true }) : gone(res);
}));

// ---------- the agents' tools ----------

export const WHATSAPP_TOOLS = [
  {
    name: 'whatsapp_draft',
    description: 'Get a TEXT message ready for someone to send on WhatsApp: a card appears in the chat with the message and an Open WhatsApp button; the user taps it and then taps send. ' +
      'Nothing opens by itself and nothing is sent by Reem. No file, plan, PDF or photo can go with it: never use this to "send" a document. ' +
      'Use it only when the user asked for a WhatsApp message, once you have both the number of the person (or a saved name) and what the message should say, which they may have given as little as "say hi". ' +
      'If the message was not said at all, ask for it first. Do not offer a choice of wordings or hand over a link: write the message and call this. ' +
      '"to" is a phone number the user just gave, or the name of someone whose number was saved before. ' +
      'If the user gives a number and says whose it is, pass "name" too and it is remembered for next time. ' +
      'If there is no saved number for a name, this tells you so: then ask the user for the WhatsApp number of that person, and call this again with it.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A phone number (e.g. 971 54 438 7902, 0544387902, +44 7911 123456) or the name of a saved contact.' },
        message: { type: 'string', description: 'The message to type, written for the person who will receive it, in the language they speak.' },
        name: { type: 'string', description: 'Whose number "to" is, when the user said. It is saved so the name alone works next time.' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'forget_whatsapp_contact',
    description: 'Delete a saved WhatsApp number, by name: "forget Francis number", "remove Ahmed from your contacts". The number is gone for good; ask for it again next time.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'list_whatsapp_contacts',
    description: 'The names and numbers the user has saved for WhatsApp. Use it when they ask whose numbers you have, or where a number came from.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_whatsapp_contact',
    description: 'Remember someone\'s WhatsApp number without opening WhatsApp: "save Ahmed\'s number 0544387902", or the user says whose number you were just given.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, phone: { type: 'string' } },
      required: ['name', 'phone'],
    },
  },
];

export function whatsappStatus(name) {
  switch (name) {
    case 'whatsapp_draft': return 'Getting WhatsApp ready…';
    case 'save_whatsapp_contact': return 'Saving the number…';
    case 'forget_whatsapp_contact': return 'Removing the number…';
    case 'list_whatsapp_contacts': return 'Checking the saved numbers…';
    default: return null;
  }
}

let cardSeq = 0;

const handlers = {
  whatsapp_draft: async (userId, ctx, input) => {
    const to = String(input.to || '').trim();
    const message = String(input.message || '').trim();
    if (!to) throw new Error('Who is it for? Ask the user for a name or a number.');
    if (!message) throw new Error('Write the message first, then call this again.');
    let phone = waNumber(to);
    let who = String(input.name || '').trim();
    let remembered = false;
    let fromSaved = false;
    if (phone) {
      if (who) { await saveContact(userId, who, to); remembered = true; }
    } else if (/\d{6,}/.test(to.replace(/\D/g, '')) && !/[a-z]/i.test(to)) {
      throw new Error(`"${to}" is not a number WhatsApp can open (a landline, or a number with no country code). Ask for their mobile number with its country code.`);
    } else {
      const hits = await findContacts(userId, to);
      if (!hits.length) throw new Error(`There is no WhatsApp number saved for "${to}". Ask the user for ${to}'s WhatsApp number (with the country code unless it is a UAE mobile), then call whatsapp_draft again with it and their name.`);
      if (hits.length > 1) throw new Error(`More than one saved contact fits "${to}": ${hits.map((h) => h.name).join(', ')}. Ask which one.`);
      phone = hits[0].phone;
      who = who || hits[0].name;
      fromSaved = true;
    }
    ctx.onCard?.({ id: `${Date.now()}-${++cardSeq}`, name: who || null, phone, message, url: whatsappUrl(phone, who, message) });
    return `A WhatsApp card is now on the user's screen for ${who || `+${phone}`} (+${phone}) with this message: "${message}". ` +
      'It has an Open WhatsApp button: nothing opens by itself, they tap it and then tap send in WhatsApp. Nothing has been sent and you must not say it was. ' +
      (fromSaved ? `The number is one they saved earlier: say so in a few words (using the saved number for ${who}), so a wrong one is easy to catch. ` : '') +
      (remembered ? `The number is saved as ${who}, so the name alone works next time. ` : !who ? 'The number is not saved under a name: if they say whose it is, call save_whatsapp_contact. ' : '') +
      'Reply in one short line: that the draft is ready on the card, and the message in plain words. It is a WhatsApp message only: say nothing about email or any other kind of draft.';
  },

  forget_whatsapp_contact: async (userId, ctx, input) => {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Whose number? Ask for the name.');
    if (await forgetContact(userId, name)) return `Removed the saved WhatsApp number for ${name}. It is gone: if they want to message ${name} again they will need to give the number.`;
    const hits = await findContacts(userId, name);
    if (hits.length === 1) {
      await forgetContact(userId, hits[0].name);
      return `Removed the saved WhatsApp number for ${hits[0].name}. It is gone.`;
    }
    return hits.length ? `More than one saved contact fits "${name}": ${hits.map((h) => h.name).join(', ')}. Ask which to remove.` : `There was no saved WhatsApp number for "${name}".`;
  },

  list_whatsapp_contacts: async (userId) => {
    const all = await listContacts(userId);
    return all.length ? `Saved WhatsApp numbers:\n${all.map((c) => `- ${c.name}: +${c.phone}`).join('\n')}` : 'No WhatsApp numbers are saved.';
  },

  save_whatsapp_contact: async (userId, ctx, input) => {
    const c = await saveContact(userId, input.name, input.phone);
    return `Saved: ${c.name} is +${c.phone} on WhatsApp. Next time the name is enough.`;
  },
};

/** The WhatsApp tools, in the kit shape chat.js holds a list of. onCard(card) puts the WhatsApp card on screen. */
export function whatsappKit(user, { onCard } = {}) {
  const ctx = { onCard };
  return {
    definitions: WHATSAPP_TOOLS,
    status: whatsappStatus,
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(user.id, ctx, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
