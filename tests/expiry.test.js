import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeDoc, closeDb } from './helpers/db.js';
import { expiringDocuments } from '../server/files.js';

test.after(() => closeDb());

/** A document that runs out `days` from today (negative = it already has). */
const inDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

async function expiringDoc(userId, name, days, extra = {}) {
  const id = await makeDoc(userId, null, name);
  const fields = { expires_on: days === null ? null : inDays(days), ...extra };
  for (const [k, v] of Object.entries(fields)) {
    await db.prepare(`UPDATE documents SET ${k} = ? WHERE id = ?`).run(v, id);
  }
  return id;
}

test('expiring lists what has run out and what is about to, soonest first', async () => {
  await reset();
  const user = await makeUser('Sara');
  const lapsed = await expiringDoc(user, 'trade-licence.pdf', -20);
  const soon = await expiringDoc(user, 'visa.pdf', 9);
  const later = await expiringDoc(user, 'tenancy.pdf', 60);

  const rows = await expiringDocuments(user, 90);
  assert.deepEqual(rows.map((r) => r.id), [lapsed, soon, later], 'expired first, then soonest');
});

test('expiring leaves out what is beyond the window', async () => {
  await reset();
  const user = await makeUser('Sara');
  await expiringDoc(user, 'near.pdf', 10);
  await expiringDoc(user, 'far.pdf', 200);

  const rows = await expiringDocuments(user, 30);
  assert.deepEqual(rows.map((r) => r.name), ['near.pdf']);
});

test('expiring ignores documents with no expiry at all', async () => {
  await reset();
  const user = await makeUser('Sara');
  await expiringDoc(user, 'invoice.pdf', null);
  assert.equal((await expiringDocuments(user, 365)).length, 0);
});

test('expiring never reaches another account, however close the date', async () => {
  await reset();
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  await expiringDoc(omar, 'his-licence.pdf', 3);

  assert.equal((await expiringDocuments(sara, 365)).length, 0, 'one user cannot see another user\'s expiries');
  assert.equal((await expiringDocuments(omar, 365)).length, 1);
});

test('expiring skips a file that is still being read', async () => {
  await reset();
  const user = await makeUser('Sara');
  await expiringDoc(user, 'queued.pdf', 5, { status: 'queued' });
  await expiringDoc(user, 'ready.pdf', 5);

  const rows = await expiringDocuments(user, 30);
  assert.deepEqual(rows.map((r) => r.name), ['ready.pdf'], 'a half-filed document has no trustworthy expiry yet');
});

test('the window is clamped, so a junk value cannot ask for everything or nothing', async () => {
  await reset();
  const user = await makeUser('Sara');
  await expiringDoc(user, 'lapsed.pdf', -30);
  await expiringDoc(user, 'soon.pdf', 5);
  await expiringDoc(user, 'beyond-a-decade.pdf', 4000);

  assert.equal((await expiringDocuments(user, 'nonsense')).length, 2, 'falls back to the default ninety days');
  const narrowed = await expiringDocuments(user, -5);
  assert.deepEqual(narrowed.map((r) => r.name), ['lapsed.pdf'], 'a window below a day still shows what has already run out');

  const widest = await expiringDocuments(user, 99999);
  assert.deepEqual(widest.map((r) => r.name), ['lapsed.pdf', 'soon.pdf'],
    'the widest window anyone can ask for is ten years, so a date beyond that stays out');
});
