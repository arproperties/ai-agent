// An agent told the boss "Draft is ready for your approval" when no draft had been written,
// and "Draft updated - cc HR" when nothing had changed. He found out only by looking.
// So a reply that says something was done is checked against the tools that ran this turn.

const CLAIMS = [
  {
    what: 'an email draft',
    tools: ['create_draft', 'reply_email'],
    said: /\bdraft(ed)?\b[^.\n]{0,60}\b(ready|updated|waiting|threaded|in your queue)\b|\b(reply|reminder|email|draft) (is )?(drafted|ready)\b|\bi(?:'ve| have) (re)?drafted\b/i,
  },
  {
    what: 'a to-do',
    tools: ['add_todo'],
    said: /\badded (it |this |that )?to your to-?do\b|\bon your to-?do list \(#\d+\)/i,
  },
  {
    what: 'a reminder card',
    tools: ['remind_people'],
    said: /\btap \**send\** on the card\b/i,
  },
];

/** What the reply says was done that no tool did this turn (`ran`: names of tools that worked). */
export function unbacked(reply, ran) {
  return CLAIMS.filter((c) => c.said.test(reply) && !c.tools.some((t) => ran.has(t))).map((c) => c.what);
}

/** Said to the agent once, as if from the app, so it does the thing or owns up. */
export function claimNote(missing) {
  return `Note from the app: your answer says you made ${missing.join(' and ')}, but no tool made one in this answer. ` +
    'If it was made earlier in this conversation and is still there as you described it, reply with nothing at all. ' +
    'Otherwise make it now with the right tool and say so in one line, or, if you cannot, say plainly in one line that it was not made. ' +
    'Do not repeat your answer.';
}
