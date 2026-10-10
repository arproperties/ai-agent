import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import {
  engine, LANGUAGES, addTurn, retryTurn, clean, hearing,
  listTranslations, getTranslation, renameTranslation, deleteTranslation,
} from '../server/translate.js';

test.after(() => closeDb());

test('the tables are there, and a conversation takes its turns with it when deleted', async () => {
  await reset();
  const user = await makeUser('Sara');
  const { id } = await db.prepare(`INSERT INTO translations (user_id, title, lang_a, lang_b) VALUES (?, 'x', 'en', 'ar') RETURNING id`).get(user);
  await db.prepare(`INSERT INTO translation_turns (translation_id, side, original, translated) VALUES (?, 'a', 'hello', 'مرحبا')`).run(id);
  await db.prepare('DELETE FROM translations WHERE id = ?').run(id);
  const left = await db.prepare('SELECT count(*)::int AS n FROM translation_turns').get();
  assert.equal(left.n, 0);
});

const audio = Buffer.from('pretend this is speech');

// Stand-ins for the two paid calls. heard: the language hint of each transcription.
// asked: each translation that was requested.
let heard, asked;
function fake({ says = 'Where is the office?', gives = 'أين المكتب؟' } = {}) {
  heard = []; asked = [];
  engine.transcribe = async (buf, mimetype, language) => { heard.push(language); return says; };
  engine.translate = async (text, from, to) => {
    asked.push({ text, from: from.code, to: to.code });
    if (gives instanceof Error) throw gives;
    return gives;
  };
}

test('side A is heard in language A and translated into language B', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio, mimetype: 'audio/webm' });
  assert.deepEqual(heard, ['en']);
  assert.deepEqual(asked, [{ text: 'Where is the office?', from: 'en', to: 'ar' }]);
  assert.equal(r.turn.side, 'a');
  assert.equal(r.turn.original, 'Where is the office?');
  assert.equal(r.turn.translated, 'أين المكتب؟');
  assert.equal(r.turn.error, null);
});

test('side B is heard in language B and translated into language A', async () => {
  await reset();
  fake({ says: 'في الطابق الثاني', gives: 'On the second floor' });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'b', buffer: audio, mimetype: 'audio/webm' });
  assert.deepEqual(heard, ['ar']);
  assert.deepEqual(asked, [{ text: 'في الطابق الثاني', from: 'ar', to: 'en' }]);
  assert.equal(r.turn.translated, 'On the second floor');
});

test('the first turn starts the conversation, the next one joins it', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const first = await addTurn(user, { langA: 'en', langB: 'ur', side: 'a', buffer: audio });
  // The languages are the conversation's own from here on: what is sent with a later turn is ignored.
  const second = await addTurn(user, { id: first.id, langA: 'fr', langB: 'ru', side: 'b', buffer: audio });
  assert.equal(second.id, first.id);
  assert.deepEqual(heard, ['en', 'ur']);
  const rows = await db.prepare('SELECT title, lang_a, lang_b FROM translations').all();
  assert.deepEqual(rows, [{ title: 'English ↔ Urdu', lang_a: 'en', lang_b: 'ur' }]);
  const turns = await db.prepare('SELECT count(*)::int AS n FROM translation_turns WHERE translation_id = ?').get(first.id);
  assert.equal(turns.n, 2);
});

test('when nothing was said, nothing is saved and nothing is translated', async () => {
  await reset();
  fake({ says: '   ' });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.deepEqual(r, { id: null, turn: null });
  assert.equal(asked.length, 0);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM translations').get()).n, 0);
});

test('a turn is refused without audio, without a side, or with languages that make no sense', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const ok = { langA: 'en', langB: 'ar', side: 'a', buffer: audio };
  await assert.rejects(() => addTurn(user, { ...ok, buffer: Buffer.alloc(0) }), /No audio/);
  await assert.rejects(() => addTurn(user, { ...ok, side: 'c' }), /who is speaking/);
  await assert.rejects(() => addTurn(user, { ...ok, langB: 'xx' }), /from the list/);
  await assert.rejects(() => addTurn(user, { ...ok, langB: 'en' }), /two different languages/);
  assert.equal(heard.length, 0, 'nothing is paid for on a refused turn');
});

test('if the speech cannot be read, it says so plainly and saves nothing', async () => {
  await reset();
  fake();
  engine.transcribe = async () => { throw new Error('upstream 500'); };
  const user = await makeUser('Sara');
  await assert.rejects(() => addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio }),
    (e) => e.status === 502 && /Could not hear that/.test(e.message));
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM translations').get()).n, 0);
});

test('every language has a code, a name and its own name for itself', () => {
  assert.ok(LANGUAGES.length >= 20);
  assert.equal(new Set(LANGUAGES.map((l) => l.code)).size, LANGUAGES.length);
  for (const l of LANGUAGES) assert.ok(/^[a-z]{2}$/.test(l.code) && l.name && l.native, l.code);
  assert.equal(LANGUAGES.find((l) => l.code === 'ar').rtl, true);
});

test('only the translated words are kept, whatever the model wraps them in', async () => {
  assert.equal(clean('  "On the second floor"  '), 'On the second floor');
  assert.equal(clean('«أين المكتب؟»'), 'أين المكتب؟');
  assert.equal(clean('Translation: “Good morning”'), 'Good morning');
  assert.equal(clean("It's the boys' room"), "It's the boys' room", 'an apostrophe that belongs is left alone');
  assert.equal(clean('He said "no" twice'), 'He said "no" twice', 'quotes inside the sentence stay');

  await reset();
  fake({ gives: 'Translation: "أين المكتب؟"' });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.equal(r.turn.translated, 'أين المكتب؟');
});

