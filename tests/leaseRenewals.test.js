import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

process.env.EMAIL_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SAIFSYS_API_KEY = 'test-read'; // never used: every call to saifsys is stubbed below
process.env.SAIFSYS_ACTION_KEY = 'test-act';
const { encrypt } = await import('../server/secrets.js');
const { needsModule, setModuleAccess } = await import('../server/modules.js');
const { look } = await import('../server/tenantCare.js');
const R = await import('../server/leaseRenewals.js');

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
function stub({ leases = [LEASE], replies = [], docs = [], files = {} } = {}) {
  world = { sent: [], acts: [], mirrored: [], todos: [], pushes: [], replies: [...replies], docs: [...docs] };
  R.useForTests({
    now: () => world.now ?? NOW,
    ask: async (module, action) => { assert.equal(`${module}/${action}`, 'realestate/renewals_due'); return { ok: true, leases }; },
    act: async (module, action, body) => {
      assert.equal(module, 'realestate_renewal');
      world.acts.push({ action, ...body });
      if (action === 'quote') {
        const admin = body.admin_fees ?? 1500;
        return { quote: { ...quoteOf(body.rent), grand_total: body.rent + admin * 1.05 + 300, fees: { admin, chiller: 0, chiller_shown: false } } };
      }
      if (action === 'contract') return { contract: { name: 'contract_525.pdf', data: Buffer.from('%PDF-saifsys-contract').toString('base64') } };
      if (action === 'start') return { renewal: { workflow_id: 117, status: 'notice_sent', notice: { name: 'renewal_notice_117.pdf', data: Buffer.from('%PDF-saifsys-notice!!').toString('base64') } } };
      if (action === 'convert') return { renewal: { workflow_id: 117, new_lease_id: 525, activate_now: false } };
      return { renewal: { workflow_id: body.workflow_id } };
    },
    readReply: async () => world.replies.shift() ?? { intent: 'unclear', summary: '?', dispute: false },
    readDocs: async () => world.docs.shift(),
    indexRent: async () => null,
    mirror: async (action, body) => { world.mirrored.push({ action, ...body }); },
    fetch: async (ref) => files[ref] ?? null,
    send: async (acc, pw, m) => { world.sent.push(m); },
    file: async () => {},
    push: async (ids, msg) => { world.pushes.push(msg.body); },
    todo: async (userId, t) => { world.todos.push({ userId, ...t }); },
  });
}

async function setup() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  await db.prepare(`INSERT INTO tenant_inbox (id, email, host, port, username, password_enc, smtp_host, smtp_port, smtp_secure, last_uid, uid_validity)
    VALUES (1, 'care@company.com', 'imap.titan.email', 993, 'care@company.com', ?, 'smtp.titan.email', 465, true, 10, 1)`).run(encrypt('pw'));
  await db.prepare(`INSERT INTO lease_renewal_settings (id, payee, actor_id) VALUES (1, 'Saif Holding LLC', ?)`).run(boss.id);
  return boss;
}

/** The last email sent, its quoted-printable text decoded so the words read whole. */
const lastMail = () => world.sent.at(-1).raw.toString()
  .replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
let uid = 100;
/** A tenant's email arriving in the Tenant care inbox, as Tenant care hands it on. */
const arrives = async (fields) => R.claim({ uid: ++uid, from: LEASE.email, subject: 'Re: Lease renewal', text: 'see', at: Math.floor((world.now ?? NOW) / 1000), ...fields }, 1);
const timeline = async (id) => (await db.prepare('SELECT kind, title FROM lease_renewal_events WHERE renewal_id = ? ORDER BY id').all(id)).map((e) => `${e.kind}: ${e.title}`);
const start = (boss, rent = 39600) => R.send(boss, { action: 'start', lease_id: LEASE.lease_id, rent });

// ---------- the rules ----------

test('the RERA index rent is the current rent up by the allowed increase, rounded down to the hundred', () => {
  assert.equal(R.indexRentFrom(36000, 5), 37800);
  assert.equal(R.indexRentFrom(36550, 5), 38300, '38,377.50 rounds down, so it never passes the index');
  assert.equal(R.indexRentFrom(36000, 0), 36000);
});

test('the papers: the signed agreement, and each cheque of the schedule to the landlord', () => {
  const r = { lease: LEASE, quote: quoteOf(37800) };
  const cheques = quoteOf(37800).cheques.map((ch) => ({ ...ch, payee: 'Saif Holding L.L.C', signed: true }));
  assert.equal(R.checkPapers(r, { agreement: 'signed', cheques }, 'Saif Holding LLC').complete, true);
  const wrong = R.checkPapers(r, { agreement: 'unsigned', cheques: [{ ...cheques[0], payee: 'Mohamed' }, ...cheques.slice(1, 3)] }, 'Saif Holding LLC');
  assert.match(wrong.missing.join('|'), /signature.*\|a cheque of AED 9,450 dated 31 October 2027/);
  assert.match(wrong.wrong[0], /payable to "Mohamed"/);
});

