import { useCallback, useRef, useState } from 'react';
import { ChevronLeft, Search, X } from 'lucide-react';
import TodoPanel from './Todos';
import RoutinePanel from './Routines';

// Two lists, deliberately separate everywhere it matters — different tables, different
// modules, different tools — meeting only here, in a tab strip. Separating the models
// without separating the screen is the point: a todo and a routine are not the same kind
// of thing, but "what do I have to do today" is still one question with one answer.

const Tab = ({ active, count, onClick, children }) => (
  <button onClick={onClick}
    className={`flex items-center justify-center gap-1.5 rounded-full py-1.5 text-sm transition ${active ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
    {children}
    {count > 0 && (
      <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-ink">{count}</span>
    )}
  </button>
);

export default function ListsPage({ onBack, onChanged, initialTab = 'todos' }) {
  const [tab, setTab] = useState(initialTab);
  const [counts, setCounts] = useState({ todos: 0, routines: 0 });
  // One search box for both tabs: it filters whichever list is showing, and keeps its
  // words when the tab changes, so "did I put the licence on a todo or a routine?" is
  // answered by flicking between the two.
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  const openSearch = () => { setSearching(true); setTimeout(() => box.current?.focus(), 0); };
  const closeSearch = () => { setSearching(false); setQ(''); };

  // Stable, and a no-op when the number has not moved: a panel reports its count from an
  // effect, so a fresh function or a pointless setState here would loop the pair of them.
  const onTodoDue = useCallback((n) => setCounts((c) => (c.todos === n ? c : { ...c, todos: n })), []);
  const onRoutineDue = useCallback((n) => setCounts((c) => (c.routines === n ? c : { ...c, routines: n })), []);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      {/* The panel paints solid over the chat, so it carries its own field. */}
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <div className="grid flex-1 grid-cols-2 rounded-full bg-white/5 p-1 sm:max-w-xs">
            <Tab active={tab === 'todos'} count={counts.todos} onClick={() => setTab('todos')}>To-do</Tab>
            <Tab active={tab === 'routines'} count={counts.routines} onClick={() => setTab('routines')}>Routines</Tab>
          </div>
          <button onClick={searching ? closeSearch : openSearch} aria-label={searching ? 'Close search' : 'Search'}
            title={searching ? 'Close search' : 'Search'}
            className={`ml-auto grid size-10 shrink-0 place-items-center rounded-full transition ${searching ? 'bg-white/15 text-txt' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
            {searching ? <X size={19} /> : <Search size={19} />}
          </button>
        </div>
        {searching && (
          <div className="mx-auto mt-2.5 flex w-full items-center gap-2 rounded-full border border-stroke bg-white/[0.04] px-3.5 focus-within:border-p1/60">
            <Search size={15} className="shrink-0 text-mute" />
            <input ref={box} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
              placeholder={tab === 'todos' ? 'Search to-dos' : 'Search routines'} enterKeyHint="search"
              className="min-w-0 flex-1 bg-transparent py-2 text-[15px] outline-none placeholder:text-mute/70" />
            {q && (
              <button onClick={() => { setQ(''); box.current?.focus(); }} aria-label="Clear" className="text-mute hover:text-txt"><X size={15} /></button>
            )}
          </div>
        )}
      </header>

      {/* Both stay mounted: switching tabs should not throw away a half-typed line, and
          each keeps reporting its count so the other tab's badge stays honest. */}
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'todos' ? '' : 'hidden'}`}>
        <TodoPanel onChanged={onChanged} onDue={onTodoDue} q={q} />
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'routines' ? '' : 'hidden'}`}>
        <RoutinePanel onChanged={onChanged} onDue={onRoutineDue} q={q} />
      </div>
    </div>
  );
}
