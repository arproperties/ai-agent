import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, closeDb, db, makeUser } from './helpers/db.js';
import { create, addDocument } from '../server/properties.js';
import { listAlerts } from '../server/leasingAlerts.js';
import * as R from '../server/renewals.js';

test.after(() => closeDb());

const AT = '2026-10-10';
const pdf = { buffer: Buffer.from('%PDF-1.4 policy'), originalname: 'fire-policy.pdf', mimetype: 'application/pdf' };
const DETAILS = { insurer: 'Orient Insurance', premium: 'USD 18,400', sum_insured: 'USD 12,500,000', deductible: 'USD 5,000', cover: 'Building and common areas' };

// Tower's fire insurance, with Orient, expires on 2027-01-08: inside its window on 2026-10-10.
async function tower() {
  await reset();
  const master = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(master);
  const c = await create('company', { name: 'ACE' });
  const b = await create('building', { name: 'Tower', address: '1 Main St', city: 'Austin', emirate: 'TX' }, c.id);
  const policy = await addDocument({ building_id: b.id, title: 'Fire insurance', number: 'PAR/4471', expiry_date: '2027-01-08', renew_by: 'quotes', details: DETAILS }, pdf, master);
  return { master, c, b, policy };
}
const docAlerts = async (day) => (await listAlerts({}, day)).filter((a) => a.rule === 'document');
const row = (v) => v.suppliers.map((s) => [s.name, s.email, s.email_confirmed, s.is_current, s.state]);

test('a renewal is a case on one document: its current insurer listed, suppliers found and added, closed by the renewed copy or by not renewing', async () => {
  const { master, b, policy } = await tower();
  const r = await R.startRenewal(policy.id, master);
  assert.deepEqual([r.status, r.document.title, r.document.where, r.document.details.insurer], ['open', 'Fire insurance', 'Tower', 'Orient Insurance']);
  assert.deepEqual(row(r), [['Orient Insurance', null, false, true, 'listed']], 'the insurer on the policy, its address not yet known');
  assert.equal((await R.startRenewal(policy.id, master)).id, r.id, 'started twice, it is the same case');
  await assert.rejects(R.startRenewal(999, master), /Not found/);

  // Found on the web: shown, and nothing kept until a person adds it. One already listed, and junk, are left out.
  const search = async () => `Here they are:\n${JSON.stringify([{ name: 'Chubb', website: 'https://chubb.com', email: 'quotes@chubb.com', kind: 'insurer', why: 'Insures commercial buildings in Texas' },
    { name: 'orient insurance', email: 'x@orient.com' }, { nope: 1 }])}`;
  const found = await R.findSuppliers(r.id, { search });
  assert.deepEqual(found.found.map((s) => [s.name, s.email, s.why]), [['Chubb', 'quotes@chubb.com', 'Insures commercial buildings in Texas']]);
  assert.equal((await R.listSuppliers()).length, 1, 'nothing found is kept yet');
  assert.deepEqual(await R.findSuppliers(r.id, { search: async () => { throw new Error('offline'); } }), { known: [], found: [], failed: true });

  // Added by a person: an address they give is one they have confirmed.
  const orient = r.suppliers[0];
  await assert.rejects(R.addSuppliers(r.id, [{ name: 'X', email: 'nope' }]), /valid email/);
  let v = await R.addSuppliers(r.id, [{ name: 'Chubb', email: ' Quotes@Chubb.com ', website: 'https://chubb.com', found_by: 'search' },
    { supplier_id: orient.supplier_id, email: 'renewals@orient.com' }, { name: 'Marsh' }]);
  assert.deepEqual(row(v), [['Orient Insurance', 'renewals@orient.com', true, true, 'listed'], ['Chubb', 'quotes@chubb.com', true, false, 'listed'], ['Marsh', null, false, false, 'listed']]);
  v = await R.removeSupplier(r.id, v.suppliers[2].supplier_id);
  assert.equal(v.suppliers.length, 2);
  assert.equal((await R.listSuppliers()).length, 3, 'taken off this renewal, still on the list for the next');

  // The alert says a renewal is under way, and opens it.
  const [a] = await docAlerts(AT);
  assert.deepEqual([a.renewal_id, a.detail], [r.id, 'Tower · 01/08/2027 · renewing: 0 asked, 0 quotes in']);

  // Not renewing: the case closes and the document stops asking.
  await assert.rejects(R.closeRenewal(r.id, 'maybe'), /not renewing or cancelled/);
  assert.equal((await R.closeRenewal(r.id, 'not_renewing')).status, 'not_renewing');
  assert.deepEqual(await docAlerts(AT), []);

  // Started again, it asks again, and the suppliers kept from before are offered first.
  const again = await R.startRenewal(policy.id, master);
  assert.notEqual(again.id, r.id);
  assert.equal((await docAlerts(AT)).length, 1);
  assert.deepEqual((await R.findSuppliers(again.id, { search: async () => '[]' })).known.map((s) => s.name), ['Chubb', 'Marsh']);

  // The renewed copy is filed: the case is done.
  await addDocument({ building_id: b.id, title: 'fire insurance', expiry_date: '2028-01-08' });
  assert.equal((await R.getRenewal(again.id)).status, 'renewed');
  assert.equal((await R.listRenewals()).length, 0, 'none open');
});

