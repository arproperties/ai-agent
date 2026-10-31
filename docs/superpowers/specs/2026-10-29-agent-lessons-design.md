# Agent lessons: Reem learns from the master's corrections

Date: 2026-10-29. Status: design, approved in chat by Francis (the master).

## Why

Reem's brain (Claude) can't be retrained. Francis wants Reem to get better over time anyway.
Memory already holds facts about a person, and the Shelf holds company facts. Neither one
changes how an agent *works*. When Francis tells an agent "no, always show rent including VAT",
the correction is only kept in that chat. A **lesson** turns that correction into a standing
rule the agent follows in every chat, for everyone who talks to it.

## What Francis agreed

1. When the master corrects an agent in a chat, Reem proposes a lesson **as a card in that
   chat, right under the reply**. It is never applied silently.
2. The card shows:
   - **The rule**: one plain sentence written by Reem from the correction, e.g. "Always show
     rent including VAT."
   - **For**: the agent being talked to (the default), another of the master's agents, or
     **All agents**. A dropdown lets him change it.
   - **Approve**, **Edit** (fix the wording, then approve) and **No**.
3. Approve: the agent follows the rule from then on, in every chat with anyone.
4. No: the lesson is dropped, and Reem does not propose the same thing again.
5. Each agent has a **Lessons** list where the master can see and remove its lessons.
6. **Only the master's own chats create lessons.** Staff and external users' chats never do.
   This is a firm rule: never propose relaxing it.
7. Personal preferences about the master himself ("I like short answers") stay in Memory, as
   now. Lessons are about how an agent does its work.

## Non-goals

- No retraining or fine-tuning.
- No lessons from staff or external users' chats, and no thumbs up/down buttons for them.
- No weekly review or batch. The card in the chat is the only place a lesson starts.
- Lessons don't touch the persona text the master wrote. They sit beside it and are shown apart.

## Anti-goals (a failure even if it works)

- A rule applied without the master tapping Approve.
- A card after every message. Most turns hold no correction. A card for something that
  isn't a correction ("thanks", a new question) is noise he will learn to ignore.
- A lesson that holds a person's private details (a tenant's name, a sum, an ID number), which
  then reaches every chat of that agent. A lesson is a rule, not a fact about someone.
- Lessons that contradict each other without him knowing.

## How it fits the code (decided here)

- **A chat kit, the same pattern as `addressKit` in `server/addressBook.js`.** It's a new
  `lessonKit(user, ctx)` with one tool, `propose_lesson({ rule, scope })`, given only when
  `user.role === 'master'`. The tool doesn't apply anything. It inserts a pending proposal and
  calls `ctx.onCard(...)`, which streams a `lesson` card (`send('lesson', p)`). The reply then
  says in one short line that the lesson is waiting on the card.
  - Why a tool and not `learn()`: `learn()` runs after the reply has ended (`res.end()`), so
    it can't put a card in the reply. The chat model sees the correction as it happens.
- **When to call it** (tool description and system prompt): only when the master corrects or
  redirects how the agent does its work ("no", "wrong", "don't…", "always…", "next time…"),
  and only for a rule that will hold beyond this one task. Not for facts about him (Memory has
  those), and not for one-off changes to the current draft ("make this one shorter").
- **Storage (new tables in `server/db.js`, added to `TABLES` in `tests/helpers/db.js`):**
  - `lesson_proposals`: master_id, conversation_id, agent_id (NULL = All agents), rule,
    status `pending|approved|declined`, decided_at, created_at. Approving or declining sets the
    status once (the status change is the lock, as in `decide()` in addressBook.js), so a
    double tap applies it once.
  - `agent_lessons`: id, owner_id (the master), agent_id (NULL = All agents), rule,
    from_proposal_id, created_at, removed_at. Removing sets `removed_at`; it doesn't delete.
- **Using them:** `systemPrompt()` in `server/chat.js` adds a block after the persona:
  `<lessons>Standing rules <owner> has taught you. Follow them.</lessons>`, filled with the
  agent's own lessons plus the owner's All-agents lessons. They're taken from the agent's
  owner, so a staff member talking to that agent gets the same rules. That's the point.
- **"All agents"** means every agent the master owns, including private agents and case agents
  that external users chat with (Francis chose this, 2026-10-29). A lesson aimed at one of those
  agents also reaches the external users who chat with it. That is intended: the rules are the
  master's own wording about how the agent works, never facts about a person. The privacy guard
  below matters most here.
- **Not asking twice:** the kit's description and the prompt list the agent's current lessons
  and its recently declined or removed rules (say the last 20), so the model doesn't propose them
  again. The server also refuses a proposal whose rule matches a current, pending, declined or
  removed one for the same scope (case-insensitive, trimmed). **A removed lesson counts as a
  "No"** (Francis agreed).
- **Clashes** (Francis agreed): the tool takes an optional `replaces` (the id of a current
  lesson it conflicts with). The model is told to set it when the new rule contradicts one of the
  listed lessons. The card then shows the old rule under the new one and asks "Replace it?":
  Approve with replace on removes the old lesson (sets `removed_at`) and adds the new one in one
  transaction. Approve with replace off keeps both. `lesson_proposals` gets a
  `replaces_lesson_id` column. The server checks that the id is a current lesson for the same
  owner, and drops it if not.
- **Which agent** a correction belongs to: the one answering the current turn, even if the
  router switched agents. An edit that changes the scope is checked for duplicates again at
  approval.
- **Privacy guard:** before a proposal is saved, run the existing `tooSpecificToShare()` from
  `server/knowledge.js`. If it trips, the tool returns an error telling the model to restate the
  rule without names, sums or ID numbers. The same check runs again on an edited rule when it is
  approved.
- **Routes** (master only, following `addressRoutes`): list the proposals for a conversation
  (so cards survive a reload), approve (with an optional edited `rule` and `agent_id`), decline,
  list an agent's lessons, remove a lesson.
- **Client:**
  - `LessonCard.jsx` next to `AddressCard.jsx`, wired into `Chat.jsx` the same way
    (`event === 'lesson'`, loaded again with the conversation). Add `'lesson'` to `CARDS` in
    `client/src/lib/petChat.js`.
  - A **Lessons** section in `AgentSheet.jsx`, master only: each rule with a remove button,
    plus the All-agents lessons shown as "From All agents".

## Left to the builder

- Exact card styling (match `AddressCard`), and the wording of the tool description and prompt
  block within the rules above.
- Whether the Edit field is inline on the card or a small sheet.
- Lesson cap: if an agent gets very many lessons, keep the newest 50 in the prompt and note it
  in the list. (My call; Francis can change it.)

## Testing

- `node:test` against the test DB, like the rest: proposals are refused for non-masters;
  approving twice applies once; declined, removed and duplicate rules are refused; approving with
  replace removes the old lesson and adds the new one together; `tooSpecificToShare`
  blocks personal detail; the lessons block is built from the agent owner's lessons (own plus
  All-agents, not removed ones, never another owner's); a staff user chatting with the agent gets
  the same block.
- A live check like the one for web fetch: a master chat with a clear correction should give a
  card, and a plain "thanks" should not.
