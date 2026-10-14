import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SAIFSYS_API_KEY = 'test-read'; // never used: every call to saifsys is stubbed below
process.env.SAIFSYS_ACTION_KEY = 'test-act';
const { encrypt } = await import('../server/secrets.js');
const { needsModule, setModuleAccess } = await import('../server/modules.js');
const { look } = await import('../server/tenantCare.js');
const R = await import('../server/renewals.js');

test.after(() => closeDb());

// ---------- the world outside, stubbed ----------

const NOW = Date.parse('2026-07-15T06:00:00Z'); // 10:00 in Dubai; the lease below ends in 108 days
const LEASE = {
  lease_id: 294, company_id: 2, lease_number: 'PARKPLAC-610-0001', building: 'PARK PLACE', unit: '610', unit_type: '1br', bedrooms: 1,
  premises_number: '648037932', tenant: 'Mohamed Saeed', email: 'tenant@mail.com', start_date: '2025-11-01', end_date: '2026-10-31',
  annual_rent: 36000, cheques: 4, payment_method: 'cheque', ejari: '0120191002002504', saifsys_renewal: null,
};
const quoteOf = (rent) => ({
  current_rent: 36000, proposed_rent: rent, grand_total: rent + 300, rera: 300, start_date: '2026-11-01', end_date: '2027-10-31', number_of_cheques: 4,
  cheques: ['2026-11-01', '2027-01-31', '2027-05-02', '2027-10-31'].map((date) => ({ date, amount: rent / 4, type: 'rent' })),
  cheques_total: rent, terms_text: 'Sixty days notice to leave.', required_documents_text: 'Passport copy',
});

let world;
function stub({ leases = [LEASE], dld, replies = [], docs = [], files = {} } = {}) {
  world = { sent: [], acts: [], todos: [], pushes: [], replies: [...replies], docs: [...docs] };
  R.useForTests({
    now: () => world.now ?? NOW,
    ask: async (module, action) => { assert.equal(`${module}/${action}`, 'realestate/renewals_due'); return { ok: true, leases }; },
    act: async (module, action, body) => {
      world.acts.push({ action, ...body });
      if (action === 'quote') return { quote: quoteOf(body.rent) };
      if (action === 'renew') return { renewal: { workflow_id: 117, new_lease_id: 525, activate_now: false } };
      throw new Error('unexpected');
    },
    actor: async () => 'boss@company.com',
    readDld: async () => dld ?? { pct: 5, average: 41000, confident: true, note: 'Up to 5%' },
    readReply: async () => world.replies.shift() ?? { intent: 'unclear', summary: '?' },
    readDocs: async () => world.docs.shift(),
    fetch: async (ref) => files[ref] ?? null,
    send: async (acc, pw, m) => { world.sent.push(m); },
    file: async () => {},
    push: async (ids, msg) => { world.pushes.push(msg.body); },
    todo: async (userId, t) => { world.todos.push({ userId, ...t }); },
  });
}

async function setup({ enabled = true } = {}) {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  await db.prepare(`INSERT INTO tenant_inbox (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, last_uid, uid_validity)
    VALUES (1, 'care@company.com', 'imap.titan.email', 993, 'care@company.com', ?, 'smtp.titan.email', 465, true, 10, 1)`).run(encrypt('pw'));
  await db.prepare(`INSERT INTO renewal_settings (id, enabled, floor_pct, max_rounds, payee, actor_id) VALUES (1, ?, 3, 2, 'Saif Holding LLC', ?)`).run(enabled, boss.id);
  return boss;
}

/** The last email sent, its quoted-printable text decoded so the words read whole. */
const lastMail = () => world.sent.at(-1).raw.toString()
  .replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const shot = { buffer: Buffer.from('a png'), mimetype: 'image/png', originalname: 'dld.png' };
let uid = 100;
/** A tenant's email arriving in the Tenant care inbox, as Tenant care hands it on. */
const arrives = async (fields) => R.claim({ uid: ++uid, from: LEASE.email, subject: 'Re: Lease renewal', text: 'see', at: Math.floor(NOW / 1000), ...fields }, 1);

// ---------- the rules ----------

