import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, makeUser, db, closeDb } from './helpers/db.js';
import { createType, updateType, planAgent, listTypes, watchFiles } from '../server/reportChecks.js';
import { runWatcher, watchWatchers, slotOf, listRuns, kitsFor, runSafely, costThisMonth } from '../server/agentRuns.js';

test.after(() => closeDb());

const at = (iso) => Date.parse(`${iso}+04:00`);

async function master() {
  const id = await makeUser('Boss');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
const watcher = (extra = {}) => createType({ kind: 'watch', name: 'Unanswered emails', brief: 'Tell me which emails have no reply after 24 hours',
  sources: ['email', 'nonsense'], cadence: 'daily', run_hour: 9, ...extra });

// A model that asks for one tool, then answers with what the tool said.
function fakeClient(final) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        if (calls.length === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'search_email', input: { query: 'tenant' } }] };
        return { content: [{ type: 'text', text: typeof final === 'string' ? final : JSON.stringify(final) }] };
      },
    },
  };
}
const fakeKit = (seen) => ({
  definitions: [{ name: 'search_email', description: 'x', input_schema: { type: 'object', properties: {} } }],
  run: async (b) => { seen.push(b.input); return { type: 'tool_result', tool_use_id: b.id, content: 'From: tenant 305 · Subject: AC leak · not replied' }; },
});

test('a watcher needs a sentence and a place to look; it keeps only real sources', async () => {
  await reset();
  const w = await watcher();
  assert.equal(w.kind, 'watch');
  assert.deepEqual(w.sources, ['email']);
  assert.equal(w.about, w.brief);
  assert.deepEqual(w.items, [], 'no checklist needed');
  await assert.rejects(watcher({ brief: 'hi' }), /in a sentence/);
  await assert.rejects(watcher({ sources: [] }), /one place/);
  await assert.rejects(watcher({ run_hour: 24 }), /0 to 23/);
  const u = await updateType(w.id, { cadence: 'weekly', run_weekday: 0 });
  assert.equal(u.cadence, 'weekly');
});

test('a run looks things up, keeps what it found, and buzzes the master', async () => {
  await reset();
  const boss = await master();
  const w = await watcher();
  const seen = [];
  const client = fakeClient({ headline: 'Tenant 305 AC leak: no reply for 2 days', findings: [{ title: 'AC leak, unit 305', detail: 'Sent Monday, no reply.', level: 'high' }], nothing_new: false });
  const sent = [];
  const r = await runWatcher(w, { client, kits: [fakeKit(seen)], pusher: async (to, m) => sent.push({ to, ...m }), now: at('2026-11-20T09:05:00'), user: boss });
  assert.deepEqual(seen, [{ query: 'tenant' }], 'the tool was used');
  assert.match(client.calls[0].messages[0].content, /Your job: Tell me which emails have no reply after 24 hours/);
  assert.match(client.calls[0].messages[0].content, /Today is Friday 2026-11-20/);
  assert.match(client.calls[0].messages[0].content, /This is your first run/);
  assert.equal(client.calls[1].messages[2].content[0].content, 'From: tenant 305 · Subject: AC leak · not replied');
  assert.equal(r.findings[0].level, 'high');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [boss.id]);
  assert.equal(sent[0].body, 'Tenant 305 AC leak: no reply for 2 days');

  // The next run is told what was found last time; nothing new is no buzz.
  const client2 = fakeClient({ headline: 'Nothing new', findings: [], nothing_new: true });
  await runWatcher(w, { client: client2, kits: [fakeKit([])], pusher: async (to, m) => sent.push(m), now: at('2026-11-21T09:05:00'), user: boss });
  assert.match(client2.calls[0].messages[0].content, /Last time \(2026-11-20\) you found: .*AC leak/);
  assert.equal(sent.length, 1);
  await db.prepare("INSERT INTO ai_costs (job, note, provider, model, usd, at) VALUES ('report_checks', ?, 'anthropic', 'm', 0.123, ?)").run(`agent ${w.id}`, Math.floor(at('2026-11-21T09:05:00') / 1000));
  assert.equal(await costThisMonth(w.id, at('2026-11-25T10:00:00')), 0.12, 'what its runs cost this month');
  assert.equal(await costThisMonth(w.id, at('2026-12-02T10:00:00')), 0, 'a new month starts at nothing');
  const runs = await listRuns(w.id);
  assert.deepEqual(runs.map((x) => x.nothing_new), [true, false]);
  assert.equal(runs[1].tools_used, 1);
});

