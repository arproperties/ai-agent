// Highlights the word being read aloud, in the reply as it is shown. The spoken words come
// from a transcription of the audio, so they are matched to the words on screen in order,
// looking a little ahead: a word said differently ("22/10" read as a date) is skipped
// and the next one that matches carries on. Painted with the CSS Highlight API, so the
// reply's own DOM is never touched; browsers without it simply show no highlight.

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const AHEAD = 15;

export function makeHighlighter(getRoot) {
  let pos = 0;      // the next word on screen we expect to hear
  let words = [];   // { node, start, end, key } for each word on screen, in order
  let seen = '';    // the text they were collected from: a reply still arriving grows

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
    const r = new Range();
    r.setStart(w.node, w.start);
    r.setEnd(w.node, w.end);
    CSS.highlights.set('reading', new Highlight(r));
    // Keep it in sight, but only scroll once it has left the screen.
    const box = r.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 140 || box.top < 80) w.node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    clear() {
      pos = 0;
      CSS.highlights?.delete('reading');
    },
  };
}
