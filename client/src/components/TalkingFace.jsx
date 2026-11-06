import { useEffect, useId, useRef } from 'react';
import { onSpeechProgress } from '../lib/voice';
import './face.css';

// A drawn face for an agent that moves its mouth while a reply is read aloud, so it feels like
// the agent is talking to you. Everything is drawn here: no outside service, no extra cost.
//
// The mouth follows the voice: the server already works out when each word is spoken (for the
// word highlighter), so during a word the mouth shapes its letters and between words it closes.
// Until those times arrive (a few seconds into a long reply) it moves in a speaking rhythm.
// Each agent keeps the same look: picked from its id, tinted with its colour.

const TINTS = {
  violet: ['#a78bfa', '#d946ef'], blue: ['#38bdf8', '#6366f1'], teal: ['#34d399', '#06b6d4'],
  amber: ['#fcd34d', '#f97316'], rose: ['#fb7185', '#db2777'], slate: ['#94a3b8', '#475569'],
};
export const SKINS = [['#f1c9a5', '#e0ad86'], ['#d9a37a', '#c48a60'], ['#b9825a', '#9f6a45'], ['#8d5a3b', '#76482d']];
export const STYLES = ['ghutra', 'shayla', 'short', 'long'];
const SHAYLA = '#25223a'; // a dark headscarf, so it stands out from any agent colour

export const faceLook = (agent) => {
  const n = Number(agent?.id) || [...String(agent?.name || 'Reem')].reduce((a, c) => a + c.charCodeAt(0), 0);
  // The look the master picked on the agent, else one picked from its id that never changes.
  const style = STYLES.includes(agent?.face_style) ? agent.face_style : STYLES[n % STYLES.length];
  const skin = SKINS[agent?.face_skin ?? Math.floor(n / STYLES.length) % SKINS.length] || SKINS[0];
  return { style, skin, tint: TINTS[agent?.color] || TINTS.violet };
};

// ---------- the mouth ----------
// Open (0..1) and wide (0..1) for a letter: a/e/i stretch, o/u round, m/b/p close.
function shapeOf(ch) {
  if (!ch) return [0.5, 0.5];
  if (/[aeiyأاآإيى]/i.test(ch)) return [0.8, 0.85];
  if (/[ouwوؤ]/i.test(ch)) return [0.75, 0.25];
  if (/[mbpمب]/i.test(ch)) return [0.05, 0.5];
  if (/[fvف]/i.test(ch)) return [0.25, 0.6];
  return [0.5, 0.55];
}

// How the mouth should look `time` seconds into the piece being read.
function mouthAt(time, words, clock) {
  if (words?.length) {
    const w = words.find((x) => time >= x.start && time <= x.end);
    if (!w) return [0, 0.5];
    const p = (time - w.start) / Math.max(0.06, w.end - w.start);
    const text = String(w.word || '').replace(/[^\p{L}]/gu, '');
    const [open, wide] = shapeOf(text[Math.min(text.length - 1, Math.floor(p * text.length))]);
    // a word opens and closes once per syllable or so, never sitting at the same height
    const syllables = Math.max(1, Math.round(text.length / 3));
    return [open * (0.45 + 0.55 * Math.abs(Math.sin(p * Math.PI * syllables))), wide];
  }
  // No word times yet: a natural rhythm of about five syllables a second with small pauses.
  const beat = Math.abs(Math.sin(clock * 9.5)) * (0.6 + 0.4 * Math.sin(clock * 2.3));
  return [Math.max(0, beat), 0.5 + 0.3 * Math.sin(clock * 3.1)];
}

const mouthPath = (open, wide) => {
  const w = 13 + wide * 9, h = 2 + open * 16, cx = 100, cy = 138;
  return `M${cx - w} ${cy} Q${cx} ${cy - 3 - open * 4} ${cx + w} ${cy} Q${cx} ${cy + h * 1.6} ${cx - w} ${cy} Z`;
};

// ---------- the head ----------
function Hair({ style, tint }) {
  if (style === 'ghutra') return (
    <>
      <path d="M44 100 Q40 38 100 30 Q160 38 156 100 L170 190 L30 190 Z" fill="#f8fafc" />
      <path d="M50 64 Q100 38 150 64" stroke="#1f2937" strokeWidth="9" fill="none" strokeLinecap="round" />
      <path d="M53 74 Q100 50 147 74" stroke="#111827" strokeWidth="6" fill="none" strokeLinecap="round" />
    </>
  );
  if (style === 'shayla') return <path d="M40 112 Q34 30 100 26 Q166 30 160 112 L176 196 L24 196 Z" fill={SHAYLA} />;
  if (style === 'long') return <path d="M46 150 Q36 40 100 36 Q164 40 154 150 L150 176 Q100 160 50 176 Z" fill="#3b2516" />;
  return <path d="M52 92 Q48 40 100 38 Q152 40 148 92 Q140 62 100 60 Q60 62 52 92 Z" fill="#2a1d14" />;
}