// ---------- requests ----------

const mailbox = { account: async () => ({ email: 'boss@ace.com', can_write: true, smtp_host: 'smtp.ace.com' }) };
const wording = { think: async () => JSON.stringify({
  new: { subject: 'Quotation request: fire insurance, Tower', body: 'Dear {supplier} team,\nPlease quote.\nBoss' },
  renewal: { subject: 'Renewal terms: policy PAR/4471', body: 'Dear {supplier} team,\nPlease send your renewal terms.\nBoss' } }) };
const drafts = () => db.prepare('SELECT * FROM email_drafts ORDER BY id').all();

// A renewal with Orient (the current insurer) and Chubb ready to be written to, and Marsh with no address yet.
async function listed() {
  const t = await tower();
  let r = await R.startRenewal(t.policy.id, t.master);
  r = await R.addSuppliers(r.id, [{ supplier_id: r.suppliers[0].supplier_id, email: 'renewals@orient.com' }, { name: 'Chubb', email: 'quotes@chubb.com' }, { name: 'Marsh' }]);
  const of = (name) => r.suppliers.find((s) => s.name === name);
  return { ...t, r, orient: of('Orient Insurance'), chubb: of('Chubb'), marsh: of('Marsh') };
}
const named = (v, name) => v.suppliers.find((s) => s.name === name);

test('requests: one draft a supplier, each waiting for a person, and nothing is sent', async () => {
  const { existsSync } = await import('node:fs');
  const { master, r, orient, chubb, marsh } = await listed();
  const deps = { ...mailbox, ...wording };
  await assert.rejects(R.draftRequests(r.id, null, master, deps), /Marsh/, 'nothing is drafted to an address nobody has confirmed');
  assert.equal((await drafts()).length, 0);

  let v = await R.draftRequests(r.id, [orient.supplier_id, chubb.supplier_id], master, deps);
  assert.deepEqual(v.suppliers.map((s) => [s.name, s.state]), [['Orient Insurance', 'drafted'], ['Chubb', 'drafted'], ['Marsh', 'listed']]);
  assert.deepEqual([named(v, 'Orient Insurance').subject, named(v, 'Orient Insurance').body.split('\n')[0]], ['Renewal terms: policy PAR/4471', 'Dear Orient Insurance team,'], 'the current insurer is asked for renewal terms');
  assert.deepEqual([named(v, 'Chubb').subject, named(v, 'Chubb').body.split('\n')[0]], ['Quotation request: fire insurance, Tower', 'Dear Chubb team,']);
  let all = await drafts();
  assert.deepEqual(all.map((d) => [d.status, d.to_addrs, d.from_addr, d.user_id]), [['pending', '["renewals@orient.com"]', 'boss@ace.com', master], ['pending', '["quotes@chubb.com"]', 'boss@ace.com', master]]);
  for (const d of all) {
    const [file] = JSON.parse(d.attachments);
    assert.deepEqual([file.filename, existsSync(file.path)], ['fire-policy.pdf', true], 'the policy goes with each, as its own copy');
  }
  await R.draftRequests(r.id, [orient.supplier_id, chubb.supplier_id], master, deps);
  assert.equal((await drafts()).length, 2, 'asked for twice, still one draft each');

  // The person may reword a draft that is waiting; nobody else's hand is on it.
  const other = await makeUser('Other');
  await assert.rejects(R.editRequest(r.id, chubb.request_id, { subject: 'x', body: 'y' }, other), /who drafted it/);
  v = await R.editRequest(r.id, chubb.request_id, { subject: 'Quote please', body: 'Dear Chubb,\nShorter.' }, master);
  assert.deepEqual([named(v, 'Chubb').subject, named(v, 'Chubb').body], ['Quote please', 'Dear Chubb,\nShorter.']);
  await assert.rejects(R.editRequest(r.id, chubb.request_id, { subject: '', body: '' }, master), /needs a subject and some words/);

  // Rejected, the request is free to be written again.
  await db.prepare("UPDATE email_drafts SET status = 'rejected' WHERE id = ?").run(named(v, 'Chubb').draft_id);
  assert.equal(named(await R.getRenewal(r.id), 'Chubb').state, 'listed');
  v = await R.draftRequests(r.id, [chubb.supplier_id], master, deps);
  assert.equal(named(v, 'Chubb').state, 'drafted');

  // The model down: the request is still written, plainly, from what is on file - and never says what is paid today.
  await R.addSuppliers(r.id, [{ supplier_id: marsh.supplier_id, email: 'a@marsh.com' }]);
  v = await R.draftRequests(r.id, [marsh.supplier_id], master, { ...mailbox, think: async () => { throw new Error('down'); } });
  const plain = named(v, 'Marsh');
  for (const word of ['Dear Marsh', 'Fire insurance', 'Tower', '01/08/2027', 'USD 12,500,000', 'ACE']) assert.ok(`${plain.subject}\n${plain.body}`.includes(word), `the plain request says ${word}`);
  assert.ok(!plain.body.includes('18,400'), 'what is paid now is not told to another insurer');

  all = await drafts();
  assert.deepEqual([...new Set(all.map((d) => d.status))].sort(), ['pending', 'rejected'], 'every email written here waits for a person');
});

