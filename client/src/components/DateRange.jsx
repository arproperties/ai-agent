import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { usDate } from '../lib/usFormat';

// One picker for a range of dates. It opens two months, side by side where there is room
// and one above the other on a phone; the first tap is the start, the second
// the end (tapped the other way round, they swap). A few usual ranges are one tap. Drawn
// from the theme's tokens like Select, and fixed to the screen so nothing can clip it.
//
// `from` and `to` are YYYY-MM-DD or ''. onChange gets (from, to), both '' when cleared.
// `className` styles the button and `wrap` the box around it (its width, say), as in Select.

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (s) => new Date(`${s}T00:00:00`);
const short = (s, year) => (year ? usDate(s) : usDate(s).slice(0, 5)); // MM/DD/YYYY, or MM/DD where the year is said once
const PRESETS = [
  ['This month', (t) => [new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth() + 1, 0)]],
  ['Last month', (t) => [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]],
  ['Next 30 days', (t) => [t, new Date(t.getFullYear(), t.getMonth(), t.getDate() + 30)]],
  ['This year', (t) => [new Date(t.getFullYear(), 0, 1), new Date(t.getFullYear(), 11, 31)]],
];

export default function DateRange({ from, to, onChange, placeholder = 'Any dates', className = '', wrap = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [month, setMonth] = useState(() => new Date());
  const [first, setFirst] = useState(''); // the start, tapped and waiting for the end
  const [hover, setHover] = useState('');
  const btn = useRef(null);
  const pop = useRef(null);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const wide = window.innerWidth >= 640; // room for the two months side by side
    const width = Math.min(wide ? 600 : 304, window.innerWidth - 16);
    const up = window.innerHeight - r.bottom < (wide ? 380 : 640) && r.top > window.innerHeight - r.bottom;
    setPos({ left: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8), width, maxHeight: (up ? r.top : window.innerHeight - r.bottom) - 14,
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };
  const close = () => { setOpen(false); setPos(null); setFirst(''); setHover(''); };
  const show = () => { const d = from ? day(from) : new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setOpen(true); };

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const away = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const pick = (d) => {
    if (!first) return setFirst(d);
    onChange(...(d < first ? [d, first] : [first, d]));
    close();
  };
  // While the end is being chosen, the range shown is from the first tap to wherever the pointer is.
  const [a, b] = first ? (hover && hover < first ? [hover, first] : [first, hover || first]) : [from, to];
  const today = iso(new Date());
  const label = from && to ? (from === to ? short(from, true) : `${short(from, from.slice(0, 4) !== to.slice(0, 4))} – ${short(to, true)}`) : from ? `From ${short(from, true)}` : to ? `Until ${short(to, true)}` : placeholder;

  return (
    <span className={`relative inline-flex ${wrap}`}>
      <button ref={btn} type="button" onClick={() => (open ? close() : show())} aria-haspopup="dialog" aria-expanded={open}
        className={`${className} flex items-center gap-2 text-left ${open ? 'border-p1/70' : ''}`}>
        <CalendarDays size={15} className="shrink-0 text-mute" />
        <span className={`truncate ${from || to ? '' : 'text-mute'}`}>{label}</span>
        {(from || to) && <span role="button" tabIndex={0} aria-label="Clear the dates" title="Clear the dates" onClick={(e) => { e.stopPropagation(); onChange('', ''); close(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange('', ''); } }} className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={13} /></span>}
      </button>
      {open && pos && createPortal(
        <div ref={pop} role="dialog" aria-label="Choose dates" style={pos} className="fixed z-[100] overflow-y-auto rounded-xl border border-stroke bg-surface p-3 text-sm text-txt shadow-xl shadow-black/30">
          <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
            {PRESETS.map(([name, make]) => (
              <button key={name} type="button" onClick={() => { onChange(...make(new Date()).map(iso)); close(); }} className="rounded-full border border-stroke/70 px-2.5 py-1 text-mute hover:bg-white/5 hover:text-txt">{name}</button>
            ))}
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {[0, 1].map((n) => {
              const m = new Date(month.getFullYear(), month.getMonth() + n, 1);
              const lead = (m.getDay() + 6) % 7; // weeks begin on Monday
              const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
              const ARROW = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt';
              return (
                <div key={n}>
                  <div className="flex items-center justify-between py-1">
                    {/* Back is on the first month and forward on the second (both on the first, on a phone, where they stack). */}
                    <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month" className={`${ARROW} ${n ? 'invisible' : ''}`}><ChevronLeft size={16} /></button>
                    <span className="font-medium">{m.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
                    <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month" className={`${ARROW} ${n ? '' : 'sm:invisible'}`}><ChevronRight size={16} /></button>
                  </div>
                  <div className="grid grid-cols-7 text-center text-[11px] text-mute">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="py-1">{d}</span>)}</div>
                  <div className="grid grid-cols-7" onMouseLeave={() => setHover('')}>
                    {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
                    {Array.from({ length: days }, (_, i) => {
                      const d = iso(new Date(m.getFullYear(), m.getMonth(), i + 1));
                      const end = d === a || d === b;
                      const inside = a && b && d > a && d < b;
                      return (
                        <button key={d} type="button" onClick={() => pick(d)} onMouseEnter={() => first && setHover(d)} aria-pressed={end}
                          className={`h-9 text-sm transition ${end ? 'rounded-full bg-p1 font-medium text-white' : inside ? 'bg-p1/15' : 'rounded-full hover:bg-white/10'} ${d === today && !end ? 'text-p1' : ''}`}>
                          {i + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-mute">{first ? `From ${short(first, true)}. Now tap the last day.` : 'Tap the first day, then the last.'}</p>
        </div>,
        document.body,
      )}
    </span>
  );
}
