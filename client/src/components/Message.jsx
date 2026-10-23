import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeMarkRows, markdownComponents } from '../lib/markRows';
import Icon from './Icon';
import Avatar from './Avatar';
import { hideMarkers } from '../lib/replyDoc';
import { splitDrawings, withoutDrawings, exportAsked } from '../lib/drawing';
import { DrawingCard, DrawingPending, DrawingFile } from './Drawing';
import { onSpokenWord } from '../lib/voice';
import { makeHighlighter } from '../lib/highlight';

const isImg = (f) => f.kind === 'image' || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name);
const isVid = (f) => f.kind === 'video' || /\.(mp4|mov|webm|m4v|3gp)$/i.test(f.name);
const isAud = (f) => f.kind === 'audio' || /\.(opus|ogg|oga|m4a|aac|amr|caf|mp3|wav|flac|weba)$/i.test(f.name);

// A voice note has no file to open; tapping it shows what was said instead.
function VoiceNote({ f }) {
  const [open, setOpen] = useState(false);
  const ready = f.transcript !== undefined;
  return (
    <div className="glass max-w-[320px] rounded-2xl py-2 pl-2 pr-3.5">
      <button onClick={() => ready && setOpen((o) => !o)} className="flex w-full items-center gap-2.5 text-left">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-p1/20 text-p1"><Icon name="mic" size={17} /></span>
        <span className="min-w-0">
          <span className="block truncate text-[13px]">{f.name}</span>
          <span className="text-[11px] text-mute">{!ready ? 'Listening…' : open ? 'Tap to hide' : 'Voice note · tap to read'}</span>
        </span>
      </button>
      {open && <p dir="auto" className="mt-2 whitespace-pre-wrap px-1 text-[13px] leading-relaxed">{f.transcript || 'No speech was heard.'}</p>}
    </div>
  );
}

// The files sent with a message, or - under a reply - the saved files Reem showed.
function Attachments({ files, onOpenFile, reply = false }) {
  if (!files?.length) return null;
  const open = (f) => f.docId && onOpenFile(f.docId);
  return (
    <div className={`flex flex-wrap gap-1.5 ${reply ? 'mt-3' : 'mb-1.5 justify-end'}`}>
      {files.map((f, i) => (isAud(f) && !f.docId ? <VoiceNote key={i} f={f} /> : isImg(f) && (f.preview || f.docId) ? (
        <button key={i} onClick={() => open(f)} aria-label={`View ${f.name}`}
          className="overflow-hidden rounded-2xl border border-stroke transition hover:border-white/30 active:scale-[0.98]">
          <img src={f.preview || `/api/documents/${f.docId}/file`} alt={f.name} className="h-36 max-w-[240px] object-cover" />
        </button>
      ) : (
        <button key={i} onClick={() => open(f)}
          className="glass flex max-w-[260px] items-center gap-2.5 rounded-2xl py-2 pl-2 pr-3.5 text-left transition hover:bg-white/10">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-p1/20 text-p1"><Icon name={isImg(f) ? 'image' : isVid(f) ? 'play' : 'file'} size={17} /></span>
          <span className="min-w-0">
            <span className="block truncate text-[13px]">{(reply && f.title) || f.name}</span>
            <span className="text-[11px] text-mute">{f.docId ? 'Tap to view' : 'Uploading…'}</span>
          </span>
        </button>
      )))}
    </div>
  );
}

// A picture Reem drew for /explain, /breakdown or /explore (server/pictures.js): shown
// whole, opened full size by a tap, with a way to keep it. The frame holds the picture's
// shape before it loads, so the chat does not jump.
function Pictures({ files }) {
  const pics = (files || []).filter((f) => f.pictureId);
  return pics.map((f) => (
    <div key={f.pictureId} className="mb-3 max-w-2xl">
      <a href={`/api/pictures/${f.pictureId}`} target="_blank" rel="noreferrer" aria-label={`Open ${f.name}`}
        className="block aspect-[3/2] overflow-hidden rounded-2xl border border-stroke bg-white transition hover:border-white/30">
        <img src={`/api/pictures/${f.pictureId}`} alt={f.name} className="size-full object-contain" />
      </a>
      <a href={`/api/pictures/${f.pictureId}?download=1`} download={f.name}
        className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-mute hover:bg-white/10 hover:text-txt">
        <Icon name="download" size={14} /> Save picture
      </a>
    </div>
  ));
}

// What the read-aloud button shows in each state. Tapping always does the
// obvious thing: start, pause, resume — or, while it is still being generated,
// give up waiting.
// When a message was sent: just the time today, "Yesterday 14:32", then the date.
function sentAt(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  if (d >= day) return time;
  if (d >= day - 86400000) return `Yesterday ${time}`;
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== day.getFullYear() && { year: 'numeric' }) });
  return `${date} ${time}`;
}

