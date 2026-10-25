import { isExternal } from './access.js';
import { propose, findFolder, refresh } from './caseFolders.js';

// The case folder tools in the chat, same shape as inventoryKit(). Only for someone from
// outside the company. pull_case only puts a card in front of them: nothing is kept until
// Save is tapped on it (caseFolders.js, decide).

const PULL = {
  name: 'pull_case',
  description: 'Use when the user asks to pull, collect or organise emails about a case from their inbox; the case number is optional. ' +
    'With a case number it finds every email about that case; without one it looks at the last 30 days and gets up to 5 cases ready. ' +
    'This only shows a card for each case: nothing is saved until the user taps Save on it, so never say it was saved. ' +
    'A case that already has a folder is brought up to date instead of getting a card.',
  input_schema: {
    type: 'object',
    properties: {
      case_number: { type: 'string', description: 'The case number as the user gave it, e.g. "Soutex E - 205791" or "205791". Leave out when none was given.' },
    },
  },
};

const UPDATE = {
  name: 'update_case',
  description: 'Refreshes an existing case folder now: adds the case\'s new emails and rewrites its case PDF. ' +
    'Use when the user asks to update, refresh or check a case they already have a folder for.',
  input_schema: {
    type: 'object',
    properties: { case_number: { type: 'string', description: 'The case number as the user gave it.' } },
    required: ['case_number'],
  },
};

const day = (at) => (at ? new Date(at * 1000).toISOString().slice(0, 10) : '?');
const emails = (n) => `${n} ${n === 1 ? 'email' : 'emails'}`;
const newOnes = (n) => (n ? `${n} new ${n === 1 ? 'email' : 'emails'} added` : 'no new emails');

async function pull(user, input, ctx, deps) {
  const lines = [];
  let cards = 0;
  for (const item of await propose(user, input, ctx, deps)) {
    if (item.refreshed) {
      const f = item.refreshed;
      lines.push(`Case ${f.case_number} already has a folder on the Shelf, "${f.name}": ` +
        (f.tracking ? `brought up to date now, ${newOnes(f.added)}.` : 'updating is stopped for it, so nothing was added.'));
      continue;
    }
    cards++;
    ctx.onCard?.(item);
    lines.push(`Ready as card #${item.id}: "${item.name}", ${emails(item.count)} from ${day(item.from)} to ${day(item.to)}.`);
  }
  if (cards) lines.push('NOT saved yet - tell the user in one short line to check the card and tap Save. Never say it is saved.');
  return lines.join('\n');
}

async function update(user, input, deps) {
  const number = String(input.case_number ?? '').trim();
  const folder = await findFolder(user, number);
  if (!folder) return `No case folder for ${number || 'that case'} yet. pull_case gets one ready to save.`;
  if (!folder.tracking) return `Updating is stopped for "${folder.name}", so nothing was added. It can be turned back on on the Shelf.`;
  const { added } = await refresh(user, folder.id, deps);
  return added ? `"${folder.name}" is up to date: ${newOnes(added)}, and the case PDF rewritten.` : `No new emails for "${folder.name}".`;
}

/** ctx: { conversationId, onCard } - onCard puts the Save/Cancel card in front of them. deps: { mailbox, ask } for tests. */
export async function caseKit(user, ctx = {}, deps = {}) {
  const open = isExternal(user);
  const handlers = open ? {
    pull_case: (input) => pull(user, input, ctx, deps),
    update_case: (input) => update(user, input, deps),
  } : {};
  return {
    definitions: open ? [PULL, UPDATE] : [],
    status: (name) => (name === PULL.name ? 'Looking through your inbox for the case…' : 'Checking the case for new emails…'),
    run: async (block) => {
      try {
        const fn = handlers[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