// ---------- starting ----------

test('the offer is a draft first, at any rent we choose; nothing goes out until Send', async () => {
  const boss = await setup();
  stub();
  const d = await R.draft(boss, { action: 'start', lease_id: LEASE.lease_id, rent: 45000 });
  assert.equal(d.to, 'tenant@mail.com');
  assert.match(d.text, /Annual rent: AED 45,000/);
  assert.deepEqual(d.attachments, ['Renewal notice - PARK PLACE 610.pdf']);
  assert.equal(world.sent.length, 0);
  assert.deepEqual(world.acts.map((a) => a.action), ['quote'], 'saifsys only priced it');
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM lease_renewals').get()).n, 0);
});

test('Send: saifsys makes its renewal, the offer goes with saifsys\'s own notice, and the timeline starts', async () => {
  const boss = await setup();
  stub();
  const r = await R.send(boss, { action: 'start', lease_id: LEASE.lease_id, rent: 45000, text: 'Dear Mohamed,\n\nOur offer, as we discussed.' });
  assert.deepEqual([r.status, r.offer, r.workflow_id, r.rent_source.kind], ['offer_sent', 45000, 117, 'manual']);
  assert.deepEqual(world.acts.map((a) => a.action), ['quote', 'start']);
  assert.equal(world.acts[1].email, 'care@company.com');
  assert.match(lastMail(), /Subject: Lease renewal: PARK PLACE, Unit 610/);
  assert.match(lastMail(), /Our offer, as we discussed/, 'the words the person approved, not the draft');
  assert.match(lastMail(), /Renewal notice - PARK PLACE 610\.pdf/);
  assert.ok(lastMail().includes(Buffer.from('%PDF-saifsys-notice!!').toString('base64')), 'the PDF saifsys made, not one of ours');
  assert.deepEqual(await timeline(r.id), ['out: Offer sent · AED 45,000']);
  await assert.rejects(start(boss), /already started/, 'a second tap starts nothing');
});

test('Start: the admin fee the person types goes to saifsys and into the offer; later steps keep it', async () => {
  const boss = await setup();
  stub();
  assert.deepEqual(await R.startFees(LEASE.lease_id), { admin: 1500, chiller: 0, chiller_shown: false, vat_rate: 5 }, 'the old lease\'s, for the Start box');
  const r = await R.send(boss, { action: 'start', lease_id: LEASE.lease_id, rent: 45000, admin_fees: 2000 });
  assert.equal(world.acts.find((a) => a.action === 'start').admin_fees, 2000);
  assert.match(lastMail(), /Admin fee: AED 2,000\n- VAT \(5%\) on these charges: AED 100\n- Total \(rent, charges and VAT\): AED 47,100\n/);
  await R.draft(boss, { id: r.id, action: 'counter', rent: 44000 });
  assert.equal(world.acts.at(-1).admin_fees, 2000, 'a counter-offer is priced with the same fee');
});

test('a lease the staff started in saifsys, or with no email, cannot be started here', async () => {
  const boss = await setup();
  stub({ leases: [{ ...LEASE, saifsys_renewal: 'initiated' }, { ...LEASE, lease_id: 300, email: '' }] });
  await assert.rejects(start(boss), /staff already have a renewal/);
  await assert.rejects(R.draft(boss, { action: 'start', lease_id: 300, rent: 40000 }), /no email/);
});

// ---------- the conversation ----------

