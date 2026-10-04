import { ChevronLeft } from 'lucide-react';

// The full-screen frame the sidebar's places open in (same look as Transcribe, Meetings…),
// for pages that are just a title and some content.
export default function Page({ title, action, onBack, children }) {
  return (
    <div className="sky absolute inset-0 z-20 flex flex-col">
      <header className="px-4 pb-3 pt-safe md:px-8">
        <div className="mx-auto flex w-full items-center gap-2 pt-1">
          <button onClick={onBack} aria-label="Back" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
            <ChevronLeft size={22} />
          </button>
          <h1 className="flex-1 text-lg font-light">{title}</h1>
          {action}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-safe md:px-8">
        <div className="mx-auto w-full pb-8">{children}</div>
      </div>
    </div>
  );
}
