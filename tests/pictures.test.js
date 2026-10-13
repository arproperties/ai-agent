import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';

const { MODULES, userModules, setModuleAccess } = await import('../server/modules.js');
const { TAGS, pictureTag, tidyPlan, imagePrompt, makePicture, pictureFor } = await import('../server/pictures.js');
const { pictureTurn } = await import('../server/chat.js');

test.after(() => closeDb());

async function people() {
  await reset();
  const boss = { id: await makeUser('Boss'), role: 'master' };
  await db.prepare(`UPDATE users SET role = 'master' WHERE id = ?`).run(boss.id);
  const sam = { id: await makeUser('Sam'), role: 'user' };
  const other = { id: await makeUser('Other'), role: 'user' };
  return { boss, sam, other };
}
const chatOf = async (userId) => (await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id').run(userId, 'Chat')).id;

const AC = {
  title: 'How an AC Works',
  summary: 'An air conditioner moves heat from the room to the outside.',
  parts: [{ heading: 'Warm air enters', text: 'Room air is drawn into the indoor unit.' }, { heading: 'Heat is absorbed', text: 'The refrigerant takes the heat.' }],
  explanation: 'An AC does not make cold. It carries heat outside.',
};
/** Stand-ins for the two AI calls: what the picture says, and the drawing of it. */
const ai = (sketch = AC, bytes = Buffer.from('not really a picture')) => {
  const seen = { plans: [], prompts: [] };
  return {
    seen,
    plan: async (q) => { seen.plans.push(q); if (sketch instanceof Error) throw sketch; return sketch; },
    draw: async (p) => { seen.prompts.push(p); if (bytes instanceof Error) throw bytes; return bytes; },
  };
};
const sweep = async () => { for (const p of await db.prepare('SELECT path FROM pictures').all()) rmSync(p.path, { force: true }); };

// ---------- the tag ----------

test('a message that opens with a tag is a picture; anything else is an ordinary message', () => {
  assert.deepEqual(pictureTag('/explain how ac works'), { tag: 'explain', topic: 'how ac works' });
  assert.deepEqual(pictureTag('  /Breakdown: service charges for a 2-bed flat '), { tag: 'breakdown', topic: 'service charges for a 2-bed flat' });
  assert.deepEqual(pictureTag('/explore\ntypes of AC systems'), { tag: 'explore', topic: 'types of AC systems' });
  assert.deepEqual(pictureTag('/explain'), { tag: 'explain', topic: '' }, 'a tag with nothing after it is still the tag');
  assert.deepEqual(Object.keys(TAGS), ['explain', 'breakdown', 'explore']);

  for (const plain of ['explain how ac works', 'please /explain this', '/explainer video', '/explain/this', '/expain how ac works', '/summary of the lease', '', null]) {
    assert.equal(pictureTag(plain), null, String(plain));
  }
});

// ---------- what the picture says ----------

test('a plan is only drawn when it has a title and parts, and nothing in it runs long', () => {
  assert.equal(tidyPlan(null), null);
  assert.equal(tidyPlan({ title: '', parts: AC.parts }), null);
  assert.equal(tidyPlan({ title: 'Lonely', parts: [AC.parts[0]] }), null, 'one part is not a picture');
  assert.equal(tidyPlan({ title: 'No headings', parts: [{ text: 'a' }, { text: 'b' }] }), null);

  const p = tidyPlan({ ...AC, title: `  How an\nAC   Works `, parts: [...Array(12)].map((_, i) => ({ heading: `Part ${i}`, text: 'x'.repeat(500) })) });
  assert.equal(p.title, 'How an AC Works');
  assert.equal(p.parts.length, 8);
  assert.equal(p.parts[0].text.length, 160);
});

test('the image model is given the plan word for word, laid out the way the tag asks', () => {
  const plan = tidyPlan(AC);
  const explain = imagePrompt('explain', plan);
  assert.match(explain, /the title "How an AC Works"/);
  assert.match(explain, /"An air conditioner moves heat from the room to the outside\."/);
  assert.match(explain, /1\. Warm air enters: Room air is drawn into the indoor unit\.\n2\. Heat is absorbed: The refrigerant takes the heat\./);
  assert.match(explain, /numbered step boxes/);
  assert.match(imagePrompt('breakdown', plan), /tidy grid of equal boxes/);
  assert.match(imagePrompt('explore', plan), /topic map/);
});

// ---------- drawing ----------

test('a picture is planned, drawn, kept on disk and hung on the reply', async () => {
  const { sam } = await people();
  const convId = await chatOf(sam.id);
  const { seen, plan, draw } = ai();
  const reply = await makePicture(sam, convId, { tag: 'explain', topic: 'how ac works' }, { plan, draw });

  assert.deepEqual(seen.plans, [{ tag: 'explain', topic: 'how ac works' }]);
  assert.equal(seen.prompts.length, 1);
  assert.equal(reply.content, '**How an AC Works**\n\nAn AC does not make cold. It carries heat outside.');
  assert.deepEqual(reply.files, [{ name: 'How an AC Works.jpg', kind: 'picture', pictureId: 1 }]);

  const row = await db.prepare('SELECT * FROM pictures WHERE id = 1').get();
  assert.equal(row.user_id, sam.id);
  assert.equal(row.conversation_id, convId);
  assert.equal(row.tag, 'explain');
  assert.equal(row.topic, 'how ac works');
  assert.equal(readFileSync(row.path, 'utf8'), 'not really a picture');
  await sweep();
});

test('nothing is drawn from an empty plan, and nothing is kept when the drawing fails', async () => {
  const { sam } = await people();
  const convId = await chatOf(sam.id);
  const empty = ai({ title: 'Only a title', parts: [] });
  await assert.rejects(makePicture(sam, convId, { tag: 'explore', topic: 'x' }, empty), /came back empty/);
  assert.equal(empty.seen.prompts.length, 0, 'the paid call is not made');

  await assert.rejects(makePicture(sam, convId, { tag: 'explore', topic: 'x' }, ai(AC, new Error('content policy'))), /content policy/);
  await assert.rejects(makePicture(sam, convId, { tag: 'explore', topic: 'x' }, ai(AC, Buffer.alloc(0))), /No picture came back/);
  assert.equal((await db.prepare('SELECT count(*)::int n FROM pictures').get()).n, 0);
});

test('a picture opens for the person it was drawn for and for the master, nobody else', async () => {
  const { boss, sam, other } = await people();
  const reply = await makePicture(sam, await chatOf(sam.id), { tag: 'breakdown', topic: 'service charges' }, ai());
  const id = reply.files[0].pictureId;
  assert.equal((await pictureFor(sam, id)).id, id);
  assert.equal((await pictureFor(boss, id)).id, id);
  assert.equal(await pictureFor(other, id), null);
  assert.equal(await pictureFor(sam, 'abc'), null);

  // The chat going does not take the picture's row with it mid-view; the person going does.
  await db.prepare('DELETE FROM conversations WHERE user_id = ?').run(sam.id);
  assert.equal((await pictureFor(sam, id)).conversation_id, null);
  const { path } = await pictureFor(sam, id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(sam.id);
  assert.equal(await pictureFor(boss, id), null);
  assert.ok(existsSync(path));
  rmSync(path, { force: true });
});

// ---------- the module ----------

test('Pictures is a module the master ticks; nobody starts with it', async () => {
  const { boss, sam } = await people();
  const pictures = MODULES.find((m) => m.key === 'pictures');
  assert.equal(pictures.label, 'Pictures');
  assert.ok(!pictures.everyone, 'each picture is paid for, so it is never handed out to everyone');
  assert.ok((await userModules(boss)).includes('pictures'));
  assert.ok(!(await userModules(sam)).includes('pictures'));
  await setModuleAccess(sam.id, ['pictures']);
  assert.deepEqual(await userModules(sam), ['pictures']);
});

// ---------- the chat turn ----------

/** A chat stream that writes its events down instead of sending them. */
const stream = () => {
  const events = [];
  const res = { writableEnded: false, end() { res.writableEnded = true; } };
  return { events, res, send: (event, data) => events.push([event, data]) };
};
const messages = (convId) => db.prepare('SELECT role, content, files, agent_id FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);

test('a picture turn saves the question and a reply carrying the picture, and says so to the app', async () => {
  const { sam } = await people();
  const team = [{ id: await makeAgent(sam.id, 'Reem') }, { id: await makeAgent(sam.id, 'Legal') }];
  const convId = await chatOf(sam.id);
  await db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hello')`).run(convId);
  await db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, content) VALUES (?, ?, 'assistant', 'Hi')`).run(convId, team[1].id);

  const { events, res, send } = stream();
  const files = [{ name: 'How an AC Works.jpg', kind: 'picture', pictureId: 7 }];
  const made = [];
  await pictureTurn({ user: sam, team, convId, text: '/explain how ac works', asked: { tag: 'explain', topic: 'how ac works' }, send, res },
    { make: async (...a) => { made.push(a); return { content: '**How an AC Works**', files }; } });

  assert.deepEqual(made, [[sam, convId, { tag: 'explain', topic: 'how ac works' }]]);
  const rows = (await messages(convId)).slice(2);
  assert.deepEqual(rows.map((r) => [r.role, r.content]), [['user', '/explain how ac works'], ['assistant', '**How an AC Works**']]);
  assert.deepEqual(JSON.parse(rows[1].files), files);
  assert.equal(rows[1].agent_id, team[1].id, 'answered by whoever was already talking in this chat');

  assert.deepEqual(events.map(([e]) => e), ['agent', 'status', 'picture', 'delta', 'done']);
  assert.deepEqual(events[2][1], files);
  assert.ok(events.at(-1)[1].messageId && events.at(-1)[1].userMessageId);
  assert.ok(res.writableEnded);
});

test('a tag with nothing after it costs nothing: the reply says how to use it', async () => {
  const { sam } = await people();
  const team = [{ id: await makeAgent(sam.id, 'Reem') }];
  const convId = await chatOf(sam.id);
  const { events, res, send } = stream();
  let drawn = 0;
  await pictureTurn({ user: sam, team, convId, text: '/breakdown', asked: { tag: 'breakdown', topic: '' }, send, res }, { make: async () => { drawn++; } });

  assert.equal(drawn, 0);
  assert.match((await messages(convId))[1].content, /^Say what to draw after the tag, for example: \/breakdown /);
  assert.deepEqual(events.map(([e]) => e), ['agent', 'delta', 'done']);
});

test('a picture that cannot be drawn ends the turn with a plain message, the question kept', async () => {
  const { sam } = await people();
  const team = [{ id: await makeAgent(sam.id, 'Reem') }];
  const convId = await chatOf(sam.id);
  const { events, res, send } = stream();
  await pictureTurn({ user: sam, team, convId, text: '/explore x', asked: { tag: 'explore', topic: 'x' }, send, res },
    { make: async () => { throw new Error('quota'); } });

  assert.deepEqual((await messages(convId)).map((r) => r.role), ['user']);
  const error = events.find(([e]) => e === 'error')[1].message;
  assert.equal(error, 'Reem could not draw that picture. Please try again.');
  assert.equal(events.at(-1)[1].messageId, null);
  assert.ok(res.writableEnded);
});
