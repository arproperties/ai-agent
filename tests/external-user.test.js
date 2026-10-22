import test from 'node:test';
import assert from 'node:assert/strict';
import { db, reset, makeUser, makeAgent, closeDb } from './helpers/db.js';
import { chatAgents, canUseAgent, onlyPrivateAgents, shelfIds, externalFence } from '../server/access.js';
import { setAssignments, setExternal, listAssignments, listUsers, userConversations } from '../server/admin.js';
import { userModules, setModuleAccess, listModuleAccess } from '../server/modules.js';
import { userModules as saifsysModules } from '../server/saifsys/index.js';
import { setOwners } from '../server/fileAccess.js';
import { options as buildingOptions } from '../server/buildings.js';
import { messengerHandlers } from '../server/messenger.js';
import { readableDocuments } from '../server/files.js';

// Someone from outside the company: an empty book. Their own things and private agents
// only, nothing of the company's, nobody on the team - and the master still sees it all.

test.after(() => closeDb());

const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const asRequest = async (u) => ({ ...u, ownFilesOnly: await onlyPrivateAgents(u) }); // what requireUser does

async function fixture() {
  await reset();
  const masterId = await makeUser('Master');
  await db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(masterId);
  const reem = await makeAgent(masterId, 'Reem');
  const lawyer = await makeAgent(masterId, 'Lawyer');
  const caseAgent = await makeAgent(masterId, 'Deck Case Attorney');
  await db.prepare('UPDATE agents SET private = true WHERE id = ?').run(caseAgent);
  const master = await user(masterId);
  const jeff = await user(await makeUser('Jeff'));
  const sara = await user(await makeUser('Sara'));
  // What jeff had on live: Reem and the case agent to chat with, every other agent as a shelf.
  await setAssignments(master, jeff.id, [
    { agentId: reem, mode: 'chat', primary: true },
    { agentId: caseAgent, mode: 'chat' },
    { agentId: lawyer, mode: 'knowledge' },
  ]);
  await setAssignments(master, sara.id, [{ agentId: reem, mode: 'chat', primary: true }, { agentId: lawyer, mode: 'knowledge' }]);
  return { master, jeff, sara, reem, lawyer, caseAgent };
}

const makeExternal = async (master, id) => { await setExternal(master, id, true); return user(id); };

test('made external, only their private agents are left, to chat with and to read', async () => {
  const { master, jeff, reem, lawyer, caseAgent } = await fixture();
  const ext = await makeExternal(master, jeff.id);
  assert.equal(ext.external, true);
  assert.deepEqual((await listAssignments(jeff.id)).map((a) => [a.agent_id, a.mode]), [[caseAgent, 'chat']]);
  assert.deepEqual((await chatAgents(ext)).map((a) => a.name), ['Deck Case Attorney']);
  assert.deepEqual(await shelfIds(ext), [caseAgent]);
  assert.equal(await canUseAgent(ext, reem), false);
  assert.equal(await canUseAgent(ext, lawyer), false);
  assert.equal(await onlyPrivateAgents(ext), true);
});

test('a company agent ticked for them again counts for nothing, and People saves cleanly', async () => {
  const { master, jeff, reem, lawyer, caseAgent } = await fixture();
  const ext = await makeExternal(master, jeff.id);
  // What the People screen sends: the ticked ones, then every other agent as a shelf.
  await setAssignments(master, jeff.id, [
    { agentId: caseAgent, mode: 'chat', primary: true }, { agentId: reem, mode: 'chat' }, { agentId: lawyer, mode: 'knowledge' },
  ]);
  assert.deepEqual((await listAssignments(jeff.id)).map((a) => a.agent_id), [caseAgent]);
  // and a row written behind the screen's back is still ignored
  await db.prepare("INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, 'chat')").run(reem, jeff.id);
  assert.deepEqual((await chatAgents(ext)).map((a) => a.name), ['Deck Case Attorney']);
  assert.equal(await canUseAgent(ext, reem), false);
  assert.equal(await onlyPrivateAgents(ext), true, 'even with an ordinary agent among them');
});

test("their Shelf is their own files only, never what the master shares company-wide", async () => {
  const { master, jeff, sara } = await fixture();
  const doc = (owner, title, shared) => db.prepare(`INSERT INTO documents (user_id, name, title, folder, status, shared)
    VALUES (?, ?, ?, 'Other', 'ready', ?)`).run(owner, `${title}.pdf`, title, shared);
  await doc(master.id, 'Company Lease', true);
  await doc(jeff.id, 'Deck Contract', false);
  await doc(sara.id, 'Staff Visa', false);
  const shelf = async (u) => (await readableDocuments(await asRequest(u))).map((d) => d.title).sort();
  assert.deepEqual(await shelf(jeff), ['Company Lease', 'Deck Contract'], 'before: Reem made him staff');
  const ext = await makeExternal(master, jeff.id);
  assert.deepEqual(await shelf(ext), ['Deck Contract']);
  assert.deepEqual(await shelf(sara), ['Company Lease', 'Staff Visa'], 'staff unchanged');
});

