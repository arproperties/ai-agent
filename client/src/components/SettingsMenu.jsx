import { useEffect, useRef, useState } from 'react';
import { Users, ListTodo, AudioLines } from 'lucide-react';
import Icon from './Icon';
import { Row, Count } from './NavRow';

/**
 * The gear in the sidebar footer, and the menu it opens above itself.
 *
 * These six are places rather than preferences, but they are places you visit
 * occasionally, so they live behind one button instead of taking six permanent rows
 * away from the chat list.
 *
 * Two of them can be waiting on you -- a licence about to lapse, a to-do that is due --
 * and a number nobody can see is a number that stops working. So the counts stay on the
 * items inside, and a single dot on the gear says "something in here wants you".
 */
export default function SettingsMenu({ user, expiring = 0, dueTodos = 0, filesOpen, todosOpen, meetingsOpen, onFiles, onTodos, onMeetings, onMemory, onEmail, onPeople }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={wrap} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={waiting ? `Settings, ${waiting} need attention` : 'Settings'} title="Settings"
        className={`relative grid size-8 place-items-center rounded-full transition ${open ? 'bg-white/10 text-txt' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
        <Icon name="gear" size={17} />
        {waiting > 0 && <span className="absolute right-1 top-1 size-[7px] rounded-full bg-warn ring-2 ring-[#0f0d20]" />}
      </button>

      {open && (
        <div role="menu" aria-label="Settings"
          className="liquid-glass absolute bottom-full right-0 z-50 mb-2 w-56 space-y-0.5 rounded-xl border border-stroke p-1.5 shadow-xl">
          <Row role="menuitem" icon={<Icon name="folder" size={17} />} label="Shelf" active={filesOpen} onClick={go(onFiles)}
            aria-label={expiring ? `Shelf (${expiring} expiring)` : 'Shelf'} badge={<Count n={expiring} />} />
          <Row role="menuitem" icon={<ListTodo size={17} strokeWidth={1.75} />} label="To-do" active={todosOpen} onClick={go(onTodos)}
            aria-label={dueTodos ? `To-do (${dueTodos} due)` : 'To-do'} badge={<Count n={dueTodos} />} />
          <Row role="menuitem" icon={<AudioLines size={17} strokeWidth={1.75} />} label="Meetings" active={meetingsOpen} onClick={go(onMeetings)} />
          <Row role="menuitem" icon={<Icon name="brain" size={17} />} label="Memory" onClick={go(onMemory)} />
          <Row role="menuitem" icon={<Icon name="mail" size={17} />} label="Email" onClick={go(onEmail)} />
          {/* Only the master manages people; the server refuses anyone else. */}
          {user.role === 'master' && <Row role="menuitem" icon={<Users size={17} />} label="People" onClick={go(onPeople)} />}
        </div>
      )}
    </div>
  );
}
