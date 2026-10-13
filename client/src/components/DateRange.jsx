import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

/**
 * A stretch of days chosen from one calendar: tap the first day, tap the last. Tapping the
 * same day twice is that one day. The shortcuts above the calendar are the stretches people
 * ask for most, so the common case is a single tap.
 *
 * value: { from, to } as 'YYYY-MM-DD', both '' when nothing is chosen. onChange gets the same.
 */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const shift = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
const short = (s, year) => day(s).toLocaleDateString([], { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });

/** How a chosen stretch reads on the button. */
export function rangeLabel({ from, to }) {
  if (!from) return '';
  if (from === to) return short(from, true);
  return `${short(from, from.slice(0, 4) !== to.slice(0, 4))} – ${short(to, true)}`;
}

function shortcuts() {
  const now = new Date();
  const monday = shift(now, -((now.getDay() + 6) % 7));
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return [
    ['Today', now, now],
    ['Yesterday', shift(now, -1), shift(now, -1)],
    ['This week', monday, now],
    ['This month', first, now],
    ['Last month', new Date(now.getFullYear(), now.getMonth() - 1, 1), shift(first, -1)],
  ].map(([label, a, b]) => ({ label, from: ymd(a), to: ymd(b) }));
}

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function DateRange({ value, onChange, placeholder = 'Any date', className = '' }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(''); // the first day tapped, while the last is still to come
  const [month, setMonth] = useState(() => new Date()); // any day of the month on show
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setStart('');
    setMonth(value.to ? day(value.to) : new Date());
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
    // Only when it opens: the calendar must not jump while a stretch is being picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (from, to) => { onChange({ from, to }); setOpen(false); };
  const tap = (d) => {
    if (!start) return setStart(d);
    return d < start ? choose(d, start) : choose(start, d);
  };

  const today = ymd(new Date());
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const blanks = (first.getDay() + 6) % 7; // the week starts on Monday
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(blanks).fill(null), ...Array.from({ length: days }, (_, i) => ymd(new Date(month.getFullYear(), month.getMonth(), i + 1)))];
  // While the last day is still to come, only the first is lit.
  const lit = start ? { from: start, to: start } : value;

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <div className={`flex items-center rounded-full border bg-white/[0.04] transition ${open || value.from ? 'border-p1/60' : 'border-stroke hover:border-white/25'}`}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
          className={`flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-4 text-sm outline-none ${value.from ? 'pr-1' : 'pr-4'}`}>
          <CalendarDays size={15} className={`shrink-0 ${value.from ? 'text-p1' : 'text-mute'}`} />
          <span className={`truncate ${value.from ? '' : 'text-mute'}`}>{rangeLabel(value) || placeholder}</span>
        </button>
        {value.from && (
          <button type="button" onClick={() => { onChange({ from: '', to: '' }); setOpen(false); }} aria-label="Any date" className="mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div role="dialog" aria-label="Choose dates" className="menu-glass absolute right-0 top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl p-3">
          <div className="flex flex-wrap gap-1.5">
            {shortcuts().map((s) => (
              <button type="button" key={s.label} onClick={() => choose(s.from, s.to)}
                className={`rounded-full border px-2.5 py-1 text-xs ${s.from === value.from && s.to === value.to ? 'border-p1/60 bg-p1/20 text-p1' : 'border-stroke text-mute hover:text-txt'}`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Earlier month" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronLeft size={16} /></button>
            <span className="text-sm font-medium">{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Later month" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><ChevronRight size={16} /></button>
          </div>
          <div className="grid grid-cols-7 gap-y-1 text-center">
            {WEEK.map((w, i) => <span key={i} className="pb-1 text-[11px] text-mute">{w}</span>)}
            {cells.map((d, i) => {
              if (!d) return <span key={`b${i}`} />;
              const end = d === lit.from || d === lit.to;
              const inside = lit.from && d > lit.from && d < lit.to;
              return (
                <button type="button" key={d} onClick={() => tap(d)} aria-pressed={end}
                  className={`mx-auto grid size-9 place-items-center rounded-full text-sm tabular-nums transition ${
                    end ? 'bg-gradient-to-br from-p1 to-p2 font-medium text-white' : inside ? 'bg-p1/15' : 'hover:bg-white/10'} ${d === today && !end ? 'ring-1 ring-p1/60' : ''}`}>
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <p className="text-center text-xs text-mute">{start ? `From ${short(start)}. Now tap the last day.` : 'Tap the first day, then the last.'}</p>
        </div>
      )}
    </div>
  );
}
