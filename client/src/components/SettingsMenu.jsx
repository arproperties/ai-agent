import { useEffect, useRef, useState } from 'react';
import { Users, ListTodo, AudioLines, Captions, ClipboardList, ListChecks, HardHat, Package, Landmark, KeyRound, Globe, Moon, Sun } from 'lucide-react';
import Icon from './Icon';
import Avatar, { AGENT_COLORS } from './Avatar';
import { THEMES, currentTheme, setTheme } from '../lib/theme';

// The mark for "this one": a thin ring standing clear of the disc, not painted over it.
const WORN = 'outline outline-2 outline-offset-2 outline-p1';

// A destination drawn the way an agent is: a coloured disc with its name underneath, so
// the tools read as a second shelf of the same kind of thing. A count that is asking for
// something sits on the disc's shoulder, and the place you are already in wears a ring.
const Tile = ({ icon, label, color, active, n = 0, onClick, ...rest }) => (
  <button role="menuitem" onClick={onClick} title={label} className="group flex flex-col items-center gap-1" {...rest}>
    <span className={`relative grid size-8 place-items-center rounded-full bg-gradient-to-br text-white shadow-lg transition group-hover:scale-105 group-active:scale-95
      ${AGENT_COLORS[color]} ${active ? WORN : ''}`}>
      {icon}
      {n > 0 && (
        <span className="absolute -right-1.5 -top-1 rounded-full bg-warn px-1 text-[10px] font-semibold leading-[15px] text-ink">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </span>
    <span className={`w-full truncate px-0.5 text-center text-[11px] group-hover:text-txt ${active ? 'text-txt' : 'text-mute'}`}>{label}</span>
  </button>
);

/**
 * The gear in the sidebar footer, and the menu it opens above itself.
 *
 * These are places rather than preferences, but they are places you visit
 * occasionally, so they live behind one button instead of taking a permanent row each
 * away from the chat list.
 *
 * Two of them can be waiting on you -- a licence about to lapse, a to-do that is due --
 * and a number nobody can see is a number that stops working. So the counts stay on the
 * items inside, and a single dot on the gear says "something in here wants you".
 *
 * Theme is the one real preference in here. Its swatches sit in the menu like everything
 * else, and choosing one leaves the menu open, so you can try a few against the app
 * behind it before settling.
 */
export default function SettingsMenu({ user, agents = [], onEditAgent, expiring = 0, dueTodos = 0, filesOpen, todosOpen, meetingsOpen, transcribeOpen, dutiesOpen, checklistsOpen, hasBuildings, buildingsOpen, inventoryOpen, propertiesOpen, leasingOpen, onFiles, onTodos, onMeetings, onTranscribe, onDuties, onChecklists, onBuildings, onInventory, onProperties, onLeasing, onMemory, onEmail, onPeople, onRegion }) {
  const [open, setOpen] = useState(false);
  const [theme, setWorn] = useState(currentTheme);
  const wrap = useRef(null);

  // Clicking anywhere else, or pressing Escape, puts it away -- the two things everyone
  // tries first when a menu is in the way.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  // Picking somewhere closes the menu on the way there.
  const go = (fn) => () => { setOpen(false); fn(); };
  const waiting = expiring + dueTodos;
  // With a single agent the grid is just one avatar saying what the whole app already
  // says, so only show it to the master (who adds agents here) or to anyone who really
  // does have a team.
  const showTeam = user.role === 'master' || agents.length > 1;

  return (
    // Not `relative`: the menu is positioned against the footer instead, so it spans
    // the sidebar rather than hanging off the gear. It stays a DOM child here, which is
    // what keeps the outside-click check below working.
    <div ref={wrap}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={waiting ? `Settings, ${waiting} need attention` : 'Settings'} title="Settings"
        className={`relative grid size-8 place-items-center rounded-full transition ${open ? 'bg-white/10 text-txt' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
        <Icon name="gear" size={17} />
        {waiting > 0 && <span className="absolute right-1 top-1 size-[7px] rounded-full bg-warn ring-2 ring-rail" />}
      </button>

      {open && (
        <div role="menu" aria-label="Settings"
          className="menu-glass absolute bottom-full left-2 right-2 z-50 mb-1 space-y-0.5 rounded-xl p-1.5">
          {showTeam && (
            <div className="mb-1 border-b border-stroke/60 pb-2.5">
              <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-mute/80">
                <span>Your AI agents</span><span>{agents.length}</span>
              </div>
              <div className="grid grid-cols-4 gap-y-3 px-1.5 pt-1">
                {agents.map((a) => (
                  <button key={a.id} role="menuitem" onClick={go(() => onEditAgent(a))} title={`Edit ${a.name}`} className="group flex flex-col items-center gap-1">
                    <Avatar icon={a.icon} color={a.color} size={32} className="transition group-hover:scale-105 group-active:scale-95" />
                    <span className="w-full truncate px-0.5 text-center text-[11px] text-mute group-hover:text-txt">{a.name.split(' ')[0]}</span>
                  </button>
                ))}
                {/* Only the master creates agents; the server refuses anyone else, so do not
                    offer a form that can only end in "Not allowed". */}
                {user.role === 'master' && (
                  <button role="menuitem" onClick={go(() => onEditAgent({}))} className="group flex flex-col items-center gap-1" aria-label="New agent">
                    <span className="grid size-8 place-items-center rounded-full border border-dashed border-white/25 text-mute transition group-hover:border-p1 group-hover:text-p1">
                      <Icon name="plus" size={14} />
                    </span>
                    <span className="text-[11px] text-mute">Add</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="mb-1 border-b border-stroke/60 pb-2.5">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-mute/80">Your tools</div>
            <div className="grid grid-cols-4 gap-y-3 px-1.5 pt-1">
              <Tile color="amber" icon={<Icon name="folder" size={15} />} label="Shelf" active={filesOpen} onClick={go(onFiles)}
                aria-label={expiring ? `Shelf (${expiring} expiring)` : 'Shelf'} n={expiring} />
              <Tile color="teal" icon={<ListTodo size={15} strokeWidth={1.75} />} label="To-do" active={todosOpen} onClick={go(onTodos)}
                aria-label={dueTodos ? `To-do (${dueTodos} due)` : 'To-do'} n={dueTodos} />
              <Tile color="violet" icon={<AudioLines size={15} strokeWidth={1.75} />} label="Meetings" active={meetingsOpen} onClick={go(onMeetings)} />
              <Tile color="blue" icon={<Captions size={15} strokeWidth={1.75} />} label="Transcribe" active={transcribeOpen} onClick={go(onTranscribe)} />
              {/* "My responsibilities" does not fit under a tile, so the tile says the short
                  word and the full name stays on hover and for screen readers. */}
              <Tile color="rose" icon={<ClipboardList size={15} strokeWidth={1.75} />} label="Duties" active={dutiesOpen} onClick={go(onDuties)}
                aria-label="My responsibilities" title="My responsibilities" />
              <Tile color="teal" icon={<ListChecks size={15} strokeWidth={1.75} />} label="Checklists" active={checklistsOpen} onClick={go(onChecklists)} />
              {/* Only for the master and for whoever runs a building: the field staff's jobs. */}
              {hasBuildings && <Tile color="amber" icon={<HardHat size={15} strokeWidth={1.75} />} label="Buildings" active={buildingsOpen} onClick={go(onBuildings)} />}
              {/* The same people keep the inventory of those buildings. */}
              {hasBuildings && <Tile color="blue" icon={<Package size={15} strokeWidth={1.75} />} label="Inventory" active={inventoryOpen} onClick={go(onInventory)} />}
              <Tile color="slate" icon={<Landmark size={15} strokeWidth={1.75} />} label="Properties" active={propertiesOpen} onClick={go(onProperties)} />
              <Tile color="amber" icon={<KeyRound size={15} strokeWidth={1.75} />} label="Leasing" active={leasingOpen} onClick={go(onLeasing)} />
              <Tile color="violet" icon={<Icon name="brain" size={15} />} label="Memory" onClick={go(onMemory)} />
              <Tile color="blue" icon={<Icon name="mail" size={15} />} label="Email" onClick={go(onEmail)} />
              {/* Only the master manages people; the server refuses anyone else. */}
              {user.role === 'master' && <Tile color="teal" icon={<Users size={15} />} label="People" onClick={go(onPeople)} />}
              {/* The business's currency, time zone and phone country code: the master's to set. */}
              {user.role === 'master' && <Tile color="slate" icon={<Globe size={15} strokeWidth={1.75} />} label="Region" onClick={go(onRegion)}
                aria-label="Currency and time zone" title="Currency and time zone" />}
            </div>
          </div>
          <div className="pb-1.5">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-mute/80">Theme</div>
            <div className="grid grid-cols-4 gap-y-3 px-1.5 pt-1">
              {THEMES.map((t) => {
                const worn = t.id === theme;
                return (
                  <button key={t.id} role="menuitemradio" aria-checked={worn} onClick={() => setWorn(setTheme(t.id))} title={t.name}
                    className="group flex flex-col items-center gap-1">
                    {/* The theme's own accent, fading toward its background: dark themes come
                        out deep, light ones soft, and the moon or sun says which is which. */}
                    <span style={{ background: `linear-gradient(135deg, ${t.accent}, color-mix(in srgb, ${t.accent} 55%, ${t.ground}))` }}
                      className={`grid size-8 place-items-center rounded-full text-white shadow-lg transition group-hover:scale-105 group-active:scale-95 ${worn ? WORN : ''}`}>
                      {t.light ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
                    </span>
                    <span className={`w-full truncate px-0.5 text-center text-[11px] group-hover:text-txt ${worn ? 'text-txt' : 'text-mute'}`}>{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
