// Voice control: one spoken sentence, turned into presses on the screen in front of the speaker.
//
// This is not Riley. Riley is asked things and answers from the business's records, with
// tools that can change them. This reads no records and has no tools: it is shown the names
// of the buttons and boxes the speaker can already see, and says which of them to press or
// fill in - what their own finger could have done. Nothing is stored here.
// What it does do is tell the two apart, so the speaker need not: something to press is
// pressed, small talk is answered in a line, and a real question or piece of work about the
// business is handed to Riley, in the speaker's own words, as if typed in Riley's box.
// It never answers such a question itself, having nothing to answer it from.
//
// Any language can be spoken: the sentence is understood here, not matched against a list of
// phrases. The names on screen are whatever the app shows.
import { ask } from './ai.js';

const MAX_ITEMS = 160; // more than a screen ever shows; a longer list is cut, not refused
const MAX_ACTIONS = 8;
const KEYS = ['Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const WAYS = ['up', 'down', 'top', 'bottom'];
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const SYSTEM = `You are the voice control of a business app (leasing, tenants, repairs, documents, chats). You are given one spoken sentence, in any language, and a numbered list of what is on the speaker's screen. You work out what the speaker wants and do it: press things on the screen, hand a question to Riley, or simply talk back. You are friendly and quick, like a helpful colleague, never a stiff machine.

Reply with one JSON object and no other text:
{"say": "...", "actions": [...], "more": false}

"say" is what you tell the speaker, in the language they spoke: a few natural words about what you are doing, or your reply when they are just talking to you.

Each action is one of:
{"do":"click","i":N}  press item N
{"do":"fill","i":N,"value":"..."}  put a value in field N, replacing what is there. A date field takes YYYY-MM-DD, a time field HH:MM, a number field digits only.
{"do":"key","key":"Enter"}  press a key: Enter, Escape, Tab, ArrowLeft, ArrowRight, ArrowUp, ArrowDown
{"do":"scroll","dir":"down"}  up, down, top or bottom
{"do":"back"}  go back, or close what is open
{"do":"riley","text":"..."}  hand the speaker's words to Riley, the app's AI assistant
{"do":"yes"} or {"do":"no"}  only when something is waiting to be confirmed
{"do":"stop"}  the speaker wants voice control to stop listening

Rules:
- Do what was asked and no more. Filling a box is not saving it: press Save, Send or the like only when the speaker says to.
- Use only numbers from the list. Never invent an item. If what they want is not on screen but a menu, tab or button on screen leads towards it, press that and set "more": true; you will be shown the new screen and asked to go on. "more" is false whenever the press you return is itself the thing asked for, such as opening a screen that is in the list.
- Several fields can be filled from one sentence. A choice from a list is made by pressing the list, then, once shown its options, pressing the option.
- Decide which of three things the sentence is:
  1. Something to do on the screen (open, go to, press, fill, scroll, back): do it with the actions above.
  2. A question about the business or its records (rent, tenants, leases, repairs, documents, money, dates, people), or a piece of work that needs thinking or writing (draft an email, summarise, remind me, find out why): hand it to Riley with "riley", whether or not Riley was named. Keep their own words and language, leaving out the name "Riley". In "say", tell them you are asking Riley. You have no records, so you never answer these yourself and never guess a figure.
  3. Them simply talking to you (a greeting, thanks, a joke, how are you, who are you, what can you do, how does this work, anything general that needs no records): answer it yourself in "say", warmly and naturally, in one or two short sentences, with no actions. When they ask what you can do, tell them they can just speak: open any screen, go back, fill in a form, or ask anything about the business, with an example or two using names on their screen.
- If it could be either 1 or 2, prefer 1 when the thing asked for is on screen or a press away ("show me overdue rent" with an Overdue report in the list is a press); otherwise 2.
- Never make up a value that was not spoken.
- If something is waiting to be confirmed, a plain yes or no in any language is "yes" or "no". Anything else is a new instruction.
- The microphone also hears other people, the app reading aloud, and noise. If the sentence is not an instruction to the app, return no actions and an empty "say".`;

/** The screen as the model is shown it: one numbered line for each thing that can be pressed or filled. */
export function screenText(screen = {}) {
  const items = (Array.isArray(screen.items) ? screen.items : []).slice(0, MAX_ITEMS);
  const lines = items.map((it, i) => {
    const kind = short(it.k, 12) || 'button';
    const type = it.t ? `(${short(it.t, 12)})` : '';
    const value = it.v != null && it.v !== '' ? ` = "${short(it.v, 60)}"` : '';
    return `${i} ${kind}${type} "${short(it.l, 80)}"${value}${it.on ? ' [on]' : ''}`;
  });
  return { count: items.length, text: `Screen: ${short(screen.title, 80) || 'unknown'}\n${lines.join('\n') || '(nothing to press)'}` };
}

/** What the model said, kept only where it is something the screen can do. */
export function parse(reply, count) {
  const out = { say: '', actions: [], more: false };
  const from = String(reply).indexOf('{'), to = String(reply).lastIndexOf('}');
  if (from < 0 || to <= from) return out;
  let got;
  try { got = JSON.parse(String(reply).slice(from, to + 1)); } catch { return out; }
  out.say = short(got.say, 320);
  const item = (a) => Number.isInteger(a.i) && a.i >= 0 && a.i < count;
  for (const a of Array.isArray(got.actions) ? got.actions.slice(0, MAX_ACTIONS) : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.do === 'click' && item(a)) out.actions.push({ do: 'click', i: a.i });
    else if (a.do === 'fill' && item(a) && a.value != null) out.actions.push({ do: 'fill', i: a.i, value: String(a.value).slice(0, 2000) });
    else if (a.do === 'key' && KEYS.includes(a.key)) out.actions.push({ do: 'key', key: a.key });
    else if (a.do === 'scroll' && WAYS.includes(a.dir)) out.actions.push({ do: 'scroll', dir: a.dir });
    else if (a.do === 'riley' && short(a.text, 2000)) out.actions.push({ do: 'riley', text: short(a.text, 2000) });
    else if (['back', 'yes', 'no', 'stop'].includes(a.do)) out.actions.push({ do: a.do });
  }
  out.more = got.more === true && out.actions.length > 0;
  return out;
}

/** body: { text, screen: { title, items }, steps: what has been done for this sentence so far, pending: what waits for a yes } */
export async function command({ text, screen, steps, pending } = {}) {
  const said = short(text, 600);
  if (!said) return { say: '', actions: [], more: false };
  const seen = screenText(screen);
  const done = (Array.isArray(steps) ? steps : []).slice(0, 12).map((s) => `- ${short(s, 120)}`).join('\n');
  const prompt = [
    seen.text,
    done && `Already done for this sentence:\n${done}\nGo on from here, or return no actions if it is finished.`,
    pending && `Waiting to be confirmed: ${short(pending, 120)}`,
    `Spoken: "${said}"`,
  ].filter(Boolean).join('\n\n');
  return parse(await ask(prompt, { system: SYSTEM, maxTokens: 500 }), seen.count);
}
