// A table row whose cells hold a colour mark (🟢 🟡 🩷 …) is shaded that colour in the chat,
// as it is in the PDF: a lone dot by the row number was easy to miss on a long register.
// The mark itself is taken out of the row: left in, it pushed the row number onto a second line.
// A small dot of the same colour takes its place, so the row can be matched to the colour key.
// The shade is light and the dot and edge carry the colour: shaded strongly over the dark theme,
// yellow came out brown and orange came out red, so a key saying "🟠 won" sat beside a red row.
const MARKS = {
  '🟢': '34, 197, 94', '🟡': '250, 204, 21', '🟠': '249, 115, 22', '🔴': '239, 68, 68',
  '🩷': '236, 72, 153', '🔵': '59, 130, 246', '🟣': '168, 85, 247', '⚪': '148, 163, 184',
};
const MARK_RE = new RegExp(`(${Object.keys(MARKS).join('|')})\\uFE0F?\\s*`, 'gu');

const textOf = (node) => (node.type === 'text' ? node.value : (node.children || []).map(textOf).join(''));
const unmark = (node) => {
  if (node.type === 'text') node.value = node.value.replace(MARK_RE, '');
  (node.children || []).forEach(unmark);
};

function shadeRows() {
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'tr') {
      const mark = textOf(node).match(MARK_RE)?.[0].trim().replace('️', '');
      if (!mark) return;
      const rgb = MARKS[mark];
      unmark(node);
      node.properties = { ...node.properties, style: `background: rgba(${rgb}, 0.1); box-shadow: inset 4px 0 0 rgb(${rgb})` };
      const first = node.children.find((c) => c.type === 'element');
      if (first) {
        // The dot sits in the cell's own margin, so a narrow cell does not push it onto a line of its own.
        first.properties = { ...first.properties, style: 'position: relative; padding-left: 28px' };
        const dot = { type: 'element', tagName: 'span', properties: { 'aria-hidden': 'true', style: `position: absolute; left: 12px; top: 50%; width: 9px; height: 9px; margin-top: -4.5px; border-radius: 9999px; background: rgb(${rgb})` }, children: [] };
        first.children = [dot, ...(first.children || [])];
      }
      return;
    }
    (node.children || []).forEach(walk);
  };
  return walk;
}

/** rehype plugins that shade marked table rows. */
export const rehypeMarkRows = [shadeRows];

// A table spans the reply's full width; a wider one scrolls sideways instead of squeezing.
function Table({ node, ...props }) {
  return <div className="overflow-x-auto"><table {...props} style={{ display: 'table', width: '100%' }} /></div>;
}

/** react-markdown components for chat replies. */
export const markdownComponents = { table: Table };