test('negotiation: a counter, a dispute, the RERA index rent, agreement, papers, convert', async () => {
  const boss = await setup();
  const cheques = quoteOf(37800).cheques;
  const photo = (name) => ({ contentType: 'image/jpeg', filename: name, content: Buffer.from(name) });
  stub({
    replies: [
      { intent: 'counter', amount: 36000, summary: 'Asks for 36,000', dispute: false },
      { intent: 'unclear', summary: 'Says the increase is illegal and will go to RDC', dispute: true, disputeNote: 'Claims the increase breaks the Rental Index', suggestedReply: 'We will review it.' },
      { intent: 'accept', summary: 'Accepts', dispute: false },
    ],
    docs: [
      { agreement: 'signed', cheques: cheques.map((ch) => ({ ...ch, payee: 'Mohamed Saeed', signed: true })), unreadable: [] },
      { agreement: 'none', cheques: cheques.map((ch) => ({ ...ch, payee: 'Saif Holding LLC', signed: true })), unreadable: [] },
    ],
    files: { '1:104': { attachments: [photo('agreement.jpg'), photo('cheques.jpg')] }, '1:105': { attachments: [photo('cheques2.jpg')] } },
  });
  let r = await start(boss, 42000);
  const noticeId = (await db.prepare(`SELECT message_id FROM lease_renewal_events WHERE kind = 'out'`).get()).message_id;

  // An email that has nothing to do with it is Tenant care's.
  assert.equal(await R.claim({ uid: 1, from: 'someone@else.com', subject: 'Leak', text: 'water', at: 1 }, 1), false);

  // The tenant asks for 36,000: the renewal waits for a person.
  assert.equal(await arrives({ inReplyTo: noticeId, text: 'Can you do 36,000?' }), true);
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.status, r.waiting, r.tenant_offer], ['offer_sent', 'reply', 36000]);
  assert.match(world.pushes.at(-1), /Tenant asks for AED 36,000/);

  // The person counters at 40,000.
  r = await R.send(boss, { id: r.id, action: 'counter', rent: 40000 });
  assert.deepEqual([r.status, r.offer, r.waiting], ['negotiating', 40000, null]);
  assert.deepEqual(world.acts.slice(-3).map((a) => [a.action, a.status ?? a.rent]), [['quote', 40000], ['rent', 40000], ['status', 'negotiation']]);
  assert.match(lastMail(), /can offer the renewal at AED 40,000 a year/);
  assert.match(lastMail(), /In-Reply-To: /, 'on the same thread');

  // The tenant disputes it: flagged, with Reem's suggested reply ready as the draft.
  await arrives({ text: 'This is illegal, I will go to RDC' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.equal(r.dispute, 'Claims the increase breaks the Rental Index');
  assert.match(world.pushes.at(-1), /Dispute/);
  assert.match((await R.draft(boss, { id: r.id, action: 'reply' })).text, /We will review it\./);

  // So we fall back to the RERA index: 5% on 36,000.
  const d = await R.draft(boss, { id: r.id, action: 'index', pct: 5 });
  assert.equal(d.rent, 37800);
  assert.match(d.text, /RERA Rental Index/);
  r = await R.send(boss, { id: r.id, action: 'index', pct: 5 });
  assert.deepEqual([r.offer, r.rent_source], [37800, { kind: 'rera_index', pct: 5 }]);
  assert.match(world.acts.find((a) => a.action === 'rent' && a.rent === 37800).note, /RERA index rent \(\+5%\)/);

  // They accept; the person confirms, and the agreement goes.
  await arrives({ text: 'OK agreed' });
  await R.readInbound();
  r = await R.send(boss, { id: r.id, action: 'accept' });
  assert.deepEqual([r.status, r.agreed], ['agreed', 37800]);
  assert.equal(world.acts.at(-1).status, 'accepted');
  assert.deepEqual(world.acts.slice(-2).map((a) => a.action), ['contract', 'status'], 'the contract is made before the renewal moves on');
  assert.match(lastMail(), /Tenancy contract - PARK PLACE 610\.pdf/);
  assert.ok(lastMail().includes(Buffer.from('%PDF-saifsys-contract').toString('base64')), 'saifsys\'s contract, not one of ours');
  assert.match(lastMail(), /confirm the renewal of PARK PLACE, Unit 610 at AED 37,800/);
  assert.match(lastMail(), /payable to Saif Holding LLC/);

  // Papers with the wrong payee: Reem lists exactly what to fix, and the person sends it.
  await arrives({ text: 'attached' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.equal(r.waiting, 'papers');
  assert.equal(r.papers.complete, false);
  assert.match((await R.draft(boss, { id: r.id, action: 'fix' })).text, /payable to "Mohamed Saeed"\. It must be payable to Saif Holding LLC/);
  await R.send(boss, { id: r.id, action: 'fix' });

  // The right cheques: complete. The person marks them OK and converts.
  await arrives({ text: 'new cheques' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.equal(r.papers.complete, true);
  await R.mark(boss, r.id, 'papers_ok');
  r = await R.send(boss, { id: r.id, action: 'convert' });
  assert.equal(r.status, 'converted');
  assert.deepEqual(world.acts.at(-1), { action: 'convert', email: 'care@company.com', workflow_id: 117, expected_total: 37800 });
  assert.match(lastMail(), /Your renewal of PARK PLACE, Unit 610 is complete/);
  assert.deepEqual(world.todos.map((t) => [t.userId, t.text]), [[boss.id, 'Collect the original cheques and register the Ejari for PARK PLACE 610']]);
  assert.deepEqual(await timeline(r.id), [
    'out: Offer sent · AED 42,000',
    'in: Tenant asks for AED 36,000',
    'out: Counter-offer · AED 40,000',
    'in: Says the increase is illegal and will go to RDC',
    'out: RERA index rent offered · AED 37,800',
    'in: Accepts',
    'out: Agreed · AED 37,800',
    'in: Tenant sent 2 files',
    'papers: Papers: 4 things to fix',
    'out: Asked to fix the papers',
    'in: Tenant sent 1 file',
    'papers: Papers complete: everything matches',
    'step: Papers checked and OK',
    'out: Renewed in saifsys · AED 37,800',
  ]);
});

test('the story is copied to saifsys: each email, each reply, each step, and the papers', async () => {
  const boss = await setup();
  const photo = { contentType: 'image/jpeg', filename: 'cheque.jpg', content: Buffer.from('cheque') };
  stub({ replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }], docs: [{ agreement: 'signed', cheques: [], unreadable: [] }] });
  let r = await start(boss, 37800);
  await arrives({ text: 'I accept' });
  await R.readInbound();
  r = await R.send(boss, { id: r.id, action: 'accept' });
  R.useForTests({ fetch: async () => ({ attachments: [photo] }) }); // the next email carries a cheque photo
  await arrives({ text: 'attached' });
  await R.readInbound();
  await R.mark(boss, r.id, 'close');
  const m = world.mirrored;
  assert.ok(m.every((x) => x.workflow_id === 117));
  assert.deepEqual(m.filter((x) => x.action === 'note').map((x) => x.message), [
    'Email to the tenant: Offer sent · AED 37,800',
    'The tenant replied: Accepts',
    'Email to the tenant: Agreed · AED 37,800',
    'The tenant emailed 1 file. To fix: a cheque of AED 9,450 dated 1 November 2026; a cheque of AED 9,450 dated 31 January 2027; a cheque of AED 9,450 dated 2 May 2027; a cheque of AED 9,450 dated 31 October 2027',
    'Closed: handled outside Reem',
  ]);
  assert.match(m[0].text, /Annual rent: AED 37,800/, 'the email itself goes to the notes');
  assert.deepEqual(m.filter((x) => x.action === 'file').map((x) => [x.name, x.mime]), [['cheque.jpg', 'image/jpeg']]);
});

test('a copy to saifsys that fails never stops the renewal', async () => {
  const boss = await setup();
  stub();
  R.useForTests({ mirror: async () => { throw new Error('saifsys is down'); } });
  const r = await start(boss);
  assert.equal(r.status, 'offer_sent');
  assert.equal(world.sent.length, 1);
});

test('not renewing: saifsys rejects its renewal and the tenant is thanked', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'reject', summary: 'Moving out', dispute: false }] });
  let r = await start(boss);
  await arrives({ text: 'We are leaving' });
  await R.readInbound();
  r = await R.send(boss, { id: r.id, action: 'not_renewing' });
  assert.equal(r.status, 'not_renewing');
  assert.deepEqual(world.acts.at(-1).status, 'rejected');
  assert.match(lastMail(), /will not renew/);
  await assert.rejects(R.send(boss, { id: r.id, action: 'counter', rent: 30000 }), /not renewing: that step is not open/);
});

