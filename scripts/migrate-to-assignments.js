// One-off: give every existing user an assignment for the agents they already own, so
// nobody's sidebar empties when access moves from ownership to assignment.
//
// Agent ownership is deliberately NOT consolidated onto the master here. Each user's
// agents carry their own documents and chunks, and agents.id cascades to both - merging
// duplicate default agents would destroy files. That is a manual follow-up.
//
//   node scripts/migrate-to-assignments.js [--apply]
import { db, closeDb } from '../server/db.js';

const apply = process.argv.includes('--apply');

const pending = await db.prepare(`SELECT a.id agent_id, a.user_id, a.name, u.email
  FROM agents a JOIN users u ON u.id = a.user_id
  WHERE NOT EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.agent_id = a.id AND aa.user_id = a.user_id)
  ORDER BY a.user_id, a.id`).all();

if (!pending.length) {
  console.log('Nothing to do - every agent already has an assignment for its owner.');
} else {
  console.log(`${pending.length} agent(s) need an assignment:`);
  for (const p of pending) console.log(`  ${p.email.padEnd(32)} ${p.name}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these rows.');
  } else {
    const ins = db.prepare("INSERT INTO agent_assignments (agent_id, user_id, mode) VALUES (?, ?, 'chat') ON CONFLICT DO NOTHING");
    for (const p of pending) await ins.run(p.agent_id, p.user_id);
    console.log(`\nWrote ${pending.length} assignment(s).`);
  }
}

const masters = await db.prepare("SELECT email FROM users WHERE role = 'master'").all();
console.log(masters.length
  ? `\nMaster: ${masters.map((m) => m.email).join(', ')}`
  : '\nNo master yet. Run: npm run make-master -- <email>');

await closeDb();