test('a translation that fails keeps what was said, and trying again fills it in', async () => {
  await reset();
  fake({ gives: new Error('overloaded') });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.equal(r.turn.original, 'Where is the office?');
  assert.equal(r.turn.translated, '');
  assert.match(r.turn.error, /could not be translated/i);

  fake({ gives: 'أين المكتب؟' });
  const again = await retryTurn(user, r.id, r.turn.id);
  assert.equal(again.translated, 'أين المكتب؟');
  assert.equal(again.error, null);
  assert.deepEqual(asked, [{ text: 'Where is the office?', from: 'en', to: 'ar' }]);
  assert.equal(heard.length, 0, 'the speech is not read a second time');
});

test('an empty reply from the model counts as a failed translation', async () => {
  await reset();
  fake({ gives: '  ' });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.match(r.turn.error, /could not be translated/i);
});

test('trying again on a turn that is already translated costs nothing', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  fake({ gives: 'something else' });
  const again = await retryTurn(user, r.id, r.turn.id);
  assert.equal(again.translated, 'أين المكتب؟');
  assert.equal(asked.length, 0);
});

test('a side-B turn is retried in the right direction', async () => {
  await reset();
  fake({ says: 'في الطابق الثاني', gives: new Error('overloaded') });
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'b', buffer: audio });
  fake({ gives: 'On the second floor' });
  await retryTurn(user, r.id, r.turn.id);
  assert.deepEqual(asked, [{ text: 'في الطابق الثاني', from: 'ar', to: 'en' }]);
});

test('history lists conversations with their languages and how many turns each has', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const one = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  await addTurn(user, { id: one.id, side: 'b', buffer: audio });
  const two = await addTurn(user, { langA: 'en', langB: 'hi', side: 'a', buffer: audio });

  const list = await listTranslations(user);
  assert.deepEqual(list.map((c) => [c.id, c.title, c.lang_a, c.lang_b, c.turns]), [
    [two.id, 'English ↔ Hindi', 'en', 'hi', 1],
    [one.id, 'English ↔ Arabic', 'en', 'ar', 2],
  ]);
  assert.equal(list[0].user_id, undefined);
});

test('opening a conversation gives every turn in the order it was said', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  fake({ says: 'في الطابق الثاني', gives: 'On the second floor' });
  await addTurn(user, { id: r.id, side: 'b', buffer: audio });

  const conv = await getTranslation(user, r.id);
  assert.equal(conv.title, 'English ↔ Arabic');
  assert.equal(conv.user_id, undefined);
  assert.deepEqual(conv.turns.map((t) => [t.side, t.original, t.translated]), [
    ['a', 'Where is the office?', 'أين المكتب؟'],
    ['b', 'في الطابق الثاني', 'On the second floor'],
  ]);
  assert.equal(conv.turns[0].translation_id, undefined);
});

test('a conversation can be renamed, and an empty name goes back to its languages', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.equal((await renameTranslation(user, r.id, '  Plumber   on Friday ')).title, 'Plumber on Friday');
  assert.equal((await renameTranslation(user, r.id, '   ')).title, 'English ↔ Arabic');
  assert.equal((await renameTranslation(user, r.id, 'x'.repeat(300))).title.length, 120);
});

test('deleting a conversation removes its turns', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  const r = await addTurn(user, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  assert.equal(await deleteTranslation(user, r.id), true);
  assert.equal(await getTranslation(user, r.id), null);
  assert.equal((await db.prepare('SELECT count(*)::int AS n FROM translation_turns').get()).n, 0);
  assert.equal(await deleteTranslation(user, r.id), false);
});

test('nobody else can read, add to, retry, rename or delete a conversation', async () => {
  await reset();
  fake({ gives: new Error('overloaded') }); // a failed turn, so there is something to retry
  const sara = await makeUser('Sara');
  const omar = await makeUser('Omar');
  const r = await addTurn(sara, { langA: 'en', langB: 'ar', side: 'a', buffer: audio });
  fake();

  assert.equal((await listTranslations(omar)).length, 0);
  assert.equal(await getTranslation(omar, r.id), null);
  await assert.rejects(() => addTurn(omar, { id: r.id, side: 'a', buffer: audio }), (e) => e.status === 404);
  assert.equal(await retryTurn(omar, r.id, r.turn.id), null);
  assert.equal(await renameTranslation(omar, r.id, 'mine now'), null);
  assert.equal(await deleteTranslation(omar, r.id), false);
  assert.equal(heard.length + asked.length, 0, 'nothing is paid for on someone else\'s conversation');

  const still = await getTranslation(sara, r.id);
  assert.equal(still.title, 'English ↔ Arabic');
  assert.equal(still.turns.length, 1);
});

test('an id that is not a number finds nothing rather than breaking', async () => {
  await reset();
  fake();
  const user = await makeUser('Sara');
  assert.equal(await getTranslation(user, 'abc'), null);
  assert.equal(await renameTranslation(user, '1; DROP', 'x'), null);
  assert.equal(await deleteTranslation(user, undefined), false);
  assert.equal(await retryTurn(user, 'abc', 'def'), null);
  await assert.rejects(() => addTurn(user, { id: 'abc', side: 'a', buffer: audio }), (e) => e.status === 404);
});

// Found against the real speech service: it refuses the code of some languages outright
// ("Language code 'pa' is not recognized"), which would fail every turn in that language.
test('a language the speech service has no code for is named in words instead', () => {
  assert.deepEqual(hearing('ar'), { language: 'ar' });
  for (const code of ['pa', 'si', 'ps', 'am']) {
    const name = LANGUAGES.find((l) => l.code === code).name;
    const how = hearing(code);
    assert.equal(how.language, undefined, code);
    assert.match(how.prompt, new RegExp(name), code);
  }
});