const Time = ({ ts }) => (ts ? <span className="px-1 text-[11px] text-mute/70">{sentAt(ts)}</span> : null);

const VOICE = {
  idle: { icon: 'speaker', label: 'Read aloud' },
  loading: { icon: 'spinner', label: 'Preparing…', hint: 'Preparing audio — tap to cancel', spin: true },
  speaking: { icon: 'pause', label: 'Playing', hint: 'Pause' },
  paused: { icon: 'play', label: 'Paused', hint: 'Resume' },
};

// A reply as it reads: its words, with any drawing shown as a picture where it was written.
function Reply({ content, savedId }) {
  const parts = splitDrawings(content);
  return parts.map((p, i) => (p.text !== undefined ? (
    <div key={i} className="md break-words text-[15px]"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypeMarkRows} components={markdownComponents}>{hideMarkers(p.text)}</Markdown></div>
  ) : p.pending ? <DrawingPending key={i} /> : <DrawingCard key={i} drawing={p.drawing} messageId={savedId} />));
}

// Select some of a reply and two buttons appear by it: Reply (draft an answer to what was
// selected) and Remove (take it out of the reply). Below the selection on a phone, where
// the phone's own copy menu sits above it.
function SelectionBar({ rootRef, onReply, onRemove }) {
  const [sel, setSel] = useState(null); // { text, x, y }

  useEffect(() => {
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const s = window.getSelection();
        const root = rootRef.current;
        const text = s && !s.isCollapsed ? s.toString().trim() : '';
        if (!text || !root || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return setSel(null);
        const box = s.getRangeAt(0).getBoundingClientRect();
        const below = window.matchMedia('(pointer: coarse)').matches;
        const x = Math.min(Math.max(box.left + box.width / 2, 90), window.innerWidth - 90);
        setSel({ text, x, y: below ? box.bottom + 12 : box.top - 52 });
      });
    };
    document.addEventListener('selectionchange', read);
    window.addEventListener('scroll', read, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('selectionchange', read); window.removeEventListener('scroll', read, true); };
  }, [rootRef]);

  if (!sel) return null;
  const act = (fn) => () => { fn(sel.text); window.getSelection()?.removeAllRanges(); setSel(null); };
  const btn = 'flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition hover:bg-white/10';
  return (
    // mousedown is stopped so tapping a button does not clear the selection first
    <div onMouseDown={(e) => e.preventDefault()} style={{ left: sel.x, top: Math.max(sel.y, 8) }}
      className="fixed z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-stroke bg-surface-2/95 p-1 shadow-xl shadow-black/40 backdrop-blur">
      {onReply && <button type="button" onClick={act(onReply)} className={btn}><Icon name="reply" size={14} /> Reply</button>}
      {onRemove && <button type="button" onClick={act(onRemove)} className={`${btn} hover:text-bad`}><Icon name="trash" size={14} /> Remove</button>}
    </div>
  );
}

