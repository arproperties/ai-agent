import { outlookAccount, outlookTools } from './outlook.js';
import { imapAccount, imapTools, imapActions, replySubject } from './imap.js';
import { createDraft, getDraft, draftOut, logAction } from './drafts.js';
import { kick } from './outbox.js';

// The tool surface the agents see. Reading works against an IMAP mailbox or Outlook.
// Acting works against IMAP only, and only when its owner has turned it on — the write
// tools are not described-and-refused, they are absent, because an agent cannot be talked
// into using a tool it was never given.

export const EMAIL_READ_TOOLS = [
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

const MESSAGE_ID = { type: 'string', description: 'The id of an email, exactly as search_email gave it (for example "INBOX:1423").' };

/**
 * Who a reply goes to. The mailbox's own address is dropped — answering yourself is never
 * what was meant — and when that empties the list (a reply to something you sent), the
 * original recipients are the right audience instead.
 */
export function replyRecipients(original, myAddress) {
  const mine = String(myAddress || '').trim().toLowerCase();
  const norm = (list) => [...new Set((list || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  const from = norm(original.from).filter((a) => a !== mine);
  if (from.length) return from;
  return norm(original.to).filter((a) => a !== mine);
}

export const EMAIL_WRITE_TOOLS = [
  {
    name: 'create_draft',
    description: 'Write a new email and show it to the user for approval. This does NOT send it: the user sees the draft ' +
      'and taps Approve or Reject, and only then does it go out. Say in your reply that you have written a draft and it is waiting for them. ' +
      'To answer an email that already exists, use reply_email instead so it threads.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text. No Markdown — this goes out as an email, not a chat message.' },
        in_reply_to: { ...MESSAGE_ID, description: 'Optional: an email this is a reply to, so it threads. Prefer reply_email.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'reply_email',
    description: 'Write a reply to an existing email, correctly threaded onto it, and show it to the user for approval. ' +
      'This does NOT send it — the user must tap Approve. Recipients and subject are taken from the original.',
    input_schema: {
      type: 'object',
      properties: { message_id: MESSAGE_ID, body: { type: 'string', description: 'Plain text.' } },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'send_email',
    description: 'Submit a draft you created earlier for sending. It still cannot go out until the user has approved it — ' +
      'if they have not yet, this simply reports that it is waiting for them. You never need to call this straight after ' +
      'create_draft or reply_email: an approved draft sends itself.',
    input_schema: {
      type: 'object',
      properties: { draft_id: { type: 'integer', description: 'The draft id returned by create_draft or reply_email.' } },
      required: ['draft_id'],
    },
  },
  {
    name: 'mark_read',
    description: 'Mark one email as read. Takes effect immediately and can be undone with mark_unread.',
    input_schema: { type: 'object', properties: { message_id: MESSAGE_ID }, required: ['message_id'] },
  },
  {
    name: 'mark_unread',
    description: 'Mark one email as unread, for example to leave it for the user to deal with. Takes effect immediately.',
    input_schema: { type: 'object', properties: { message_id: MESSAGE_ID }, required: ['message_id'] },
  },
  {
    name: 'move_email',
    description: 'File one email into another folder of the mailbox. Takes effect immediately and can be undone by moving it back. ' +
      'If the folder does not exist the error lists the folders that do.',
    input_schema: {
      type: 'object',
      properties: { message_id: MESSAGE_ID, folder: { type: 'string', description: 'The folder name as the user would say it, e.g. "Archive".' } },
      required: ['message_id', 'folder'],
    },
  },
];

/** The label the chat screen shows while a tool is running. */
export function statusFor(name, input = {}) {
  const q = String(input.query || '').slice(0, 60);
  switch (name) {
    case 'read_email': return 'Reading an email…';
    case 'search_email': return q ? `Searching your email: “${q}”` : 'Checking your inbox…';
    case 'create_draft': return 'Writing a draft…';
    case 'reply_email': return 'Writing a reply…';
    case 'send_email': return 'Checking a draft…';
    case 'mark_read': return 'Marking an email as read…';
    case 'mark_unread': return 'Marking an email as unread…';
    case 'move_email': return input.folder ? `Filing an email in ${String(input.folder).slice(0, 40)}…` : 'Filing an email…';
    default: return 'Working on your email…';
  }
}

// ctx: { agentId, conversationId, onDraft } — onDraft puts the approval card in the chat
// as the draft is written, rather than making the user go and look for it.
function writeTools(ctx) {
  const show = (d) => { ctx.onDraft?.(draftOut(d)); return d; };
  const waiting = (d) => `Draft ${d.id} is written and is now in front of ${ctx.userName || 'the user'} with Approve and Reject buttons. ` +
    'It has NOT been sent and you cannot send it — tell them it is ready for them to approve.';

  // Marking and moving happen without anyone tapping anything, so the log is the only
  // record that they happened at all — and the only way a user finds out that an email
  // telling the agent to file everything away was obeyed. Failures are recorded too: a
  // refusal is as much a thing that happened as a success.
  const act = async (userId, action, target, fn) => {
    try {
      const out = await fn();
      await logAction(userId, { agentId: ctx.agentId, action, target });
      return out;
    } catch (e) {
      await logAction(userId, { agentId: ctx.agentId, action, target, ok: false, error: e.message });
      throw e;
    }
  };

  const drafted = (userId, d) =>
    logAction(userId, { agentId: ctx.agentId, action: 'draft', draftId: d.id, recipients: d.to_addrs, target: d.reply_to_id });

  return {
    create_draft: async (userId, { to, cc, subject, body, in_reply_to }) => {
      // in_reply_to is optional here and best-effort: a draft that cannot be threaded is
      // still a draft worth showing, so a failed lookup loses the headers, not the email.
      const thread = in_reply_to ? await imapActions.original(userId, in_reply_to).catch(() => null) : null;
      const d = show(await createDraft(userId, {
        agentId: ctx.agentId, conversationId: ctx.conversationId,
        to, cc, subject, body,
        inReplyTo: thread?.messageId ?? null, refs: thread?.refs ?? null, replyToId: in_reply_to ?? null,
      }));
      await drafted(userId, d);
      return waiting(d);
    },

    reply_email: async (userId, { message_id, body }) => {
      const o = await imapActions.original(userId, message_id);
      const acc = await imapAccount(userId);
      const to = replyRecipients(o, acc.email);
      const d = show(await createDraft(userId, {
        agentId: ctx.agentId, conversationId: ctx.conversationId,
        to,
        subject: replySubject(o.subject),
        body,
        inReplyTo: o.messageId, refs: o.refs, replyToId: message_id,
      }));
      await drafted(userId, d);
      return `${waiting(d)} It is threaded onto “${o.subject || '(no subject)'}”.`;
    },

    send_email: async (userId, { draft_id }) => {
      const d = await getDraft(userId, Number(draft_id));
      if (!d) throw new Error(`No draft with id ${draft_id}. Use the id create_draft or reply_email gave you.`);
      switch (d.status) {
        case 'pending': return `Draft ${d.id} is waiting for the user to tap Approve. It will go out the moment they do — there is nothing more for you to do.`;
        case 'approved': kick(); return `Draft ${d.id} is approved and queued; it will be sent shortly.`;
        case 'sending': return `Draft ${d.id} is approved and is going out now.`;
        case 'sent': return `Draft ${d.id} has already been sent.`;
        default: return `Draft ${d.id} was ${d.status} and cannot be sent. Write a new one if the user asks.`;
      }
    },

    mark_read: (userId, { message_id }) =>
      act(userId, 'mark_read', message_id, () => imapActions.markSeen(userId, message_id, true)),
    mark_unread: (userId, { message_id }) =>
      act(userId, 'mark_unread', message_id, () => imapActions.markSeen(userId, message_id, false)),
    // target carries both ends of the move: which email, and where it went.
    move_email: (userId, { message_id, folder }) =>
      act(userId, 'move_email', `${message_id} → ${folder}`, () => imapActions.moveMessage(userId, message_id, folder)),
  };
}

/** The user's connected mailbox (IMAP first, then Outlook), or null when none is connected. */
export async function connectedMailbox(userId, ctx = {}) {
  const imap = await imapAccount(userId);
  const acc = imap || (await outlookAccount(userId));
  if (!acc) return null;

  // Outlook stays read-only: sending through Graph is a separate integration with its own
  // consent. An Outlook mailbox therefore never gets the write tools, whatever is stored.
  const canWrite = !!(imap && imap.can_write && imap.smtp_host);
  const tools = imap ? { ...imapTools, ...(canWrite ? writeTools(ctx) : {}) } : outlookTools;

  return {
    address: acc.email || 'connected mailbox',
    canWrite,
    definitions: [...EMAIL_READ_TOOLS, ...(canWrite ? EMAIL_WRITE_TOOLS : [])],
    status: statusFor,
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
