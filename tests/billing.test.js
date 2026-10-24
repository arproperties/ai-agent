import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { reset, makeUser, closeDb, db } from './helpers/db.js';
import { claudeCost, watch, billAs, billNote, recordOpenAI, jobOfPath, billingRoutes } from '../server/billing.js';

test.after(() => closeDb());

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const settle = () => new Promise((r) => setTimeout(r, 50)); // rows are written as the answer comes back

// A stand-in for the Anthropic client: create answers at once, stream finishes or is stopped.
function fakeClient(answer) {
  const side = () => ({
    create: async () => answer,
    stream: () => {
      const s = new EventEmitter();
      s.currentMessage = { ...answer, usage: { ...answer.usage, output_tokens: 10 } };
      s.finish = () => s.emit('finalMessage', answer);
      s.stop = () => s.emit('abort', new Error('aborted'));
      return s;
    },
  });
  return { messages: side(), beta: { messages: side() } };
}

test('prices: input, output, cache reads and writes, and Haiku 5.5 over 100k', () => {
  near(claudeCost('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12);
  near(claudeCost('claude-haiku-4-5-20251001', { input_tokens: 1e6 }), 1); // a dated id finds its row
  near(claudeCost('claude-sonnet-5-5', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0.2 + 2.5);
  near(claudeCost('claude-sonnet-5-5', { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } }), 4);
  near(claudeCost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1e6 }), 0.005 + 0.5);
  near(claudeCost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1e6 }), 0.1 + 2.5);
  assert.equal(claudeCost('some-new-model', { input_tokens: 1e6 }), 0);
});

test('each call is billed to the person and job it was made for, with its note', async () => {
  await reset();
  const rona = await makeUser('Rona');
  const client = watch(fakeClient({ model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } } }));
  await billAs({ userId: rona, job: 'chat' }, async () => {
    billNote('What is the rent  for\n unit 101?');
    await client.messages.create({});
  });
  await client.messages.create({}); // nobody: background
  await settle();
  const rows = await db.prepare('SELECT * FROM ai_costs ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].user_id, rona);
  assert.equal(rows[0].job, 'chat');
  assert.equal(rows[0].note, 'What is the rent for unit 101?');
  assert.equal(rows[0].searches, 2);
  near(rows[0].usd, (1000 * 2 + 500 * 10) / 1e6 + 0.02);
  assert.equal(rows[1].user_id, null);
  assert.equal(rows[1].job, 'other');
});

test('Auto: the advisor is billed as its own model; a stopped stream still costs what came', async () => {
  await reset();
  const answer = {
    model: 'claude-haiku-5-5',
    usage: {
      input_tokens: 3000, output_tokens: 400,
      iterations: [
        { type: 'message', input_tokens: 2000, output_tokens: 300 },
        { type: 'advisor_message', model: 'claude-sonnet-5-5', input_tokens: 5000, output_tokens: 800 },
        { type: 'message', input_tokens: 1000, output_tokens: 100 },
      ],
    },
  };
  const client = watch(fakeClient(answer));
  const s = client.beta.messages.stream({});
  s.finish();
  const cut = client.messages.stream({});
  cut.stop();
  cut.finish(); // never counted twice
  await settle();
  const rows = await db.prepare('SELECT model, input_tokens, output_tokens, usd FROM ai_costs ORDER BY id').all();
  // the finished answer: Haiku's two parts together, Sonnet's advice on its own
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.model, r.input_tokens, r.output_tokens]), [['claude-haiku-5-5', 3000, 400], ['claude-sonnet-5-5', 5000, 800]]);
  near(rows[1].usd, (5000 * 2 + 800 * 10) / 1e6);
  assert.equal(rows.length, 4); // the stopped one is counted once, not again when it ends
});

test('voice and pictures, and the address a request came in on', async () => {
  await reset();
  await billAs({ job: 'voice' }, () => recordOpenAI('gpt-4o-mini-transcribe', { minutes: 2 }));
  recordOpenAI('gpt-image', { pictures: 1 });
  await settle();
  const rows = await db.prepare('SELECT job, usd FROM ai_costs ORDER BY id').all();
  near(rows[0].usd, 0.006);
  near(rows[1].usd, 0.063);
  assert.equal(jobOfPath('/chat'), 'chat');
  assert.equal(jobOfPath('/documents/12/file'), 'files');
  assert.equal(jobOfPath('/lease-renewals/4/send'), 'renewals');
  assert.equal(jobOfPath('/something-new'), 'other');
});

test('the screen adds up by person, job, model and day', async () => {
  await reset();
  const said = await makeUser('Said');
  const ins = 'INSERT INTO ai_costs (user_id, job, provider, model, input_tokens, output_tokens, usd) VALUES (?, ?, ?, ?, ?, ?, ?)';
  await db.prepare(ins).run(said, 'chat', 'anthropic', 'claude-haiku-5-5', 100, 10, 0.5);
  await db.prepare(ins).run(said, 'files', 'anthropic', 'claude-sonnet-5', 100, 10, 1.5);
  await db.prepare(ins).run(null, 'renewals', 'anthropic', 'claude-sonnet-5', 100, 10, 1);
  await db.prepare('INSERT INTO ai_costs (job, provider, model, usd, at) VALUES (?, ?, ?, ?, ?)')
    .run('chat', 'anthropic', 'claude-haiku-5-5', 9, Math.floor(Date.now() / 1000) - 40 * 86400); // too old for 7 days
  const get = (path, query) => new Promise((resolve, reject) => {
    const layer = billingRoutes.stack.find((l) => l.route?.path === path);
    layer.route.stack[0].handle({ query }, { json: resolve }, reject);
  });
  const d = await get('/', { range: 'week' });
  near(d.totals.week, 3);
  near(d.totals.today, 3);
  assert.deepEqual(d.people.map((p) => [p.id, p.usd]), [[said, 2], [null, 1]]);
  assert.deepEqual(d.jobs.map((j) => j.name), ['Reading files', 'Lease renewals', 'Chat']);
  assert.equal(d.models[0].name, 'Sonnet 5');
  near(d.models[0].usd, 2.5);
  assert.equal(d.days.length, 1);
  const calls = await get('/calls', { range: 'week', user: String(said) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].jobName, 'Reading files');
  const none = await get('/calls', { range: 'week', user: 'none' });
  assert.deepEqual(none.map((c) => c.job), ['renewals']);
});
