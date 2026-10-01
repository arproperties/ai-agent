import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

// A stand-in for saifsys: the read door (index.php) for finding units and guests, and
// the action door (act.php) for quote and create. It records every create it is asked for.
let created = [];
let price = 750;
let actDown = false;
const saifsysUsers = ['shrin@ainalreempro.com', 'boss@ainalreempro.com'];

const fake = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const action = url.searchParams.get('action');
  if (url.pathname.endsWith('/act.php')) {
    if (req.headers['x-jarvis-action-key'] !== 'act-key') return send(401, { ok: false, error: { code: 'unauthorized', message: 'Not authorised.' } });
    if (actDown) return req.socket.destroy();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!saifsysUsers.includes(body.email)) return send(403, { ok: false, error: { code: 'no_saifsys_user', message: 'no user' } });
    const quote = {
      unit: { unit_id: body.unit_id, unit: '204', building: 'Ayla Residence', nightly_rate: 200, monthly_rate: 0, max_guests: 4 },
      guest: body.guest_id ? { guest_id: body.guest_id, name: 'Ali Hassan', phone: '+971500000000', new: false } : { name: `${body.new_guest.first_name} ${body.new_guest.last_name}`, new: true },
      check_in: body.check_in, check_out: body.check_out, nights: 5, num_guests: body.num_guests,
      price: { pricing_mode: body.pricing_mode, rate: body.rate ?? 200, custom_rate: body.rate != null, subtotal: price, discount: 0,
        vat_mode: body.vat_mode, vat_rate: 5, vat_amount: 0, total: price, currency: 'AED' },
      deposit: 0, starts_as: 'pending', pending_expiry_hours: 24, created_by: body.email, warnings: [],
    };
    if (action === 'quote') return send(200, { ok: true, quote });
    if (action === 'create') {
      if (Math.abs(body.expected_total - price) > 0.009) return send(409, { ok: false, error: { code: 'price_changed', message: 'changed', quote } });
      created.push(body);
      return send(200, { ok: true, booking: { booking_id: 9, booking_number: 'ARS-26-00300', status: 'pending', total: price } });
    }
  }
  if (action === 'unit') return send(200, { ok: true, unit: { unit_id: 55, unit: '204', building: 'Ayla Residence' } });
  if (action === 'guest') return send(200, { ok: true, guest: { guest_id: 7, name: 'Ali Hassan' } });
  send(404, { ok: false, error: { message: 'unknown' } });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.SAIFSYS_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.SAIFSYS_API_KEY = 'read-key';
process.env.SAIFSYS_ACTION_KEY = 'act-key';
const { bookingKit, proposeBooking, decideBooking, verifiedEmail, setActions, CREATE_BOOKING } = await import('../server/saifsys/booking.js');
const { saifsysActionKit, setAccess } = await import('../server/saifsys/index.js');

test.after(() => { fake.close(); return closeDb(); });

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const person = async (name, { master = false, mailbox, login } = {}) => {
  const id = await makeUser(name);
  if (master) await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(id);
  if (mailbox) {
    await db.prepare(`INSERT INTO imap_accounts (user_id, email, host, username, password_enc) VALUES (?, ?, 'imap.titan.email', ?, 'x')`)
      .run(id, mailbox, login ?? mailbox);
  }
  return userRow(id);
};
const STAY = { unit: '204', guest: 'Ali', check_in: '2026-10-05', check_out: '2026-10-10', num_guests: 2, vat_mode: 'none', rate: 150 };

test('only a mailbox login that is an email address counts as proof', async () => {
  await reset();
  const a = await person('A', { mailbox: 'Shrin@AinalreemPro.com' });
  const b = await person('B', { mailbox: 'b@x.com', login: 'bob' });
  assert.equal(await verifiedEmail(a.id), 'shrin@ainalreempro.com');
  assert.equal(await verifiedEmail(b.id), null);
});

test('the master always has the booking tools; staff only when ticked and with ARS', async () => {
  await reset();
  const boss = await person('Boss', { master: true });
  const staff = await person('Shrin');
  assert.ok(await saifsysActionKit(boss, {}));
  assert.equal(await saifsysActionKit(staff, {}), null);
  await setActions(staff.id, [CREATE_BOOKING]);
  assert.equal(await saifsysActionKit(staff, {}), null); // ticked, but no ARS module
  await setAccess(staff.id, ['ars']);
  const kit = await saifsysActionKit(staff, {});
  assert.deepEqual(kit.definitions.map((d) => d.name), ['ars_quote_booking', 'ars_propose_booking']);
  assert.ok(!('historical' in kit.definitions[0].input_schema.properties)); // past stays are the master's
  assert.ok('historical' in (await bookingKit(boss, {})).definitions[0].input_schema.properties);
});