// ---------- silence ----------

test('silence: Reem reminds by itself a week apart, twice, then says No answer', async () => {
  const boss = await setup();
  stub();
  const r = await start(boss);
  const day = 86400000;
  world.now = NOW + 6 * day; await R.chase();
  assert.equal(world.sent.length, 1, 'six days is not yet a week');
  world.now = NOW + 7 * day; await R.chase();
  assert.match(lastMail(), /A reminder about the renewal/);
  world.now = NOW + 14 * day; await R.chase();
  assert.equal(world.sent.length, 3);
  world.now = NOW + 21 * day; await R.chase();
  assert.equal(world.sent.length, 3, 'no third reminder');
  assert.equal((await R.getRenewal(r.id)).waiting, 'no_answer');
  assert.match(world.pushes.at(-1), /No answer from the tenant/);
  assert.deepEqual((await timeline(r.id)).slice(1), ['out: Reminder 1 sent by Reem', 'out: Reminder 2 sent by Reem', 'step: No answer after 2 reminders']);
});

test('reminders can be switched off', async () => {
  const boss = await setup();
  stub();
  await start(boss);
  await db.prepare('UPDATE lease_renewal_settings SET reminders = false').run();
  world.now = NOW + 8 * 86400000; await R.chase();
  assert.equal(world.sent.length, 1);
});

// ---------- the inbox ----------

test('a reply on a renewal\'s thread is not answered by Tenant care\'s building-and-unit ask', async () => {
  const boss = await setup();
  stub();
  await start(boss);
  const noticeId = (await db.prepare(`SELECT message_id FROM lease_renewal_events WHERE kind = 'out'`).get()).message_id;
  const sent = [];
  const mail = [{ uid: 11, from: 'stranger@mail.com', subject: 'hello', text: 'my sink is broken', inReplyTo: noticeId, at: 1, headers: new Map() }];
  await look({ read: async () => ({ mail, lastUid: 11, uidValidity: 1 }), dir: { buildings: [], tenants: new Set(), leases: [] }, send: async (a, p, m) => sent.push(m), file: async () => {} });
  assert.equal(sent.length, 0, 'Tenant care left it alone');
  assert.equal((await db.prepare(`SELECT count(*)::int AS n FROM lease_renewal_events WHERE kind = 'in'`).get()).n, 1);
});

test('a fresh email from the tenant about something else is let go, and nobody is asked', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'unclear', summary: 'The AC is not cooling', dispute: false }] });
  const r = await start(boss);
  await arrives({ subject: 'AC problem', text: 'The AC is not cooling' });
  await R.readInbound();
  assert.equal((await R.getRenewal(r.id)).waiting, null);
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

