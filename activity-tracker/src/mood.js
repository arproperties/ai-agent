// Buddy's moods and lines, decided from what the tracker already knows. No AI anywhere: a
// fixed list of lines, picked at random, never more than once an hour so it stays a companion
// and not a nag. Pure functions, tested without Electron.

/** Seconds at the desk without a three-minute break before Buddy suggests a stretch. */
export const STRETCH_AFTER = 2 * 3600;
/** Seconds between two chatty lines, at the most. */
export const LINE_EVERY = 3600;

/**
 * Which face Buddy makes. The names are Reem's pet moods (buddy.css animates them):
 * working = watching you, sleep = dozing (idle or locked), alert = needs you (not paired),
 * happy = the day just went to Reem, think = waiting to be paired for the first time.
 */
export function moodFor({ idleSeconds = 0, locked = false, pairError = '', recording = true, justSent = false }) {
  if (pairError) return 'alert';
  if (!recording) return 'think';
  if (justSent) return 'happy';
  if (locked || idleSeconds >= 180) return 'sleep';
  return 'working';
}

/** True when the person has been at it for STRETCH_AFTER since the last break, and Buddy has not said so this stretch. */
export function nudgeDue({ activeSince, now, lastNudgeAt }) {
  if (activeSince == null) return false;
  const since = Math.max(activeSince, lastNudgeAt ?? -Infinity);
  return now - since >= STRETCH_AFTER;
}

export const LINES = {
  working: [
    'Nice. Keep going, I am counting.',
    'Excel again? Respect.',
    'I blinked. Did you?',
    'Water. Just saying.',
    'Still here. Still watching the clock, not you.',
    'Your day goes to HR at day end. Automatically.',
    'Top program today: probably the one in front of you.',
  ],
  sleep: [
    'zzz',
    'Wake me when you are back.',
    'Dozing. Not counting this as work, sorry.',
  ],
  alert: [
    'Reem does not know me any more. Pair me again?',
  ],
  happy: [
    'Day sent. Go home.',
    'Sent to Reem. Good day.',
  ],
  think: [
    'Paste the key from Reem and we start.',
  ],
  stretch: [
    'Two hours straight. Stretch time.',
    'Stand up for a minute. I will wait.',
  ],
};

/**
 * A line for the mood, or null when it is too soon or bubbles are off. An alert is never
 * held back: being unpaired is the one thing the person must act on.
 */
export function lineFor(mood, { now, lastLineAt = 0, rng = Math.random, bubbles = true } = {}) {
  if (!bubbles) return null;
  const list = LINES[mood] || LINES.working;
  if (mood !== 'alert' && lastLineAt != null && now - lastLineAt < LINE_EVERY) return null;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

const MARGIN = 24;

/**
 * Where Buddy sits: the saved spot if it is still on a screen (a monitor may have been
 * unplugged), pulled inside the nearest screen otherwise; the bottom-right corner of the
 * first screen the very first time.
 */
export function clampToScreen(pos, size, screens) {
  const first = screens[0];
  if (!pos) return { x: first.x + first.width - size.width - MARGIN, y: first.y + first.height - size.height - MARGIN };
  const on = screens.find((s) => pos.x + size.width / 2 >= s.x && pos.x + size.width / 2 <= s.x + s.width && pos.y + size.height / 2 >= s.y && pos.y + size.height / 2 <= s.y + s.height) || first;
  return {
    x: Math.min(Math.max(pos.x, on.x), on.x + on.width - size.width),
    y: Math.min(Math.max(pos.y, on.y), on.y + on.height - size.height),
  };
}