test('with no mailbox that can send, the request is written to be copied, and marked as sent by hand', async () => {
  const { master, r, chubb, marsh } = await listed();
  let v = await R.draftRequests(r.id, [chubb.supplier_id], master, { account: async () => null, ...wording });
  assert.deepEqual([named(v, 'Chubb').state, named(v, 'Chubb').body.split('\n')[0], (await drafts()).length], ['written', 'Dear Chubb team,', 0]);
  v = await R.editRequest(r.id, chubb.request_id, { subject: 'Quote please', body: 'Shorter.' }, master);
  assert.equal(named(v, 'Chubb').body, 'Shorter.');
  await assert.rejects(R.markSent(r.id, marsh.request_id), /nothing written/);
  v = await R.markSent(r.id, chubb.request_id);
  assert.equal(named(v, 'Chubb').state, 'sent');
  await assert.rejects(R.removeSupplier(r.id, chubb.supplier_id), /already been written to/);
});

test('a supplier that has not answered in five days gets a follow-up drafted, once, and it too waits', async () => {
  const { master, r, orient, chubb } = await listed();
  const deps = { ...mailbox, ...wording };
  let v = await R.draftRequests(r.id, [orient.supplier_id, chubb.supplier_id], master, deps);
  const now = Math.floor(Date.now() / 1000);
  const sent = (name, daysAgo, messageId) => db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, message_id = ? WHERE id = ?").run(now - daysAgo * 86400, messageId, named(v, name).draft_id);
  await sent('Orient Insurance', 6, '<m1@ace.com>');
  await sent('Chubb', 2, '<m2@ace.com>');

  v = await R.chase(r.id, master, deps, now);
  assert.deepEqual(v.suppliers.map((s) => [s.name, s.state, s.chaser_status]), [['Orient Insurance', 'sent', 'pending'], ['Chubb', 'sent', null], ['Marsh', 'listed', null]]);
  const chaser = (await drafts()).at(-1);
  assert.deepEqual([chaser.status, chaser.to_addrs, chaser.in_reply_to, chaser.subject], ['pending', '["renewals@orient.com"]', '<m1@ace.com>', 'Re: Renewal terms: policy PAR/4471']);
  await R.chase(r.id, master, deps, now);
  assert.equal((await drafts()).length, 3, 'chased once');
});

// ---------- replies and quotes ----------

