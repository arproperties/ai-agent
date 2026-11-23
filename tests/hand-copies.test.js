import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, closeDb } from './helpers/db.js';
import { shelfKit, searchShelf } from '../server/shelf.js';
import { kindOf, sameCompany } from '../server/handCopies.js';

test.after(() => closeDb());

// Titles as they are on live: the hand copies the AI named, the saifsys copies' companies.
test('a hand copy is matched only when it is plainly the same company and the same kind of paper', () => {
  assert.equal(kindOf('Madar Al Wadi – Trade License 2025'), 'trade_license');
  assert.equal(kindOf('Commercial License – AL MANKHOOL CONTRACTING 551201'), 'trade_license');
  assert.equal(kindOf('Establishment Card – AL MANKHOOL CONTRACTING'), 'establishment_card');
  assert.equal(kindOf('Vehicle License – PRIME ELITE CONSTRUCTION E/24959'), null, 'a vehicle licence is not a trade licence');
  assert.equal(kindOf('Trade license fee payment – PRIME ELITE'), null, 'a payment for a licence is not the licence');
  assert.equal(kindOf('Tradex Auditing Invoice – VAT Return Filing'), null);

  assert.ok(sameCompany('Madar Al Wadi – Trade License 2025', 'Madar Alwadi Building Contracting LLC'));
  assert.ok(sameCompany('Trade licence – AL MANKHOOL CONTRACTING 551201', 'AL MANKHOOL CONTRACTING'));
  assert.ok(sameCompany('WATER WAYS SHIPPING Trade License 228097', 'WATER WAYS SHIPPING L.L.C'));
  assert.equal(sameCompany('Commercial License – PRIME ELITE CONSTRUCTION', 'Prime Elite Transportation LLC'), false, 'two companies sharing a name');
  assert.equal(sameCompany('Trade License – Heroes Zone Pest Control', 'Heroes Zone Building Cleaning'), false);
  assert.equal(sameCompany('ARS Vacation Homes Rental – Commercial License 2025–2026', 'ARS Home Rentals'), false, 'unsure is left alone');
  assert.equal(sameCompany('Trade License', 'ARS Home Rentals'), false, 'no company named');
});

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const master = await db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
  return { master };
}

const doc = async (userId, title, { subject = null, expires = null, text = '' } = {}) => {
  const { id } = await db.prepare(`INSERT INTO documents (user_id, name, title, kind, shared, status, subject, expires_on)
    VALUES (?, ?, ?, 'doc', true, 'ready', ?, ?) RETURNING id`).run(userId, `${title}.pdf`, title, subject, expires);
  if (text) await db.prepare('INSERT INTO chunks (user_id, document_id, text, shared) VALUES (?, ?, ?, true)').run(userId, id, `[${title}] ${text}`);
  return id;
};
let nextSaifsysId = 1;
const fromSaifsys = async (userId, title, subject, type, expires) => {
  const id = await doc(userId, title, { subject, expires });
  await db.prepare('INSERT INTO saifsys_company_doc_links (saifsys_id, version_no, document_id, doc_type) VALUES (?, 0, ?, ?)').run(nextSaifsysId++, id, type);
  return id;
};
const search = async (user, query) => (await shelfKit(user).run({ id: 't', name: 'search_files', input: { query } })).content;
// The file each result line is about: the first number on the line, after any OLD note.
const order = (text) => [...text.matchAll(/^(?:[^#\n]*#\d+[^#\n]*: )?#(\d+) /gm)].map((m) => Number(m[1]));
const dayFromNow = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

test('the saifsys licence comes before an old copy uploaded by hand, which is marked OLD', async () => {
  const { master } = await fixture();
  // The hand copy matches the words better: "madar al wadi trade license" is its whole title.
  const hand = await doc(master.id, 'Madar Al Wadi – Trade License 2025', { text: 'Madar Al Wadi trade license expiry 2025' });
  const saifsys = await fromSaifsys(master.id, 'Trade Licence – Madar Alwadi Building Contracting LLC', 'Madar Alwadi Building Contracting LLC', 'trade_license', dayFromNow(300));

  const out = await search(master, 'Madar Al Wadi trade license');
  const ids = order(out);
  assert.ok(ids.indexOf(saifsys) >= 0 && ids.indexOf(saifsys) < ids.indexOf(hand), out);
  assert.match(out, new RegExp(`OLD - a hand-uploaded copy of #${saifsys} from saifsys: #${hand} `));
  assert.match(out, /answer from the current one/);

  // The Shelf screen's search box shows them in the same order.
  const screen = await searchShelf(master, 'Madar Al Wadi trade license');
  assert.ok(screen.indexOf(saifsys) < screen.indexOf(hand));
});

test('the saifsys copy is brought in even when only the hand copy matched the words', async () => {
  const { master } = await fixture();
  const hand = await doc(master.id, 'Trade licence – AL MANKHOOL CONTRACTING 551201', { text: 'licence number 551201' });
  const saifsys = await fromSaifsys(master.id, 'Trade Licence – AL MANKHOOL CONTRACTING', 'AL MANKHOOL CONTRACTING', 'trade_license', dayFromNow(300));

  const ids = order(await search(master, '551201'));
  assert.deepEqual(ids.slice(0, 2), [saifsys, hand]);
});

test('an expired saifsys copy loses to a newer hand copy, and the reply says saifsys needs updating', async () => {
  const { master } = await fixture();
  const saifsys = await fromSaifsys(master.id, 'Trade Licence – WATER WAYS SHIPPING L.L.C', 'WATER WAYS SHIPPING L.L.C', 'trade_license', '2025-06-06');
  const hand = await doc(master.id, 'WATER WAYS SHIPPING Trade License 228097', { expires: dayFromNow(200) });

  const out = await search(master, 'water ways trade license');
  const ids = order(out);
  assert.deepEqual(ids.slice(0, 2), [hand, saifsys]);
  assert.match(out, new RegExp(`newer than the saifsys copy #${saifsys}, which has expired`));
  assert.match(out, /EXPIRED - saifsys has no newer issue yet/);
  assert.match(out, /should be updated there/);
});

test('an expired saifsys copy with no newer hand copy still comes first, said to be expired', async () => {
  const { master } = await fixture();
  const saifsys = await fromSaifsys(master.id, 'Trade Licence – WATER WAYS SHIPPING L.L.C', 'WATER WAYS SHIPPING L.L.C', 'trade_license', '2025-06-06');
  const hand = await doc(master.id, 'WATER WAYS SHIPPING Trade License 228097');

  const out = await search(master, 'water ways trade license');
  assert.deepEqual(order(out).slice(0, 2), [saifsys, hand]);
  assert.match(out, /EXPIRED/);
});

test('files that are not copies of a saifsys document keep their order', async () => {
  const { master } = await fixture();
  await fromSaifsys(master.id, 'Trade Licence – Prime Elite Transportation LLC', 'Prime Elite Transportation LLC', 'trade_license', dayFromNow(300));
  const other = await doc(master.id, 'Commercial License – PRIME ELITE CONSTRUCTION');
  const car = await doc(master.id, 'Vehicle License – PRIME ELITE CONSTRUCTION E/24959');

  const out = await search(master, 'prime elite construction license');
  assert.doesNotMatch(out, /hand-uploaded copy/);
  const ids = order(out);
  assert.ok(ids.includes(other) && ids.includes(car));
});
