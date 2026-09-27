// The one row shape every destination uses, wherever it appears -- pinned in the
// sidebar or inside the settings menu. Same height, same icon box, same hover, so a
// list of them reads as a list rather than as six separate buttons.

export const Row = ({ icon, label, badge, active, onClick, ...rest }) => (
  <button onClick={onClick}
    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm transition
      ${active ? 'bg-white/10 text-txt' : 'text-txt/85 hover:bg-white/[0.06]'}`} {...rest}>
    <span className={`grid size-[18px] shrink-0 place-items-center ${active ? 'text-txt' : 'text-mute'}`}>{icon}</span>
    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    {badge}
  </button>
);

// A count only earns colour when it is asking for something: a licence about to lapse,
// a to-do that is due, a message nobody has read. Everything else stays quiet.
export const Count = ({ n, tone }) => n > 0 && (
  <span className={`shrink-0 rounded-full px-1.5 text-[11px] font-semibold leading-[18px]
    ${tone === 'unread' ? 'bg-emerald-500/90 text-white' : 'bg-warn/90 text-[#141128]'}`}>
    {n > 99 ? '99+' : n}
  </span>
);