test('the offer is the increase DLD allows, rounded down; the floor is the boss\'s, never above the offer', () => {
  const s = { floor_pct: 3, building_floors: { 'PARK PLACE': 1 } };
  assert.deepEqual(R.plan(LEASE, 5, s, '2026-07-15'), { offer: 37800, floor: 36300, late: false });
  assert.deepEqual(R.plan({ ...LEASE, building: 'AYLA' }, 5, s, '2026-07-15'), { offer: 37800, floor: 37000, late: false }, 'other buildings take the general floor');
  assert.deepEqual(R.plan({ ...LEASE, annual_rent: 36550 }, 5, s, '2026-07-15').offer, 38300, '38377.5 rounds down, so it never passes the legal limit');
  assert.deepEqual(R.plan({ ...LEASE, building: 'AYLA' }, 0, s, '2026-07-15'), { offer: 36000, floor: 36000, late: false }, 'no increase allowed: the floor cannot be above the offer');
});

test('with fewer than 90 days left the rent may not go up, whatever DLD allows', () => {
  assert.deepEqual(R.plan(LEASE, 10, { floor_pct: 3 }, '2026-08-10'), { offer: 36000, floor: 36000, late: true });
});

test('the tenant\'s answer: accept, a counter at or above the floor, a counter below it, and the boss for the rest', () => {
  const s = { max_rounds: 2 };
  const c = { offer: 37800, floor: 37000, rounds: 0 };
  assert.deepEqual(R.respond(c, { intent: 'accept' }, s), { do: 'agree', rent: 37800 });
  assert.deepEqual(R.respond(c, { intent: 'counter', amount: 37200 }, s), { do: 'agree', rent: 37200 });
  assert.deepEqual(R.respond(c, { intent: 'counter', amount: 39000 }, s), { do: 'agree', rent: 37800 }, 'more than asked is not taken');
  assert.deepEqual(R.respond(c, { intent: 'counter', amount: 36000 }, s), { do: 'counter', rent: 37000 }, 'halfway, 36,900, rounded up to 500, but never below the floor');
  assert.deepEqual(R.respond({ ...c, floor: 36000 }, { intent: 'counter', amount: 35000 }, s), { do: 'counter', rent: 36500 });
  assert.equal(R.respond({ ...c, rounds: 2 }, { intent: 'counter', amount: 36000 }, s).do, 'boss', 'after two counter-offers the boss decides');
  assert.equal(R.respond({ ...c, offer: 37000 }, { intent: 'counter', amount: 36000 }, s).do, 'boss', 'already at the floor: nothing left to give');
  assert.deepEqual(R.respond(c, { intent: 'reject' }, s), { do: 'reject' });
  assert.deepEqual(R.respond(c, { intent: 'question', answer: 'Yes, 4 cheques.' }, s), { do: 'answer', text: 'Yes, 4 cheques.' });
  assert.equal(R.respond(c, { intent: 'question', question: 'Can I pay cash?', answer: null }, s).do, 'boss');
  assert.equal(R.respond(c, { intent: 'unclear', summary: 'hmm' }, s).do, 'boss');
  assert.equal(R.respond(c, { intent: 'documents' }, s).do, 'boss');
});

test('the papers: a signed agreement and one cheque per payment, right amount, date and payee', () => {
  const c = { lease: LEASE, quote: quoteOf(37800) };
  const good = quoteOf(37800).cheques.map((ch) => ({ amount: ch.amount, date: ch.date, payee: 'SAIF HOLDING L.L.C', signed: true }));
  assert.deepEqual(R.checkPapers(c, { agreement: 'signed', cheques: good }, 'Saif Holding LLC'), { missing: [], wrong: [], complete: true });

  const partial = R.checkPapers(c, { agreement: 'unsigned', cheques: good.slice(0, 3) }, 'Saif Holding LLC');
  assert.equal(partial.complete, false);
  assert.match(partial.missing[0], /not signed/);
  assert.match(partial.missing[1], /cheque of AED 9,450 dated 31 October 2027/);

  const wrongPayee = R.checkPapers(c, { agreement: 'signed', cheques: [{ ...good[0], payee: 'Mohamed Saeed' }, ...good.slice(1)] }, 'Saif Holding LLC');
  assert.match(wrongPayee.wrong[0], /payable to "Mohamed Saeed"\. It must be payable to Saif Holding LLC/);

  const extra = R.checkPapers(c, { agreement: 'signed', cheques: [...good, { amount: 500, date: '2026-11-01', payee: null, signed: true }] }, null);
  assert.match(extra.wrong[0], /AED 500 dated 1 November 2026 does not match/);

  const late = R.checkPapers(c, { agreement: 'signed', cheques: [{ ...good[0], date: '2026-11-10' }, ...good.slice(1)] }, null);
  assert.equal(late.complete, false, 'a cheque dated over three days off is not that payment');

  assert.deepEqual(R.checkPapers({ ...c, lease: { ...LEASE, payment_method: 'bank_transfer' } }, { agreement: 'signed' }, null).complete, true, 'no cheques asked of a lease not paid by cheque');
});

