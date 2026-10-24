import { useEffect, useRef, useState } from 'react';
import { Users, ListTodo, AudioLines, Captions, Languages, Building2, ClipboardList, ListChecks, HardHat, Package, Split, Moon, Sun, FileSignature, Inbox, BookUser, Receipt } from 'lucide-react';
import Icon from './Icon';
import { Row, Count } from './NavRow';
import { THEMES, currentTheme, setTheme } from '../lib/theme';

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
 * Theme is the one real preference in here. Its swatches sit at the foot of the menu,
 * and choosing one leaves the menu open, so you can try each against the app behind it
 * before settling.
 */
export default function SettingsMenu({ user, expiring = 0, dueTodos = 0, tenantCare, mailRoutingOpen, onMailRouting, addressBookOpen, onAddressBook, billingOpen, onBilling, sharedInbox, sharedInboxOpen, onSharedInbox, filesOpen, todosOpen, translateOpen, meetingsOpen, transcribeOpen, tenantCareOpen, dutiesOpen, checklistsOpen, hasBuildings, buildingsOpen, inventoryOpen, modules = [], renewalsOpen, onRenewals, onFiles, onTodos, onTranslate, onMeetings, onTranscribe, onTenantCare, onDuties, onChecklists, onBuildings, onInventory, onMemory, onEmail, onPeople }) {
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
  const waiting = expiring + dueTodos + (tenantCare?.waiting || 0);
  // Reem's own modules (server/modules.js): a row is there only for the people the master
  // has given it to, and for the master.
  const has = (key) => modules.includes(key);

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
          {has('shelf') && (
            <Row role="menuitem" icon={<Icon name="folder" size={17} />} label="Shelf" active={filesOpen} onClick={go(onFiles)}
              aria-label={expiring ? `Shelf (${expiring} expiring)` : 'Shelf'} badge={<Count n={expiring} />} />
          )}
          {has('todos') && (
            <Row role="menuitem" icon={<ListTodo size={17} strokeWidth={1.75} />} label="To-do" active={todosOpen} onClick={go(onTodos)}
              aria-label={dueTodos ? `To-do (${dueTodos} due)` : 'To-do'} badge={<Count n={dueTodos} />} />
          )}
          {has('translate') && <Row role="menuitem" icon={<Languages size={17} strokeWidth={1.75} />} label="Live Translator" active={translateOpen} onClick={go(onTranslate)} />}
          {has('meetings') && <Row role="menuitem" icon={<AudioLines size={17} strokeWidth={1.75} />} label="Meetings" active={meetingsOpen} onClick={go(onMeetings)} />}
          {has('transcribe') && <Row role="menuitem" icon={<Captions size={17} strokeWidth={1.75} />} label="Transcribe" active={transcribeOpen} onClick={go(onTranscribe)} />}
          {/* Only for the people who look after the tenant inbox (and the master). */}
          {tenantCare?.member && (
            <Row role="menuitem" icon={<Building2 size={17} strokeWidth={1.75} />} label="Tenant care" active={tenantCareOpen} onClick={go(onTenantCare)}
              aria-label={tenantCare.waiting ? `Tenant care (${tenantCare.waiting} waiting)` : 'Tenant care'} badge={<Count n={tenantCare.waiting} />} />
          )}
          {has('renewals') && <Row role="menuitem" icon={<FileSignature size={17} strokeWidth={1.75} />} label="Lease renewals" active={renewalsOpen} onClick={go(onRenewals)} />}
          {/* The shared mailbox: who each email goes to, and who sent what. The master's alone. */}
          {user.role === 'master' && <Row role="menuitem" icon={<Split size={17} strokeWidth={1.75} />} label="Mail routing" active={mailRoutingOpen} onClick={go(onMailRouting)} />}
          {/* The company mailboxes Reem may send to. The master's alone. */}
          {user.role === 'master' && <Row role="menuitem" icon={<BookUser size={17} strokeWidth={1.75} />} label="Address book" active={addressBookOpen} onClick={go(onAddressBook)} />}
          {/* What the AI cost, by person, job and model. The master's alone. */}
          {user.role === 'master' && <Row role="menuitem" icon={<Receipt size={17} strokeWidth={1.75} />} label="Billing" active={billingOpen} onClick={go(onBilling)} />}
          {/* The emails Mail routing passed on to them, answered from the shared address. */}
          {sharedInbox && <Row role="menuitem" icon={<Inbox size={17} strokeWidth={1.75} />} label="Shared inbox" active={sharedInboxOpen} onClick={go(onSharedInbox)} />}
          {has('duties') && <Row role="menuitem" icon={<ClipboardList size={17} strokeWidth={1.75} />} label="My responsibilities" active={dutiesOpen} onClick={go(onDuties)} />}
          {has('checklists') && <Row role="menuitem" icon={<ListChecks size={17} strokeWidth={1.75} />} label="Checklists" active={checklistsOpen} onClick={go(onChecklists)} />}
          {/* Only for the master and for whoever runs a building: the field staff's jobs. */}
          {hasBuildings && <Row role="menuitem" icon={<HardHat size={17} strokeWidth={1.75} />} label="Buildings" active={buildingsOpen} onClick={go(onBuildings)} />}
          {/* The same people keep the inventory of those buildings. */}
          {hasBuildings && <Row role="menuitem" icon={<Package size={17} strokeWidth={1.75} />} label="Inventory" active={inventoryOpen} onClick={go(onInventory)} />}
          {has('memory') && <Row role="menuitem" icon={<Icon name="brain" size={17} />} label="Memory" onClick={go(onMemory)} />}
          {has('email') && <Row role="menuitem" icon={<Icon name="mail" size={17} />} label="Email" onClick={go(onEmail)} />}
          {/* Only the master manages people; the server refuses anyone else. */}
          {user.role === 'master' && <Row role="menuitem" icon={<Users size={17} />} label="People" onClick={go(onPeople)} />}
          <div className="mt-1 flex items-center gap-3 border-t border-stroke/60 px-3 pb-1.5 pt-2.5">
            <span className="flex-1 text-[11px] font-medium text-mute/80">Theme</span>
            {THEMES.map((t) => {
              const worn = t.id === theme;
              return (
                <button key={t.id} role="menuitemradio" aria-checked={worn} onClick={() => setWorn(setTheme(t.id))} title={t.name} aria-label={`${t.name} theme`}
                  // The theme's own accent, fading toward its background: the dark one comes
                  // out deep, the light one soft, and the moon or sun says which is which.
                  style={{ background: `linear-gradient(135deg, ${t.accent}, color-mix(in srgb, ${t.accent} 55%, ${t.ground}))` }}
                  className={`grid size-8 place-items-center rounded-full text-white shadow-lg transition hover:scale-105 active:scale-95 ${worn ? 'outline outline-2 outline-offset-2 outline-p1' : ''}`}>
                  {t.light ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
