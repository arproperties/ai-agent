// Buddy's four characters, lifted as they are from Reem's web app (client/src/components/Pet.jsx)
// so the desktop Buddy is the same creature people know from Reem. Plain functions returning
// SVG; the animations live in buddy.css (Reem's pet.css). Change the drawings there first,
// then copy them here, so the two stay the same.

// ---------- the four characters: same parts on each (.pupil follows the pointer, .lids blink) ----------
const eyes = (lx, rx, y, r, fill, pupil, lid) => `<g><circle cx="${lx}" cy="${y}" r="${r}" fill="${fill}"/><circle cx="${rx}" cy="${y}" r="${r}" fill="${fill}"/>
 <g class="pupil"><circle cx="${lx}" cy="${y}" r="${r * 0.5}" fill="${pupil}"/><circle cx="${rx}" cy="${y}" r="${r * 0.5}" fill="${pupil}"/><circle cx="${lx + 1.5}" cy="${y - 1.5}" r="${r * 0.18}" fill="#fff"/><circle cx="${rx + 1.5}" cy="${y - 1.5}" r="${r * 0.18}" fill="#fff"/></g>
 <g class="lids"><rect x="${lx - r - 1}" y="${y - r - 1}" width="${r * 2 + 2}" height="${r * 2 + 2}" rx="${r}" fill="${lid}"/><rect x="${rx - r - 1}" y="${y - r - 1}" width="${r * 2 + 2}" height="${r * 2 + 2}" rx="${r}" fill="${lid}"/></g></g>`;
const mouthPath = (d, big, ink) => `<path d="${d}" stroke="${ink}" stroke-width="3" stroke-linecap="round" fill="${big ? ink : 'none'}"/>`;

export const CHARS = {
  buddy: {
    name: 'Buddy',
    mouths: { smile: 'M42 71q6 5 12 0', o: 'M45 72a3 3 0 1 0 6 0a3 3 0 1 0-6 0', flat: 'M43 72h10', big: 'M41 70q7 10 14 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M78 78q16-4 13-22" stroke="#c98a52" stroke-width="8" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" values="-12 78 78;22 78 78;-12 78 78" dur=".45s" repeatCount="indefinite"/></path>
      <ellipse cx="48" cy="56" rx="34" ry="31" fill="#c98a52"/><ellipse cx="62" cy="48" rx="11" ry="10" fill="#8a5a32"/><ellipse cx="48" cy="70" rx="17" ry="12" fill="#f3dcc2"/>
      ${eyes(35, 61, 49, 7, '#fff', '#2b1d12', '#c98a52')}<ellipse cx="48" cy="63" rx="5.5" ry="4" fill="#2b1d12"/>${mouthPath(m, big, '#2b1d12')}
      <ellipse cx="16" cy="52" rx="9" ry="19" fill="#8a5a32" transform="rotate(18 16 52)"/><ellipse cx="80" cy="52" rx="9" ry="19" fill="#8a5a32" transform="rotate(-18 80 52)"/></g>`,
  },
  jelly: {
    name: 'Jelly',
    mouths: { smile: 'M41 66q7 6 14 0', o: 'M44 66a4 4 0 1 0 8 0a4 4 0 1 0-8 0', flat: 'M42 67h12', big: 'M39 64q9 11 18 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M10 82C6 50 22 18 48 18s42 32 38 64c-1 6-6 8-12 8H22c-6 0-11-2-12-8z" fill="#4fd1b5"/><path d="M24 34c4-7 10-10 16-10" stroke="#fff" stroke-opacity=".55" stroke-width="5" stroke-linecap="round" fill="none"/>
      ${eyes(36, 60, 52, 8, '#fff', '#1a1f2b', '#4fd1b5')}<ellipse cx="26" cy="64" rx="5" ry="3" fill="#ff8a8a" opacity=".6"/><ellipse cx="70" cy="64" rx="5" ry="3" fill="#ff8a8a" opacity=".6"/>${mouthPath(m, big, '#1a1f2b')}</g>`,
  },
  bolt: {
    name: 'Bolt',
    mouths: { smile: 'M41 60q7 5 14 0', o: 'M44 60a4 4 0 1 0 8 0a4 4 0 1 0-8 0', flat: 'M42 61h12', big: 'M39 58q9 10 18 0z' },
    svg: (m, big, mood) => `<g class="body-g"><line x1="48" y1="20" x2="48" y2="8" stroke="#8b93a8" stroke-width="3"/><circle cx="48" cy="7" r="5" fill="${mood === 'alert' ? '#ff5a5f' : mood === 'working' ? '#5ff2ff' : '#ffc94d'}"/>
      <rect x="12" y="20" width="72" height="62" rx="20" fill="#c8cfdc"/><rect x="20" y="30" width="56" height="40" rx="13" fill="#3a4256"/>
      ${eyes(37, 59, 48, 7, '#2a3142', '#5ff2ff', '#3a4256')}${mouthPath(m, big, '#5ff2ff')}
      <rect x="6" y="44" width="8" height="18" rx="4" fill="#8b93a8"/><rect x="82" y="44" width="8" height="18" rx="4" fill="#8b93a8"/><rect x="28" y="82" width="40" height="8" rx="4" fill="#8b93a8"/></g>`,
  },
  miso: {
    name: 'Miso',
    mouths: { smile: 'M42 69q3 3 6 0q3 3 6 0', o: 'M45 70a3 3 0 1 0 6 0a3 3 0 1 0-6 0', flat: 'M43 70h10', big: 'M41 68q7 9 14 0z' },
    svg: (m, big) => `<g class="body-g"><path d="M80 80q16-6 10-26" stroke="#f4a24c" stroke-width="8" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" values="0 80 80;12 80 80;0 80 80" dur="1.6s" repeatCount="indefinite"/></path>
      <path d="M16 36L20 10l20 16zM80 36L76 10 56 26z" fill="#f4a24c"/><path d="M21 18l3 12 9-6zM75 18l-3 12-9-6z" fill="#ffc9a8"/>
      <ellipse cx="48" cy="58" rx="38" ry="32" fill="#f4a24c"/><ellipse cx="48" cy="70" rx="18" ry="12" fill="#ffe2cc"/>
      ${eyes(34, 62, 52, 7.5, '#fff', '#2b1d12', '#f4a24c')}<path d="M45 64h6l-3 3z" fill="#e0607a"/>${mouthPath(m, big, '#2b1d12')}
      <path d="M18 64h12M18 70l12-2M78 64H66M78 70l-12-2" stroke="#2b1d12" stroke-width="1.5" stroke-linecap="round"/></g>`,
  },
};
export const MOUTH_FOR = { working: 'o', eat: 'o', alert: 'o', sleep: 'flat', happy: 'big', listen: 'o', think: 'flat', talk: 'big' };
export function charSvg(id, mood) {
  const c = CHARS[id] || CHARS.buddy;
  const key = MOUTH_FOR[mood] || 'smile';
  return c.svg(c.mouths[key], key === 'big', mood);
}