const quotePdf = { name: 'chubb-quote.pdf', originalname: 'chubb-quote.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF quote') };
const OFFER = { kind: 'quote', note: 'Annual premium USD 16,900.', premium: 'USD 16,900', sum_insured: 'USD 12,500,000', deductible: 'USD 10,000', cover: 'Building and common areas', exclusions: 'Flood', valid_until: '2026-11-30', extra: 'x' };

// Orient and Chubb were both written to `days` ago, from the master's mailbox.
async function asked(days = 3) {
  const t = await listed();
  const v = await R.draftRequests(t.r.id, [t.orient.supplier_id, t.chubb.supplier_id], t.master, { ...mailbox, ...wording });
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE email_drafts SET status = 'sent', sent_at = ?, message_id = '<m' || id || '@ace.com>'").run(now - days * 86400);
  const at = (daysAgo) => new Date((now - daysAgo * 86400) * 1000);
  return { ...t, v, now, at };
}

test('replies are found by who they are from, read once, and an offer is kept with its file', async () => {
  const { r, at } = await asked();
  const mail = [
    { id: 'INBOX:1', from: 'Chubb Quotes <quotes@chubb.com>', subject: 'Re: Quotation', at: at(1), text: 'Please find our quotation attached.' },
    { id: 'INBOX:2', from: 'Sam <Sam@Orient.com>', subject: 'Re: Renewal', at: at(1), text: 'How many floors does the building have?' }, // another person at the same company
    { id: 'INBOX:3', from: 'News <news@chubb.com>', subject: 'Newsletter', at: at(9), text: 'from before we wrote' },
    { id: 'INBOX:4', from: 'Someone <x@other.com>', subject: 'Hi', at: at(1), text: 'nothing to do with it' },
  ];
  const read = [];
  const deps = { ...mailbox, inbox: async () => mail,
    parts: async (userId, id) => ({ text: mail.find((m) => m.id === id).text, files: id === 'INBOX:1' ? [quotePdf] : [] }),
    think: async (content) => { read.push(content); return JSON.stringify(JSON.stringify(content).includes('floors') ? { kind: 'question', note: 'Asks how many floors the building has.' } : OFFER); } };

  const got = await R.checkReplies(r.id, deps);
  assert.deepEqual([got.quotes, got.questions], [['Chubb'], ['Orient Insurance']]);
  assert.deepEqual(got.renewal.suppliers.map((s) => [s.name, s.state, s.reply_kind, s.reply_note]),
    [['Orient Insurance', 'replied', 'question', 'Asks how many floors the building has.'], ['Chubb', 'replied', 'quote', 'Annual premium USD 16,900.'], ['Marsh', 'listed', null, null]]);
  assert.deepEqual(got.renewal.quotes.map((q) => [q.supplier, q.premium, q.deductible, q.exclusions, q.valid_until, q.source, q.has_file, q.file_name]),
    [['Chubb', 'USD 16,900', 'USD 10,000', 'Flood', '2026-11-30', 'email', true, 'chubb-quote.pdf']]);
  assert.equal(read.length, 2, 'mail from before the request, and from anyone else, is never read');
  assert.equal(read.find((c) => c.length > 1)[0].type, 'document', 'the attached quote is read as the file it is');

  const again = await R.checkReplies(r.id, deps);
  assert.deepEqual([again.quotes, again.questions, read.length, again.renewal.quotes.length], [[], [], 2, 1], 'the same mail is not read twice');
});

