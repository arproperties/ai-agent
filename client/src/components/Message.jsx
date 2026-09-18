import { useState } from 'react';
import { Globe } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Icon from './Icon';
import Avatar from './Avatar';

const isImg = (f) => f.kind === 'image' || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name);

function Attachments({ files, onOpenFile }) {
  if (!files?.length) return null;
  const open = (f) => f.docId && onOpenFile(f.docId);
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {files.map((f, i) => (isImg(f) && (f.preview || f.docId) ? (
        <button key={i} onClick={() => open(f)} aria-label={`View ${f.name}`}
          className="overflow-hidden rounded-2xl border border-stroke transition hover:border-white/30 active:scale-[0.98]">
          <img src={f.preview || `/api/documents/${f.docId}/file`} alt={f.name} className="h-36 max-w-[240px] object-cover" />
        </button>
      ) : (
        <button key={i} onClick={() => open(f)}
          className="glass flex max-w-[260px] items-center gap-2.5 rounded-2xl py-2 pl-2 pr-3.5 text-left transition hover:bg-white/10">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-p1/20 text-p1"><Icon name={isImg(f) ? 'image' : 'file'} size={17} /></span>
          <span className="min-w-0">
            <span className="block truncate text-[13px]">{f.name}</span>
            <span className="text-[11px] text-mute">{f.docId ? 'Tap to view' : 'Uploading…'}</span>
          </span>
        </button>
      )))}
    </div>
  );
}

export default function Message({ msg, agent, speaking, onSpeak, voiceEnabled, onOpenFile }) {
  const [copied, setCopied] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="rise ml-auto max-w-[85%]">
        <Attachments files={msg.files} onOpenFile={onOpenFile} />
        {msg.content && (
          <div className="whitespace-pre-wrap break-words rounded-3xl rounded-br-lg border border-p1/30 bg-gradient-to-br from-p1/30 to-p2/20 px-4 py-2.5">
            {msg.content}
          </div>
        )}
      </div>
    );
  }

  const copy = async () => {
    await navigator.clipboard?.writeText(msg.content);
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
      {msg.error ? (
        <div className="rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm">{msg.error}</div>
      ) : msg.content ? (
        <div className="md break-words text-[15px]"><Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown></div>
      ) : (
        <div className="flex gap-1.5 py-2">{[0, 1, 2].map((i) => (
          <span key={i} className="size-2 animate-bounce rounded-full bg-p1" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}</div>
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
        <div className="mt-2 flex gap-1 text-mute">
          {voiceEnabled && (
            <button onClick={onSpeak} aria-label={speaking ? 'Stop' : 'Read aloud'}
              className={`grid size-8 place-items-center rounded-full hover:bg-white/10 ${speaking ? 'text-p2' : ''}`}>
              <Icon name={speaking ? 'stop' : 'speaker'} size={16} />
            </button>
          )}
          <button onClick={copy} aria-label="Copy" className="grid size-8 place-items-center rounded-full hover:bg-white/10">
            <Icon name={copied ? 'check' : 'copy'} size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
