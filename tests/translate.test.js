import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, closeDb, db } from './helpers/db.js';

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
