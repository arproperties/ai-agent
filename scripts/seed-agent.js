// Add one of the DEFAULT_AGENTS to the live team.
//
// Agents are master-owned and reach people through agent_assignments, so seeding one
// is two steps: create it under the master, then give every account a row for it.
// Both steps are idempotent - an agent the master already owns by that name is reused,
// and an assignment that already exists is left as it is. Nothing else is touched:
// unlike setAssignments this never rewrites a user's existing rows, so no one's filed
// documents can be detached by running it.
//
//   node scripts/seed-agent.js "Operations Manager" [--apply]
import { db, closeDb } from '../server/db.js';
import { DEFAULT_AGENTS } from '../server/defaultAgents.js';
import { agentIn } from '../server/agents.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wanted = args.filter((a) => !a.startsWith('--')).join(' ').trim();
const say = (...a) => console.log(...a);
const done = async (code = 0) => { await closeDb(); process.exit(code); };

const spec = DEFAULT_AGENTS.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
if (!spec) {
  console.error(`Unknown agent: ${wanted || '(none given)'}`);
  console.error(`Known: ${DEFAULT_AGENTS.map((a) => a.name).join(', ')}`);
  await done(1);
}

const master = await db.prepare("SELECT * FROM users WHERE role = 'master'").get();
if (!master) {
  console.error('No master account. Run: npm run make-master -- <email>');
  await done(1);
}
say(`Master: ${master.email}`);

let agent = await db.prepare('SELECT * FROM agents WHERE user_id = ? AND lower(name) = lower(?)').get(master.id, spec.name);
if (agent) {
  say(`${spec.name} already exists (agent ${agent.id}) - reusing it.`);
} else if (apply) {
  const a = agentIn(spec);
  agent = await db.prepare(`INSERT INTO agents (user_id, name, icon, color, persona, model, voice, starters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(master.id, a.name, a.icon, a.color, a.persona, a.model, a.voice, a.starters);
  say(`Created ${spec.name} as agent ${agent.id}.`);
} else {
  say(`Would create ${spec.name} (icon ${spec.icon}, colour ${spec.color}).`);
}

const users = await db.prepare('SELECT id, email FROM users ORDER BY id').all();
const already = agent
  ? new Set((await db.prepare('SELECT user_id FROM agent_assignments WHERE agent_id = ?').all(agent.id)).map((r) => r.user_id))
  : new Set();
const missing = users.filter((u) => !already.has(u.id));

say(`\n${users.length} account(s), ${missing.length} without ${spec.name}:`);
for (const u of missing) say(`  ${u.email}`);

if (apply && agent) {
  for (const u of missing) {
    await db.prepare(`INSERT INTO agent_assignments (agent_id, user_id, mode, is_primary)
      VALUES (?, ?, 'chat', false) ON CONFLICT (agent_id, user_id) DO NOTHING`).run(agent.id, u.id);
  }
  say(`\nAssigned to ${missing.length} account(s).`);
} else if (!apply) {
  say('\nDry run. Re-run with --apply to make these changes.');
}

await done();
