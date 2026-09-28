import { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { documentPart } from '../lib/replyDoc';
import Icon from './Icon';
import Sheet from './Sheet';

// A reply's document as a PDF. The preview is what goes in - only the document, not the
// chat around it - and the PDF itself is laid out by the server from the saved reply.
export default function PdfSheet({ messageId, content, onClose, onOpenFile }) {
  const part = useMemo(() => documentPart(content), [content]);
  const [busy, setBusy] = useState(''); // 'download' | 'shelf'
  const [saved, setSaved] = useState(null); // { id, duplicate }
  const [error, setError] = useState('');

  const download = async () => {
    setBusy('download'); setError('');
    try {
      const res = await fetch(`/api/replies/${messageId}/pdf`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the PDF');
      const name = decodeURIComponent(res.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'Document.pdf');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e.message);
    }
    setBusy('');
  };

  const keep = async () => {
    setBusy('shelf'); setError('');
    try {
      setSaved(await api.post(`/replies/${messageId}/pdf/shelf`));
    } catch (e) {
      setError(e.message);
    }
    setBusy('');
  };

  return (
    <Sheet title={part?.title || 'PDF'} onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Icon name="pdf" size={16} /></span>}>
      <p className="mb-3 text-sm text-mute">Only the document goes in the PDF. The chat around it stays here.</p>

      <div className="paper md mb-4 max-h-[46dvh] overflow-y-auto rounded-2xl bg-white px-5 py-4 text-[13px] text-[#1c1a2e] shadow-inner">
        {part ? <Markdown remarkPlugins={[remarkGfm]}>{part.markdown}</Markdown> : <p>There is no document in this reply.</p>}
      </div>

      {error && <p className="mb-3 text-sm text-bad">{error}</p>}

      <div className="grid grid-cols-2 gap-2.5">
        <button onClick={download} disabled={!part || !!busy}
          className="flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-p1 to-p2 py-3 text-sm font-medium text-white disabled:opacity-40">
          <Icon name={busy === 'download' ? 'spinner' : 'download'} size={17} className={busy === 'download' ? 'animate-spin' : ''} />
          Download PDF
        </button>
        {saved ? (
          <button onClick={() => { onOpenFile(saved.id); onClose(); }}
            className="glass flex items-center justify-center gap-2 rounded-full py-3 text-sm">
            <Icon name="check" size={17} className="text-p2" />
            {saved.duplicate ? 'On your Shelf · Open' : 'Saved · Open'}
          </button>
        ) : (
          <button onClick={keep} disabled={!part || !!busy}
            className="glass flex items-center justify-center gap-2 rounded-full py-3 text-sm disabled:opacity-40">
            <Icon name={busy === 'shelf' ? 'spinner' : 'folder'} size={17} className={busy === 'shelf' ? 'animate-spin' : ''} />
            {busy === 'shelf' ? 'Saving…' : 'Save to Shelf'}
          </button>
        )}
      </div>
    </Sheet>
  );
}
