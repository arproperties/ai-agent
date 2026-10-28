// Highlights what has been read aloud so far, in the reply as it is shown: every word up to
// the one being said stays lit, so the read part grows like a marker pen. The spoken words come
// from a transcription of the audio, so they are matched to the words on screen in order,
// looking a little ahead: a word said differently ("22/10" read as a date) is skipped
// and the next one that matches carries on. Painted with the CSS Highlight API, so the
// reply's own DOM is never touched; browsers without it simply show no highlight.

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const AHEAD = 15;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// The box the reply scrolls in (the chat's own list), or null for the page itself.
const scrollerOf = (el) => {
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
};

export function makeHighlighter(getRoot) {
  let pos = 0;      // the next word on screen we expect to hear
  let words = [];   // { node, start, end, key } for each word on screen, in order
  let seen = '';    // the text they were collected from: a reply still arriving grows
  let follow = true; // keep the spoken word in sight, until the person scrolls themselves

  // Their own scrolling wins: once they wheel, swipe or press a scroll key, the page stays
  // where they put it for the rest of this reading instead of being pulled back to the voice.
  // Typing in the chat box does not count.
  const letGo = () => { follow = false; };
  const onKey = (e) => { if (SCROLL_KEYS.has(e.key) && !e.target.closest?.('input, textarea, [contenteditable]')) follow = false; };
  window.addEventListener('wheel', letGo, { passive: true });
  window.addEventListener('touchmove', letGo, { passive: true });
  window.addEventListener('keydown', onKey);

  const collect = () => {
    const root = getRoot();
    if (!root || root.textContent === seen) return;
    seen = root.textContent;
    words = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      for (const m of node.data.matchAll(/\S+/g)) {
        const key = norm(m[0]);
        if (key) words.push({ node, start: m.index, end: m.index + m[0].length, key });
      }
    }
  };

  const paint = (w) => {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return;
    // From the first word to this one, so a word the matching skipped is lit too.
    const read = new Range();
    read.setStart(words[0].node, words[0].start);
    read.setEnd(w.node, w.end);
    CSS.highlights.set('reading', new Highlight(read));
    if (!follow) return;
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
    word(said) {
      collect();
      const k = norm(said);
      if (!k) return;
      for (let j = pos; j < Math.min(words.length, pos + AHEAD); j++) {
        const w = words[j].key;
        if (w === k || (k.length > 3 && w.length > 3 && (w.startsWith(k) || k.startsWith(w)))) {
          pos = j + 1;
          paint(words[j]);
          return;
        }
      }
    },
    // A new start of the audio: nothing read yet, and the voice may be followed again.
    clear() {
      pos = 0;
      follow = true;
      CSS.highlights?.delete('reading');
    },
    // The reading is over: stop listening for the person's scrolling.
    stop() {
      window.removeEventListener('wheel', letGo);
      window.removeEventListener('touchmove', letGo);
      window.removeEventListener('keydown', onKey);
      CSS.highlights?.delete('reading');
    },
  };
}
