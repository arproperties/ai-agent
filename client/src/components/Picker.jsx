import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

/**
 * Choosing one thing from a list: a button that opens the list under itself, with a box
 * to type in so a long list is searched rather than scrolled. Used instead of the
 * browser's own dropdown, which cannot be searched and ignores the look of the app.
 *
 * options: [{ value, label, hint?, group? }]. Options that share a `group` and follow one
 * another sit under that word as a heading. `none` is the label of the "nothing chosen" row
 * (value ''), left out when a choice is required. `icon` sits before the chosen label.
 */
export default function Picker({ value, onChange, options, none, icon, placeholder = 'Choose', searchPlaceholder = 'Search', className = '' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0); // the row the arrow keys are on
  const wrap = useRef(null);
  const input = useRef(null);

  const all = useMemo(() => [...(none ? [{ value: '', label: none, quiet: true }] : []), ...options], [none, options]);
  const shown = useMemo(() => {
    const want = q.trim().toLowerCase();
    return want ? all.filter((o) => `${o.label} ${o.hint || ''} ${o.group || ''}`.toLowerCase().includes(want)) : all;
  }, [all, q]);
  const current = all.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return undefined;
    setQ('');
    setAt(Math.max(0, all.findIndex((o) => o.value === value)));
    input.current?.focus();
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
    // Only when it opens: typing must not put the highlight back on the saved choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (o) => { onChange(o.value); setOpen(false); };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((n) => Math.min(shown.length - 1, n + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setAt((n) => Math.max(0, n - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); if (shown[at]) pick(shown[at]); }
  };

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className={`glass flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left outline-none transition ${open ? 'border-p1/70' : 'hover:border-white/20'}`}>
        {icon}
        <span className={`min-w-0 flex-1 truncate ${!current || current.quiet ? 'text-mute' : ''}`}>{current?.label || placeholder}</span>
        <ChevronDown size={16} className={`shrink-0 text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="menu-glass absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl">
          <div className="flex items-center gap-2 border-b border-stroke/70 px-3 py-2">
            <Search size={15} className="shrink-0 text-mute" />
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} onKeyDown={key} placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute/70" />
          </div>
          <ul role="listbox" className="max-h-60 overflow-y-auto p-1.5">
            {shown.map((o, n) => (
              <Fragment key={o.value}>
                {o.group && o.group !== shown[n - 1]?.group && (
                  <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-medium tracking-[0.14em] text-mute">{o.group.toUpperCase()}</li>
                )}
                <li role="option" aria-selected={o.value === value}>
                  <button type="button" onClick={() => pick(o)} onPointerMove={() => setAt(n)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${n === at ? 'bg-white/10' : ''}`}>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${o.quiet ? 'text-mute' : ''}`}>{o.label}</span>
                      {o.hint && <span className="block truncate text-xs text-mute">{o.hint}</span>}
                    </span>
                    {o.value === value && <Check size={15} className="shrink-0 text-p1" />}
                  </button>
                </li>
              </Fragment>
            ))}
            {shown.length === 0 && <li className="px-2.5 py-3 text-center text-sm text-mute">Nothing matches "{q.trim()}"</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