test('company modules and saifsys are gone, and cannot be ticked back', async () => {
  const { master, jeff } = await fixture();
  await setModuleAccess(jeff.id, ['shelf', 'todos', 'renewals', 'notices', 'duties', 'checklists', 'email']);
  await db.prepare("INSERT INTO saifsys_access (user_id, module) VALUES (?, 'ars')").run(jeff.id);
  const ext = await makeExternal(master, jeff.id);
  assert.deepEqual(await userModules(ext), ['shelf', 'todos', 'email']);
  assert.deepEqual(await saifsysModules(ext), []);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM saifsys_access WHERE user_id = ?').get(jeff.id)).n, 0);
  const listed = await listModuleAccess(jeff.id);
  assert.equal(listed.external, true);
  assert.ok(!listed.modules.some((m) => m.key === 'renewals'), 'not even offered');
  await assert.rejects(setModuleAccess(jeff.id, ['shelf', 'renewals']), /company's own work/);
  // a company tick that slipped into the table still gives nothing
  await db.prepare("INSERT INTO module_access (user_id, module) VALUES (?, 'notices')").run(jeff.id);
  assert.ok(!(await userModules(ext)).includes('notices'));
});

test('nobody on the team sees them, and they see nobody', async () => {
  const { master, jeff, sara } = await fixture();
  await db.prepare("INSERT INTO buildings (site_id, name, admin_id) VALUES (1, 'Tower A', ?)").run(jeff.id);
  await db.prepare('INSERT INTO tenant_inbox_members (user_id) VALUES (?)').run(jeff.id);
  await setOwners(master, sara.id, [jeff.id]);
  await makeExternal(master, jeff.id);

  const people = async (u) => {
    let out;
    await messengerHandlers.people({ user: u }, { json: (x) => { out = x; } });
    return out.map((p) => p.name);
  };
  assert.deepEqual(await people(sara), ['Master']);
  assert.deepEqual(await people(master), ['Sara']);
  assert.ok(!(await buildingOptions()).people.some((p) => p.id === jeff.id));
  assert.equal((await db.prepare("SELECT admin_id FROM buildings WHERE name = 'Tower A'").get()).admin_id, null);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM tenant_inbox_members').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM file_access').get()).n, 0, "Sara no longer reads Jeff's files");
  assert.deepEqual(await setOwners(master, sara.id, [jeff.id]), [], 'and cannot be given them again');
  await assert.rejects(setOwners(master, jeff.id, [sara.id]), /external/);
});

test('the fence lets them into their own things only', async () => {
  const { master, jeff, sara } = await fixture();
  const ext = await makeExternal(master, jeff.id);
  const through = (u, path) => {
    let passed = false;
    let status = 200;
    externalFence({ user: u, path }, { status: (s) => { status = s; return { json: () => {} }; } }, () => { passed = true; });
    return passed ? 200 : status;
  };
  for (const p of ['/chat', '/conversations/4/messages', '/documents/9/file', '/todos/due', '/agents', '/email/drafts', '/auth/me']) {
    assert.equal(through(ext, p), 200, p);
  }
  for (const p of ['/messenger/people', '/team-reminders/people', '/buildings', '/shared-inbox/me', '/tenant-care/me',
    '/saifsys/ars/checkouts', '/lease-renewals', '/responsibilities/mine', '/inventory', '/recurring-payments', '/checklists']) {
    assert.equal(through(ext, p), 404, p);
  }
  assert.equal(through(sara, '/messenger/people'), 200, 'staff unchanged');
  assert.equal(through(master, '/buildings'), 200);
});

test('the master still sees everything of theirs, and can make them staff again', async () => {
  const { master, jeff } = await fixture();
  await db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(jeff.id, 'Deck case timeline');
  await makeExternal(master, jeff.id);
  assert.deepEqual((await userConversations(jeff.id)).map((c) => c.title), ['Deck case timeline']);
  assert.equal((await listUsers()).find((u) => u.id === jeff.id).external, true);
  await assert.rejects(setExternal(master, master.id, true), /master cannot be external/);
  await setExternal(master, jeff.id, false);
  assert.equal((await user(jeff.id)).external, false);
});
