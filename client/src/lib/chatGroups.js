// Chats in the sidebar are bucketed by when they were last touched, the way a person
// thinks about them: what I was doing just now, what I was doing yesterday, then
// progressively vaguer. The buckets are cut at local midnight rather than by elapsed
// hours, because "yesterday" means the day before this one, not 24 hours ago -- at 1am
// a chat from 11pm last night belongs under Yesterday, not Today.

const DAY = 86400000;

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// In order, newest first. Each one claims every chat the ones above it did not.
const BUCKETS = [
  { label: 'Today', within: 0 },
  { label: 'Yesterday', within: 1 },
  { label: 'Previous 7 days', within: 7 },
  { label: 'Previous 30 days', within: 30 },
];

/**
 * Group conversations for the sidebar list.
 *
 * @param {Array<{updated_at?: number}>} convs - newest first, as the API returns them
 * @param {number} [now] - milliseconds, injectable so the buckets can be tested
 * @returns {Array<{label: string, items: Array}>} only the buckets that have chats,
 *   newest first, each keeping the order the chats arrived in
 */
export function groupChats(convs, now = Date.now()) {
  const today = startOfDay(now);
  const out = new Map();

  for (const c of convs) {
    // A row with no timestamp still has to be reachable, so it falls to the bottom
    // rather than being dropped from the list entirely.
    const daysBack = c.updated_at
      ? Math.round((today - startOfDay(c.updated_at * 1000)) / DAY)
      : Infinity;
    const label = BUCKETS.find((b) => daysBack <= b.within)?.label ?? 'Older';
    if (!out.has(label)) out.set(label, []);
    out.get(label).push(c);
  }

  // Map preserves insertion order, which follows the incoming list, but a chat from
  // last week can arrive before one from today if the caller did not sort. Ordering
  // by the bucket list keeps the headings in a sensible sequence either way.
  const order = [...BUCKETS.map((b) => b.label), 'Older'];
  return order.filter((l) => out.has(l)).map((label) => ({ label, items: out.get(label) }));
}
