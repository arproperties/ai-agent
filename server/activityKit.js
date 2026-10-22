import { listActivity, collected } from './activity.js';

// Riley reading the activity log: who did what and when, what changed, who deleted
// something, how much someone collected. Given only to the master and to holders of the
// Activity module (server/chat.js), as the screen is. She reads it; nobody changes it.

export const ACTIVITY_TOOLS = [
  {
    name: 'activity_search',
    description: 'The activity log of the whole app: every record anyone added, changed or deleted, by whom, when, from the screens or the chat, '
      + 'with each changed field old → new. Use it for any question like "who changed the payment on GSL 101", "who deleted a payment", '
      + '"what did Maria do today", "what changed on Tom\'s lease". '
      + 'mode "collected" answers "how much did Jeff collect": the payments that person recorded with the money received in the range, '
      + 'plus any of them since changed or deleted. Dates are YYYY-MM-DD. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['entries', 'collected'], description: 'entries (default) lists changes; collected totals a person\'s payments.' },
        person: { type: 'string', description: 'Who made the change (or, for collected, who recorded the payments). Part of the name is enough.' },
        kind: { type: 'string', description: 'What kind of record: payment, charge, lease, tenant, unit, building, work order, to-do, person, chat message…' },
        action: { type: 'string', enum: ['added', 'changed', 'deleted'] },
        text: { type: 'string', description: 'Words found in the record, like a tenant\'s name or a unit number.' },
        from: { type: 'string', description: 'First day, YYYY-MM-DD. For collected, default the 1st of this month.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD. Default today.' },
        include_system: { type: 'boolean', description: 'Also what the app did by itself (email sync, reminders). Default false.' },
      },
    },
  },
];

const VERB = { insert: 'added', update: 'changed', delete: 'deleted' };
const line = (e) => {
  const what = e.changes.map((c) => (e.action === 'update' ? `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}` : `${c.field}: ${e.action === 'delete' ? c.from : c.to}`)).join('; ');
  return `${e.when} · ${e.who}${e.via === 'chat' ? ' (via chat)' : ''} · ${VERB[e.action]} ${e.kind}${e.about ? ` (${e.about})` : ''}${what ? ` — ${what}` : ''}`;
};

async function search(input) {
  if (input.mode === 'collected') {
    if (!input.person) throw new Error('Say whose collections to total.');
    const c = await collected(input);
    const later = c.changed_or_deleted.map(line);
    return [`${c.person} recorded ${c.count} payment${c.count === 1 ? '' : 's'} received ${c.from} to ${c.to}: ${c.total_text} in all (currency ${c.currency}).`,
      ...c.payments.map((p) => `- ${p.received_on}: ${p.amount} by ${p.method}`),
      later.length ? `Since changed or deleted (not in the total if deleted):\n${later.map((l) => `- ${l}`).join('\n')}` : 'None of their payments has been changed or deleted.'].join('\n');
  }
  const entries = await listActivity({ ...input, system: !!input.include_system, limit: 100 });
  if (!entries.length) return 'Nothing in the activity log matches.';
  return `${entries.length === 100 ? 'The latest 100 matches' : `${entries.length} match${entries.length === 1 ? '' : 'es'}`}, newest first:\n${entries.map(line).join('\n')}`;
}

export function activityKit() {
  return {
    definitions: ACTIVITY_TOOLS,
    status: () => 'Looking through the activity log…',
    run: async (block) => {
      try {
        return { type: 'tool_result', tool_use_id: block.id, content: await search(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