// ---------- the advisors and the RDC case pack ----------

const agent = async (owner, name, color = 'slate') => (await db.prepare(`INSERT INTO agents (user_id, name, icon, color, persona) VALUES (?, ?, 'scale', ?, ?) RETURNING id`)
  .get(owner, name, color, `You are ${name}.`)).id;

test('advisors: on a dispute each picked agent gives its view by itself; a failing one is left out', async () => {
  const boss = await setup();
  const lawyer = await agent(boss.id, 'Lawyer');
  const rdc = await agent(boss.id, 'RDC', 'rose');
  const writer = await agent(boss.id, 'Writer');
  await db.prepare(`UPDATE lease_renewal_settings SET advisors = ?`).run(JSON.stringify([lawyer, rdc]));
  stub({ replies: [{ intent: 'unclear', summary: 'Says it is illegal', dispute: true, disputeNote: 'Claims the increase breaks the index' }] });
  const asked = [];
  R.useForTests({
    advise: async ({ agent: a, facts, thread, dispute }) => {
      asked.push({ name: a.name, persona: a.persona, facts, thread, dispute });
      if (a.name === 'Lawyer') throw new Error('overloaded');
      return { view: `${a.name}: send the 90-day notice proof.`, reply: 'We have noted your concern.' };
    },
  });
  const r = await start(boss, 42000);
  await arrives({ text: 'This is illegal, I will go to RDC' });
  await R.readInbound();

  assert.deepEqual(asked.map((a) => a.name), ['Lawyer', 'RDC'], 'only the picked agents, never the Writer');
  assert.equal(asked[1].persona, 'You are RDC.', 'each answers in its own persona');
  assert.equal(asked[1].dispute, 'Claims the increase breaks the index');
  assert.match(asked[1].facts, /AED 36,000 a year/);
  assert.match(asked[1].thread, /We wrote[\s\S]*Tenant wrote/, 'the emails, oldest first');
  const advice = await db.prepare(`SELECT title, body, data FROM lease_renewal_events WHERE renewal_id = ? AND kind = 'advice'`).all(r.id);
  assert.deepEqual(advice.map((a) => [a.title, a.data.agent.color, a.data.reply, a.data.asked]), [["RDC's view", 'rose', 'We have noted your concern.', false]]);
  assert.equal(world.sent.length, 1, 'advice never emails the tenant');
  assert.equal(writer > 0, true);

  // Asked again by a person: one more bubble each, and the reply opens as a draft to change.
  R.useForTests({ advise: async ({ agent: a }) => ({ view: `${a.name} again`, reply: `Reply from ${a.name}` }) });
  assert.equal(await R.askAdvisors(await R.getRenewal(r.id), { user: boss }), 2);
  assert.equal((await db.prepare(`SELECT count(*)::int AS n FROM lease_renewal_events WHERE kind = 'advice' AND (data->>'asked')::boolean`).get()).n, 2);
  const d = await R.draft(boss, { id: r.id, action: 'reply', words: 'Reply from RDC' });
  assert.match(d.text, /^Dear Mohamed Saeed,\n\nReply from RDC\n/);
});

test('advisors: none picked means none asked; every one failing says so', async () => {
  const boss = await setup();
  stub();
  const r = await start(boss, 42000);
  assert.equal(await R.askAdvisors(r), 0);
  const rdc = await agent(boss.id, 'RDC');
  await db.prepare(`UPDATE lease_renewal_settings SET advisors = ?`).run(JSON.stringify([rdc]));
  R.useForTests({ advise: async () => { throw new Error('down'); } });
  await assert.rejects(R.askAdvisors(r), /None of the advisors could answer/);
});

test('the RDC case pack: a PDF of the story and its papers, without the advisors\' views', async () => {
  const boss = await setup();
  const rdc = await agent(boss.id, 'RDC');
  await db.prepare(`UPDATE lease_renewal_settings SET advisors = ?`).run(JSON.stringify([rdc]));
  stub({ replies: [{ intent: 'unclear', summary: 'Says it is illegal', dispute: true, disputeNote: 'Claims the increase breaks the index' }] });
  let story = null;
  R.useForTests({
    advise: async () => ({ view: 'SECRET ADVICE', reply: null }),
    caseSummary: async (x) => { story = x.story; return 'On 15 July 2026 we offered a renewal.'; },
  });
  const r = await start(boss, 42000);
  await arrives({ text: 'This is illegal' });
  await R.readInbound();
  const bytes = await R.casePack(await R.getRenewal(r.id));
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /^%PDF-/);
  assert.match(story, /Email to the tenant: Offer sent · AED 42,000/);
  assert.match(story, /Email from the tenant: Says it is illegal/);
  assert.doesNotMatch(story, /view/, 'the advisors\' views stay ours');

  // A summary that cannot be written still leaves the timeline and the list of papers.
  R.useForTests({ caseSummary: async () => { throw new Error('down'); } });
  assert.match(Buffer.from(await R.casePack(await R.getRenewal(r.id))).toString('latin1'), /^%PDF-/);
});

