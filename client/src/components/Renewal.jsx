import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Copy, ExternalLink, FileUp, Loader2, Mail, Paperclip, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Select from './Select';

// One renewal: getting a document that is due renewed, with Riley doing the legwork
// (server/renewals.js). Five steps across the top: who to ask, the requests, the quotes that
// came back, the offers side by side, and the decision. What Riley found or wrote is shown
// with her mark; a person ticks, confirms an address, approves an email and chooses.
// No email leaves from here without Approve being pressed on it.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-p1/70';
const CARD = 'rounded-2xl border border-stroke px-4 py-3';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const QUIET = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-3.5 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt disabled:opacity-50';
const STEPS = [['suppliers', 'Who to ask'], ['requests', 'Requests'], ['quotes', 'Quotes'], ['compare', 'Compare'], ['decide', 'Decision']];
const STATE = { listed: ['Not asked', 'bg-white/10 text-txt/80'], written: ['Written, to send by hand', 'bg-warn/10 text-warn'], drafted: ['Waiting for approval', 'bg-warn/10 text-warn'],
  sending: ['Sending…', 'bg-p3/15 text-p3'], sent: ['Sent', 'bg-p3/15 text-p3'], replied: ['Replied', 'bg-ok/10 text-ok'] };
const REPLY = { quote: 'Sent a quote', question: 'Asked a question', declined: 'Will not quote', other: 'Wrote back', unread: 'Wrote back (not read)' };
const ROWS = [['premium', 'Premium'], ['sum_insured', 'Sum insured'], ['deductible', 'Deductible'], ['cover', 'What is covered'], ['exclusions', 'Exclusions'], ['valid_until', 'Offer stands until']];
const VERDICT = { better: 'text-ok', worse: 'text-bad', same: 'text-mute' };
const CLOSED = { renewed: 'Renewed: the new policy is on file.', not_renewing: 'Closed: this document is not being renewed.', cancelled: 'This renewal was cancelled.' };

const Riley = ({ children }) => <span className="inline-flex items-center gap-1 text-xs text-p3"><Sparkles size={12} /> {children}</span>;
const Chip = ({ tone, children }) => <span className={`rounded-full px-2.5 py-0.5 text-xs ${tone}`}>{children}</span>;
const when = (seconds) => (seconds ? fmt(new Date(seconds * 1000).toISOString().slice(0, 10)) : '');

