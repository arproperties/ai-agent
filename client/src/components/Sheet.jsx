import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

// Bottom sheet on phones, centred dialog on desktop
export default function Sheet({ title, icon, tabs, tab, onTab, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-md md:items-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="rise flex max-h-[92dvh] w-full flex-col rounded-t-[28px] border border-stroke bg-[#141128] shadow-2xl shadow-black/50 md:max-w-lg md:rounded-[28px]">
        <div className="flex items-center gap-2.5 px-5 pb-2 pt-4">
          {icon}
          <h2 className="flex-1 truncate text-lg font-light">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full text-mute hover:bg-white/10"><Icon name="x" /></button>
        </div>
        {tabs?.length > 0 && (
          <div className="mx-5 mb-2 grid rounded-full bg-white/5 p-1 text-sm" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
            {tabs.map(([k, l]) => (
              <button key={k} onClick={() => onTab(k)}
                className={`rounded-full py-1.5 transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l}</button>
            ))}
          </div>
        )}
        <div className="overflow-y-auto px-5 pb-safe pt-2"><div className="pb-4">{children}</div></div>
      </div>
    </div>,
    document.body,
  );
}