test('saifsys records every step as its Tenant care user, never as the person who tapped', async () => {
  const boss = await setup();
  stub();
  await start(boss, 42000);
  assert.ok(world.acts.length >= 2);
  assert.deepEqual([...new Set(world.acts.map((a) => a.email))], ['care@company.com']);

  const again = await setup();
  stub();
  await db.prepare('DELETE FROM tenant_inbox').run();
  await assert.rejects(R.draft(again, { action: 'start', lease_id: LEASE.lease_id, rent: 40000 }), /Tenant care inbox is not connected/);
});

test('a cheque re-sent for the same date replaces the wrong one, so the papers can complete', () => {
  const r = { lease: { payment_method: 'cheque' }, quote: quoteOf(42000) };
  const sched = quoteOf(42000).cheques;
  const ok = (ch) => ({ amount: ch.amount, date: ch.date, payee: 'Saif Holding LLC', signed: true });
  let got = R.addPapers({}, { agreement: 'signed', cheques: [ok(sched[0]), ok(sched[1]), ok(sched[2]), { ...ok(sched[3]), amount: 10000 }] });
  let check = R.checkPapers(r, got, 'Saif Holding LLC');
  assert.equal(check.complete, false);
  assert.equal(check.wrong.length, 1);
  got = R.addPapers(got, { agreement: 'none', cheques: [ok(sched[3])] });
  check = R.checkPapers(r, got, 'Saif Holding LLC');
  assert.deepEqual(check, { missing: [], wrong: [], complete: true });
  assert.equal(got.cheques.length, 4);
});

test('words typed inside the quoted email are still the tenant\'s', () => {
  assert.equal(R.tenantWords('I can pay 51,000\n\nOn Thu, 15 Oct 2026 at 15:40, Tenant Care <care@company.com> wrote:\n> Dear Test,\n> Our offer'), 'I can pay 51,000');
  assert.equal(R.tenantWords('On Thu, 15 Oct 2026 at 15:53, Tenant Care <care@company.com> wrote:\n> OK, I accept 53,000\n>\n> Dear Test Two Counter,\n> Thank you for your reply.'), 'OK, I accept 53,000');
  assert.equal(R.tenantWords('> OK, I accept\n> Dear Test,\n> offer'), 'OK, I accept');
});

test('rewrite with Reem: only the words between greeting and sign-off are rewritten, nothing is sent', async () => {
  const boss = await setup();
  stub();
  const r = await start(boss, 42000);
  const asked = [];
  R.useForTests({ rewriteReply: async (x) => { asked.push(x); return 'We would be pleased to clarify the admin fee.'; } });
  const out = await R.rewrite(r.id, 'Dear Mohamed Saeed,\n\nadmin fee is standard ok\n\nKind regards,\nTenant Care Team');
  assert.equal(asked[0].draft, 'admin fee is standard ok');
  assert.match(asked[0].facts, /AED 36,000 a year/);
  assert.equal(out.text, 'Dear Mohamed Saeed,\n\nWe would be pleased to clarify the admin fee.\n\nKind regards,\nTenant Care Team');
  assert.equal(world.sent.length, 1, 'only the offer was ever sent');
  await assert.rejects(R.rewrite(r.id, 'Dear Mohamed Saeed,\n\nKind regards,\nTenant Care Team'), /Write a few words first/);
});

test('charges: each extra listed, VAT taken from saifsys\'s own total, shown as 5% on the charges', () => {
  const q = { proposed_rent: 249375, rera: 300, grand_total: 249375 + 1500 + 2000 + 175 + 300, fees: { admin: 1500, chiller: 0, parking: 2000, small_store: 0, big_store: 0 } };
  const c = R.chargesOf(q);
  assert.deepEqual(c.items.map((x) => [x.label, x.amount]), [['Admin fee', 1500], ['Additional parking slot', 2000]]);
  assert.equal(c.vat, 175);
  assert.equal(c.onCharges, true);
  assert.equal(c.total, 249375 + 3500 + 175);
  assert.equal(R.chargesOf({ proposed_rent: 1000, rera: 0, grand_total: 1000, fees: {} }).vat, 0);
});

// ---------- automatic: the person gives the RERA index, Reem does the rest ----------

const autoStart = (boss, rent = 42000, rera = 5) => R.send(boss, { action: 'start', lease_id: LEASE.lease_id, rent, rera_pct: rera });

