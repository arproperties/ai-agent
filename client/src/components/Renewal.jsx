import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Copy, ExternalLink, FileUp, Loader2, Mail, Paperclip, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { usDate as fmt } from '../lib/usFormat';
import Select from './Select';

// One renewal: getting a document that is due renewed, with Riley doing the legwork
// (server/renewals.js). It is one page, for people who are not at home with forms: a line
// at the top says what to do now, and under it only what that takes. First who to ask (Riley
// has looked already; a person ticks and gives an email address), then the emails to
// approve, then the offers as cards with her pick first, then the email that accepts one.
// Comparing happens by itself when a quote arrives. What Riley found or wrote carries her
// mark. No email leaves from here without Approve being pressed on it.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-p1/70';
const CARD = 'rounded-2xl border border-stroke px-4 py-3';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const QUIET = 'flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-3.5 py-2 text-sm text-mute hover:bg-white/5 hover:text-txt disabled:opacity-50';
const STATE = { listed: ['Not asked', 'bg-white/10 text-txt/80'], written: ['Written, to send by hand', 'bg-warn/10 text-warn'], drafted: ['Waiting for approval', 'bg-warn/10 text-warn'],
  failed: ['Could not be sent', 'bg-bad/10 text-bad'], sending: ['Sending…', 'bg-p3/15 text-p3'], sent: ['Sent', 'bg-p3/15 text-p3'], replied: ['Replied', 'bg-ok/10 text-ok'] };
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

/** One company that can be asked: a tick, its name, why it is here, and the one thing a person gives, its email address. */
function AskRow({ on, onTick, name, tag, why, website, address, onAddress, fixed }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${on ? 'border-p1/50 bg-p1/[0.06]' : 'border-stroke'}`}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={on} onChange={(e) => onTick(e.target.checked)} className="mt-0.5 size-5 accent-p1" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-mute">{tag}{why ? ` · ${why}` : ''}</span>
        </span>
      </label>
      {on && (fixed ? <p className="mt-2 pl-8 text-sm text-txt/80">{address}</p> : (
        <div className="mt-2 pl-8">
          <input value={address} onChange={(e) => onAddress(e.target.value)} type="email" placeholder="Their email address" aria-label={`Email address for ${name}`} className={FIELD} />
          {!address && website && <a href={/^https?:\/\//i.test(website) ? website : `https://${website}`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-p3 hover:underline"><ExternalLink size={12} /> Find it on their website</a>}
        </div>
      ))}
    </div>
  );
}

