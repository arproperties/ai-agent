import { useCallback, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
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
      <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-[#141128]">{count}</span>
    )}
  </button>
);

export default function ListsPage({ onBack, onChanged, initialTab = 'todos' }) {
  const [tab, setTab] = useState(initialTab);
  const [counts, setCounts] = useState({ todos: 0, routines: 0 });

  // Stable, and a no-op when the number has not moved: a panel reports its count from an
  // effect, so a fresh function or a pointless setState here would loop the pair of them.
  const onTodoDue = useCallback((n) => setCounts((c) => (c.todos === n ? c : { ...c, todos: n })), []);
  const onRoutineDue = useCallback((n) => setCounts((c) => (c.routines === n ? c : { ...c, routines: n })), []);

  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <div className="grid flex-1 grid-cols-2 rounded-full bg-white/5 p-1 sm:max-w-xs">
            <Tab active={tab === 'todos'} count={counts.todos} onClick={() => setTab('todos')}>To-do</Tab>
            <Tab active={tab === 'routines'} count={counts.routines} onClick={() => setTab('routines')}>Routines</Tab>
          </div>
        </div>
      </header>

      {/* Both stay mounted: switching tabs should not throw away a half-typed line, and
          each keeps reporting its count so the other tab's badge stays honest. */}
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'todos' ? '' : 'hidden'}`}>
        <TodoPanel onChanged={onChanged} onDue={onTodoDue} />
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'routines' ? '' : 'hidden'}`}>
        <RoutinePanel onChanged={onChanged} onDue={onRoutineDue} />
      </div>
    </div>
  );
}