test('automatic: a dispute gets the RERA index rent, an acceptance the contract, papers are sent back then renewed', async () => {
  const boss = await setup();
  const cheques = quoteOf(37800).cheques;
  const photo = (name) => ({ contentType: 'image/jpeg', filename: name, content: Buffer.from(name) });
  stub({
    replies: [
      { intent: 'unclear', summary: 'Says the increase is illegal', dispute: true, disputeNote: 'Claims it breaks the index' },
      { intent: 'accept', summary: 'Accepts', dispute: false },
    ],
    docs: [
      { agreement: 'signed', cheques: cheques.map((ch) => ({ ...ch, payee: 'Mohamed Saeed', signed: true })), unreadable: [] },
      { agreement: 'none', cheques: cheques.map((ch) => ({ ...ch, payee: 'Saif Holding LLC', signed: true })), unreadable: [] },
    ],
  });
  let r = await autoStart(boss);
  assert.deepEqual([r.status, r.auto, r.rera_pct], ['offer_sent', true, 5]);

  await arrives({ text: 'This is illegal' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.status, r.offer, r.waiting, r.rent_source], ['negotiating', 37800, null, { kind: 'rera_index', pct: 5 }]);
  assert.match(lastMail(), /RERA Rental Index/);
  assert.match(world.pushes.at(-1), /Reem offered the RERA index rent, AED 37,800/);

  await arrives({ text: 'OK agreed' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.status, r.agreed], ['agreed', 37800]);
  assert.match(lastMail(), /Tenancy contract - PARK PLACE 610\.pdf/);

  R.useForTests({ fetch: async () => ({ attachments: [photo('a.jpg')] }) });
  await arrives({ text: 'attached' });
  await R.readInbound();
  assert.match(lastMail(), /It must be payable to Saif Holding LLC/, 'Reem sent back what is wrong');
  assert.equal((await R.getRenewal(r.id)).waiting, null);

  await arrives({ text: 'new cheques' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.equal(r.status, 'converted');
  assert.equal(world.acts.at(-1).action, 'convert');
  assert.match(lastMail(), /is complete/);
  assert.deepEqual(world.todos.map((t) => t.userId), [boss.id], 'the to-do goes to whoever started it');
  assert.deepEqual((await timeline(r.id)).filter((t) => t.startsWith('out')), [
    'out: Offer sent · AED 42,000', 'out: RERA index rent offered · AED 37,800', 'out: Agreed · AED 37,800',
    'out: Asked to fix the papers', 'out: Renewed in saifsys · AED 37,800',
  ]);
});

test('automatic: never a counter of its own; a second push-back, a question or not renewing waits for a person', async () => {
  const boss = await setup();
  stub({ replies: [
    { intent: 'counter', amount: 36000, summary: 'Asks for 36,000', asksLess: true, dispute: false },
    { intent: 'counter', amount: 36000, summary: 'Still asks for 36,000', asksLess: true, dispute: false },
  ] });
  let r = await autoStart(boss);
  await arrives({ text: '36,000?' });
  await R.readInbound();
  assert.equal((await R.getRenewal(r.id)).offer, 37800, 'the index rent, not the tenant\'s figure');
  await arrives({ text: 'still 36,000' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.offer, r.waiting], [37800, 'reply']);
  assert.match(world.pushes.at(-1), /needs you/);

  assert.equal(R.autoAnswer({ ...r, status: 'offer_sent', rent_source: { kind: 'manual' } }, { intent: 'reject' }), null);
  assert.equal(R.autoAnswer({ ...r, status: 'offer_sent', rent_source: { kind: 'manual' } }, { intent: 'question' }), null);
  assert.equal(R.autoAnswer({ ...r, status: 'offer_sent', offer: 37800, rent_source: { kind: 'manual' } }, { intent: 'counter', asksLess: true }), null,
    'an offer already at the index has nothing to fall back to');
  assert.equal(R.autoAnswer({ ...r, status: 'offer_sent', auto: false }, { intent: 'accept' }), null, 'switched off: a person answers');
});

test('a renewal started without the RERA index, or switched off, waits for a person as before', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }, { intent: 'accept', summary: 'Accepts', dispute: false }] });
  const r = await start(boss);
  assert.equal(r.auto, false);
  await arrives({ text: 'I accept' });
  await R.readInbound();
  assert.deepEqual([(await R.getRenewal(r.id)).status, world.sent.length], ['offer_sent', 1]);
});

test('scheduled: started more than 120 days ahead, the offer waits, then Reem sends it on the day', async () => {
  const boss = await setup();
  const later = { ...LEASE, end_date: '2026-12-31' }; // 169 days from NOW: the offer is due on 2 September
  stub({ leases: [later] });
  let r = await autoStart(boss);
  assert.equal(r.status, 'scheduled');
  assert.equal(world.sent.length, 0);
  assert.ok(!world.acts.some((a) => a.action === 'start'), 'saifsys has nothing yet');
  assert.deepEqual(await timeline(r.id), ['step: Offer ready: Reem sends it on 2 September 2026']);

  world.now = Date.parse('2026-09-01T06:00:00Z');
  await R.sendDue();
  assert.equal(world.sent.length, 0, 'not yet');
  world.now = Date.parse('2026-09-02T06:00:00Z');
  await R.sendDue();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.status, r.workflow_id, r.plan], ['offer_sent', 117, null]);
  assert.match(lastMail(), /Please reply to this email by 16 September 2026/, 'the reply-by date is from the day it went');
  assert.match(world.pushes.at(-1), /Reem sent the renewal offer/);
  await R.sendDue();
  assert.equal(world.sent.length, 1, 'once');
});