// savedId: the reply's row, which the PDF and AutoCAD files are made from. drawingFrom: the
// latest drawing up to this reply, for a reply that hands it over as a file.
export default function Message({ msg, agent, voice = 'idle', onSpeak, onStopSpeak, voiceEnabled, onOpenFile, onShare, onPdf, onDelete, onReplyTo, onRemoveText, savedId, drawingFrom }) {
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef();
  const reading = voice !== 'idle';

  // While this reply is read aloud, each word lights up as it is said.
  useEffect(() => {
    if (!reading) return;
    const h = makeHighlighter(() => bodyRef.current);
    const off = onSpokenWord((e) => (e.reset ? h.clear() : h.word(e.word)));
    return () => { off(); h.clear(); };
  }, [reading]);

  if (msg.role === 'user') {
    return (
      <div className="rise ml-auto max-w-[85%]">
        <Attachments files={msg.files} onOpenFile={onOpenFile} />
        {/* Which earlier chats this message brought in, so scrolling back later still says
            where the answer's material came from. */}
        {msg.carried?.length > 0 && (
          <div className="mb-1.5 flex items-center justify-end gap-1.5 pr-1 text-[11px] text-mute">
            <Icon name="history" size={12} className="shrink-0 text-p1" />
            <span className="truncate">Brought in {msg.carried.join(' · ')}</span>
          </div>
        )}
        {msg.content && (
          <div className="whitespace-pre-wrap break-words rounded-3xl rounded-br-lg border border-p1/30 bg-gradient-to-br from-p1/30 to-p2/20 px-4 py-2.5">
            {msg.content}
          </div>
        )}
        {/* Their own text as a PDF: word for word, no model involved. */}
        {(onPdf || onDelete || msg.created_at) && (
          <div className="mt-1 flex min-h-8 items-center justify-end text-mute">
            <Time ts={msg.created_at} />
            {onDelete && (
              <button onClick={onDelete} aria-label="Delete message" title="Delete message"
                className="grid size-8 place-items-center rounded-full hover:bg-white/10 hover:text-bad">
                <Icon name="trash" size={16} />
              </button>
            )}
            {onPdf && (
              <button onClick={onPdf} aria-label="Make a PDF" title="Make a PDF"
                className="grid size-8 place-items-center rounded-full hover:bg-white/10">
                <Icon name="pdf" size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const copy = async () => {
    await navigator.clipboard?.writeText(hideMarkers(withoutDrawings(msg.content)).trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rise max-w-full">
      {agent && (
        <div className="mb-2 flex items-center gap-2 text-xs text-mute">
          <Avatar icon={agent.icon} color={agent.color} size={22} className="shadow-none" />
          <span className="font-medium text-txt/90">{agent.name}</span>
          {msg.why && <span className="truncate">· {msg.why}</span>}
        </div>
      )}
      <Pictures files={msg.files} />
      {msg.error ? (
        <div className="rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm">{msg.error}</div>
      ) : msg.content ? (
        <div ref={bodyRef}>
          <Reply content={msg.content} savedId={savedId} />
          {!msg.streaming && (onReplyTo || onRemoveText) && <SelectionBar rootRef={bodyRef} onReply={onReplyTo} onRemove={onRemoveText} />}
        </div>
      ) : (
        <div className="flex gap-1.5 py-2">{[0, 1, 2].map((i) => (
          <span key={i} className="size-2 animate-bounce rounded-full bg-p1" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}</div>
      )}
      <Attachments files={(msg.files || []).filter((f) => f.docId)} onOpenFile={onOpenFile} reply />
      {!msg.streaming && exportAsked(msg.content) && drawingFrom && (
        <DrawingFile format={exportAsked(msg.content)} drawing={drawingFrom.drawing} messageId={drawingFrom.messageId} />
      )}
      {msg.sources?.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-mute"><Globe size={12} /> SOURCES</p>
          <div className="flex flex-wrap gap-1.5">
            {msg.sources.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}
                className="glass flex max-w-[260px] items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs text-mute hover:text-txt">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-p1/25 text-[10px] font-semibold text-txt">{i + 1}</span>
                <span className="truncate">{new URL(s.url).hostname.replace(/^www\./, '')}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {msg.content && !msg.streaming && (
        <div className="mt-2 flex items-center gap-1 text-mute">
          {voiceEnabled && (() => {
            const v = VOICE[voice] || VOICE.idle;
            const active = voice !== 'idle';
            return (
              <>
                <button onClick={onSpeak} aria-label={v.hint || v.label} title={v.hint || v.label}
                  className={`flex h-8 items-center gap-1.5 rounded-full px-2 transition hover:bg-white/10 ${active ? 'bg-white/5 text-p2' : ''}`}>
                  <Icon name={v.icon} size={16} className={v.spin ? 'animate-spin' : ''} />
                  {active && <span className="text-xs">{v.label}</span>}
                </button>
                {active && (
                  <button onClick={onStopSpeak} aria-label="Stop reading" title="Stop"
                    className="grid size-8 place-items-center rounded-full text-p2 hover:bg-white/10">
                    <Icon name="stop" size={13} />
                  </button>
                )}
              </>
            );
          })()}
          <button onClick={copy} aria-label="Copy" className="grid size-8 place-items-center rounded-full hover:bg-white/10">
            <Icon name={copied ? 'check' : 'copy'} size={16} />
          </button>
          {/* Only once the reply is saved: sharing sends its id, not the text on screen. */}
          {onShare && (
            <button onClick={onShare} aria-label="Share with the team" title="Share with the team"
              className="grid size-8 place-items-center rounded-full hover:bg-white/10">
              <Icon name="share" size={16} />
            </button>
          )}
          {/* Only on a saved reply: the PDF is built from the saved words. */}
          {onPdf && (
            <button onClick={onPdf} aria-label="Make a PDF" title="Make a PDF"
              className="grid size-8 place-items-center rounded-full hover:bg-white/10">
              <Icon name="pdf" size={16} />
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} aria-label="Delete message" title="Delete message"
              className="grid size-8 place-items-center rounded-full hover:bg-white/10 hover:text-bad">
              <Icon name="trash" size={16} />
            </button>
          )}
          <Time ts={msg.created_at} />
        </div>
      )}
    </div>
  );
}
