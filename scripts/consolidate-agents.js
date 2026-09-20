// One-off: point everyone at the master's agents and remove the duplicate copies.
//
// Before agents became master-owned, every account was seeded with its own copy of
// DEFAULT_AGENTS, and the Plan 2 migration assigned each user to their own copies so
// nobody's sidebar emptied. That works, but it means nothing the master shares reaches
// anyone: a shared shelf is one of the MASTER's agents, and nobody is assigned those.
//
// This assigns every other user to the master's agents instead, then deletes the
// duplicates - but only ones with nothing left attached. An agent that still holds
// somebody's documents, chunks or assignments is reported and left alone, because
// deleting it would detach their files, which is not this script's call to make.
//
//   node scripts/consolidate-agents.js [--apply]
import { db, closeDb } from '../server/db.js';
import { setAssignments } from '../server/admin.js';

const apply = process.argv.includes('--apply');
const say = (...a) => console.log(...a);

const master = await db.prepare("SELECT * FROM users WHERE role = 'master'").get();
if (!master) {
  console.error('No master account. Run: npm run make-master -- <email>');
  await closeDb();
  process.exit(1);
}

const mine = await db.prepare('SELECT id, name FROM agents WHERE user_id = ? ORDER BY id').all(master.id);
if (!mine.length) {
  console.error(`${master.email} owns no agents, so there is nothing to hand out.`);
  await closeDb();
  process.exit(1);
}

say(`Master: ${master.email}`);
say(`Their agents: ${mine.map((a) => a.name).join(', ')}\n`);

const others = await db.prepare("SELECT id, email FROM users WHERE role <> 'master' ORDER BY id").all();

for (const u of others) {
  const current = await db.prepare(`SELECT a.id, a.name, a.user_id = ? AS is_masters
    FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id
    WHERE aa.user_id = ? ORDER BY a.id`).all(master.id, u.id);
  const stale = current.filter((a) => !a.is_masters);

  say(`${u.email}`);
  say(`  has ${current.length} assignment(s), ${stale.length} of them to their own copies`);
  say(`  will be assigned: ${mine.map((a) => a.name).join(', ')}`);

  if (apply) {
    // The first of the master's agents becomes their primary: it is the general
    // assistant, and it is what a new chat should open with.
    await setAssignments(master, u.id, mine.map((a, i) => ({ agentId: a.id, mode: 'chat', primary: i === 0 })));
    say('  reassigned');
  }
}

// Now the duplicates: agents owned by somebody other than the master.
// Only what the reassignment above will NOT clear is counted, so the dry run promises
// exactly what --apply does. Reassigning a user deletes their old assignments and
// detaches their own documents and chunks from the shelves they are losing, so
// anything belonging to a non-master is already accounted for by the time we get here.
// What remains is the master's own, which nothing above touches.
const dupes = await db.prepare(`SELECT a.id, a.name, u.email owner,
    (SELECT COUNT(*)::int FROM agent_assignments aa JOIN users au ON au.id = aa.user_id
      WHERE aa.agent_id = a.id AND au.role = 'master') assignments,
    (SELECT COUNT(*)::int FROM documents d WHERE d.agent_id = a.id AND d.user_id = ?) documents,
    (SELECT COUNT(*)::int FROM chunks c WHERE c.agent_id = a.id AND c.user_id = ?) chunks
  FROM agents a JOIN users u ON u.id = a.user_id
  WHERE a.user_id <> ? ORDER BY a.user_id, a.id`).all(master.id, master.id, master.id);

const free = dupes.filter((d) => !d.assignments && !d.documents && !d.chunks);
const busy = dupes.filter((d) => d.assignments || d.documents || d.chunks);

say(`\n${dupes.length} duplicate agent(s) not owned by the master.`);
if (busy.length) {
  say(`  ${busy.length} still in use, left alone:`);
  for (const d of busy) say(`    ${d.owner} · ${d.name} — ${d.assignments} assignment(s), ${d.documents} document(s), ${d.chunks} chunk(s)`);
}
if (free.length) {
  say(`  ${free.length} with nothing attached${apply ? ', deleting' : ', would be deleted'}.`);
  if (apply) {
    for (const d of free) await db.prepare('DELETE FROM agents WHERE id = ?').run(d.id);
    say('  deleted');
  }
}

if (!apply) say('\nDry run. Re-run with --apply to make these changes.');
await closeDb();