test('no connected company email: Reem says where to connect it, and nothing reaches saifsys', async () => {
  await reset();
  const boss = await person('Boss', { master: true });
  const out = await (await bookingKit(boss, {})).run({ id: 't', name: 'ars_quote_booking', input: STAY });
  assert.equal(out.is_error, true);
  assert.match(out.content, /Workspace menu → Email/);
});

test('an email that is not on a saifsys profile is explained, not a raw error', async () => {
  await reset();
  const boss = await person('Boss', { master: true, mailbox: 'someone@else.com' });
  const out = await (await bookingKit(boss, {})).run({ id: 't', name: 'ars_quote_booking', input: STAY });
  assert.match(out.content, /not on your saifsys profile/);
});

test('the quote gives the price and asks about price and VAT; nothing is created', async () => {
  await reset();
  created = [];
  const boss = await person('Boss', { master: true, mailbox: 'boss@ainalreempro.com' });
  const out = await (await bookingKit(boss, {})).run({ id: 't', name: 'ars_quote_booking', input: { ...STAY, rate: undefined } });
  assert.ok(!out.is_error, out.content);
  assert.match(out.content, /AED 750\.00/);
  assert.match(out.content, /different price\? With VAT or no VAT\?/);
  assert.equal(created.length, 0);
});

test('propose makes a card and nothing else; Create makes the booking once, as the person', async () => {
  await reset();
  created = [];
  price = 750;
  const staff = await person('Shrin', { mailbox: 'shrin@ainalreempro.com' });
  await setAccess(staff.id, ['ars']);
  await setActions(staff.id, [CREATE_BOOKING]);
  let card = null;
  const kit = await saifsysActionKit(staff, { onCard: (c) => { card = c; } });
  const out = await kit.run({ id: 't', name: 'ars_propose_booking', input: STAY });
  assert.match(out.content, /NOT created yet/);
  assert.equal(card.status, 'pending');
  assert.equal(card.input, undefined); // the card is not handed the raw request
  assert.equal(created.length, 0);

  const done = await decideBooking(staff, card.id, true);
  assert.equal(done.status, 'created');
  assert.equal(done.result.booking_number, 'ARS-26-00300');
  assert.equal(created.length, 1);
  assert.equal(created[0].email, 'shrin@ainalreempro.com');
  assert.equal(created[0].expected_total, 750);
  assert.equal(created[0].unit_id, 55);
  assert.equal(created[0].guest_id, 7);

  await assert.rejects(decideBooking(staff, card.id, true), /already been created/);
  assert.equal(created.length, 1);
});

test('a price that moved after the card: nothing is made, the card shows the new price', async () => {
  await reset();
  created = [];
  price = 750;
  const boss = await person('Boss', { master: true, mailbox: 'boss@ainalreempro.com' });
  const card = await proposeBooking(boss, STAY);
  price = 800;
  const after = await decideBooking(boss, card.id, true);
  assert.equal(after.status, 'pending');
  assert.equal(after.quote.price.total, 800);
  assert.match(after.note, /price changed/);
  assert.equal(created.length, 0);
  price = 750;
});

test('saifsys not answering is failed with a warning to check, never quietly retried', async () => {
  await reset();
  created = [];
  const boss = await person('Boss', { master: true, mailbox: 'boss@ainalreempro.com' });
  const card = await proposeBooking(boss, STAY);
  actDown = true;
  const after = await decideBooking(boss, card.id, true);
  actDown = false;
  assert.equal(after.status, 'failed');
  assert.match(after.error, /Check in saifsys before trying again/);
});

test('a tick taken away before the tap stops it, and the card stays open', async () => {
  await reset();
  const staff = await person('Shrin', { mailbox: 'shrin@ainalreempro.com' });
  await setAccess(staff.id, ['ars']);
  await setActions(staff.id, [CREATE_BOOKING]);
  const card = await proposeBooking(staff, STAY);
  await setActions(staff.id, []);
  await assert.rejects(decideBooking(staff, card.id, true), /not allowed/);
  assert.equal((await db.prepare('SELECT status FROM ars_booking_requests WHERE id = ?').get(card.id)).status, 'pending');
});

test('staff cannot add past stays; cancel closes the card', async () => {
  await reset();
  const staff = await person('Shrin', { mailbox: 'shrin@ainalreempro.com' });
  await assert.rejects(proposeBooking(staff, { ...STAY, historical: true }), /Only the admin/);
  const boss = await person('Boss', { master: true, mailbox: 'boss@ainalreempro.com' });
  const card = await proposeBooking(boss, STAY);
  assert.equal((await decideBooking(boss, card.id, false)).status, 'cancelled');
  assert.equal(await decideBooking(staff, card.id, true), null); // someone else's card is not found
});
