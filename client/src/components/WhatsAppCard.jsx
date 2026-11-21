import { MessageCircle } from 'lucide-react';

// A WhatsApp message Reem got ready (server/whatsapp.js): who it is for, the words, and a button.
// WhatsApp is never opened by itself: the person taps Open WhatsApp (a new tab, with the words
// already typed), then presses send there. Nothing is sent from Reem.
export default function WhatsAppCard({ card }) {
  return (
    <div className="rounded-2xl border border-ok/40 bg-ok/[0.06] p-3.5 text-sm">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ok">
        <MessageCircle size={13} strokeWidth={2} />
        WhatsApp · {card.name ? `${card.name} · ` : ''}+{card.phone}
      </p>
      <p dir="auto" className="whitespace-pre-wrap break-words rounded-xl bg-white/5 px-3 py-2 text-[15px] leading-snug">{card.message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a href={card.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ok/20 px-4 text-sm font-medium transition hover:bg-ok/30">
          <MessageCircle size={15} /> Open WhatsApp
        </a>
        <span className="text-xs text-mute">Tap send there. Nothing is sent from Reem.</span>
      </div>
    </div>
  );
}
