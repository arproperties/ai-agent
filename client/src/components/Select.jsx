import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';

// The one dropdown. A native <select> opens a list the browser draws, which ignores the
// theme and cannot be searched, so nothing in the app uses one: this draws its own list
// from the theme's tokens, with a search box on top.
//
// `options` is a list of { value, label }, [value, label] pairs, or bare strings. onChange
// gets the same `e.target.value` a <select> would give, so a form's setters fit both.
// `className` is the look of the field; `wrap` sizes it inside its row.
// With `onCreate`, a name typed in the search that is not in the list can be added to it:
// the list ends with a "Create …" row, and onCreate gets the name.

const norm = (o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o && typeof o === 'object' ? o : { value: o, label: String(o) });

export default function Select({ value, onChange, onCreate, options, placeholder, required, disabled, className = '', wrap = '', 'aria-label': ariaLabel }) {
  const list = useMemo(() => options.map(norm), [options]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const search = useRef(null);

  const current = list.find((o) => String(o.value) === String(value ?? ''));
  // An empty choice ("None") reads as the placeholder when the field has one.
  const empty = !current || (String(current.value) === '' && placeholder != null);
  const typed = q.trim();
  const found = typed ? list.filter((o) => String(o.label).toLowerCase().includes(typed.toLowerCase())) : list;
  const fresh = !!onCreate && !!typed && !list.some((o) => String(o.label).toLowerCase() === typed.toLowerCase());
  const last = found.length - (fresh ? 0 : 1); // the "Create …" row comes after the matches

  // The list is fixed to the screen, not to the field, so a sheet that scrolls cannot clip it.
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width, 224), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 240 && above > below;
    setPos({
      left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8), width,
      maxHeight: Math.min(320, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };

  const close = () => { setOpen(false); setQ(''); setPos(null); };
  const show = () => {
    if (disabled) return;
    setAt(Math.max(0, list.indexOf(current)));
    setOpen(true);
  };
  const choose = (o) => {
    onChange?.({ target: { value: String(o.value) } });
    close();
    btn.current?.focus();
  };
  const create = () => {
    onCreate(typed);
    close();
    btn.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const move = (e) => { if (!pop.current?.contains(e.target)) place(); };
    const away = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) close(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', move, true);
    document.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', move, true);
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  // Only where there is a real keyboard: on a phone, focusing the box would throw the
  // on-screen keyboard over the list before you had asked to type.
  const placed = !!pos;
  useEffect(() => {
    if (placed && window.matchMedia('(pointer: fine)').matches) search.current?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => { if (placed) pop.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' }); }, [placed, at]);

  const keys = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(last, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (found[at]) choose(found[at]); else if (fresh) create(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.current?.focus(); } // not the sheet behind it
    else if (e.key === 'Tab') close();
  };

  return (
    <span className={`relative block ${wrap}`}>
      <button ref={btn} type="button" disabled={disabled} onClick={() => (open ? close() : show())} onKeyDown={keys}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        className={`${className} flex w-full items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${open ? 'border-p1/70' : ''}`}>
        <span className={`min-w-0 flex-1 truncate ${empty ? 'text-mute' : ''}`}>{empty ? placeholder ?? 'Choose…' : current.label}</span>
        <ChevronDown size={16} className={`shrink-0 text-mute transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* Lets the form's own "fill this in" stop a submit, as a required <select> would. */}
      {required && <input tabIndex={-1} aria-hidden="true" required value={value ?? ''} onChange={() => {}}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px w-full opacity-0" />}
      {open && pos && createPortal(
        <div ref={pop} onKeyDown={keys} onClick={(e) => e.stopPropagation()} style={pos}
          className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-stroke bg-surface text-sm text-txt shadow-xl shadow-black/30">
          <div className="flex items-center gap-2 border-b border-stroke px-3 py-2">
            <Search size={15} className="shrink-0 text-mute" />
            <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} placeholder={onCreate ? 'Search, or type a new one…' : 'Search…'} aria-label="Search"
              className="min-w-0 flex-1 bg-transparent text-sm text-txt outline-none placeholder:text-mute/70" />
          </div>
          <div role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
            {found.length === 0 && !fresh && <p className="px-3 py-2.5 text-mute">{onCreate && !list.length ? 'Type a name to add the first one.' : 'Nothing matches.'}</p>}
            {found.map((o, i) => {
              const on = o === current;
              return (
                <button key={String(o.value)} type="button" role="option" aria-selected={on} data-at={i === at ? '' : undefined}
                  onClick={() => choose(o)} onMouseMove={() => setAt(i)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${i === at ? 'bg-white/10' : ''} ${on ? 'text-p1' : ''}`}>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {on && <Check size={15} className="shrink-0" />}
                </button>
              );
            })}
            {fresh && (
              <button type="button" role="option" aria-selected={false} data-at={at >= found.length ? '' : undefined}
                onClick={create} onMouseMove={() => setAt(found.length)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-p1 ${at >= found.length ? 'bg-white/10' : ''}`}>
                <Plus size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">Create “{typed}”</span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
