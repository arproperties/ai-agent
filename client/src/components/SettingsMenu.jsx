import { useEffect, useRef, useState } from 'react';
import { Users, ListTodo, AudioLines, Captions, Building2, ClipboardList, Landmark } from 'lucide-react';
import Icon from './Icon';
import { Row, Count } from './NavRow';

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
 */
export default function SettingsMenu({ user, expiring = 0, dueTodos = 0, tenantCare, filesOpen, todosOpen, meetingsOpen, transcribeOpen, tenantCareOpen, dutiesOpen, propertiesOpen, onFiles, onTodos, onMeetings, onTranscribe, onTenantCare, onDuties, onProperties, onMemory, onEmail, onPeople }) {
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
  const waiting = expiring + dueTodos + (tenantCare?.waiting || 0);

  return (
    // Not `relative`: the menu is positioned against the footer instead, so it spans
    // the sidebar rather than hanging off the gear. It stays a DOM child here, which is
    // what keeps the outside-click check below working.
    <div ref={wrap}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={waiting ? `Settings, ${waiting} need attention` : 'Settings'} title="Settings"
        className={`relative grid size-8 place-items-center rounded-full transition ${open ? 'bg-white/10 text-txt' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
        <Icon name="gear" size={17} />
        {waiting > 0 && <span className="absolute right-1 top-1 size-[7px] rounded-full bg-warn ring-2 ring-[#0f0d20]" />}
      </button>

      {open && (
        <div role="menu" aria-label="Settings"
          className="menu-glass absolute bottom-full left-2 right-2 z-50 mb-1 space-y-0.5 rounded-xl p-1.5">
          <Row role="menuitem" icon={<Icon name="folder" size={17} />} label="Shelf" active={filesOpen} onClick={go(onFiles)}
            aria-label={expiring ? `Shelf (${expiring} expiring)` : 'Shelf'} badge={<Count n={expiring} />} />
          <Row role="menuitem" icon={<ListTodo size={17} strokeWidth={1.75} />} label="To-do" active={todosOpen} onClick={go(onTodos)}
            aria-label={dueTodos ? `To-do (${dueTodos} due)` : 'To-do'} badge={<Count n={dueTodos} />} />
          <Row role="menuitem" icon={<AudioLines size={17} strokeWidth={1.75} />} label="Meetings" active={meetingsOpen} onClick={go(onMeetings)} />
          <Row role="menuitem" icon={<Captions size={17} strokeWidth={1.75} />} label="Transcribe" active={transcribeOpen} onClick={go(onTranscribe)} />
          {/* Only for the people who look after the tenant inbox (and the master). */}
          {tenantCare?.member && (
            <Row role="menuitem" icon={<Building2 size={17} strokeWidth={1.75} />} label="Tenant care" active={tenantCareOpen} onClick={go(onTenantCare)}
              aria-label={tenantCare.waiting ? `Tenant care (${tenantCare.waiting} waiting)` : 'Tenant care'} badge={<Count n={tenantCare.waiting} />} />
          )}
          <Row role="menuitem" icon={<ClipboardList size={17} strokeWidth={1.75} />} label="My responsibilities" active={dutiesOpen} onClick={go(onDuties)} />
          <Row role="menuitem" icon={<Landmark size={17} strokeWidth={1.75} />} label="Properties" active={propertiesOpen} onClick={go(onProperties)} />
          <Row role="menuitem" icon={<Icon name="brain" size={17} />} label="Memory" onClick={go(onMemory)} />
          <Row role="menuitem" icon={<Icon name="mail" size={17} />} label="Email" onClick={go(onEmail)} />
          {/* Only the master manages people; the server refuses anyone else. */}
          {user.role === 'master' && <Row role="menuitem" icon={<Users size={17} />} label="People" onClick={go(onPeople)} />}
        </div>
      )}
    </div>
  );
}
