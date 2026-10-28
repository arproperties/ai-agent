import { useEffect, useState } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import Page from './Page';
import { FileViewer, FileDetail } from './Knowledge';
import { CaseFiles, CaseDeadlines, useCaseFiles, useCaseDeadlines, span } from './CaseRails';

// Case Home: everything about one case in one place (server/caseFocus.js caseHome) - its brief,
// every chat about it, its files, its legal dates and the time spent on it. The files, dates
// and time are the ones beside a case chat, asked for with the newest chat on the case.

const field = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const btn = 'rounded-full px-3 py-1 text-xs transition disabled:opacity-50';
const heading = 'mb-2 block text-xs font-medium uppercase tracking-wide text-mute';
const ago = (t) => (t ? new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

/**
 * The case brief (server/caseBrief.js): what earlier chats on the case settled, handed to every
 * new chat on it. Reem only suggests; it goes into the brief when the person approves it,
 * as it is or edited. c: { key, number, brief, suggestion }; onChange gets the new { brief, suggestion }.
 */
export function CaseBrief({ c, onChange, className = 'border-t border-stroke/60 p-3' }) {
  const [editing, setEditing] = useState(null); // 'brief' | 'suggestion' | null
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { brief, suggestion } = c;
  const call = async (p) => {
    setBusy(true); setError('');
    try { onChange(await p); setEditing(null); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const base = `/case-focus/brief/${encodeURIComponent(c.key)}`;
  const edit = (what, body) => { setText(body || ''); setEditing(what); };

  return (
    <div className={`space-y-2 ${className}`}>
      {suggestion && editing !== 'suggestion' && (
        <div className="rounded-xl border border-p1/40 bg-p1/10 p-3">
          <p className="mb-1.5 text-xs font-medium tracking-wide text-p1">SUGGESTED UPDATE TO THE BRIEF</p>
          <div className="md text-sm"><Markdown remarkPlugins={[remarkGfm]}>{suggestion.body}</Markdown></div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => call(api.post(`${base}/suggestions/${suggestion.id}/approve`, {}))}
              className={`${btn} bg-gradient-to-br from-p1 to-p2 text-white`}>Approve</button>
            <button type="button" disabled={busy} onClick={() => edit('suggestion', suggestion.body)} className={`${btn} bg-white/10 hover:bg-white/15`}>Edit</button>
            <button type="button" disabled={busy} onClick={() => call(api.post(`${base}/suggestions/${suggestion.id}/dismiss`, {}))}
              className={`${btn} text-mute hover:bg-white/10`}>Dismiss</button>
          </div>
        </div>
      )}
      {editing ? (
        <div className="space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className={`${field} resize-y text-sm leading-relaxed`} />
          <div className="flex gap-2">
            <button type="button" disabled={busy}
              onClick={() => call(editing === 'suggestion'
                ? api.post(`${base}/suggestions/${suggestion.id}/approve`, { body: text })
                : api.put(base, { number: c.number, body: text }))}
              className={`${btn} bg-gradient-to-br from-p1 to-p2 text-white`}>{editing === 'suggestion' ? 'Approve' : 'Save'}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)} className={`${btn} text-mute hover:bg-white/10`}>Cancel</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium tracking-wide text-mute">CASE BRIEF</span>
            <button type="button" onClick={() => edit('brief', brief?.body)} className="text-xs text-p1 hover:underline">{brief ? 'Edit' : 'Write'}</button>
          </div>
          {brief
            ? <div className="md text-sm text-txt/90"><Markdown remarkPlugins={[remarkGfm]}>{brief.body}</Markdown></div>
            : <p className="text-xs text-mute">No brief yet. After a chat on this case, Reem suggests one here for you to approve. New chats on the case start from it.</p>}
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

function CaseTime({ convId }) {
  const [t, setT] = useState(null);
  useEffect(() => { api.get(`/case-focus/${convId}/time`).then(setT).catch(() => {}); }, [convId]);
  if (!t) return <p className="text-xs text-mute">Loading…</p>;
  const top = Math.max(1, ...t.days.map((d) => d.seconds));
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-mute">Today</dt><dd className="tabular-nums">{span(t.today)}</dd></div>
        <div className="flex justify-between"><dt className="text-mute">Last 7 days</dt><dd className="tabular-nums">{span(t.week)}</dd></div>
        <div className="flex justify-between"><dt className="text-mute">All time</dt><dd className="tabular-nums">{span(t.total)}</dd></div>
      </dl>
      <div className="flex h-10 items-end gap-1" aria-label="Time on this case, last 7 days">
        {t.days.map((d) => (
          <span key={d.day} title={`${d.day}: ${span(d.seconds)}`} className="flex-1 rounded-t bg-p1/70"
            style={{ height: `${Math.max(d.seconds ? 8 : 2, (d.seconds / top) * 100)}%`, opacity: d.seconds ? 1 : 0.25 }} />
        ))}
      </div>
      <p className="text-[11px] text-mute">Only you can see your time. The timer runs in a chat on the case.</p>
    </div>
  );
}

export default function CaseHomePage({ caseKey, folders, me, onBack, onOpenChat, onOpenShelf }) {
  return (
    <Page title="Case" onBack={onBack}>
      <CaseHomeBody caseKey={caseKey} folders={folders} me={me} onOpenChat={onOpenChat} onOpenShelf={onOpenShelf} />
    </Page>
  );
}

/**
 * Everything about one case. Also the first tab of an agent bound to the case (AgentSheet),
 * where it is narrow: compact puts it in one column. number: the bound case, so it opens
 * before the case has a chat.
 */
export function CaseHomeBody({ caseKey, number = '', folders, me, onOpenChat, onOpenShelf, compact = false, newChat }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [viewer, setViewer] = useState(null);
  const [details, setDetails] = useState(null);
  useEffect(() => {
    api.get(`/case-focus/case/${encodeURIComponent(caseKey)}${number ? `?number=${encodeURIComponent(number)}` : ''}`)
      .then(setC).catch((e) => setError(e.message));
  }, [caseKey, number]);
  const latest = c?.chats[0]?.id;
  const primary = c && { number: c.number };
  const files = useCaseFiles(latest, primary);
  const deadlines = useCaseDeadlines(latest, primary);
  const openFile = (id) => api.get(`/documents/${id}`).then(setViewer).catch((e) => setError(e.message));

  const parties = c && (c.partyA || c.partyB ? `${c.partyA || '?'} vs ${c.partyB || '?'}` : c.title);
  return (
    <>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!c && !error && <p className="text-sm text-mute">Loading…</p>}
      {c && (
        <div className={`mx-auto grid max-w-6xl gap-6 ${compact ? '' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-light">Case {c.number}</p>
                {parties && <p className="text-sm text-txt/80">{parties}</p>}
              </div>
              <button onClick={() => onOpenChat(null, newChat || `Case ${c.number}: `)}
                className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white">
                <Plus size={15} /> New chat
              </button>
            </div>
            <section className="rounded-2xl border border-stroke bg-white/[0.03]">
              <CaseBrief c={c} className="p-4" onChange={(b) => setC((x) => ({ ...x, ...b }))} />
            </section>
            <section>
              <b className={heading}>Chats on this case · {c.chats.length}</b>
              {!c.chats.length && <p className="text-sm text-mute">No chats yet. Press New chat to start one.</p>}
              <div className="space-y-1">
                {c.chats.map((ch) => (
                  <button key={ch.id} onClick={() => onOpenChat(ch.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-stroke/60 px-3 py-2.5 text-left transition hover:bg-white/5">
                    <MessageSquare size={15} className="shrink-0 text-mute" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{ch.title}</span>
                      {ch.agent && <span className="block text-[11px] text-mute">{ch.agent}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-mute">{ago(ch.updated_at)}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
          <div className="space-y-6">
            <section>
              <b className={heading}>Files</b>
              <CaseFiles files={latest ? files : []} number={c.number} onOpen={openFile} onOpenShelf={onOpenShelf} />
            </section>
            <section>
              <b className={heading}>Legal dates</b>
              {latest ? <CaseDeadlines deadlines={deadlines} onOpen={openFile} /> : <p className="text-xs text-mute">Reem reads the dates from the case papers once the case has a chat.</p>}
            </section>
            {latest && (
              <section>
                <b className={heading}>Time on this case</b>
                <CaseTime convId={latest} />
              </section>
            )}
          </div>
        </div>
      )}
      {viewer && <FileViewer d={viewer} onClose={() => setViewer(null)} onInfo={(d) => { setViewer(null); setDetails(d); }} />}
      {details && <FileDetail d={details} folders={folders} me={me} onClose={() => setDetails(null)} onChanged={() => {}} />}
    </>
  );
}
