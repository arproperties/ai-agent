import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { usDate, isoDate, typeDate } from '../lib/usFormat';

// The one box for a single date. A native date input writes the date the way the phone or
// computer is set, so the same booking would read 08/10 on one screen and 10/08 on another;
// this one is always MM/DD/YYYY. It can be typed into (the slashes go in by themselves) or
// picked from a small calendar, drawn from the theme's tokens like Select and DateRange.
//
// `value` is YYYY-MM-DD or ''. onChange gets the same `e.target.value` a date input would
// give, and only once the date is whole (or the box is emptied), so a form's setters fit.
// `min` and `max` are YYYY-MM-DD. `className` is the look of the box and `wrap` the span around it.

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (s) => new Date(`${s}T00:00:00`);

export default function DateField({ value, onChange, min, max, required, autoFocus, className = '', wrap = '', 'aria-label': ariaLabel }) {
  const [text, setText] = useState(() => usDate(value));
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [month, setMonth] = useState(() => new Date());
  const box = useRef(null);
  const input = useRef(null);
  const pop = useRef(null);

  const out = (d) => (min && d < min) || (max && d > max);
  // Why what is typed cannot be saved yet, for the browser to say when the form is sent.
  const wrong = (t) => {
    if (!t) return '';
    const d = isoDate(t);
    if (!d) return 'Write the date as MM/DD/YYYY.';
    if (min && d < min) return `This cannot be before ${usDate(min)}.`;
    if (max && d > max) return `This cannot be after ${usDate(max)}.`;
    return '';
  };

  // A date set from outside (the form opened on another row, a filter reset) replaces what is typed.
  useEffect(() => { if (isoDate(text) !== (value || '')) setText(usDate(value)); }, [value]);
  useEffect(() => { input.current?.setCustomValidity(wrong(text)); }, [text, min, max]);

  const give = (d) => onChange?.({ target: { value: d } });
  const type = (e) => {
    const t = typeDate(e.target.value);
    setText(t);
    const d = isoDate(t);
    if (!t) give('');
    else if (d && !out(d) && d !== value) give(d);
  };

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(288, window.innerWidth - 16);
    const up = window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom;
    setPos({ left: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8), width, maxHeight: (up ? r.top : window.innerHeight - r.bottom) - 14,
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };
  const close = () => { setOpen(false); setPos(null); };
  const show = () => { const d = value ? day(value) : new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setOpen(true); };

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const away = (e) => { if (!box.current?.contains(e.target) && !pop.current?.contains(e.target)) close(); };
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

  const pick = (d) => { setText(usDate(d)); give(d); close(); input.current?.focus(); };
  const today = iso(new Date());
  const lead = (month.getDay() + 6) % 7; // weeks begin on Monday, as in DateRange
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const ARROW = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt';

  return (
    <span ref={box} className={`relative block ${wrap}`}>
      <input ref={input} value={text} onChange={type} required={required} autoFocus={autoFocus} aria-label={ariaLabel}
        // Half a date left behind goes back to the one that is saved, so the box never shows what is not kept.
        onBlur={() => { if (text && (!isoDate(text) || out(isoDate(text)))) setText(usDate(value)); }}
        inputMode="numeric" autoComplete="off" placeholder="MM/DD/YYYY" maxLength={10} className={`${className} pr-10 ${open ? 'border-p1/70' : ''}`} />
      <button type="button" onClick={() => (open ? close() : show())} aria-label="Open the calendar" aria-haspopup="dialog" aria-expanded={open}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-xl text-mute hover:text-txt"><CalendarDays size={15} /></button>
      {open && pos && createPortal(
        <div ref={pop} role="dialog" aria-label="Choose a date" style={pos} className="fixed z-[100] overflow-y-auto rounded-xl border border-stroke bg-surface p-3 text-sm text-txt shadow-xl shadow-black/30">
          <div className="flex items-center justify-between py-1">
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month" className={ARROW}><ChevronLeft size={16} /></button>
            <span className="font-medium">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
            <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month" className={ARROW}><ChevronRight size={16} /></button>
          </div>
          <div className="grid grid-cols-7 text-center text-[11px] text-mute">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="py-1">{d}</span>)}</div>
          <div className="grid grid-cols-7">
            {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const d = iso(new Date(month.getFullYear(), month.getMonth(), i + 1));
              const on = d === value;
              return (
                <button key={d} type="button" disabled={out(d)} onClick={() => pick(d)} aria-pressed={on}
                  className={`h-9 rounded-full text-sm transition disabled:opacity-30 ${on ? 'bg-p1 font-medium text-white' : 'enabled:hover:bg-white/10'} ${d === today && !on ? 'text-p1' : ''}`}>
                  {i + 1}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
