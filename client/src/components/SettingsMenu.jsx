import { useEffect, useRef, useState } from 'react';
import { Users, ListTodo, AudioLines, Captions, Languages, Building2, ClipboardList, ListChecks, HardHat, Package, Split, Moon, Sun, FileSignature, Inbox, BookUser, Receipt, KeyRound, Activity, FileClock, Gavel, ChevronRight, Search, PawPrint, Timer, Plug } from 'lucide-react';
import Icon from './Icon';
import { CaseTimeSheet } from './CaseRails';
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
// One folding group of rows. Closed, it is a single line (with the total of any counts
// inside, so nothing waiting goes unseen); open, it shows its rows. While searching,
// every group opens and keeps only the rows whose name matches. A group with nothing in
// it for this person (no module ticked, or no match) is left out entirely.
function Group({ title, open, onToggle, count = 0, q = '', children }) {
  const term = q.trim().toLowerCase();
  const rows = [].concat(children).filter(Boolean)
    .filter((r) => !term || String(r.props.label).toLowerCase().includes(term));
  if (!rows.length) return null;
  if (term) return <div className="space-y-0.5">{rows}</div>;
  return (
    <div>
      <button onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition hover:bg-white/[0.06]">
        <ChevronRight size={15} className={`text-mute transition ${open ? 'rotate-90' : ''}`} />
        <span className="flex-1">{title}</span>
        {!open && <Count n={count} />}
      </button>
      {open && <div className="space-y-0.5 pb-1 pl-3">{rows}</div>}
    </div>
  );
}

