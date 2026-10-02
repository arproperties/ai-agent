import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import Icon from './Icon';
import Sheet from './Sheet';
import ShareSheet from './ShareSheet';

// Passing a meeting on: the same four things a chat reply offers - a PDF to download, a
// copy on the Shelf, a message to someone on the team, or an email - with the transcript
// left out unless it is asked for. The PDF is made by the server (server/meetingShare.js).

const SETTLED = ['sent', 'failed', 'rejected'];

async function fetchPdf(id, transcript) {
  const res = await fetch(`/api/meetings/${id}/pdf${transcript ? '?transcript=1' : ''}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the PDF');
  const name = decodeURIComponent(res.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'Meeting.pdf');
  return { name, blob: await res.blob() };
}

function EmailSheet({ meeting, transcript, people, onClose }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState(meeting.title || 'Meeting notes');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const watch = useRef(null);

  useEffect(() => {
    api.get(`/meetings/${meeting.id}/text`).then((r) => setBody((b) => b || r.text)).catch(() => {});
    return () => clearTimeout(watch.current);
  }, [meeting.id]);

  // Sending is queued, so ask what became of it until it settles, as the chat's email card does.
  const follow = (id, left = 15) => {
    if (left <= 0) return;
    watch.current = setTimeout(async () => {
      const { draft: d } = await api.get(`/email/drafts/${id}`).catch(() => ({}));
      if (!d) return;
      setDraft(d);
      if (!SETTLED.includes(d.status)) follow(id, left - 1);
    }, 2000);
  };

  const send = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/meetings/${meeting.id}/email`, { to, subject, body, transcript });
      setDraft(r.draft);
      if (!r.attached) setError('The PDF could not be made, so the email went without it.');
      if (!SETTLED.includes(r.draft.status)) follow(r.draft.id);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  const field = 'w-full rounded-xl border border-stroke bg-white/[0.04] px-3.5 py-2.5 text-sm outline-none placeholder:text-mute/70 focus:border-p1/60';
  const status = draft && ({ sent: ['Sent', 'text-ok'], failed: [draft.error || 'Could not be sent', 'text-bad'] }[draft.status] || ['Sending…', 'text-p1']);

  return (
    <Sheet title="Email this meeting" onClose={onClose}
      icon={<span className="grid size-8 place-items-center rounded-full bg-p1/20 text-p1"><Icon name="mail" size={16} /></span>}>
      <div className="space-y-2.5">
        <input value={to} onChange={(e) => setTo(e.target.value)} list="meeting-email-people" disabled={!!draft}
          placeholder="To - one or more addresses, separated by commas" className={field} />
        <datalist id="meeting-email-people">
          {people.filter((p) => p.email).map((p) => <option key={p.id} value={p.email}>{p.name}</option>)}
        </datalist>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!!draft} placeholder="Subject" className={field} />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!!draft} rows={10} className={`${field} resize-y leading-relaxed`} />
        <p className="flex items-center gap-1.5 text-xs text-mute">
          <Icon name="pdf" size={14} /> The PDF{transcript ? ', with the transcript,' : ''} is attached. It goes from your own mailbox.
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {status ? (
        <p className={`mt-4 flex items-center justify-center gap-2 text-sm ${status[1]}`}>
          <Icon name={draft.status === 'sent' ? 'check' : draft.status === 'failed' ? 'x' : 'spinner'} size={16}
            className={SETTLED.includes(draft.status) ? '' : 'animate-spin'} />
          {status[0]}
        </p>
      ) : (
        <button onClick={send} disabled={busy || !to.trim()}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-p1 to-p2 py-3 text-sm font-medium text-white disabled:opacity-40">
          <Icon name={busy ? 'spinner' : 'send'} size={17} className={busy ? 'animate-spin' : ''} /> Send
        </button>
      )}
    </Sheet>
  );
}

export default function MeetingShare({ meeting, dm, onOpenFiles }) {
  const [transcript, setTranscript] = useState(false);
  const [busy, setBusy] = useState(''); // 'download' | 'shelf'
  const [saved, setSaved] = useState(null); // { id, duplicate, transcript }
  const [sheet, setSheet] = useState(null); // 'share' | 'email'
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const download = async () => {
    setBusy('download'); setError('');
    try {
      const { name, blob } = await fetchPdf(meeting.id, transcript);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setError(e.message); }
    setBusy('');
  };

  const keep = async () => {
    if (saved?.transcript === transcript) return onOpenFiles?.();
    setBusy('shelf'); setError('');
    try { setSaved({ ...await api.post(`/meetings/${meeting.id}/pdf/shelf`, { transcript }), transcript }); } catch (e) { setError(e.message); }
    setBusy('');
  };

  // Into a team chat: the PDF as a file, with the summary written out beside it so it can
  // be read without opening anything.
  const sendTo = async (chatId) => {
    const [{ name, blob }, { text }] = await Promise.all([fetchPdf(meeting.id, transcript), api.get(`/meetings/${meeting.id}/text`)]);
    const form = new FormData();
    form.append('body', text);
    form.append('file', new File([blob], name, { type: 'application/pdf' }));
    await api.upload(`/messenger/chats/${chatId}/messages`, form);
  };

  const btn = 'flex items-center justify-center gap-2 rounded-full border border-stroke px-4 py-2.5 text-sm hover:bg-white/5 disabled:opacity-40';
  const onShelf = saved && saved.transcript === transcript;

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <button onClick={download} disabled={!!busy} className={btn}>
          <Icon name={busy === 'download' ? 'spinner' : 'download'} size={16} className={busy === 'download' ? 'animate-spin' : ''} /> Download PDF
        </button>
        <button onClick={keep} disabled={!!busy} className={btn}>
          <Icon name={busy === 'shelf' ? 'spinner' : onShelf ? 'check' : 'folder'} size={16}
            className={busy === 'shelf' ? 'animate-spin' : onShelf ? 'text-ok' : ''} />
          {busy === 'shelf' ? 'Saving…' : onShelf ? 'On Shelf · Open' : 'Save to Shelf'}
        </button>
        <button onClick={() => setSheet('share')} disabled={!dm} className={btn}>
          <Icon name="share" size={16} /> Send to team
        </button>
        <button onClick={() => setSheet('email')} className={btn}>
          <Icon name="mail" size={16} /> Email
        </button>
      </div>
      <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-sm text-mute">
        <input type="checkbox" checked={transcript} onChange={(e) => setTranscript(e.target.checked)} className="accent-p1" />
        Include the full transcript
      </label>
      {note && <p className="px-1 text-sm text-ok">{note}</p>}
      {error && <p className="px-1 text-sm text-bad">{error}</p>}

      {sheet === 'share' && dm && (
        <ShareSheet dm={dm} send={sendTo} onClose={() => setSheet(null)} onDone={(msg) => { setNote(msg); setError(''); }}
          note={`The summary is sent as a message from you, with the PDF${transcript ? ' (including the transcript)' : ''} attached.`} />
      )}
      {sheet === 'email' && (
        <EmailSheet meeting={meeting} transcript={transcript} people={dm?.people || []} onClose={() => setSheet(null)} />
      )}
    </section>
  );
}
