import { outlookAccount, outlookTools } from './outlook.js';
import { imapAccount, imapTools } from './imap.js';

// Email tools for the agents. The same two tools work for an IMAP mailbox (Titan, Gmail…) or Outlook.
export const EMAIL_TOOLS = [
  {
    name: 'search_email',
    description: "Search or list emails in the user's mailbox. Returns up to `limit` messages with id, date, sender, subject and a short preview. " +
      'Leave query empty to list the latest emails. Use read_email with an id to read the full message.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, a person, company or email address. Empty = latest emails.' },
        folder: { type: 'string', enum: ['inbox', 'sent', 'all'], description: 'Default: inbox and sent when searching, inbox when listing.' },
        unread_only: { type: 'boolean' },
        since: { type: 'string', description: 'Only emails received on or after this date (YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 10.' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read one email in full (recipients, body text and attachment names) by the id from search_email.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

// the user's connected mailbox (IMAP first, then Outlook), or null when none is connected
export async function connectedMailbox(userId) {
  const acc = (await imapAccount(userId)) || (await outlookAccount(userId));
  if (!acc) return null;
  const tools = acc.password_enc ? imapTools : outlookTools;
  return {
    address: acc.email || 'connected mailbox',
    // runs one tool_use block and returns its tool_result
    run: async (block) => {
      try {
        const fn = tools[block.name];
        if (!fn) throw new Error(`Unknown tool ${block.name}`);
        return { type: 'tool_result', tool_use_id: block.id, content: await fn(userId, block.input || {}) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: block.id, content: e.message, is_error: true };
      }
    },
  };
}