export default function SettingsMenu({ user, expiring = 0, dueTodos = 0, tenantCare, mailRoutingOpen, onMailRouting, addressBookOpen, onAddressBook, billingOpen, onBilling, healthOpen, onHealth, aiKeysOpen, onAiKeys, appsOpen, onApps, docRenewalsOpen, onDocRenewals, legalOpen, onLegal, sharedInbox, sharedInboxOpen, onSharedInbox, filesOpen, todosOpen, translateOpen, meetingsOpen, transcribeOpen, tenantCareOpen, dutiesOpen, checklistsOpen, hasBuildings, buildingsOpen, inventoryOpen, modules = [], petOn, onPet, renewalsOpen, onRenewals, onFiles, onTodos, onTranslate, onMeetings, onTranscribe, onTenantCare, onDuties, onChecklists, onBuildings, onInventory, onMemory, onEmail, onPeople }) {
  const [open, setOpen] = useState(false);
  const [theme, setWorn] = useState(currentTheme);
  const wrap = useRef(null);
  // One group open at a time; Work first, since that is where the counts usually are.
  const [group, setGroup] = useState('Work');
  const [q, setQ] = useState('');
  const [timeOpen, setTimeOpen] = useState(false); // Time on cases
  const fold = (name) => ({ q, open: group === name, onToggle: () => setGroup(group === name ? null : name) });

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
  const go = (fn) => () => { setOpen(false); setQ(''); fn(); };
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
          className="menu-glass absolute bottom-full left-2 right-2 z-50 mb-1 max-h-[75vh] overflow-y-auto rounded-xl p-1.5">
          <div className="mb-1 flex items-center gap-2 rounded-lg bg-white/[0.06] px-2.5">
            <Search size={15} className="shrink-0 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" autoFocus
              className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-mute/70" />
          </div>
          <Group title="Work" {...fold('Work')} count={expiring + dueTodos}>
            {has('shelf') && (
              <Row role="menuitem" icon={<Icon name="folder" size={17} />} label="Shelf" active={filesOpen} onClick={go(onFiles)}
                aria-label={expiring ? `Shelf (${expiring} expiring)` : 'Shelf'} badge={<Count n={expiring} />} />
            )}
            {has('todos') && (
              <Row role="menuitem" icon={<ListTodo size={17} strokeWidth={1.75} />} label="To-do" active={todosOpen} onClick={go(onTodos)}
                aria-label={dueTodos ? `To-do (${dueTodos} due)` : 'To-do'} badge={<Count n={dueTodos} />} />
            )}
            {has('duties') && <Row role="menuitem" icon={<ClipboardList size={17} strokeWidth={1.75} />} label="My responsibilities" active={dutiesOpen} onClick={go(onDuties)} />}
            {has('checklists') && <Row role="menuitem" icon={<ListChecks size={17} strokeWidth={1.75} />} label="Checklists" active={checklistsOpen} onClick={go(onChecklists)} />}
            {has('legal') && <Row role="menuitem" icon={<Gavel size={17} strokeWidth={1.75} />} label="Legal cases" active={legalOpen} onClick={go(onLegal)} />}
            {/* What the case timer in each case chat added up to: their own time only. */}
            {has('case_focus') && <Row role="menuitem" icon={<Timer size={17} strokeWidth={1.75} />} label="Time on cases" onClick={go(() => setTimeOpen(true))} />}
          </Group>
          <Group title="Property" {...fold('Property')} count={tenantCare?.waiting || 0}>
            {has('renewals') && <Row role="menuitem" icon={<FileSignature size={17} strokeWidth={1.75} />} label="Lease renewals" active={renewalsOpen} onClick={go(onRenewals)} />}
            {/* Only for the people who look after the tenant inbox (and the master). */}
            {tenantCare?.member && (
              <Row role="menuitem" icon={<Building2 size={17} strokeWidth={1.75} />} label="Tenant care" active={tenantCareOpen} onClick={go(onTenantCare)}
                aria-label={tenantCare.waiting ? `Tenant care (${tenantCare.waiting} waiting)` : 'Tenant care'} badge={<Count n={tenantCare.waiting} />} />
            )}
            {/* Only for the master and for whoever runs a building: the field staff's jobs. */}
            {hasBuildings && <Row role="menuitem" icon={<HardHat size={17} strokeWidth={1.75} />} label="Buildings" active={buildingsOpen} onClick={go(onBuildings)} />}
            {/* The same people keep the inventory of those buildings. */}
            {hasBuildings && <Row role="menuitem" icon={<Package size={17} strokeWidth={1.75} />} label="Inventory" active={inventoryOpen} onClick={go(onInventory)} />}
          </Group>
          <Group title="People & mail" {...fold('People & mail')}>
            {has('document_renewals') && <Row role="menuitem" icon={<FileClock size={17} strokeWidth={1.75} />} label="Document renewals" active={docRenewalsOpen} onClick={go(onDocRenewals)} />}
            {has('email') && <Row role="menuitem" icon={<Icon name="mail" size={17} />} label="Email" onClick={go(onEmail)} />}
            {/* The emails Mail routing passed on to them, answered from the shared address. */}
            {sharedInbox && <Row role="menuitem" icon={<Inbox size={17} strokeWidth={1.75} />} label="Shared inbox" active={sharedInboxOpen} onClick={go(onSharedInbox)} />}
            {/* The shared mailbox: who each email goes to, and who sent what. The master's alone. */}
            {user.role === 'master' && <Row role="menuitem" icon={<Split size={17} strokeWidth={1.75} />} label="Mail routing" active={mailRoutingOpen} onClick={go(onMailRouting)} />}
            {/* The company mailboxes Reem may send to. The master's alone. */}
            {user.role === 'master' && <Row role="menuitem" icon={<BookUser size={17} strokeWidth={1.75} />} label="Address book" active={addressBookOpen} onClick={go(onAddressBook)} />}
            {/* Only the master manages people; the server refuses anyone else. */}
            {user.role === 'master' && <Row role="menuitem" icon={<Users size={17} />} label="People" onClick={go(onPeople)} />}
          </Group>
          <Group title="Tools" {...fold('Tools')}>
            {has('translate') && <Row role="menuitem" icon={<Languages size={17} strokeWidth={1.75} />} label="Live Translator" active={translateOpen} onClick={go(onTranslate)} />}
            {has('meetings') && <Row role="menuitem" icon={<AudioLines size={17} strokeWidth={1.75} />} label="Meetings" active={meetingsOpen} onClick={go(onMeetings)} />}
            {has('transcribe') && <Row role="menuitem" icon={<Captions size={17} strokeWidth={1.75} />} label="Transcribe" active={transcribeOpen} onClick={go(onTranscribe)} />}
            {has('memory') && <Row role="menuitem" icon={<Icon name="brain" size={17} />} label="Memory" onClick={go(onMemory)} />}
            {/* What the AI cost, by person, job and model. The master's alone. */}
            {user.role === 'master' && <Row role="menuitem" icon={<Receipt size={17} strokeWidth={1.75} />} label="Billing" active={billingOpen} onClick={go(onBilling)} />}
            {/* Disk, memory, database and backups, and how fast they grow. The master's alone. */}
            {user.role === 'master' && onHealth && <Row role="menuitem" icon={<Activity size={17} strokeWidth={1.75} />} label="Server health" active={healthOpen} onClick={go(onHealth)} />}
            {/* The Claude and OpenAI keys everyone uses; anyone's own are on their profile in People. */}
            {user.role === 'master' && onAiKeys && <Row role="menuitem" icon={<KeyRound size={17} strokeWidth={1.75} />} label="AI keys" active={aiKeysOpen} onClick={go(onAiKeys)} />}
            {/* Mailboxes connected to Claude.ai as custom connectors. The master's alone. */}
            {user.role === 'master' && onApps && <Row role="menuitem" icon={<Plug size={17} strokeWidth={1.75} />} label="Apps" active={appsOpen} onClick={go(onApps)} />}
            {/* The pet is still being tried out: the master's alone, off until switched on here.
                A switch, not a place, so the menu stays open. */}
            {user.role === 'master' && onPet && (
              <Row role="menuitemcheckbox" aria-checked={!!petOn} icon={<PawPrint size={17} strokeWidth={1.75} />} label="Buddy (pet)" onClick={onPet}
                badge={(
                  <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${petOn ? 'bg-p1' : 'bg-white/15'}`}>
                    <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${petOn ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                )} />
            )}
          </Group>
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
      {timeOpen && <CaseTimeSheet onClose={() => setTimeOpen(false)} />}
    </div>
  );
}