function Front({ style, tint }) {
  // what sits over the forehead, drawn after the face
  if (style === 'ghutra') return <path d="M58 76 Q100 56 142 76 L142 82 Q100 64 58 82 Z" fill="#e2e8f0" />;
  if (style === 'shayla') return <path d="M56 84 Q60 46 100 44 Q140 46 144 84 Q130 58 100 58 Q70 58 56 84 Z" fill={SHAYLA} />;
  if (style === 'long') return <path d="M58 82 Q62 48 100 46 Q138 48 142 82 Q120 60 100 66 Q80 58 58 82 Z" fill="#3b2516" />;
  return null;
}

export default function TalkingFace({ agent, state = 'speaking', size = 120, className = '' }) {
  const mouth = useRef(null);
  const teeth = useRef(null);
  const brows = useRef(null);
  const last = useRef({ at: 0, time: 0, words: null });
  const look = faceLook(agent);
  const id = `f${useId().replace(/[^a-zA-Z0-9]/g, '')}`; // unique per face, since one screen can show several

  // Progress comes every frame while the voice plays; the drawing loop runs on its own, so the
  // mouth eases shut when the voice pauses, stalls or ends instead of freezing half open.
  useEffect(() => onSpeechProgress((e) => {
    if (e.finished) { last.current.at = 0; return; }
    last.current = { at: performance.now(), time: e.time, words: e.words };
  }), []);

  useEffect(() => {
    let raf, open = 0, wide = 0.5;
    const draw = (now) => {
      const { at, time, words } = last.current;
      const talking = now - at < 150;
      const [o, w] = talking ? mouthAt(time + (now - at) / 1000, words, now / 1000) : [0, 0.5];
      open += (o - open) * 0.45; // eased, so it moves like a mouth and not a switch
      wide += (w - wide) * 0.35;
      mouth.current?.setAttribute('d', mouthPath(open, wide));
      if (teeth.current) teeth.current.style.opacity = open > 0.25 ? 1 : 0;
      if (brows.current) brows.current.style.transform = `translateY(${-open * 2.5}px)`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const [skin, shade] = look.skin;
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`${agent?.name || 'Reem'} talking`}
      className={`face face-${state} ${className}`}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={look.tint[0]} /><stop offset="1" stopColor={look.tint[1]} />
        </linearGradient>
        <clipPath id={`${id}-clip`}><circle cx="100" cy="100" r="100" /></clipPath>
        <clipPath id={`${id}-mouth`}><use href={`#${id}-lips`} /></clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="200" height="200" fill={`url(#${id}-bg)`} />
        <g className="face-head">
          <Hair style={look.style} tint={look.tint} />
          {/* shoulders and neck */}
          <path d="M28 200 Q34 168 100 162 Q166 168 172 200 Z" fill={look.style === 'ghutra' ? '#f8fafc' : look.style === 'shayla' ? SHAYLA : look.tint[1]} />
          <rect x="86" y="140" width="28" height="30" rx="10" fill={shade} />
          {/* ears (hidden under a ghutra or shayla) and face */}
          {(look.style === 'short' || look.style === 'long') && (
            <><ellipse cx="57" cy="108" rx="8" ry="12" fill={shade} /><ellipse cx="143" cy="108" rx="8" ry="12" fill={shade} /></>
          )}
          <path d="M58 96 Q58 56 100 54 Q142 56 142 96 Q142 150 100 160 Q58 150 58 96 Z" fill={skin} />
          <Front style={look.style} tint={look.tint} />
          {/* brows rise a little with a wide-open mouth */}
          <g ref={brows}>
            <path d="M72 90 Q81 85 90 89" stroke="#2a1d14" strokeWidth="3.5" fill="none" strokeLinecap="round" />
            <path d="M110 89 Q119 85 128 90" stroke="#2a1d14" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          </g>
          <g className="face-eyes">
            <ellipse cx="81" cy="103" rx="7" ry="6" fill="#fff" />
            <ellipse cx="119" cy="103" rx="7" ry="6" fill="#fff" />
            <g className="face-look">
              <circle cx="81" cy="103.5" r="4.2" fill="#2b1d12" /><circle cx="119" cy="103.5" r="4.2" fill="#2b1d12" />
              <circle cx="82.5" cy="102" r="1.3" fill="#fff" /><circle cx="120.5" cy="102" r="1.3" fill="#fff" />
            </g>
            <g className="face-lids" fill={skin}>
              <rect x="72" y="95" width="18" height="16" rx="7" /><rect x="110" y="95" width="18" height="16" rx="7" />
            </g>
          </g>
          <path d="M100 108 Q97 120 94 123 Q100 126 106 123" stroke={shade} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <ellipse cx="74" cy="124" rx="7" ry="4" fill="#f43f5e" opacity="0.12" />
          <ellipse cx="126" cy="124" rx="7" ry="4" fill="#f43f5e" opacity="0.12" />
          {/* the mouth: dark inside, top teeth showing once it is open enough */}
          <path ref={mouth} id={`${id}-lips`} d={mouthPath(0, 0.5)} fill="#5b1a1f" stroke="#a8505a" strokeWidth="2.5" strokeLinejoin="round" />
          <g clipPath={`url(#${id}-mouth)`}>
            <rect ref={teeth} x="84" y="134" width="32" height="6" rx="2" fill="#fff" style={{ opacity: 0, transition: 'opacity .08s' }} />
          </g>
        </g>
      </g>
    </svg>
  );
}