test('papers from several emails add up, and a signed agreement stays signed', () => {
  const a = R.addPapers({}, { agreement: 'unsigned', cheques: [{ amount: 1, date: '2026-11-01', payee: 'Wrong' }] });
  const b = R.addPapers(a, { agreement: 'signed', cheques: [{ amount: 1, date: '2026-11-01', payee: 'Right' }, { amount: 2, date: '2027-01-31' }] });
  const c = R.addPapers(b, { agreement: 'none', cheques: [] });
  assert.equal(c.agreement, 'signed');
  assert.equal(c.cheques.length, 2, 'the same cheque twice is one cheque');
  assert.equal(c.cheques[0].payee, 'Right', 'the one sent again replaces the first');
});

// ---------- opening ----------

test('each morning\'s leases become cases once; staff renewals and monthly leases are left out', async () => {
  await setup();
  stub({ leases: [
    LEASE,
    { ...LEASE, lease_id: 300, unit: '611', saifsys_renewal: 'notice_sent' },
    { ...LEASE, lease_id: 301, unit: '612', start_date: '2026-10-01' },
    { ...LEASE, lease_id: 302, unit: '613', email: '' },
  ] });
  assert.deepEqual(await R.openCases({ force: true }), { day: '2026-07-15', due: 4, opened: 2 });
  assert.deepEqual(await R.openCases({ force: true }), { day: '2026-07-15', due: 4, opened: 0 }, 'a second run opens nothing again');
  const cases = await db.prepare('SELECT lease_id, status, needs FROM renewal_cases ORDER BY lease_id').all();
  assert.deepEqual(cases.map((c) => [c.lease_id, c.status]), [[294, 'dld_needed'], [302, 'boss']]);
  assert.match(cases[1].needs, /no email/);
  assert.match(world.pushes[0], /2 leases to renew/);
});

test('switched off, nothing is opened; the morning job runs once a day, from 8', async () => {
  await setup({ enabled: false });
  stub();
  assert.deepEqual(await R.openCases(), { skipped: 'switched off' });
  await db.prepare('UPDATE renewal_settings SET enabled = true').run();
  world.now = Date.parse('2026-07-15T03:00:00Z'); // 7:00 in Dubai
  assert.deepEqual(await R.openCases(), { skipped: 'before 8' });
  world.now = NOW;
  assert.equal((await R.openCases()).opened, 1);
  assert.deepEqual(await R.openCases(), { skipped: 'already done today' });
});

// ---------- the DLD check ----------

test('a screenshot Reem cannot read is refused, and the case keeps waiting for one', async () => {
  const boss = await setup();
  stub({ dld: { pct: null, average: null, confident: false, note: 'Not a DLD result' } });
  await R.openCases({ force: true });
  await assert.rejects(R.readDldShot(boss, 1, shot), /could not read the allowed increase.*Not a DLD result/);
  assert.equal((await R.getCase(1)).status, 'dld_needed');
  await assert.rejects(R.readDldShot(boss, 1, { ...shot, mimetype: 'application/zip' }), /as a picture/);
});

test('nothing is emailed while renewals is switched off', async () => {
  const boss = await setup();
  stub();
  await R.openCases({ force: true });
  await R.readDldShot(boss, 1, shot);
  await db.prepare('UPDATE renewal_settings SET enabled = false').run();
  await assert.rejects(R.sendNotice(boss, 1), /switched off/);
  assert.equal(world.sent.length, 0);
});

// ---------- one renewal, start to finish ----------