export default function Renewal({ id, onBack, onFile }) {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const kept = `renewal-found-${id}`; // what Riley found, kept for this visit to the app: opening the renewal again does not search again
  const [found, setFoundNow] = useState(() => { try { return JSON.parse(sessionStorage.getItem(kept)); } catch { return null; } }); // { known, found, failed }
  const setFound = (f) => { setFoundNow(f); try { if (f && !f.failed) sessionStorage.setItem(kept, JSON.stringify(f)); else sessionStorage.removeItem(kept); } catch { /* kept only on the page, then */ } };
  const [picks, setPicks] = useState({}); // a row → { on, address }: who is ticked, and the address typed for them
  const [extra, setExtra] = useState({ open: false, name: '', email: '' }); // a company added by hand
  const [asking, setAsking] = useState(false); // the list of who to ask is open again, after the first emails
  const [upload, setUpload] = useState({ open: false, from: '' }); // a quote handed over as a file

  const base = `/properties/renewals/${id}`;
  const take = (v) => { setR(v); return v; };
  useEffect(() => { api.get(base).then(take).catch((e) => setError(e.message)); }, [id]);
  const reload = () => api.get(base).then(take).catch(() => {});
  const here = useRef(true); // false once the page is left, so nothing still waiting writes to it
  useEffect(() => { here.current = true; return () => { here.current = false; }; }, []);
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

  /** Do one thing on the server, showing what is happening; gives back what came, or null if it failed. */
  const run = async (label, fn) => {
    setBusy(label); setError(''); setNote('');
    try { return await fn(); } catch (e) { if (here.current) setError(e.message); return null; } finally { if (here.current) setBusy(''); }
  };
  const act = (label, fn, then) => run(label, fn).then((v) => { if (v) { take(v.renewal || v); then?.(v); } return v; });
  // Approving hands the email to the outbox; a moment later the renewal knows it has gone.
  const settle = (draftId, verb) => api.post(`/email/drafts/${draftId}/${verb}`, {});
  const decideDraft = (draftId, verb) => run(verb === 'approve' ? 'Sending…' : 'Withdrawing…', () => settle(draftId, verb))
    .then((ok) => { if (ok) { reload(); if (verb === 'approve') { setTimeout(reload, 2500); setTimeout(reload, 8000); } } });

  // Riley looks for more companies by herself the first time the renewal is opened with nobody asked yet.
  // The search takes a minute or more, so it runs on the server while this asks after it.
  const looked = useRef(!!found);
  const find = async () => {
    looked.current = true;
    setBusy('Riley is looking for insurers and brokers to ask. This takes a minute or two…'); setError('');
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
  const nobodyAsked = !!r && r.status === 'open' && r.suppliers.every((s) => s.state === 'listed');
  useEffect(() => { if (nobodyAsked && !looked.current) find(); }, [nobodyAsked]);

  // Once quotes are in, they are compared without being asked: again whenever another arrives.
  const compared = useRef(-1);
  useEffect(() => {
    if (!r || r.status !== 'open' || !r.quotes.length || r.compared || busy || compared.current === r.quotes.length) return;
    compared.current = r.quotes.length;
    act('Riley is comparing the offers…', () => api.post(`${base}/compare`, {}));
  }, [r, busy]);
  // Looking the suppliers up runs on the server: while it does, the page reads again every few seconds.
  useEffect(() => {
    if (!r?.looking) return undefined;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [r]);

  if (!r) return error ? (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-mute hover:text-txt"><ChevronLeft size={16} /> Back to documents</button>
      <p className="text-sm text-bad">{error}</p>
    </div>
  ) : <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;

  const d = r.document;
  const open = r.status === 'open' || r.status === 'decided';
  const toAsk = r.suppliers.filter((s) => ['listed', 'failed'].includes(s.state)); // on the renewal, not written to yet
  const letters = r.suppliers.filter((s) => !['listed'].includes(s.state)); // everybody an email exists for
  const waitingForMe = letters.filter((s) => s.state === 'drafted' && s.draft_owner === r.me);
  const byHand = letters.filter((s) => s.state === 'written');
  const out = letters.filter((s) => ['sending', 'sent', 'replied'].includes(s.state));
  const silent = out.filter((s) => s.state !== 'replied');
  const chosen = r.quotes.find((q) => q.id === r.chosen_quote_id);
  const closingForMe = r.closing.filter((c) => c.status === 'pending' && c.draft_owner === r.me);
  const about = (sid) => r.suppliers.find((s) => s.supplier_id === sid)?.about || {};
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // The rows of who can be asked: those on the renewal and not yet written to, then the ones kept from before, then the ones found.
  const rows = [
    ...toAsk.map((s) => ({ key: `s${s.supplier_id}`, supplier_id: s.supplier_id, name: s.name, tag: s.is_current ? 'Has it now' : s.found_by === 'search' ? 'Found on the web' : 'Added', email: s.email || '', website: s.website, onByDefault: true })),
    ...(found?.known || []).map((s) => ({ key: `k${s.id}`, supplier_id: s.id, name: s.name, tag: 'Used before', email: s.email || '', website: s.website, add: true })),
    ...(found?.found || []).map((s) => ({ key: `f${s.name}`, name: s.name, tag: 'Found on the web', why: s.why, email: s.email || '', website: s.website, phone: s.phone, kind: s.kind, add: true, web: true })),
  ];
  const pick = (row) => ({ on: row.onByDefault || false, address: row.email, ...picks[row.key] });
  const setPick = (row, change) => setPicks({ ...picks, [row.key]: { ...pick(row), ...change } });
  const ticked = rows.filter((row) => pick(row).on);
  const ready = ticked.filter((row) => pick(row).address.trim());

  // One press: the ticked companies join the renewal with the addresses given, and Riley writes to each.
  const ask = () => act('Riley is writing the emails…', async () => {
    const fresh = ready.filter((row) => row.add && !row.supplier_id);
    // A company found on the web is first kept as found, then its address confirmed by this press: two acts, so it is on record which it was.
    if (fresh.length) await api.post(`${base}/suppliers`, { suppliers: fresh.map((row) => ({ name: row.name, website: row.website, phone: row.phone, kind: row.kind, found_by: 'search' })) });
    let v = await api.get(base);
    const idOf = (row) => row.supplier_id || v.suppliers.find((s) => s.name.toLowerCase() === row.name.toLowerCase())?.supplier_id;
    v = await api.post(`${base}/suppliers`, { suppliers: ready.map((row) => ({ supplier_id: idOf(row), email: pick(row).address.trim() })).filter((s) => s.supplier_id) });
    const ids = ready.map(idOf).filter(Boolean);
    return ids.length ? api.post(`${base}/requests`, { supplier_ids: ids }) : v;
  }, () => { setPicks({}); setFound(null); setAsking(false); });

  const approveAll = (list, what) => confirm(`Send ${plural(list.length, 'email')} now? ${what}`) && run('Sending…', async () => { for (const draftId of list) await settle(draftId, 'approve'); return true; })
    .then(() => { reload(); setTimeout(reload, 2500); setTimeout(reload, 8000); });

  // What happens next, in one line: the only thing a person has to read to know what to do.
  const next = !open ? CLOSED[r.status]
    : chosen ? (closingForMe.length ? `Approve the email to ${chosen.supplier} below to accept their offer.` : 'When the new policy arrives, upload it below. That finishes the renewal.')
      : r.quotes.length ? `${plural(r.quotes.length, 'quote')} in. Choose the one you want.`
        : waitingForMe.length ? `Read the ${plural(waitingForMe.length, 'email')} below and approve ${waitingForMe.length === 1 ? 'it' : 'them'}. Nothing is sent until you do.`
          : byHand.length ? 'Send the emails below yourself, then press “I have sent it” on each.'
            : silent.length ? `Waiting for ${silent.map((s) => s.name).join(', ')} to reply. Riley checks your inbox every half hour.`
              : busy ? 'One moment…' : 'Tick who to ask, give their email address, and press the button.';
  const showAsk = r.status === 'open' && !chosen && (nobodyAsked || asking);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-mute hover:text-txt"><ChevronLeft size={16} /> Back to documents</button>
      <div>
        <h2 className="text-lg font-light">Renewing {d.title}</h2>
        <p className="text-sm text-mute">{[d.where, d.expiry_date && `expires ${fmt(d.expiry_date)}`, d.details.insurer && `with ${d.details.insurer}`].filter(Boolean).join(' · ')}</p>
      </div>

      <div className="rounded-2xl bg-gradient-to-br from-p1/15 to-p2/10 px-4 py-3.5">
        <p className="text-[11px] font-medium uppercase tracking-widest text-p3">What to do now</p>
        <p className="mt-1 text-base">{next}</p>
        {busy && <p className="mt-2 flex items-center gap-2 text-sm text-p3"><Loader2 size={15} className="animate-spin" /> {busy}</p>}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {note && <p className="text-sm text-ok">{note}</p>}

      {/* 1. Who to ask */}
      {showAsk && (
        <div className="space-y-2.5">
          {found?.failed && <p className="text-sm text-warn">Riley could not search the web just now. You can still ask the companies below, or add one.</p>}
          {rows.map((row) => (
            <AskRow key={row.key} name={row.name} tag={row.tag} why={row.why} website={row.website} on={pick(row).on} address={pick(row).address}
              onTick={(on) => setPick(row, { on })} onAddress={(address) => setPick(row, { address })} />
          ))}
          {extra.open ? (
            <form className={`${CARD} space-y-2`} onSubmit={(e) => { e.preventDefault(); act('Adding…', () => api.post(`${base}/suppliers`, { suppliers: [{ name: extra.name, email: extra.email }] }), () => setExtra({ open: false, name: '', email: '' })); }}>
              <input value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} required placeholder="Company name" className={FIELD} autoFocus />
              <input value={extra.email} onChange={(e) => setExtra({ ...extra, email: e.target.value })} type="email" placeholder="Their email address" className={FIELD} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setExtra({ open: false, name: '', email: '' })} className={QUIET}>Cancel</button>
                <button className={QUIET}><Plus size={15} /> Add</button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className={QUIET} onClick={() => setExtra({ ...extra, open: true })}><Plus size={15} /> Add a company I know</button>
              {!busy && <button className={QUIET} onClick={find}><Search size={15} /> Look for more</button>}
            </div>
          )}
          <button className={`${PRIMARY} w-full justify-center py-3 text-base`} disabled={!!busy || !ready.length} onClick={ask}>
            <Sparkles size={17} /> {ready.length ? `Write the email to ${ready.length === 1 ? ready[0].name : plural(ready.length, 'company', 'companies')}` : ticked.length ? 'Give an email address first' : 'Tick who to ask'}
          </button>
          {ticked.length > ready.length && ready.length > 0 && <p className="text-center text-xs text-mute">{plural(ticked.length - ready.length, 'company', 'companies')} without an address will be left out.</p>}
        </div>
      )}

      {/* 2. The emails */}
      {letters.length > 0 && !chosen && (
        <div className="space-y-2.5">
          {waitingForMe.length > 1 && (
            <button className={`${PRIMARY} w-full justify-center py-3 text-base`} disabled={!!busy} onClick={() => approveAll(waitingForMe.map((s) => s.draft_id), `They go to: ${waitingForMe.map((s) => s.to).join(', ')}.`)}>
              <Mail size={17} /> Approve and send all {waitingForMe.length}
            </button>
          )}
          {letters.map((s) => (
            <details key={s.supplier_id} className={CARD} open={['drafted', 'written', 'failed'].includes(s.state)}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                {s.state === 'replied' ? <Chip tone={s.reply_kind === 'quote' ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}>{REPLY[s.reply_kind] || 'Wrote back'}</Chip>
                  : <Chip tone={STATE[s.state][1]}>{STATE[s.state][0]}{s.sent_at ? ` ${when(s.sent_at)}` : ''}</Chip>}
              </summary>
              {s.reply_note && <p className="mt-2"><Riley>{s.reply_note}</Riley></p>}
              {s.state === 'failed' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-sm text-bad">It could not be sent: {s.error || 'no reason was given'}</p>
                  {r.status === 'open' && <button className={QUIET} disabled={!!busy} onClick={() => act('Riley is writing it again…', () => api.post(`${base}/requests`, { supplier_ids: [s.supplier_id] }))}><Sparkles size={14} /> Write it again</button>}
                </div>
              )}
              {s.state === 'drafted' && s.found_by === 'search' && <p className="mt-2 text-xs text-warn">This company was found on the web. Check the address is theirs before you approve.</p>}
              {s.body && (
                <Letter to={s.to} subject={s.subject} body={s.body} status={s.state === 'drafted' ? 'pending' : s.state === 'written' ? null : s.state} mine={s.draft_owner === r.me}
                  canEdit={open && (s.state === 'written' || (s.state === 'drafted' && s.draft_owner === r.me))}
                  onSave={(w) => act('Saving…', () => api.put(`${base}/requests/${s.request_id}`, w))}
                  onApprove={() => decideDraft(s.draft_id, 'approve')} onReject={() => decideDraft(s.draft_id, 'reject')}
                  onSent={() => act('Noting it…', () => api.post(`${base}/requests/${s.request_id}/sent`, {}))}
                  note={d.has_file && s.state === 'drafted' ? `Attached: ${d.file_name}` : null} />
              )}
              {s.chaser_status === 'pending' && (
                <>
                  <p className="mt-3"><Riley>No reply yet, so a follow-up is written</Riley></p>
                  <Letter to={s.to} subject={/^re\s*:/i.test(s.subject || '') ? s.subject : `Re: ${s.subject}`} body={s.chaser_body} status="pending" mine={s.chaser_owner === r.me}
                    onApprove={() => decideDraft(s.chaser_draft_id, 'approve')} onReject={() => decideDraft(s.chaser_draft_id, 'reject')} />
                </>
              )}
            </details>
          ))}
          {r.status === 'open' && (
            <div className="flex flex-wrap gap-2">
              {out.length > 0 && <button className={QUIET} disabled={!!busy} onClick={() => act('Riley is reading your inbox…', () => api.post(`${base}/check`, {}),
                (g) => setNote(g.quotes.length || g.questions.length ? [g.quotes.length && `New quote from ${g.quotes.join(', ')}`, g.questions.length && `A question from ${g.questions.join(', ')}`].filter(Boolean).join('. ') : 'Nothing new has come in yet.'))}><RefreshCw size={14} /> Check for replies now</button>}
              <button className={QUIET} onClick={() => setUpload({ ...upload, open: !upload.open })}><FileUp size={14} /> I got a quote another way</button>
              {!showAsk && <button className={QUIET} onClick={() => setAsking(true)}><Plus size={14} /> Ask more companies</button>}
            </div>
          )}
          {upload.open && (
            <div className={`${CARD} space-y-2`}>
              <Select value={upload.from} onChange={(e) => setUpload({ ...upload, from: e.target.value })} options={r.suppliers.map((s) => [s.supplier_id, s.name])} placeholder="Who is the quote from?" aria-label="Supplier" className={FIELD} />
              <label className={`flex items-center justify-center gap-2 rounded-xl border border-dashed border-stroke px-3.5 py-4 text-sm text-mute ${upload.from ? 'cursor-pointer hover:bg-white/5' : 'opacity-50'}`}>
                <FileUp size={16} /> Choose the PDF: Riley reads it
                <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={!upload.from || !!busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const form = new FormData();
                    form.append('supplier_id', upload.from);
                    form.append('file', file);
                    act('Riley is reading the quote…', () => api.upload(`${base}/quotes`, form), () => setUpload({ open: false, from: '' }));
                  }} />
              </label>
            </div>
          )}
        </div>
      )}

      {/* 3. The offers: each one a card to choose, Riley's pick first */}
      {r.quotes.length > 0 && (
        <div className="space-y-2.5">
          {r.compared && !r.compared.failed && r.compared.why && (
            <div className={CARD}>
              <Riley>What Riley would do</Riley>
              <p className="mt-1 whitespace-pre-wrap text-sm">{r.compared.why}</p>
              {r.compared.unsure && <p className="mt-2 text-sm text-warn">Check first: {r.compared.unsure}</p>}
            </div>
          )}
          {(r.compared ? [...r.compared.offers].sort((a, b) => (b.quote_id === r.compared.pick) - (a.quote_id === r.compared.pick)) : r.quotes.map((q) => ({ ...q, quote_id: q.id, verdicts: {} }))).map((o) => {
            const a = about(o.supplier_id);
            const picked = r.compared?.pick === o.quote_id;
            const mine = o.quote_id === r.chosen_quote_id;
            const q = r.quotes.find((x) => x.id === o.quote_id);
            return (
              <div key={o.quote_id} className={`rounded-2xl border px-4 py-3.5 ${mine ? 'border-ok/60 bg-ok/[0.06]' : picked ? 'border-p1/60 bg-p1/[0.06]' : 'border-stroke'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate font-medium">{o.supplier}</p>
                  {mine ? <Chip tone="bg-ok/15 text-ok">Chosen</Chip> : picked && <Chip tone="bg-p1/20 text-p1">Riley’s pick</Chip>}
                </div>
                <p className="mt-1 text-2xl font-light">{o.premium || 'Price not read'}{o.verdicts?.premium && <span className={`ml-2 text-sm ${VERDICT[o.verdicts.premium]}`}>{o.verdicts.premium === 'better' ? 'cheaper than now' : o.verdicts.premium === 'worse' ? 'dearer than now' : 'same as now'}</span>}</p>
                <dl className="mt-2 space-y-0.5 text-sm">
                  {ROWS.slice(1).filter(([k]) => o[k]).map(([k, l]) => (
                    <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt>
                      <dd className="min-w-0 flex-1 break-words text-right">{k === 'valid_until' ? fmt(o[k]) : o[k]}{o.verdicts?.[k] && k !== 'valid_until' && <span className={`ml-1.5 text-xs ${VERDICT[o.verdicts[k]]}`}>{o.verdicts[k]}</span>}</dd></div>
                  ))}
                </dl>
                {q?.has_file && <a href={`/api${base}/quotes/${q.id}/file`} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1.5 text-sm text-p3 hover:underline"><Paperclip size={14} /> Open their quote</a>}
                {(a.summary || a.licensed || a.rating || r.looking) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-mute hover:text-txt">About this company</summary>
                    {r.looking && !a.checked_on ? <p className="mt-1 flex items-center gap-2 text-xs text-mute"><Loader2 size={12} className="animate-spin" /> Riley is looking them up…</p> : (
                      <>
                        <dl className="mt-1 space-y-0.5 text-xs">
                          {[['summary', 'Who they are'], ['licensed', 'Licence'], ['rating', 'Rating'], ['since', 'Trading since']].filter(([k]) => a[k]).map(([k, l]) => <div key={k} className="flex gap-3"><dt className="shrink-0 text-mute">{l}</dt><dd className="min-w-0 flex-1 break-words text-right">{a[k]}</dd></div>)}
                        </dl>
                        {(a.sources || []).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-xs text-p3 hover:underline"><ExternalLink size={12} /> {s.title}</a>)}
                        <p className="mt-1 text-[11px] text-mute">Found on the web. Check it yourself before relying on it.</p>
                      </>
                    )}
                  </details>
                )}
                {open && !mine && (
                  <button className={`${picked ? PRIMARY : QUIET} mt-3 w-full justify-center py-2.5`} disabled={!!busy}
                    onClick={() => confirm(`Go with ${o.supplier}? Riley writes the email accepting their offer. It is not sent until you approve it.`) && act('Riley is writing the emails…', () => api.post(`${base}/decide`, { quote_id: o.quote_id }))}>
                    <Check size={16} /> Choose {o.supplier}
                  </button>
                )}
                {open && !chosen && <button onClick={() => confirm(`Remove this quote from ${o.supplier}?`) && act('Removing…', () => api.del(`${base}/quotes/${o.quote_id}`))} className="mt-2 flex items-center gap-1 text-xs text-mute hover:text-bad"><Trash2 size={12} /> Remove this quote</button>}
              </div>
            );
          })}
        </div>
      )}

      {/* 4. After choosing: the emails that say so, and the new policy */}
      {chosen && (
        <div className="space-y-2.5">
          {closingForMe.length > 1 && (
            <button className={`${PRIMARY} w-full justify-center py-3 text-base`} disabled={!!busy} onClick={() => approveAll(closingForMe.map((c) => c.draft_id), `They go to: ${closingForMe.map((c) => c.to).join(', ')}.`)}>
              <Mail size={17} /> Approve and send all {closingForMe.length}
            </button>
          )}
          {r.closing.map((c) => (
            <details key={`${c.kind}-${c.supplier_id}`} className={CARD} open={c.status === 'pending' || c.status == null}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.kind === 'accept' ? 'Accepting' : 'Thanking'} {c.supplier}</span>
                {c.status && <Chip tone={c.status === 'sent' ? 'bg-ok/10 text-ok' : c.status === 'pending' ? 'bg-warn/10 text-warn' : 'bg-white/10 text-txt/80'}>{c.status === 'pending' ? 'Waiting for approval' : c.status === 'sent' ? 'Sent' : c.status === 'rejected' ? 'Not sent' : c.status === 'failed' ? 'Could not be sent' : 'Sending…'}</Chip>}
              </summary>
              {c.error && <p className="mt-1 text-sm text-bad">It could not be sent: {c.error}</p>}
              <Letter to={c.to} subject={c.subject} body={c.body} status={c.draft_id ? c.status : null} mine={c.draft_owner === r.me}
                onApprove={() => decideDraft(c.draft_id, 'approve')} onReject={() => decideDraft(c.draft_id, 'reject')} />
            </details>
          ))}
          {open && (
            <button className={`${closingForMe.length ? QUIET : PRIMARY} w-full justify-center py-3`} onClick={() => onFile(d)}><FileUp size={16} /> Upload the new policy</button>
          )}
        </div>
      )}

      {open && (
        <div className="border-t border-stroke/60 pt-4 text-right">
          <button className="text-xs text-mute underline hover:text-txt" disabled={!!busy} onClick={() => confirm('Stop this renewal? The document will stop reminding you to renew it.') && act('Closing…', () => api.post(`${base}/close`, { status: 'not_renewing' }))}>We are not renewing this</button>
        </div>
      )}
    </div>
  );
}
