// Reading a reply aloud, paragraph by paragraph, with the read part lit like a marker pen.
//
// The reply is read in short pieces cut from what is on screen: a paragraph, a list item, a
// table row, a few short ones together. Short pieces matter twice over. The voice model cuts
// a long text short, which is why reading used to stop halfway through. And the highlight can
// only go wrong inside one piece: when the next piece starts it is back in step, instead of
// drifting further behind or ahead for the rest of the reply.
//
// Within a piece, the word times come from a transcription of its audio. Until they arrive the
// highlight moves at the voice's usual pace; once they do, the words that match are pinned to
// their times and the ones in between (a number read as words, say) are spread evenly.
// Painted with the CSS Highlight API, so the reply's own DOM is never touched; browsers without
// it simply show no highlight.

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const BLOCK = 'li, p, h1, h2, h3, h4, h5, h6, blockquote, tr';
const ENOUGH = 200;    // a piece shorter than this takes in the next paragraph too
const MAX_PIECE = 600; // a paragraph longer than this is read in more than one piece
const CHARS_PER_SEC = 14; // the voice's usual pace, for before the word times arrive
const AHEAD = 6;
const HOLD_MS = 4000; // after the person scrolls, how long before the page follows the voice again
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// The box the reply scrolls in (the chat's own list), or null for the page itself.
const scrollerOf = (el) => {
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
};

/**
 * The reply under `root` as pieces to read, starting from `from` ({ node, offset }: a tapped
 * word or the start of a selection) or from the top. Each piece is { text, words }, its words
 * being { node, start, end, key, at } with `at` the word's place in the piece's text.
 */
export function readingPlan(root, from) {
  const all = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Only the reply's own words: not code, not drawings, not the buttons that float over it.
    acceptNode: (n) => (n.parentElement?.closest('.md') && !n.parentElement.closest('pre, button')
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const start = from?.node?.isConnected ? document.createRange() : null;
  start?.setStart(from.node, from.offset);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const block = node.parentElement.closest(BLOCK) || node.parentElement.closest('.md');
    for (const m of node.data.matchAll(/\S+/g)) {
      const end = m.index + m[0].length;
      // The word that was tapped is read too, not just what follows it.
      if (start && start.comparePoint(node, end) !== 1) continue;
      all.push({ node, start: m.index, end, text: m[0], key: norm(m[0]), block });
    }
  }

  const pieces = [];
  let cur = null;
  const add = (w, sep) => {
    w.at = cur.text.length + (cur.text ? sep.length : 0);
    cur.text += (cur.text ? sep : '') + w.text;
    cur.words.push(w);
  };
  for (const w of all) {
    const newBlock = cur && w.block !== cur.words.at(-1).block;
    const sentenceDone = cur && /[.!?:]["')\]]*$/.test(cur.words.at(-1).text);
    // Close the piece at a paragraph once it has enough, or mid-paragraph once it is too long
    // (at a sentence end if one is near, so the pause sounds natural).
    if (!cur || (newBlock && cur.text.length >= ENOUGH) || cur.text.length >= MAX_PIECE
      || (sentenceDone && cur.text.length >= MAX_PIECE * 0.7)) {
      cur = { text: '', words: [] };
      pieces.push(cur);
    }
    add(w, newBlock ? '\n' : ' '); // a line break between paragraphs reads as a pause
  }
  return { pieces: pieces.filter((p) => p.words.some((w) => w.key)) };
}

// The words heard, pinned to the words on screen they match, in order. A word that does not
// match is passed over; the search looks only a few words ahead, so a common word further on
// cannot pull the highlight forward.
function align(words, said) {
  const pins = [];
  let pos = 0;
  for (const s of said) {
    const k = norm(s.w);
    if (!k) continue;
    for (let j = pos; j < Math.min(words.length, pos + AHEAD); j++) {
      const w = words[j].key;
      if (w === k || (k.length > 3 && w.length > 3 && (w.startsWith(k) || k.startsWith(w)))) {
        pins.push({ i: j, s: s.s });
        pos = j + 1;
        break;
      }
    }
  }
  return pins;
}

// Which word of the piece is being said `time` seconds into its audio.
function wordAt(piece, time, said) {
  const n = piece.words.length;
  if (said?.length) {
    if (piece.saidFrom !== said) { piece.pins = align(piece.words, said); piece.saidFrom = said; }
    const pins = piece.pins;
    if (pins.length) {
      let k = -1;
      while (k + 1 < pins.length && pins[k + 1].s <= time) k++;
      const a = k < 0 ? { i: 0, s: 0 } : pins[k];
      const b = pins[k + 1] || { i: n - 1, s: said.at(-1).e };
      if (b.s <= a.s || b.i <= a.i) return a.i;
      return a.i + Math.floor(Math.min(1, (time - a.s) / (b.s - a.s)) * (b.i - a.i));
    }
  }
  const guess = time * CHARS_PER_SEC;
  const i = piece.words.findIndex((w) => w.at + w.text.length >= guess);
  return i < 0 ? n - 1 : i;
}

export function makeHighlighter(plan) {
  let heldUntil = 0; // until then the person's own scrolling wins over following the voice
  let lit = null;

  // Their own scrolling wins: when they wheel, swipe or press a scroll key, the page stays
  // where they put it for a few seconds instead of being pulled back to the voice. Then it
  // follows again: stopping for the rest of the reading meant a stray touch (a tap to pause
  // moves the finger a little) left the voice reading off the bottom of the screen.
  // Typing in the chat box does not count.
  const letGo = () => { heldUntil = Date.now() + HOLD_MS; };
  const onKey = (e) => { if (SCROLL_KEYS.has(e.key) && !e.target.closest?.('input, textarea, [contenteditable]')) letGo(); };
  window.addEventListener('wheel', letGo, { passive: true });
  window.addEventListener('touchmove', letGo, { passive: true });
  window.addEventListener('keydown', onKey);

  const paint = (w) => {
    if (typeof Highlight === 'undefined' || !CSS.highlights || !w.node.isConnected) return;
    // From where this reading started to the word being said.
    const first = plan.pieces[0].words[0];
    const read = new Range();
    read.setStart(first.node, first.start);
    read.setEnd(w.node, w.end);
    CSS.highlights.set('reading', new Highlight(read));
    if (Date.now() < heldUntil) return;
    // Keep the spoken word in sight, but only scroll once it has left the screen, and to
    // the word itself: centring its whole paragraph would jump back to the paragraph's top.
    const word = new Range();
    word.setStart(w.node, w.start);
    word.setEnd(w.node, w.end);
    const box = word.getBoundingClientRect();
    const scroller = scrollerOf(w.node.parentElement);
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (box.bottom > view.bottom - 140 || box.top < view.top + 80) {
      const by = box.top - (view.top + view.bottom) / 2;
      (scroller || window).scrollBy({ top: by, behavior: 'smooth' });
    }
  };

  return {
    // Where the voice is: piece `index`, `time` seconds into it, with its word times if known.
    at({ index, time, words }) {
      const piece = plan.pieces[index];
      if (!piece) return;
      const w = piece.words[wordAt(piece, time, words)];
      if (w && w !== lit) { lit = w; paint(w); }
    },
    stop() {
      window.removeEventListener('wheel', letGo);
      window.removeEventListener('touchmove', letGo);
      window.removeEventListener('keydown', onKey);
      CSS.highlights?.delete('reading');
    },
  };
}

/** The spot under a tap, as { node, offset }, for reading on from there. */
export function pointAt(x, y) {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}