test('a renewal by email: notice, a counter-offer, agreement, papers fixed, saifsys told once', async () => {
  const boss = await setup();
  const cheques = quoteOf(37000).cheques;
  const photo = (name) => ({ contentType: 'image/jpeg', filename: name, content: Buffer.from(name) });
  stub({
    replies: [
      { intent: 'counter', amount: 36000, summary: 'Can you do 36,000?' },
      { intent: 'accept', summary: 'OK, agreed' },
    ],
    docs: [
      { agreement: 'signed', cheques: cheques.map((ch) => ({ ...ch, payee: 'Mohamed Saeed', signed: true })), unreadable: [] },
      { agreement: 'none', cheques: cheques.map((ch) => ({ ...ch, payee: 'Saif Holding LLC', signed: true })), unreadable: [] },
    ],
    files: { '1:103': { attachments: [photo('agreement.jpg'), photo('cheques.jpg')] }, '1:104': { attachments: [photo('cheques2.jpg')] } },
  });
  await R.openCases({ force: true });

  // The DLD check, and the notice.
  let c = await R.readDldShot(boss, 1, shot);
  assert.deepEqual([c.status, c.offer, c.floor], ['dld_read', 37800, 37000]);
  c = await R.sendNotice(boss, 1);
  assert.equal(c.status, 'notice_sent');
  assert.equal(world.sent.length, 1);
  assert.match(lastMail(), /Subject: Lease renewal: PARK PLACE, Unit 610/);
  assert.match(lastMail(), /Annual rent: AED 37,800/);
  assert.match(lastMail(), /application\/pdf/, 'the offer letter is attached');
  await assert.rejects(R.sendNotice(boss, 1), /already sent/, 'a second tap sends nothing');
  const noticeId = (await db.prepare(`SELECT message_id FROM renewal_messages WHERE kind = 'notice'`).get()).message_id;

  // An email that has nothing to do with it is Tenant care's.
  assert.equal(await R.claim({ uid: 1, from: 'someone@else.com', subject: 'Leak', text: 'water', at: 1 }, 1), false);

  // The tenant asks for 36,000: below the floor, so Reem meets them halfway.
  assert.equal(await arrives({ inReplyTo: noticeId, text: 'Can you do 36,000?' }), true);
  await R.readInbound();
  c = await R.getCase(1);
  assert.deepEqual([c.status, c.offer, c.rounds, c.tenant_offer], ['negotiating', 37000, 1, 36000]);
  assert.match(lastMail(), /can offer the renewal at AED 37,000 a year/);
  assert.match(lastMail(), /In-Reply-To: /, 'on the same thread');

  // They accept, writing a fresh email: still theirs, by their address.
  await arrives({ subject: 'renewal', text: 'OK agreed' });
  await R.readInbound();
  c = await R.getCase(1);
  assert.deepEqual([c.status, c.agreed], ['agreed', 37000]);
  assert.match(lastMail(), /confirm the renewal of PARK PLACE, Unit 610 at AED 37,000/);
  assert.match(lastMail(), /payable to Saif Holding LLC/);

  // Papers with the wrong payee: Reem says exactly what to fix.
  await arrives({ text: 'attached' });
  await R.readInbound();
  c = await R.getCase(1);
  assert.equal(c.status, 'agreed');
  assert.match(lastMail(), /payable to "Mohamed Saeed"\. It must be payable to Saif Holding LLC/);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM renewal_files WHERE message_id IS NOT NULL').get()).n, 2, 'the attachments are kept');

  // The right cheques: complete, and saifsys is told, once.
  await arrives({ text: 'new cheques' });
  await R.readInbound();
  assert.equal((await R.getCase(1)).status, 'converting');
  await R.convert();
  await R.convert();
  const renews = world.acts.filter((a) => a.action === 'renew');
  assert.equal(renews.length, 1, 'renewed once, however often the clock ticks');
  assert.deepEqual([renews[0].lease_id, renews[0].end_date, renews[0].rent, renews[0].expected_total, renews[0].email],
    [294, '2026-10-31', 37000, 37000, 'boss@company.com']);
  assert.match(renews[0].summary, /first offer AED 37,800, 1 counter-offer/);
  c = await R.getCase(1);
  assert.equal(c.status, 'renewed');
  assert.match(lastMail(), /Your renewal of PARK PLACE, Unit 610 is complete/);
  assert.deepEqual(world.todos.map((t) => [t.userId, t.text]), [[boss.id, 'Collect the original cheques and register the Ejari for PARK PLACE 610']]);
});

