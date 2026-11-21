import { useState } from 'react';
import { MessageCircle, RotateCcw } from 'lucide-react';
import { whatsappUrl } from '../lib/whatsapp';

// A WhatsApp message Reem got ready (server/whatsapp.js): who it is for, the words, and a button.
// The words can be changed right here before opening: the button's link is built from whatever
// is in the box when it is tapped, so there is no need to ask the agent to write it again.
// WhatsApp is never opened by itself: the person taps Open WhatsApp (a new tab, with the words
// already typed), then presses send there. Nothing is sent from Reem.
export default function WhatsAppCard({ card }) {
  const [text, setText] = useState(card.message);
  const edited = text !== card.message;
  const empty = !text.trim();
  // The link follows the box; an empty box has nothing to open with.
  const url = empty ? null : whatsappUrl(card.phone, card.name, text);

  return (
    <div className="rounded-2xl border border-ok/40 bg-ok/[0.06] p-3.5 text-sm">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ok">
        <MessageCircle size={13} strokeWidth={2} />
        WhatsApp · {card.name ? `${card.name} · ` : ''}+{card.phone}
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} dir="auto" aria-label="Message"
        rows={Math.min(8, Math.max(2, text.split('\n').length, Math.ceil(text.length / 70)))}
        className="w-full resize-y rounded-xl bg-white/5 px-3 py-2 text-[15px] leading-snug outline-none focus:ring-1 focus:ring-ok/50" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ok/20 px-4 text-sm font-medium transition hover:bg-ok/30">
            <MessageCircle size={15} /> Open WhatsApp
          </a>
        ) : (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/5 px-4 text-sm font-medium text-mute">
            <MessageCircle size={15} /> Write a message first
          </span>
        )}
        {edited && (
          <button type="button" onClick={() => setText(card.message)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs text-mute hover:bg-white/10 hover:text-txt">
            <RotateCcw size={13} /> Back to Reem's wording
          </button>
        )}
        <span className="text-xs text-mute">Change the words if you like, then tap. Nothing is sent from Reem.</span>
      </div>
    </div>
  );
}