test('a reply that cannot be read is still shown as received, and a quote handed over as a file is read the same way', async () => {
  const { existsSync } = await import('node:fs');
  const { r, at, chubb, marsh } = await asked();
  const mail = [{ id: 'INBOX:7', from: 'Orient <renewals@orient.com>', subject: 'Re: Renewal', at: at(1), text: 'see attached' }];
  const got = await R.checkReplies(r.id, { ...mailbox, inbox: async () => mail, parts: async () => { throw new Error('gone'); }, think: async () => '{}' });
  assert.deepEqual(got.renewal.suppliers.map((s) => [s.name, s.state, s.reply_kind]).slice(0, 1), [['Orient Insurance', 'replied', 'unread']]);

  // By WhatsApp or on paper: the file is put in by hand, and read like the others.
  let v = await R.addQuote(r.id, chubb.supplier_id, quotePdf, { think: async () => JSON.stringify({ ...OFFER, valid_until: '31/11/2026' }) });
  assert.deepEqual(v.quotes.map((q) => [q.supplier, q.premium, q.valid_until, q.source, q.has_file]), [['Chubb', 'USD 16,900', null, 'upload', true]], 'a date that is not one is left out');
  assert.equal(named(v, 'Chubb').state, 'replied');
  // Not readable: it is kept all the same, for a person to open.
  v = await R.addQuote(r.id, marsh.supplier_id, quotePdf, { think: async () => { throw new Error('down'); } });
  assert.deepEqual(v.quotes.map((q) => [q.supplier, q.premium, q.note]).at(-1), ['Marsh', null, 'This could not be read: open the file to see the offer.']);
  await assert.rejects(R.addQuote(r.id, 999, quotePdf), /Not found/);
  await assert.rejects(R.addQuote(r.id, chubb.supplier_id, null), /Choose the file/);

  const kept = await db.prepare('SELECT id, file_path FROM prop_renewal_quotes ORDER BY id').all();
  v = await R.removeQuote(r.id, kept[0].id);
  assert.deepEqual([v.quotes.length, existsSync(kept[0].file_path), existsSync(kept[1].file_path)], [1, false, true]);
});

test('unasked, Riley looks for replies: a new quote is told once, and a supplier gone quiet is chased', async () => {
  const { master, r, at, now } = await asked(6);
  const mail = [{ id: 'INBOX:1', from: 'Chubb <quotes@chubb.com>', subject: 'Quotation', at: at(1), text: 'Attached.' }];
  const told = [];
  const deps = { ...mailbox, inbox: async () => mail, parts: async () => ({ text: 'Attached.', files: [quotePdf] }), think: async () => JSON.stringify(OFFER),
    push: async (ids, note) => { told.push([ids, note.title, note.body]); } };
  await R.runRenewals(deps, now);
  assert.deepEqual(told, [[[master], 'A quote from Chubb', 'Fire insurance, Tower · USD 16,900'], [[master], 'No reply from Orient Insurance', 'Fire insurance, Tower · a follow-up is written and waiting for you']]);
  assert.equal(named(await R.getRenewal(r.id), 'Orient Insurance').chaser_status, 'pending');
  await R.runRenewals(deps, now);
  assert.equal(told.length, 2, 'neither is told twice');
  assert.deepEqual([...new Set((await drafts()).map((d) => d.status))].sort(), ['pending', 'sent'], 'only the two this test marked as sent were ever sent');
});

// ---------- comparison and decision ----------

// Both have quoted: Chubb cheaper with a higher deductible, Orient dearer on the present terms.
async function quoted() {
  const t = await asked();
  await R.addQuote(t.r.id, t.chubb.supplier_id, quotePdf, { think: async () => JSON.stringify(OFFER) });
  const v = await R.addQuote(t.r.id, t.orient.supplier_id, quotePdf, { think: async () => JSON.stringify({ ...OFFER, premium: 'USD 19,900', deductible: 'USD 5,000', exclusions: null }) });
  const [chubbQ, orientQ] = v.quotes.map((q) => q.id);
  return { ...t, chubbQ, orientQ };
}

