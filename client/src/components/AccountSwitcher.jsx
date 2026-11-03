import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, UserPlus } from 'lucide-react';
import { api } from '../lib/api';

const Initial = ({ name }) => (
  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-medium">{name[0]?.toUpperCase()}</span>
);

/**
 * The name at the foot of the sidebar, which opens the account switcher: someone with a
 * personal and a business account stays signed in to both on this browser and moves
 * between them with one tap. One account is active at a time, in every tab.
 */
export default function AccountSwitcher({ user, onSwitch, onAdd }) {
  const [open, setOpen] = useState(false);
  const [others, setOthers] = useState([]);
  const wrap = useRef(null);

  // Asked each time it opens: a parked account can end elsewhere (password changed).
  useEffect(() => {
    if (!open) return undefined;
    api.get('/auth/accounts').then((r) => setOthers(r.accounts)).catch(() => setOthers([]));
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  const go = (fn) => () => { setOpen(false); fn(); };

  return (
    // Not `relative`, like the settings menu: the list spans the sidebar footer.
    <div ref={wrap} className="min-w-0 flex-1">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Switch account"
        className="flex w-full min-w-0 items-center gap-2 rounded-lg py-0.5 pl-1 pr-0.5 text-left hover:bg-white/[0.06]">
        <Initial name={user.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{user.name}</span>
          <span className="block truncate text-xs text-mute">{user.email}</span>
        </span>
        <ChevronsUpDown size={12} className="shrink-0 text-mute" />
      </button>

      {open && (
        <div role="menu" aria-label="Accounts" className="menu-glass absolute bottom-full left-2 right-2 z-50 mb-1 rounded-xl p-1.5">
          <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
            <Initial name={user.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{user.name}</span>
              <span className="block truncate text-xs text-mute">{user.email}</span>
            </span>
            <Check size={16} className="shrink-0 text-p1" />
          </div>
          {others.map((a) => (
            <button key={a.id} role="menuitem" onClick={go(() => onSwitch(a.id))}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.06]">
              <Initial name={a.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{a.name}</span>
                <span className="block truncate text-xs text-mute">{a.email}</span>
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-stroke/60" />
          <button role="menuitem" onClick={go(onAdd)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-mute hover:bg-white/[0.06] hover:text-txt">
            <span className="grid size-8 shrink-0 place-items-center"><UserPlus size={17} /></span>
            Add another account
          </button>
        </div>
      )}
    </div>
  );
}