/** An email that is written: its words, and what can be done with it (approve, reword, reject; or copy it out). */
function Letter({ to, subject, body, status, mine, canEdit, onSave, onApprove, onReject, onSent, note }) {
  const [edit, setEdit] = useState(null); // { subject, body } while being reworded
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(`${subject}\n\n${body}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  return (
    <div className="mt-2 rounded-xl border border-stroke/60 bg-white/[0.03] p-3">
      {edit ? (
        <div className="space-y-2">
          <input value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} aria-label="Subject" className={FIELD} />
          <textarea value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={10} aria-label="Email" className={`${FIELD} resize-y`} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEdit(null)} className={QUIET}>Cancel</button>
            <button type="button" onClick={async () => { if (await onSave(edit)) setEdit(null); }} className={PRIMARY}>Save wording</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-mute">To {to || 'no address'} · <span className="text-txt/80">{subject}</span></p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-txt/90">{body}</p>
          {note && <p className="mt-2 text-xs text-mute">{note}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {canEdit && <button type="button" onClick={() => setEdit({ subject, body })} className={QUIET}><Pencil size={14} /> Reword</button>}
            {status === 'pending' && mine && <>
              <button type="button" onClick={onReject} className={QUIET}><X size={14} /> Reject</button>
              <button type="button" onClick={onApprove} className={PRIMARY}><Mail size={15} /> Approve and send</button>
            </>}
            {status === 'pending' && !mine && <span className="text-xs text-mute">Waiting for the person who wrote it to approve.</span>}
            {status == null && <>
              <button type="button" onClick={copy} className={QUIET}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
              {to && <a href={`mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`} className={QUIET}><Mail size={14} /> Open in my mail</a>}
              {onSent && <button type="button" onClick={onSent} className={PRIMARY}><Check size={15} /> I have sent it</button>}
            </>}
          </div>
        </>
      )}
    </div>
  );
}

/** Who else could be asked: kept from before, and found on the web. Ticked, with an address a person has checked, they join the renewal. */
function Candidates({ found, onAdd, onClose }) {
  const all = [...found.known.map((s) => ({ ...s, supplier_id: s.id, from: 'known' })), ...found.found.map((s) => ({ ...s, from: 'web' }))];
  const [rows, setRows] = useState(all.map((s) => ({ ...s, on: false, address: s.email || '' })));
  const put = (i, change) => setRows(rows.map((x, j) => (j === i ? { ...x, ...change } : x)));
  const ticked = rows.filter((x) => x.on);
  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">Others who could be asked</p>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10"><X size={15} /></button>
      </div>
      {found.failed && <p className="text-sm text-warn">The web search could not be made just now. You can still add a supplier yourself below.</p>}
      {!rows.length && !found.failed && <p className="text-sm text-mute">Nobody new was found.</p>}
      {rows.map((s, i) => (
        <div key={`${s.from}-${s.name}`} className="rounded-xl border border-stroke/60 p-3">
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={s.on} onChange={(e) => put(i, { on: e.target.checked })} className="mt-1 size-4 accent-p1" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{s.name} <span className="text-xs text-mute">· {s.kind || 'insurer'}</span></span>
              {s.from === 'web' ? <Riley>Found on the web{s.why ? `: ${s.why}` : ''}</Riley> : <span className="text-xs text-mute">Used before</span>}
              {s.website && <a href={s.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mt-0.5 flex items-center gap-1 text-xs text-p3 hover:underline"><ExternalLink size={12} /> {s.website}</a>}
            </span>
          </label>
          {s.on && (
            <label className="mt-2 block text-xs text-mute">
              Email address to write to{s.from === 'web' && s.email ? ' — found on the web, check it before you add it' : ''}
              <input value={s.address} onChange={(e) => put(i, { address: e.target.value })} type="email" placeholder="quotes@company.com" className={`${FIELD} mt-1`} />
            </label>
          )}
        </div>
      ))}
      {ticked.length > 0 && (
        <div className="flex justify-end">
          <button type="button" className={PRIMARY}
            onClick={() => onAdd(ticked.map((s) => (s.supplier_id ? { supplier_id: s.supplier_id, email: s.address } : { name: s.name, email: s.address, website: s.website, phone: s.phone, kind: s.kind, found_by: 'search' })))}>
            <Plus size={15} /> Add {ticked.length} to this renewal
          </button>
        </div>
      )}
    </div>
  );
}

export default function Renewal({ id, onBack, onFile }) {
  const [r, setR] = useState(null);
  const [tab, setTab] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [found, setFound] = useState(null); // what "Find more" came back with
  const [mine, setMine] = useState({ name: '', email: '' }); // a supplier typed in by hand
  const [emails, setEmails] = useState({}); // supplier → the address being typed for it
  const [quoteFor, setQuoteFor] = useState('');

  const base = `/properties/renewals/${id}`;
  // The step a renewal is at, for when it is opened: the furthest one that has something in it.
  const stepOf = (v) => (v.chosen_quote_id ? 'decide' : v.compared ? 'compare' : v.quotes.length ? 'quotes' : v.suppliers.some((s) => s.state !== 'listed') ? 'requests' : 'suppliers');
  const take = (v) => { setR(v); setTab((t) => t || stepOf(v)); return v; };
  useEffect(() => { api.get(base).then(take).catch((e) => setError(e.message)); }, [id]);

  /** Do one thing on the server, showing what is happening; gives back what came, or null if it failed. */
  const run = async (label, fn) => {
    setBusy(label); setError(''); setNote('');
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(''); }
  };
  const act = (label, fn, then) => run(label, fn).then((v) => { if (v) { take(v.renewal || v); then?.(v); } return v; });
  const reload = () => api.get(base).then(take).catch(() => {});
  const here = useRef(true); // false once the page is left, so nothing still waiting writes to it
  useEffect(() => () => { here.current = false; }, []);
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // The search takes a minute or more, so it runs on the server while this asks after it.
  const find = async () => {
    setBusy('Riley is searching the web for insurers and brokers. This takes a minute or two…'); setError(''); setNote('');
    try {
      await api.post(`${base}/find`, {});
      for (let i = 0; i < 100 && here.current; i++) {
        await wait(3000);
        const f = await api.get(`${base}/find`);
        if (f.pending) continue;
        if (here.current && !f.none) setFound(f);
        break;
      }
    } catch (e) { if (here.current) setError(e.message); }
    if (here.current) setBusy('');
  };
  // Looking the suppliers up runs on the server too: while it does, the page reads again every few seconds.
  useEffect(() => {
    if (!r?.looking) return undefined;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [r]);
  // Approving hands the email to the outbox; a moment later the renewal knows it has gone.
  const decideDraft = (draftId, verb) => run(verb === 'approve' ? 'Sending…' : 'Withdrawing…', () => api.post(`/email/drafts/${draftId}/${verb}`, {}))
    .then((ok) => { if (ok) { reload(); if (verb === 'approve') setTimeout(reload, 2500); } });

  if (!r) return error ? <p className="text-sm text-bad">{error}</p> : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  const d = r.document;
  const open = r.status === 'open' || r.status === 'decided';
  const ready = r.suppliers.filter((s) => ['listed', 'written'].includes(s.state) && s.email && s.email_confirmed);
  const written = r.suppliers.filter((s) => s.state !== 'listed');
  const chosen = r.quotes.find((q) => q.id === r.chosen_quote_id);
  const about = (sid) => r.suppliers.find((s) => s.supplier_id === sid)?.about || {};

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-mute hover:text-txt"><ChevronLeft size={16} /> Back to documents</button>
      <div>
        <h2 className="text-lg font-light">Renewing {d.title}</h2>
        <p className="text-sm text-mute">{[d.where, d.number, d.expiry_date && `expires ${fmt(d.expiry_date)}`, d.details.insurer && `with ${d.details.insurer}`].filter(Boolean).join(' · ')}</p>
        {!open && <p className="mt-2 rounded-xl bg-white/5 px-3 py-2 text-sm">{CLOSED[r.status]}</p>}
      </div>

      <div className="flex gap-5 overflow-x-auto border-b border-stroke text-sm">
        {STEPS.map(([k, l], i) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px shrink-0 border-b-2 pb-2 pt-1 transition ${tab === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>
            <span className="mr-1 text-xs opacity-60">{i + 1}</span>{l}
          </button>
        ))}
      </div>
      {busy && <p className="flex items-center gap-2 text-sm text-p3"><Loader2 size={15} className="animate-spin" /> {busy}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {note && <p className="text-sm text-ok">{note}</p>}

      {tab === 'suppliers' && (
        <div className="space-y-3">
          <p className="text-sm text-mute">Who Riley will write to. Nothing is written to an address until you have confirmed it.</p>
          {r.suppliers.map((s) => (
            <div key={s.supplier_id} className={CARD}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</p>
                {s.is_current && <Chip tone="bg-p1/20 text-p1">Has it now</Chip>}
                <Chip tone={STATE[s.state][1]}>{STATE[s.state][0]}</Chip>
                {open && ['listed', 'written'].includes(s.state) && (
                  <button onClick={() => act('Removing…', () => api.del(`${base}/suppliers/${s.supplier_id}`))} aria-label={`Remove ${s.name}`} className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
                )}
              </div>
              {s.email && s.email_confirmed ? <p className="mt-1 text-xs text-mute">{s.email}</p> : open && (
                <div className="mt-2 flex gap-2">
                  <input value={emails[s.supplier_id] ?? s.email ?? ''} onChange={(e) => setEmails({ ...emails, [s.supplier_id]: e.target.value })} type="email" placeholder="Their email address for quotations" aria-label={`Email for ${s.name}`} className={FIELD} />
                  <button className={QUIET} disabled={!(emails[s.supplier_id] ?? s.email)} onClick={() => act('Saving…', () => api.post(`${base}/suppliers`, { suppliers: [{ supplier_id: s.supplier_id, email: emails[s.supplier_id] ?? s.email }] }))}>Confirm</button>
                </div>
              )}
            </div>
          ))}
          {!r.suppliers.length && <p className="text-sm text-mute">Nobody listed yet.</p>}

          {open && (found ? (
            <Candidates found={found} onClose={() => setFound(null)} onAdd={(list) => act('Adding…', () => api.post(`${base}/suppliers`, { suppliers: list }), () => setFound(null))} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className={QUIET} disabled={!!busy} onClick={find}><Search size={15} /> Find more with Riley</button>
            </div>
          ))}

          {open && (
            <form className={`${CARD} space-y-2`} onSubmit={(e) => { e.preventDefault(); act('Adding…', () => api.post(`${base}/suppliers`, { suppliers: [mine] }), () => setMine({ name: '', email: '' })); }}>
              <p className="text-sm">Add one yourself</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={mine.name} onChange={(e) => setMine({ ...mine, name: e.target.value })} required placeholder="Company name *" className={FIELD} />
                <input value={mine.email} onChange={(e) => setMine({ ...mine, email: e.target.value })} type="email" placeholder="Email address" className={FIELD} />
              </div>
              <div className="flex justify-end"><button className={QUIET}><Plus size={15} /> Add</button></div>
            </form>
          )}

          {r.status === 'open' && ready.length > 0 && (
            <div className="flex justify-end">
              <button className={PRIMARY} disabled={!!busy} onClick={() => act('Riley is writing the requests…', () => api.post(`${base}/requests`, { supplier_ids: ready.map((s) => s.supplier_id) }), () => setTab('requests'))}>
                <Sparkles size={15} /> Write the request to {ready.length === 1 ? ready[0].name : `${ready.length} suppliers`}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'requests' && (
        <div className="space-y-3">
          <p className="text-sm text-mute">{r.can_send ? 'Each request is a draft. It goes only when you press Approve and send.' : 'Your mailbox is not set up to send from here, so each request is written for you to copy and send yourself.'}</p>
          {!written.length && <p className="text-sm text-mute">Nothing written yet. Choose who to ask first.</p>}
          {written.map((s) => (
            <div key={s.supplier_id} className={CARD}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</p>
                <Chip tone={STATE[s.state][1]}>{STATE[s.state][0]}{s.sent_at ? ` ${when(s.sent_at)}` : ''}</Chip>
              </div>
              {s.error && <p className="mt-1 text-sm text-bad">It could not be sent: {s.error}</p>}
              {s.body && (
                <Letter to={s.email} subject={s.subject} body={s.body} status={s.state === 'drafted' ? 'pending' : s.state === 'written' ? null : s.state} mine={s.draft_owner === r.me}
                  canEdit={open && (s.state === 'written' || (s.state === 'drafted' && s.draft_owner === r.me))}
                  onSave={(w) => act('Saving…', () => api.put(`${base}/requests/${s.request_id}`, w))}
                  onApprove={() => decideDraft(s.draft_id, 'approve')} onReject={() => decideDraft(s.draft_id, 'reject')}
                  onSent={() => act('Noting it…', () => api.post(`${base}/requests/${s.request_id}/sent`, {}))}
                  note={d.has_file && s.state === 'drafted' ? `Attached: ${d.file_name}` : null} />
              )}
              {s.chaser_status === 'pending' && (
                <>
                  <p className="mt-3"><Riley>No reply yet, so a follow-up is written</Riley></p>
                  <Letter to={s.email} subject={`Re: ${s.subject}`} body={s.chaser_body} status="pending" mine={s.chaser_owner === r.me}
                    onApprove={() => decideDraft(s.chaser_draft_id, 'approve')} onReject={() => decideDraft(s.chaser_draft_id, 'reject')} />
                </>
              )}
              {s.chaser_status === 'sent' && <p className="mt-2 text-xs text-mute">A follow-up was sent.</p>}
            </div>
          ))}
          {r.status === 'open' && r.can_send && r.suppliers.some((s) => s.state === 'sent' && !s.chaser_status) && (
            <div className="flex justify-end"><button className={QUIET} disabled={!!busy} onClick={() => act('Writing follow-ups…', () => api.post(`${base}/chase`, {}))}>Write a follow-up to those silent for 5 days</button></div>
          )}
        </div>
      )}

      {tab === 'quotes' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-mute">Riley looks for replies by herself every half hour. You can also look now.</p>
            {r.status === 'open' && <button className={QUIET} disabled={!!busy} onClick={() => act('Riley is reading the replies…', () => api.post(`${base}/check`, {}),
              (g) => setNote(g.quotes.length || g.questions.length ? [g.quotes.length && `New quote from ${g.quotes.join(', ')}`, g.questions.length && `A question from ${g.questions.join(', ')}`].filter(Boolean).join('. ') : 'Nothing new has come in.'))}><RefreshCw size={14} /> Check for replies</button>}
          </div>
          {r.suppliers.filter((s) => ['sent', 'replied'].includes(s.state)).map((s) => (
            <div key={s.supplier_id} className="flex flex-wrap items-center gap-2 rounded-xl border border-stroke/60 px-3.5 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.state === 'replied' ? <Chip tone={s.reply_kind === 'quote' ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}>{REPLY[s.reply_kind] || 'Wrote back'}</Chip> : <Chip tone="bg-white/10 text-txt/80">No reply yet</Chip>}
              {s.reply_note && <p className="w-full text-xs text-mute"><Riley>{s.reply_note}</Riley></p>}
            </div>
          ))}
          {r.quotes.map((q) => (
            <div key={q.id} className={CARD}>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{q.supplier}{q.premium && <span className="text-mute"> · {q.premium}</span>}</p>
                <Chip tone="bg-white/10 text-txt/80">{q.source === 'upload' ? 'Added by hand' : 'From their email'}</Chip>
                {open && <button onClick={() => confirm(`Remove this quote from ${q.supplier}?`) && act('Removing…', () => api.del(`${base}/quotes/${q.id}`))} aria-label="Remove quote" className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>}
              </div>
              <dl className="mt-2 space-y-0.5 text-sm">
                {ROWS.filter(([k]) => q[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{k === 'valid_until' ? fmt(q[k]) : q[k]}</dd></div>)}
              </dl>
              {q.note && <p className="mt-1.5"><Riley>{q.note}</Riley></p>}
              {q.has_file && <a href={`/api${base}/quotes/${q.id}/file`} target="_blank" rel="noreferrer" className="mt-1.5 flex items-center gap-1.5 text-sm text-p3 hover:underline"><Paperclip size={14} /> {q.file_name}</a>}
            </div>
          ))}
          {!r.quotes.length && <p className="text-sm text-mute">No quotes yet.</p>}

          {open && r.suppliers.length > 0 && (
            <div className={`${CARD} space-y-2`}>
              <p className="text-sm">A quote that came another way (WhatsApp, paper)</p>
              <Select value={quoteFor} onChange={(e) => setQuoteFor(e.target.value)} options={r.suppliers.map((s) => [s.supplier_id, s.name])} placeholder="Who is it from?" aria-label="Supplier" className={FIELD} />
              <label className={`flex items-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-2.5 text-sm text-mute ${quoteFor ? 'cursor-pointer hover:bg-white/5' : 'opacity-50'}`}>
                <FileUp size={15} /> Choose the file: Riley reads it
                <input type="file" accept="application/pdf,image/*" className="hidden" disabled={!quoteFor || !!busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const form = new FormData();
                    form.append('supplier_id', quoteFor);
                    form.append('file', file);
                    act('Riley is reading the quote…', () => api.upload(`${base}/quotes`, form), () => setQuoteFor(''));
                  }} />
              </label>
            </div>
          )}
          {open && r.quotes.length > 0 && <div className="flex justify-end"><button className={PRIMARY} disabled={!!busy} onClick={() => act('Riley is comparing the offers…', () => api.post(`${base}/compare`, {}), () => setTab('compare'))}><Sparkles size={15} /> Compare the offers</button></div>}
        </div>
      )}

      {tab === 'compare' && (
        <div className="space-y-3">
          {!r.compared ? (
            <div className="space-y-3">
              <p className="text-sm text-mute">{r.quotes.length ? 'The offers have not been compared yet, or a new one has come in since.' : 'There are no quotes to compare yet.'}</p>
              {open && r.quotes.length > 0 && <button className={PRIMARY} disabled={!!busy} onClick={() => act('Riley is comparing the offers…', () => api.post(`${base}/compare`, {}))}><Sparkles size={15} /> Compare the offers</button>}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-2xl border border-stroke">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="border-b border-stroke text-left text-xs text-mute">
                      <th className="px-3 py-2 font-normal" />
                      <th className="px-3 py-2 font-normal">Now{r.compared.current.supplier ? ` · ${r.compared.current.supplier}` : ''}</th>
                      {r.compared.offers.map((o) => <th key={o.quote_id} className={`px-3 py-2 font-normal ${o.quote_id === r.compared.pick ? 'text-p3' : ''}`}>{o.supplier}{o.quote_id === r.compared.pick ? ' · Riley’s pick' : ''}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stroke/60">
                    {ROWS.map(([k, l]) => (
                      <tr key={k} className="align-top">
                        <td className="px-3 py-2 text-mute">{l}</td>
                        <td className="px-3 py-2">{r.compared.current[k] || '—'}</td>
                        {r.compared.offers.map((o) => (
                          <td key={o.quote_id} className="px-3 py-2">
                            {o[k] ? (k === 'valid_until' ? fmt(o[k]) : o[k]) : '—'}
                            {o.verdicts?.[k] && <span className={`ml-1.5 text-xs ${VERDICT[o.verdicts[k]]}`}>{o.verdicts[k]}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={CARD}>
                <Riley>What Riley would do</Riley>
                {r.compared.failed ? <p className="mt-1 text-sm text-mute">The offers could not be weighed just now. The figures above are as the suppliers gave them.</p> : (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{r.compared.why || 'She has no recommendation.'}</p>
                    {r.compared.unsure && <p className="mt-2 text-sm text-warn">Check before you decide: {r.compared.unsure}</p>}
                  </>
                )}
              </div>

              {r.compared.offers.map((o) => {
                const a = about(o.supplier_id);
                return (
                  <div key={o.quote_id} className={CARD}>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium">{o.supplier}</p>
                      {open && <button className={o.quote_id === r.chosen_quote_id ? QUIET : PRIMARY} disabled={!!busy}
                        onClick={() => confirm(`Go with ${o.supplier}? Riley will write the acceptance and the thank-yous for you to approve. Nothing is sent yet.`) && act('Writing the letters…', () => api.post(`${base}/decide`, { quote_id: o.quote_id }), () => setTab('decide'))}>
                        <Check size={15} /> {o.quote_id === r.chosen_quote_id ? 'Chosen' : 'Choose this offer'}
                      </button>}
                    </div>
                    <p className="mt-2"><Riley>What was found about them{a.checked_on ? `, ${fmt(a.checked_on)}` : ''} — evidence to check, not a verdict</Riley></p>
                    {['licensed', 'rating', 'since', 'summary'].some((k) => a[k]) ? (
                      <dl className="mt-1 space-y-0.5 text-sm">
                        {[['summary', 'Who they are'], ['licensed', 'Licence'], ['rating', 'Rating'], ['since', 'Trading since']].filter(([k]) => a[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{a[k]}</dd></div>)}
                      </dl>
                    ) : r.looking ? <p className="mt-1 flex items-center gap-2 text-sm text-mute"><Loader2 size={14} className="animate-spin" /> Riley is looking them up. This takes a minute or two…</p>
                      : (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <p className="min-w-0 flex-1 text-sm text-mute">{a.checked_on ? 'Nothing could be found.' : 'Not looked up yet.'}</p>
                          {!a.checked_on && <button className={QUIET} onClick={() => act('Starting…', () => api.post(`${base}/lookup`, {}))}><Search size={14} /> Look them up</button>}
                        </div>
                      )}
                    {(a.sources || []).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-xs text-p3 hover:underline"><ExternalLink size={12} /> {s.title}</a>)}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {tab === 'decide' && (
        <div className="space-y-3">
          {!chosen ? <p className="text-sm text-mute">No offer has been chosen yet. Compare the offers, then choose one.</p> : (
            <>
              <div className={CARD}>
                <p className="text-sm">Going with <span className="font-medium">{chosen.supplier}</span>{chosen.premium ? ` at ${chosen.premium}` : ''}.</p>
                <p className="mt-1 text-xs text-mute">Nothing has been accepted until the letter below is sent.</p>
              </div>
              {r.closing.map((c) => (
                <div key={`${c.kind}-${c.supplier_id}`} className={CARD}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{c.kind === 'accept' ? 'Acceptance' : 'Thank-you'} · {c.supplier}</p>
                    {c.status && <Chip tone={c.status === 'sent' ? 'bg-ok/10 text-ok' : c.status === 'pending' ? 'bg-warn/10 text-warn' : 'bg-white/10 text-txt/80'}>{c.status === 'pending' ? 'Waiting for approval' : c.status === 'sent' ? 'Sent' : c.status === 'rejected' ? 'Not sent' : c.status}</Chip>}
                  </div>
                  {c.error && <p className="mt-1 text-sm text-bad">It could not be sent: {c.error}</p>}
                  <Letter to={c.email} subject={c.subject} body={c.body} status={c.draft_id ? c.status : null} mine={c.draft_owner === r.me}
                    onApprove={() => decideDraft(c.draft_id, 'approve')} onReject={() => decideDraft(c.draft_id, 'reject')} />
                </div>
              ))}
              {open && (
                <div className={`${CARD} space-y-2`}>
                  <p className="text-sm">When the new policy arrives, file it. That closes this renewal and stops the alert.</p>
                  <button className={PRIMARY} onClick={() => onFile(d)}><FileUp size={15} /> File the new policy</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-stroke/60 pt-4">
          <button className={QUIET} disabled={!!busy} onClick={() => confirm('Close this as not renewing? The document will stop asking to be renewed.') && act('Closing…', () => api.post(`${base}/close`, { status: 'not_renewing' }))}>We are not renewing this</button>
          <button className={QUIET} disabled={!!busy} onClick={() => confirm('Cancel this renewal? What was gathered stays on record, and the document goes on asking to be renewed.') && act('Cancelling…', () => api.post(`${base}/close`, { status: 'cancelled' }))}>Cancel this renewal</button>
        </div>
      )}
    </div>
  );
}
