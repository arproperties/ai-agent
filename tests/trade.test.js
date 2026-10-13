import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { db, reset, makeUser, closeDb } from './helpers/db.js';

const { MODULES, userModules, listModuleAccess, setModuleAccess, needsModule, needsModuleUnless, giveToEveryoneOnce } = await import('../server/modules.js');
const { tidy, monthAndDay, dayStart, createEntry, addVoice, listEntries, deleteEntry } = await import('../server/trade.js');

test.after(() => closeDb());

const jpg = () => ({ mimetype: 'image/jpeg', buffer: Buffer.from('not really a picture') });
const voice = () => ({ mimetype: 'audio/webm;codecs=opus', buffer: Buffer.from('not really a sound') });

async function people() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const sam = { id: await makeUser('Sam'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  return { boss, sam, other };
}

/** Stand-ins for the two AI calls: what the bill says, and what was spoken. */
const ai = (bill = { party: 'Al Noor Trading', amount: 450, currency: 'AED', date: '2026-10-12', about: 'Paint and brushes' }, spoken = 'paid in cash') => {
  const asked = [];
  return {
    asked,
    read: async (q) => { asked.push(q); if (bill instanceof Error) throw bill; return bill; },
    hear: async () => { if (spoken instanceof Error) throw spoken; return spoken; },
  };
};
const sweep = async (boss) => { for (const e of (await listEntries(boss)).entries) await deleteEntry(boss, e.id); };

// ---------- the module ----------

test('a person can hold several modules at once, and each opens only its own routes', async () => {
  const { boss, sam } = await people();
  assert.deepEqual(await userModules(boss), MODULES.map((m) => m.key));
  assert.equal(await setModuleAccess(sam.id, ['trade', 'notices']), 2);
  assert.deepEqual(await userModules(sam), ['notices', 'trade']);
  assert.deepEqual((await listModuleAccess(sam.id)).modules.filter((m) => m.on).map((m) => m.label), ['Tenant notices', 'Sales & purchase']);

  await setModuleAccess(sam.id, ['trade']);
  const knock = (key) => new Promise((done) => {
    needsModule(key)({ user: sam }, { status: (code) => ({ json: () => done(code) }) }, () => done('in'));
  });
  assert.equal(await knock('trade'), 'in');
  assert.equal(await knock('notices'), 403, 'taking one module away leaves the other');
});

test('a screen that becomes a module stays with whoever had it, once, and the master can then take it away', async () => {
  const { boss, sam } = await people();
  const old = MODULES.filter((m) => m.everyone).map((m) => m.key);
  assert.deepEqual(old, ['shelf', 'todos', 'translate', 'meetings', 'transcribe', 'duties', 'checklists', 'memory', 'email']);
  assert.deepEqual(await userModules(sam), [], 'before the day it is done, nobody but the master has any');
  assert.deepEqual(await giveToEveryoneOnce(), old);
  assert.deepEqual(await userModules(sam), old, 'not the new ones: those are still a tick');

  await setModuleAccess(sam.id, ['shelf', 'trade']);
  const late = { id: await makeUser('Late'), role: 'user' };
  assert.deepEqual(await giveToEveryoneOnce(), [], 'a restart does it again to nobody');
  assert.deepEqual(await userModules(sam), ['shelf', 'trade'], 'what the master took away stays away');
  assert.deepEqual(await userModules(late), [], 'someone added afterwards starts with nothing');
});

test('what a chat asks of the same data stays open to someone without the module', async () => {
  const { sam } = await people();
  const glance = (req) => req.method === 'GET' && req.path === '/';
  const knock = (req) => new Promise((done) => {
    needsModuleUnless('email', glance)({ user: sam, ...req }, { status: (code) => ({ json: () => done(code) }) }, () => done('in'));
  });
  assert.equal(await knock({ method: 'GET', path: '/' }), 'in');
  assert.equal(await knock({ method: 'POST', path: '/' }), 403);
  assert.equal(await knock({ method: 'GET', path: '/suggest' }), 403);
  await setModuleAccess(sam.id, ['email']);
  assert.equal(await knock({ method: 'POST', path: '/' }), 'in');
});

// ---------- recording ----------

test('an entry is a photo of the bill and a few spoken words; Reem fills in the rest', async () => {
  const { boss, sam } = await people();
  const { asked, read, hear } = ai();
  const e = await createEntry(sam, { kind: 'purchase', photos: [jpg(), jpg()], voice: voice() }, { read, hear });
  assert.equal(e.kind, 'purchase');
  assert.equal(e.party, 'Al Noor Trading');
  assert.equal(e.amount, 450);
  assert.equal(e.currency, 'AED');
  assert.equal(e.date, '2026-10-12');
  assert.equal(e.about, 'Paint and brushes');
  assert.equal(e.said, 'paid in cash');
  assert.equal(e.status, 'ok');
  assert.equal(e.photos.length, 2);
  assert.equal(e.voices.length, 1);
  assert.equal(asked[0].kind, 'purchase');
  assert.equal(asked[0].photos.length, 2);
  assert.equal(asked[0].said, 'paid in cash', 'what was said is read along with the bill');
  for (const f of await db.prepare('SELECT path, mime FROM trade_entry_files').all()) {
    assert.ok(existsSync(f.path));
    assert.doesNotMatch(f.mime, /;/, 'the type is kept without its codec');
  }
  await sweep(boss);
});

test('words in any language are kept as they were spoken', async () => {
  const { boss, sam } = await people();
  const { read, hear } = ai(undefined, 'ادا کر دیا گیا ہے');
  const e = await createEntry(sam, { kind: 'sale', voice: voice() }, { read, hear });
  assert.equal(e.said, 'ادا کر دیا گیا ہے');
  assert.equal(e.photos.length, 0, 'a sale with no bill can be spoken alone');
  await sweep(boss);
});

test('a bill Reem cannot read is still saved, and marked to be looked at', async () => {
  const { boss, sam } = await people();
  const blurred = await createEntry(sam, { kind: 'sale', photos: [jpg()] }, ai({ party: null, amount: null, about: 'Unreadable photo' }));
  assert.equal(blurred.status, 'check');
  assert.equal(blurred.amount, null);
  const down = await createEntry(sam, { kind: 'sale', photos: [jpg()], voice: voice() }, ai(new Error('overloaded'), new Error('no voice key')));
  assert.equal(down.status, 'check');
  assert.equal(down.said, null);
  assert.equal(down.photos.length, 1, 'the picture is kept whatever happened to the reading');
  assert.equal(down.voices.length, 1, 'and so is the recording, for the master to play');
  await sweep(boss);
});

test('what comes back from the reading is tidied before it is kept', () => {
  assert.deepEqual(tidy({ party: '  Al Noor  ', amount: '1,250.456', currency: 'usd', date: '2026-02-30', about: ' x ' }),
    { party: 'Al Noor', amount: 1250.46, currency: 'USD', bill_date: null, about: 'x' });
  assert.deepEqual(tidy({ amount: 0, date: '2026-10-12' }), { party: null, amount: null, currency: 'AED', bill_date: '2026-10-12', about: null });
  assert.deepEqual(tidy(null), { party: null, amount: null, currency: 'AED', bill_date: null, about: null });
});

test('an entry needs to be a sale or a purchase, and to have a photo or a voice note', async () => {
  const { sam } = await people();
  const { read, hear } = ai();
  const make = (o) => createEntry(sam, { kind: 'sale', photos: [jpg()], ...o }, { read, hear });
  await assert.rejects(make({ kind: 'gift' }), /Sale or Purchase/);
  await assert.rejects(make({ photos: [] }), /photo of the bill or say/);
  await assert.rejects(make({ photos: [{ mimetype: 'application/pdf', buffer: Buffer.from('x') }] }), /JPG or PNG/);
  await assert.rejects(make({ photos: Array.from({ length: 6 }, jpg) }), /At most 5 photos/);
  await assert.rejects(make({ voice: { mimetype: 'text/plain', buffer: Buffer.from('x') } }), /voice note could not be used/);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM trade_entries').get()).n, 0, 'nothing refused is left behind');
});

// ---------- putting it right ----------

test('a wrong reading is put right by saying so', async () => {
  const { boss, sam, other } = await people();
  const first = await createEntry(sam, { kind: 'purchase', photos: [jpg()], voice: voice() }, ai());
  const fix = ai({ party: 'Al Noor Trading', amount: 540, currency: 'AED', date: '2026-10-12', about: 'Paint and brushes' }, 'the amount is 540');
  await assert.rejects(addVoice(other, first.id, voice(), fix), /not found/, 'somebody else\'s entry is not theirs to change');
  const e = await addVoice(sam, first.id, voice(), fix);
  assert.equal(e.amount, 540);
  assert.equal(e.said, 'paid in cash\nthe amount is 540');
  assert.equal(e.voices.length, 2);
  assert.equal(fix.asked[0].said, 'paid in cash\nthe amount is 540', 'the bill is read again with everything said so far');
  assert.equal(fix.asked[0].photos.length, 1);
  await assert.rejects(addVoice(sam, first.id, voice(), ai(undefined, '  ')), /could not hear/);
  await assert.rejects(addVoice(sam, first.id, voice(), ai(undefined, new Error('down'))), /could not hear/);
  assert.equal((await listEntries(sam)).entries[0].amount, 540, 'a correction nobody could hear changes nothing');
  await sweep(boss);
});

test('a person can take back an entry just made, and after that only the master can', async () => {
  const { boss, sam, other } = await people();
  const { read, hear } = ai();
  const a = await createEntry(sam, { kind: 'sale', photos: [jpg()] }, { read, hear });
  const b = await createEntry(sam, { kind: 'sale', photos: [jpg()] }, { read, hear });
  const paths = (await db.prepare('SELECT path FROM trade_entry_files').all()).map((f) => f.path);
  assert.equal(a.canRemove, true);
  await assert.rejects(deleteEntry(other, a.id), /not found/);
  await deleteEntry(sam, a.id);
  await db.prepare('UPDATE trade_entries SET created_at = created_at - 3600 WHERE id = ?').run(b.id);
  assert.equal((await listEntries(sam)).entries[0].canRemove, false);
  await assert.rejects(deleteEntry(sam, b.id), /Only the master/);
  await deleteEntry(boss, b.id);
  assert.deepEqual((await listEntries(boss)).entries, []);
  for (const p of paths) assert.equal(existsSync(p), false, 'the pictures go with the entry');
});

// ---------- who sees what ----------

test('a person sees their own entries; the master sees everyone\'s, and the totals follow', async () => {
  const { boss, sam, other } = await people();
  await createEntry(sam, { kind: 'sale', photos: [jpg()] }, ai({ party: 'A', amount: 100, currency: 'AED' }));
  await createEntry(sam, { kind: 'sale', photos: [jpg()] }, ai({ party: 'B', amount: 50.5, currency: 'AED' }));
  await createEntry(other, { kind: 'purchase', photos: [jpg()] }, ai({ party: 'C', amount: 30, currency: 'AED' }));
  await createEntry(other, { kind: 'purchase', photos: [jpg()] }, ai({ party: null, amount: null }));
  // One from last month, whatever today is: listed, but in neither total.
  const { month } = monthAndDay();
  const old = await createEntry(sam, { kind: 'sale', photos: [jpg()] }, ai({ party: 'D', amount: 1000, currency: 'AED' }));
  await db.prepare('UPDATE trade_entries SET created_at = ? WHERE id = ?').run(month - 86400, old.id);

  const mine = await listEntries(sam);
  assert.deepEqual(mine.entries.map((e) => e.party), ['D', 'B', 'A']);
  assert.equal(mine.entries[0].by, 'Sam');
  assert.deepEqual(mine.totals, [{ kind: 'sale', currency: 'AED', today: 150.5, month: 150.5 }]);

  const find = async (who, q) => (await listEntries(who, { q })).entries.map((e) => e.party);
  assert.deepEqual(await find(boss, 'sam'), ['D', 'B', 'A'], 'by who recorded it');
  assert.deepEqual(await find(boss, '50.5'), ['B'], 'by the amount');
  assert.deepEqual(await find(boss, ' c '), ['C'], 'by the name, whatever the case');
  assert.deepEqual(await find(sam, 'c'), [], 'a search finds nothing of somebody else’s');
  assert.deepEqual(await find(boss, '%'), [], 'a percent sign is a percent sign');
  assert.deepEqual(await find(boss, '_'), [], 'and an underscore an underscore');
  assert.deepEqual(await find(boss, '0.5'), ['B'], 'part of an amount is enough');
  assert.deepEqual((await listEntries(sam, { q: 'zzz' })).totals, mine.totals, 'the totals are of everything, whatever is searched for');
  assert.equal(mine.found, null, 'with nothing narrowed there is nothing found to add up');
  assert.deepEqual((await listEntries(boss, { q: 'sam' })).found, [{ kind: 'sale', currency: 'AED', entries: 3, total: 1150.5 }]);

  // The days are Dubai's, and both ends count.
  const ymd = (secs) => new Date((secs + 4 * 3600) * 1000).toISOString().slice(0, 10);
  const today = ymd(Date.now() / 1000);
  const then = ymd(month - 86400);
  const on = async (who, from, to) => (await listEntries(who, { from, to })).entries.map((e) => e.party);
  assert.deepEqual(await on(boss, today, today), [null, 'C', 'B', 'A']);
  assert.deepEqual(await on(boss, then, then), ['D']);
  assert.deepEqual(await on(boss, then, today), ['D', null, 'C', 'B', 'A']);
  assert.deepEqual(await on(boss, today, then), ['D', null, 'C', 'B', 'A'], 'the wrong way round is still the same stretch');
  assert.deepEqual(await on(sam, today, today), ['B', 'A']);
  assert.deepEqual((await listEntries(boss, { from: today, to: today, q: 'sam' })).found, [{ kind: 'sale', currency: 'AED', entries: 2, total: 150.5 }]);
  assert.deepEqual((await listEntries(boss, { from: today, to: today })).found, [
    { kind: 'purchase', currency: 'AED', entries: 2, total: 30 },
    { kind: 'sale', currency: 'AED', entries: 2, total: 150.5 },
  ], 'an entry with no amount is counted, and adds nothing');
  assert.deepEqual(await on(boss, 'last week', '2026-02-30'), ['D', null, 'C', 'B', 'A'], 'a day that is not a day narrows nothing');

  const all = await listEntries(boss);
  assert.equal(all.entries.length, 5);
  assert.deepEqual(all.totals, [
    { kind: 'purchase', currency: 'AED', today: 30, month: 30 },
    { kind: 'sale', currency: 'AED', today: 150.5, month: 150.5 },
  ]);
  await sweep(boss);
});

test('a chosen day begins at midnight in Dubai', () => {
  assert.equal(dayStart('2026-10-13'), Date.UTC(2026, 9, 12, 20) / 1000);
  assert.equal(dayStart('2026-02-30'), null);
  assert.equal(dayStart('13/10/2026'), null);
  assert.equal(dayStart(undefined), null);
});

test('today and this month begin at midnight in Dubai', () => {
  // 13 October 2026, 01:30 in Dubai is still the 12th in UTC.
  const at = Date.UTC(2026, 9, 12, 21, 30) / 1000;
  assert.deepEqual(monthAndDay(at), { day: Date.UTC(2026, 9, 12, 20) / 1000, month: Date.UTC(2026, 8, 30, 20) / 1000 });
});