test('a reply Reem cannot settle goes to the boss, who answers with one tap', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'counter', amount: 30000, summary: '30k' }, { intent: 'counter', amount: 30000, summary: '30k' }, { intent: 'counter', amount: 30000, summary: '30k' }] });
  await R.openCases({ force: true });
  await R.readDldShot(boss, 1, shot);
  await R.sendNotice(boss, 1);
  for (let i = 0; i < 3; i++) { await arrives({ text: '30000' }); await R.readInbound(); }
  let c = await R.getCase(1);
  assert.equal(c.status, 'boss');
  assert.match(c.needs, /offers AED 30,000\. Reem's offer of AED 37,000 is already your lowest/, 'one counter-offer took Reem down to the floor');
  await assert.rejects(R.decide(boss, 1, { action: 'offer', rent: 0 }), /Type the annual rent/);
  c = await R.decide(boss, 1, { action: 'accept' });
  assert.deepEqual([c.status, c.agreed], ['agreed', 30000], 'the boss may go below the floor');
  assert.match(lastMail(), /AED 30,000 a year/);
});

test('silence: two reminders a week apart, then the boss when the end is 60 days off', async () => {
  const boss = await setup();
  stub();
  await R.openCases({ force: true });
  await R.readDldShot(boss, 1, shot);
  await R.sendNotice(boss, 1);
  const day = 86400000;
  world.now = NOW + 6 * day; await R.chase();
  assert.equal(world.sent.length, 1, 'six days is not yet a week');
  world.now = NOW + 7 * day; await R.chase();
  assert.match(lastMail(), /A reminder about the renewal/);
  world.now = NOW + 14 * day; await R.chase();
  assert.equal(world.sent.length, 3);
  world.now = NOW + 30 * day; await R.chase();
  assert.equal(world.sent.length, 3, 'no third reminder');
  assert.equal((await R.getCase(1)).status, 'notice_sent', 'still 78 days to go');
  world.now = NOW + 50 * day; await R.chase();
  assert.equal((await R.getCase(1)).status, 'no_reply');
  assert.match(world.pushes.at(-1), /no answer to the renewal offer/);
});

test('a reply on a renewal\'s thread is not answered by Tenant care\'s building-and-unit ask', async () => {
  const boss = await setup();
  stub();
  await R.openCases({ force: true });
  await R.readDldShot(boss, 1, shot);
  await R.sendNotice(boss, 1);
  const noticeId = (await db.prepare(`SELECT message_id FROM renewal_messages WHERE kind = 'notice'`).get()).message_id;
  const sent = [];
  const mail = [{ uid: 11, from: 'stranger@mail.com', subject: 'hello', text: 'my sink is broken', inReplyTo: noticeId, at: 1, headers: new Map() }];
  await look({ read: async () => ({ mail, lastUid: 11, uidValidity: 1 }), dir: { buildings: [], tenants: new Set(), leases: [] }, send: async (a, p, m) => sent.push(m), file: async () => {} });
  assert.equal(sent.length, 0, 'Tenant care left it alone');
  assert.equal((await db.prepare(`SELECT count(*)::int AS n FROM renewal_messages WHERE direction = 'in'`).get()).n, 1, 'it waits for Reem to read it');
});

test('a fresh email from the tenant about something else is let go, not taken for an answer', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'unclear', summary: 'The AC is not cooling' }] });
  await R.openCases({ force: true });
  await R.readDldShot(boss, 1, shot);
  await R.sendNotice(boss, 1);
  await arrives({ subject: 'AC problem', text: 'The AC is not cooling' });
  await R.readInbound();
  const c = await R.getCase(1);
  assert.equal(c.status, 'notice_sent', 'not sent to the boss as a renewal question');
  assert.equal(world.sent.length, 1, 'and nothing written back');
  assert.match((await db.prepare(`SELECT reading FROM renewal_messages WHERE direction = 'in'`).get()).reading.note, /Not about the renewal/);
});

test('the Lease renewals routes are only for those with the module', async () => {
  await setup();
  const staff = { id: await makeUser('Staff'), role: 'user' };
  const knock = (user) => new Promise((done) => {
    needsModule('renewals')({ user }, { status: (code) => ({ json: () => done(code) }) }, () => done('in'));
  });
  assert.equal(await knock(staff), 403);
  await setModuleAccess(staff.id, ['renewals']);
  assert.equal(await knock(staff), 'in');
});
