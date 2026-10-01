import { useEffect } from 'react';
import { X } from 'lucide-react';

// The pop-up for a team-chat message that lands while Reem is open but somewhere else —
// another chat, an AI chat, the Files screen. Like WhatsApp on the desktop: name and words
// at the top, gone by itself after a few seconds, tap to open that chat.
export default function MessageToast({ toast, onOpen, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-4 pt-safe sm:justify-end sm:px-5">
      <div key={toast.key} className="rise pointer-events-auto mt-3 flex w-full max-w-sm items-start gap-3 rounded-2xl border border-stroke bg-[#141225]/95 p-3 shadow-2xl backdrop-blur-xl">
        <button onClick={() => onOpen(toast.chatId)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-sm font-medium text-white">
            {toast.title.trim()[0]?.toUpperCase() || '•'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{toast.title}</span>
            <span className="line-clamp-2 text-[13px] text-mute">{toast.body}</span>
          </span>
        </button>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-full p-1 text-mute hover:bg-white/10 hover:text-txt">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