test('the offers beside the current policy, what was found about each supplier, and which Riley would take', async () => {
  const fresh = await asked();
  await assert.rejects(R.compare(fresh.r.id, mailbox), /no quotes to compare/);

  const { r, chubb, chubbQ, orientQ } = await quoted();
  const looked = [];
  const deps = { ...mailbox,
    search: async (prompt) => { looked.push(prompt); return JSON.stringify({ licensed: 'Licensed by the Texas Department of Insurance', rating: 'AM Best A++', since: '1882', summary: 'A large commercial insurer.',
      sources: [{ title: 'TDI', url: 'https://www.tdi.texas.gov/x' }, { title: 'not a link', url: 'javascript:alert(1)' }] }); },
    think: async () => JSON.stringify({ verdicts: { [chubbQ]: { premium: 'better', deductible: 'worse', cover: 'same', sum_insured: 'amazing', nonsense: 'better' }, [orientQ]: { premium: 'worse' } },
      pick: chubbQ, why: 'Chubb is USD 1,500 cheaper for the same cover.', unsure: 'Its deductible is twice as high.' }) };

  let v = await R.compare(r.id, deps);
  assert.deepEqual(v.compared.current, { supplier: 'Orient Insurance', premium: 'USD 18,400', sum_insured: 'USD 12,500,000', deductible: 'USD 5,000', cover: 'Building and common areas' });
  assert.deepEqual(v.compared.offers.map((o) => [o.supplier, o.premium, o.deductible, o.verdicts]),
    [['Chubb', 'USD 16,900', 'USD 10,000', { premium: 'better', deductible: 'worse', cover: 'same' }], ['Orient Insurance', 'USD 19,900', 'USD 5,000', { premium: 'worse' }]]);
  assert.deepEqual([v.compared.pick, v.compared.why, v.compared.unsure, v.compared.failed], [chubbQ, 'Chubb is USD 1,500 cheaper for the same cover.', 'Its deductible is twice as high.', false]);
  const { checked_on, ...about } = named(v, 'Chubb').about;
  assert.deepEqual(about, { licensed: 'Licensed by the Texas Department of Insurance', rating: 'AM Best A++', since: '1882', summary: 'A large commercial insurer.', sources: [{ title: 'TDI', url: 'https://www.tdi.texas.gov/x' }] });
  assert.match(checked_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(looked.length, 2, 'each supplier that quoted is looked up');

  await R.compare(r.id, deps);
  assert.equal(looked.length, 2, 'and not looked up again');

  // The model down: the figures are still side by side, with no verdicts and nothing recommended.
  v = await R.compare(r.id, { ...deps, think: async () => { throw new Error('down'); } });
  assert.deepEqual([v.compared.failed, v.compared.pick, v.compared.offers.map((o) => o.verdicts)], [true, null, [{}, {}]]);

  // A newer quote from the same supplier takes the older one's place; and the comparison is to be made again.
  v = await R.addQuote(r.id, chubb.supplier_id, quotePdf, { think: async () => JSON.stringify({ ...OFFER, premium: 'USD 16,200' }) });
  assert.equal(v.compared, null);
  v = await R.compare(r.id, deps);
  assert.deepEqual(v.compared.offers.map((o) => [o.supplier, o.premium]), [['Orient Insurance', 'USD 19,900'], ['Chubb', 'USD 16,200']]);
});

test('choosing an offer writes the acceptance and the thank-yous, and they wait like every other email', async () => {
  const { master, b, r, chubbQ, orientQ } = await quoted();
  await assert.rejects(R.decide(r.id, 999, master, mailbox), /Not found/);
  let v = await R.decide(r.id, chubbQ, master, mailbox);
  assert.deepEqual([v.status, v.chosen_quote_id], ['decided', chubbQ]);
  assert.deepEqual(v.closing.map((c) => [c.supplier, c.kind, c.status]), [['Chubb', 'accept', 'pending'], ['Orient Insurance', 'thanks', 'pending']], 'Marsh was never asked, so is not written to');
  assert.ok(v.closing[0].body.includes('USD 16,900') && v.closing[0].body.includes('Fire insurance'));
  assert.ok(!v.closing[1].body.includes('16,900'), 'what the other offered is not told to the one not chosen');
  assert.deepEqual((await drafts()).map((d) => d.status), ['sent', 'sent', 'pending', 'pending']);

  // A change of mind: the letters that have not gone are withdrawn, and written again.
  v = await R.decide(r.id, orientQ, master, mailbox);
  assert.deepEqual(v.closing.map((c) => [c.supplier, c.kind, c.status]), [['Orient Insurance', 'accept', 'pending'], ['Chubb', 'thanks', 'pending']]);
  assert.deepEqual((await drafts()).map((d) => d.status), ['sent', 'sent', 'rejected', 'rejected', 'pending', 'pending']);

  // With no mailbox the words are still written, to copy.
  v = await R.decide(r.id, chubbQ, master, { account: async () => null });
  assert.deepEqual(v.closing.map((c) => [c.supplier, c.kind, c.status, c.body.split('\n')[0]]), [['Chubb', 'accept', null, 'Dear Chubb team,'], ['Orient Insurance', 'thanks', null, 'Dear Orient Insurance team,']]);

  // The new policy is filed: the renewal is done.
  await addDocument({ building_id: b.id, title: 'Fire insurance', expiry_date: '2028-01-08' });
  assert.equal((await R.getRenewal(r.id)).status, 'renewed');
  await assert.rejects(R.decide(r.id, chubbQ, master, mailbox), /already closed/);
});