test('the tools stay the same every round, and the last round is told to answer', async () => {
  await reset();
  const boss = await master();
  const w = await watcher();
  const calls = [];
  // A model that never stops looking.
  const client = { messages: { create: async (req) => {
    calls.push(JSON.parse(JSON.stringify(req)));
    return calls.length < 6 ? { content: [{ type: 'tool_use', id: `t${calls.length}`, name: 'search_email', input: {} }] }
      : { content: [{ type: 'text', text: '{"headline":"Done","findings":[],"nothing_new":true}' }] };
  } } };
  const r = await runWatcher(w, { client, kits: [fakeKit([])], pusher: async () => {}, user: boss });
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => c.tools?.length === 1), 'the same tools in every round');
  assert.match(JSON.stringify(calls[5].messages.at(-1).content.at(-1)), /last step: use no more tools/);
  assert.deepEqual(calls[5].messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' }, 'what was read is cached for the next round');
  assert.equal(r.headline, 'Done');
});

test('an answer that is not JSON is still kept, and a failure is kept on the page', async () => {
  await reset();
  const boss = await master();
  const w = await watcher();
  const r = await runWatcher(w, { client: fakeClient('Two emails need you.'), kits: [fakeKit([])], pusher: async () => {}, user: boss });
  assert.equal(r.headline, 'Two emails need you.');
  const broken = { messages: { create: async () => { throw new Error('no key'); } } };
  assert.equal(await runSafely(w, { client: broken, kits: [], user: boss }), null);
  assert.equal((await listRuns(w.id))[0].error, 'no key');
});

test('what is not connected is said, not faked', async () => {
  await reset();
  const boss = await master();
  const { kits, missing } = await kitsFor(['email'], boss);
  assert.equal(kits.length, 0);
  assert.deepEqual(missing, ['email'], 'no mailbox connected in the test database');
});

test('it runs once per day, week or month, from its hour', async () => {
  const d = { cadence: 'daily', run_hour: 9, run_weekday: 0 };
  assert.equal(slotOf(d, at('2026-11-20T08:59:00')), null);
  assert.equal(slotOf(d, at('2026-11-20T09:00:00')), '2026-11-20');
  const w = { cadence: 'weekly', run_hour: 9, run_weekday: 0 };
  assert.equal(slotOf(w, at('2026-11-20T10:00:00')), null, 'a Friday');
  assert.equal(slotOf(w, at('2026-11-22T10:00:00')), '2026-11-22', 'the Sunday');
  const m = { cadence: 'monthly', run_hour: 8, run_weekday: 0 };
  assert.equal(slotOf(m, at('2026-12-01T08:00:00')), '2026-12');
  assert.equal(slotOf(m, at('2026-12-02T08:00:00')), null);

  await reset();
  await master();
  const a = await watcher();
  await createType({ kind: 'watch', name: 'Paused', brief: 'Something to watch', sources: ['leases'], active: false });
  const ran = [];
  const run = async (agent) => { ran.push(agent.id); return {}; };
  await watchWatchers({ now: at('2026-11-20T09:10:00'), run });
  await watchWatchers({ now: at('2026-11-20T15:00:00'), run });
  assert.deepEqual(ran, [a.id], 'once a day, and a paused one never');
});

test('watchers are left out of the file sorting', async () => {
  await reset();
  await master();
  await watcher();
  let asked = 0;
  const done = await watchFiles({ asker: async () => { asked++; return '{"matches":[]}'; }, pusher: async () => {} });
  assert.deepEqual(done, []);
  assert.equal(asked, 0, 'no report agents, so nothing to sort for');
  assert.equal((await listTypes()).length, 1);
});

test('one sentence can make a watcher', async () => {
  const p = await planAgent('Every Sunday list leases ending in 60 days with no renewal', async () => JSON.stringify({
    kind: 'watch', name: 'Leases with no renewal', summary: 'It will list them.', sources: ['leases', 'web'], cadence: 'weekly', run_hour: '9', run_weekday: 0, limits: '',
  }));
  assert.deepEqual([p.kind, p.sources, p.cadence, p.run_hour, p.run_weekday], ['watch', ['leases'], 'weekly', 9, 0]);
  await reset();
  const t = await createType(p);
  assert.equal(t.kind, 'watch');
  assert.equal(t.brief, 'Every Sunday list leases ending in 60 days with no renewal');
});