test('scheduled: a person can send it now or cancel it', async () => {
  const boss = await setup();
  stub({ leases: [{ ...LEASE, end_date: '2026-12-31' }] });
  let r = await autoStart(boss);
  assert.equal(await R.mark(boss, r.id, 'unschedule'), null);
  assert.ok(!(await R.getRenewal(r.id)), 'gone: the lease can start again');
  r = await autoStart(boss);
  r = await R.mark(boss, r.id, 'send_now');
  assert.equal(r.status, 'offer_sent');
});

test('the RERA check: leases 120 days from the end that nobody started are told once, in one push', async () => {
  const boss = await setup();
  stub({ leases: [LEASE, { ...LEASE, lease_id: 295, unit: '611' }, { ...LEASE, lease_id: 296, end_date: '2026-12-31' }] });
  R.resetNudge();
  assert.equal(await R.nudge(), 2, 'the one 169 days away is not due yet');
  assert.match(world.pushes.at(-1), /2 leases are due: check the RERA index/);
  R.resetNudge();
  assert.equal(await R.nudge(), 0, 'each lease once');
});

// ---------- staff can step in ----------

test('take over: staff run it by hand, and can hand it back', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }] });
  let r = await autoStart(boss);
  r = await R.mark(boss, r.id, 'auto_off');
  assert.equal(r.auto, false);
  await arrives({ text: 'I accept' });
  await R.readInbound();
  assert.deepEqual([(await R.getRenewal(r.id)).status, world.sent.length], ['offer_sent', 1], 'Reem sent nothing');
  r = await R.mark(boss, r.id, 'auto_on');
  assert.equal(r.auto, true);
  assert.deepEqual((await timeline(r.id)).filter((t) => t.startsWith('step')), ['step: Taken over: staff run it by hand', 'step: Handed back to Reem']);
});

test('when something breaks Reem stops on that lease and tells staff', async () => {
  const boss = await setup();
  stub({ replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }] });
  let r = await autoStart(boss);
  R.useForTests({ act: async (m, action) => { if (action === 'contract') throw new Error('saifsys is down'); return { renewal: {} }; } });
  await arrives({ text: 'I accept' });
  await R.readInbound();
  r = await R.getRenewal(r.id);
  assert.deepEqual([r.auto, r.waiting], [false, 'reply']);
  assert.match(world.pushes.at(-1), /Reem stopped on this lease: .*saifsys is down.*take it from here/);
  assert.match((await timeline(r.id)).at(-1), /step: Reem stopped/);
});

test('papers still wrong after three tries: Reem stops', async () => {
  const boss = await setup();
  const wrongDocs = { agreement: 'none', cheques: [], unreadable: [] };
  stub({ replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }], docs: [wrongDocs, wrongDocs, wrongDocs, wrongDocs] });
  let r = await autoStart(boss);
  await arrives({ text: 'I accept' });
  await R.readInbound();
  R.useForTests({ fetch: async () => ({ attachments: [{ contentType: 'image/jpeg', filename: 'x.jpg', content: Buffer.from('x') }] }) });
  for (let i = 0; i < 4; i++) { await arrives({ text: `try ${i}` }); await R.readInbound(); }
  r = await R.getRenewal(r.id);
  assert.equal((await timeline(r.id)).filter((t) => t === 'out: Asked to fix the papers').length, 3);
  assert.deepEqual([r.auto, r.waiting], [false, 'papers']);
  assert.match(world.pushes.at(-1), /still not right after 3 tries/);
});

test('pause all: Reem answers nothing and sends no scheduled offer until it is back on', async () => {
  const boss = await setup();
  stub({ leases: [LEASE, { ...LEASE, lease_id: 296, end_date: '2026-12-31' }], replies: [{ intent: 'accept', summary: 'Accepts', dispute: false }] });
  const r = await autoStart(boss);
  const later = await R.send(boss, { action: 'start', lease_id: 296, rent: 42000, rera_pct: 5 });
  await db.prepare('UPDATE lease_renewal_settings SET paused = true').run();
  await arrives({ text: 'I accept' });
  await R.readInbound();
  assert.deepEqual([(await R.getRenewal(r.id)).status, world.sent.length], ['offer_sent', 1]);
  world.now = Date.parse('2026-09-02T06:00:00Z');
  await R.sendDue();
  assert.equal((await R.getRenewal(later.id)).status, 'scheduled');
  await db.prepare('UPDATE lease_renewal_settings SET paused = false').run();
  await R.sendDue();
  assert.equal((await R.getRenewal(later.id)).status, 'offer_sent');
});
