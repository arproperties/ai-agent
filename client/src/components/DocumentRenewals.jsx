import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, AlertTriangle, Search, X, ChevronRight, Check, FileText, Ban, Undo2, Building2, UserRound, RefreshCw, Settings2, Send, Paperclip, Bell as BellIcon, Briefcase,
} from 'lucide-react';
import { api } from '../lib/api';
import { cleanEmail } from '../lib/email';
import Page from './Page';
import Picker from './Picker';
import Sheet from './Sheet';
import RenewalCasePage, { StatusChip, ContractSalary, ProposalForm, ProposalView, canPropose } from './RenewalCase';

// Document Renewals (server/documentRenewals.js): the employees whose labour contract runs
// out within 60 days, to renew or terminate (the contract is the one paper the company
// renews), and the company's own papers. Tap a person to see their saifsys record and all
// their documents, which come from saifsys.

const day = (d) => (d && d >= '1900' ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const TONE = { bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', ok: 'bg-ok/15 text-ok', mute: 'bg-white/10 text-mute' };

// One document's (or one person's worst) state, as words and a colour.
const STEP = {
  expired: ['Expired', 'bad'], d14: ['Within 14 days', 'bad'], d30: ['Within 30 days', 'warn'], d60: ['Within 60 days', 'p1'],
  later: ['Valid', 'ok'], no_date: ['No date', 'mute'], not_renewing: ['Not renewing', 'mute'], none: ['No documents', 'mute'],
};
const daysWord = (s) => (s.step === 'expired' ? `Expired ${-s.days} day${s.days === -1 ? '' : 's'} ago`
  : s.days === 0 ? 'Expires today' : s.days != null && s.step !== 'later' ? `${s.days} day${s.days === 1 ? '' : 's'} left` : STEP[s.step][0]);

const Chip = ({ step, children }) => {
  const [label, tone] = STEP[step] || STEP.none;
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${TONE[tone]}`}>{children || label}</span>;
};
const Problem = ({ text }) => (text ? <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {text}</p> : null);
const Spinner = () => <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>;

// The list shows only whose labour contract (the one paper the company renews) ends between
// today and 60 days from now, soonest first; a search looks through everyone. Company papers: any due.
const DUE = ['expired', 'd14', 'd30', 'd60'];
const due = (row) => DUE.some((s) => row.steps?.[s] > 0);
const contractDue = (e) => ['d14', 'd30', 'd60'].includes(e.contract?.step);
const contractWord = (c) => (c ? `Contract: ${daysWord(c).replace(/^Valid$/, `ends ${day(c.expires_on)}`)}` : 'No labour contract');

// ---------- the list ----------

export default function DocumentRenewalsPage({ onBack, start = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('employees');
  const [q, setQ] = useState('');
  // { kind: 'employee', code } | { kind: 'subject', name } | { kind: 'unlinked' }; a notification may name an employee
  const [open, setOpen] = useState(!start || start === '1' ? null
    : start.startsWith('case-') ? { kind: 'case', id: Number(start.slice(5)) } : { kind: 'employee', code: start });
  const [settings, setSettings] = useState(false);
  const [rowError, setRowError] = useState('');
  const [modal, setModal] = useState(null); // { code, name, kind }: Renew or Terminate, in a pop-up on this page

  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState('');

  const load = useCallback(() => api.get('/document-renewals').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  // The master brings saifsys's employee documents across now instead of waiting for the night.
  const sync = async () => {
    setSyncing(true); setSynced(''); setError('');
    try {
      const r = await api.post('/document-renewals/sync');
      setSynced(r.skipped ? r.skipped : `From saifsys: ${r.added} new, ${r.updated} changed, ${r.superseded} replaced by a newer one.`);
      await load();
    } catch (e) { setError(e.message); }
    setSyncing(false);
  };
  const syncButton = data && (
    <div className="flex gap-2">
    <Bell onPick={(i) => setOpen(i.case_id ? { kind: 'case', id: i.case_id } : { kind: 'employee', code: i.employee_code })} />
    {data.master && <>
    <button onClick={() => setSettings(true)} title="Settings" className="grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt"><Settings2 size={15} /></button>
    <button onClick={sync} disabled={syncing}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute transition hover:text-txt disabled:opacity-50">
      <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync from saifsys'}
    </button>
    </>}
    </div>
  );

  if (open?.kind === 'case') return <RenewalCasePage id={open.id} onBack={() => { setOpen(open.from || null); load(); }} />;
  if (open) return <Holder open={open} onBack={() => { setOpen(null); load(); }} onCase={(id) => setOpen({ kind: 'case', id, from: open })} />;

  const want = q.trim().toLowerCase();
  const people = (data?.employees || []).filter((e) => (want ? [e.name, e.code, e.position, e.department, e.company].join(' ').toLowerCase().includes(want) : contractDue(e)))
    .sort((a, b) => (a.contract?.days ?? 1e9) - (b.contract?.days ?? 1e9) || a.name.localeCompare(b.name));
  const subjects = (data?.subjects || []).filter((s) => (want ? s.name.toLowerCase().includes(want) : due(s)));

  return (
    <Page title="Document Renewals" onBack={onBack} action={syncButton}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !data ? <Spinner /> : (
        <div className="space-y-4 pb-8">
          {synced && <p className="flex items-center gap-1.5 text-sm text-ok"><Check size={15} /> {synced}</p>}
          {!data.saifsys && <Problem text="saifsys did not answer, so only the employees who already have documents are listed." />}
          <div className="glass flex items-center gap-2 rounded-xl px-3.5 py-2">
            <Search size={15} className="shrink-0 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, position…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute/70" />
            {q && <button onClick={() => setQ('')} aria-label="Clear" className="text-mute hover:text-txt"><X size={14} /></button>}
          </div>
          <div className="flex gap-1.5">
            {[['employees', 'Employees', people.length], ['company', 'Company', subjects.length]].map(([k, label, n]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${tab === k ? 'bg-white/15 text-txt' : 'text-mute hover:text-txt'}`}>
                {label} <span className="rounded-full bg-white/10 px-1.5 text-xs">{n}</span>
              </button>
            ))}
          </div>
          {!want && (
            <p className="-mt-2 text-xs text-mute">{tab === 'employees' ? 'Labour contracts ending within the next 60 days. Search to find anyone else.' : 'Expired or ending within 60 days.'}</p>
          )}
          <Problem text={rowError} />
          {tab === 'employees' ? (
            people.length === 0 ? <p className="pt-12 text-center text-sm text-mute">{want ? 'Nobody found.' : 'No labour contract ends within the next 60 days.'}</p> : (
              <ul className="glass divide-y divide-stroke/60 overflow-hidden rounded-2xl">
                {people.map((e) => (
                  <Row key={e.code} icon={<UserRound size={17} />} title={e.name} worst={e.contract?.step || 'none'} label={contractWord(e.contract)}
                    sub={[e.code, e.position, e.department, e.company, e.current === false ? 'Not current in saifsys' : null].filter(Boolean).join(' · ')}
                    onClick={() => setOpen({ kind: 'employee', code: e.code })}
                    actions={e.contract && (
                      <>
                        <SmallBtn onClick={() => setModal({ code: e.code, name: e.name, kind: 'renew' })} tone="p1"><RefreshCw size={13} /> Renew</SmallBtn>
                        <SmallBtn onClick={() => setModal({ code: e.code, name: e.name, kind: 'cancel' })}><Ban size={13} /> Terminate</SmallBtn>
                      </>
                    )} />
                ))}
              </ul>
            )
          ) : (
            subjects.length === 0 ? <p className="pt-12 text-center text-sm text-mute">{want ? 'Nothing found.' : 'No company document expired or ending within 60 days.'}</p> : (
              <ul className="glass divide-y divide-stroke/60 overflow-hidden rounded-2xl">
                {subjects.map((s) => (
                  <Row key={s.name} icon={<Building2 size={17} />} title={s.name} worst={s.worst} documents={s.documents} confirm={s.confirm}
                    onClick={() => setOpen({ kind: 'subject', name: s.name })} />
                ))}
              </ul>
            )
          )}
        </div>
      )}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      {modal && <ContractModal {...modal} onClose={() => { setModal(null); load(); }} onError={setRowError} />}
    </Page>
  );
}

// ---------- the bell ----------

const FEED_SEEN = 'documentRenewals.feedSeen';
const ago = (secs) => {
  if (!secs) return '';
  const m = Math.round((Date.now() / 1000 - secs) / 60);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * Who sent what on the labour contracts, and when: the renewal and termination emails and
 * the hand-offs to the PRO. A bell with a count of what is new since it was last opened.
 */
function Bell({ onPick }) {
  const [items, setItems] = useState(null);
  const [shown, setShown] = useState(false);
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(FEED_SEEN)) || 0);
  const [newSince, setNewSince] = useState(0); // the dots stay on what was new when the panel opened
  useEffect(() => { api.get('/document-renewals/feed').then((r) => setItems(r.items)).catch(() => setItems([])); }, [shown]);
  const list = items || [];
  const count = list.filter((i) => i.at > seen).length;
  const show = () => {
    setShown(true); setNewSince(seen);
    const latest = Math.max(0, ...list.map((i) => i.at || 0));
    if (latest) { localStorage.setItem(FEED_SEEN, String(latest)); setSeen(latest); }
  };
  return (
    <>
      <button onClick={show} title="Notifications" className="relative grid size-9 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:text-txt">
        <BellIcon size={15} />
        {count > 0 && <span className="absolute -right-1 -top-1 grid min-w-[1.1rem] place-items-center rounded-full bg-bad px-1 text-[10px] font-medium leading-[1.1rem] text-white">{count > 99 ? '99+' : count}</span>}
      </button>
      {shown && (
        <Sheet title="Notifications" onClose={() => setShown(false)}>
          {!items ? <Spinner /> : list.length === 0 ? <p className="py-10 text-center text-sm text-mute">No email sent yet.</p> : (
            <ul className="divide-y divide-stroke/60">
              {list.map((i) => {
                const Ico = /PRO/.test(i.title) ? Briefcase : Send;
                return (
                  <li key={i.key}>
                    <button onClick={() => { setShown(false); onPick(i); }} disabled={!i.case_id && !i.employee_code}
                      className="flex w-full items-start gap-3 py-3 text-left transition hover:bg-white/[0.04]">
                      <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${/^Termination/.test(i.title) ? TONE.bad : TONE.p1}`}><Ico size={14} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{i.title}</span>
                        <span className="block text-xs text-mute">{[i.employee_name, i.by && `by ${i.by}`, ago(i.at)].filter(Boolean).join(' · ')}</span>
                      </span>
                      {i.at > newSince && <span className="mt-2 size-2 shrink-0 rounded-full bg-p1" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Sheet>
      )}
    </>
  );
}

// A light wash on the whole row, in the colour of its state.
const WASH = { expired: 'bg-bad/[0.07]', d14: 'bg-bad/[0.07]', d30: 'bg-warn/[0.07]', d60: 'bg-p1/[0.08]' };

function Row({ icon, title, sub, worst, label, documents, confirm, onClick, actions }) {
  return (
    <li className={`flex items-center ${WASH[worst] || ''}`}>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.06]">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-mute">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{title}</span>
            <Chip step={worst}>{label}</Chip>
            {documents != null && <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-mute">{documents} doc{documents === 1 ? '' : 's'}</span>}
            {confirm > 0 && <span className={`rounded-full px-2.5 py-0.5 text-xs ${TONE.warn}`}>{confirm} to confirm</span>}
          </span>
          {sub && <span className="mt-0.5 block truncate text-xs text-mute">{sub}</span>}
        </span>
        {!actions && <ChevronRight size={16} className="shrink-0 text-mute" />}
      </button>
      {actions && <div className="flex shrink-0 gap-1.5 pr-4">{actions}</div>}
    </li>
  );
}

/**
 * Renew or Terminate on an employee's row, in a pop-up: their labour contract's case is opened
 * (or the one already there taken up), its form is filled in and saved (that is final, no
 * approval), and the email to the PRO follows here.
 */
function ContractModal({ code, name, kind, onClose, onError }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [paper, setPaper] = useState(null);
  useEffect(() => {
    api.post(`/document-renewals/employees/${encodeURIComponent(code)}/cases`, { kind })
      .then((r) => api.get(`/document-renewals/cases/${r.case_id}`)).then(setD)
      .catch((e) => { onError(`${name}: ${e.message}`); onClose(); });
  }, [code, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (what, path, body) => {
    setBusy(what); setError('');
    try { setD(await api.post(`/document-renewals/cases/${d.case.id}/${path}`, body)); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const c = d?.case;
  const title = `${kind === 'renew' ? 'Renew' : 'Terminate'} the labour contract – ${name}`;
  return (
    <Sheet title={title} onClose={onClose} wide="text">
      {!d ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-sm text-mute">Ends {day(c.ends_on)}.</p>
          {kind === 'renew' && <ContractSalary code={code} onRead={setPaper} />}
          {canPropose(c, d.tasks) ? (
            <ProposalForm c={c} contract employee={d.employee} paper={paper} busy={busy}
              onSave={(body) => act('save', 'proposal', body)} />
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">Where it stands: <StatusChip status={c.status} /></div>
              {c.proposal && <ProposalView p={c.proposal} />}
              <button onClick={onClose} className="w-full rounded-full border border-stroke py-2.5 text-sm text-mute hover:text-txt">Close</button>
            </>
          )}
          <Problem text={error} />
          {c.proposal && <CaseEmail key={c.proposal.at} caseId={c.id} renew={c.kind === 'renew'} />}
        </div>
      )}
    </Sheet>
  );
}

// Addresses picked from the list (company address book and staff), several at once; one
// that is not in the list can be typed and used as it is.
function Addresses({ label, value, onChange, choices }) {
  const options = [
    ...choices.map((c) => ({ value: c.email, label: c.email, hint: c.name || undefined })),
    ...value.filter((a) => !choices.some((c) => c.email === a)).map((a) => ({ value: a, label: a })),
  ];
  const add = (text) => {
    const more = text.split(/[,;\s]+/).map(cleanEmail).filter(Boolean);
    if (more.length) onChange([...new Set([...value, ...more])]);
  };
  return (
    <div className="space-y-1">
      <span className="text-xs text-mute">{label}</span>
      <Picker multi value={value} onChange={onChange} options={options} onNew={add}
        placeholder="Choose the addresses" searchPlaceholder="Search or type an address" />
    </div>
  );
}

/**
 * After the proposal is saved: the email to send about it. The person picks who it goes to
 * and who is copied; a renewal attaches the employee's documents (ticked ones only), a
 * termination none. Send sends it from their own mailbox.
 */
function CaseEmail({ caseId, renew }) {
  const [d, setD] = useState(null);
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  useEffect(() => {
    api.get(`/document-renewals/cases/${caseId}/email`).then((r) => {
      setD(r); setTo(r.to || []); setSubject(r.subject); setBody(r.body);
      setPicked(r.documents.filter((x) => x.available).map((x) => x.id));
    }).catch((e) => setError(e.message));
  }, [caseId]);
  const send = async () => {
    setBusy(true); setError('');
    try { setSent(await api.post(`/document-renewals/cases/${caseId}/email`, { to, cc, subject, body, document_ids: picked })); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const field = 'w-full rounded-xl border border-stroke bg-black/10 px-3 py-2.5 text-sm outline-none focus:border-p1/60';
  if (sent) {
    return <p className="flex items-start gap-1.5 rounded-xl bg-ok/10 p-3 text-sm text-ok"><Check size={15} className="mt-0.5 shrink-0" /> Sent to {[...sent.to, ...sent.cc].join(', ')}{sent.files.length ? `, with ${sent.files.length} document${sent.files.length === 1 ? '' : 's'}` : ''}. It is going out from your mailbox now.</p>;
  }
  return (
    <section className="glass space-y-3 rounded-2xl p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Send size={15} /> {renew ? 'Email to the PRO' : 'Email to the employee'}</h3>
      {!d ? (error ? <Problem text={error} /> : <Spinner />) : (
        <>
          {!renew && !d.to.length && <p className="text-xs text-warn">saifsys has no email for this employee: type it below.</p>}
          {!d.from && <Problem text="Your email is not connected with sending turned on, so this cannot be sent yet (Settings, Email)." />}
          {d.from && <p className="text-xs text-mute">From {d.from}</p>}
          <Addresses label="To" value={to} onChange={setTo} choices={d.addresses || []} />
          <Addresses label="Cc" value={cc} onChange={setCc} choices={d.addresses || []} />
          <label className="block space-y-1"><span className="text-xs text-mute">Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} /></label>
          <label className="block space-y-1"><span className="text-xs text-mute">Message</span><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={field} /></label>
          {renew && d.documents.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-mute">Attach their documents</p>
              {d.documents.map((x) => (
                <label key={x.id} className={`flex items-center gap-2 text-sm ${x.available ? '' : 'opacity-50'}`}>
                  <input type="checkbox" disabled={!x.available} checked={picked.includes(x.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((p) => p !== x.id))} />
                  <Paperclip size={13} className="text-mute" /> {x.type}{x.expires_on ? <span className="text-xs text-mute">· expires {day(x.expires_on)}</span> : null}
                  {!x.available && <span className="text-xs text-mute">· no file in saifsys</span>}
                </label>
              ))}
            </div>
          )}
          <Problem text={error} />
          <button onClick={send} disabled={busy || !to.length || !d.from}
            className="flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {busy ? (picked.length ? 'Fetching the documents and sending…' : 'Sending…') : 'Send'}
          </button>
        </>
      )}
    </section>
  );
}

// ---------- one employee, company or the unlinked files ----------

function Holder({ open, onBack, onCase }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const path = open.kind === 'employee' ? `/document-renewals/employees/${encodeURIComponent(open.code)}`
    : open.kind === 'subject' ? `/document-renewals/subjects?name=${encodeURIComponent(open.name)}`
      : '/document-renewals/unlinked';
  const load = useCallback(() => api.get(path).then(setD).catch((e) => setError(e.message)), [path]);
  useEffect(() => { load(); }, [load]);

  const e = d?.employee;
  const title = open.kind === 'employee' ? (e?.name || open.code) : open.kind === 'subject' ? open.name : 'Not linked to anyone';

  return (
    <Page title={title} onBack={onBack}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !d ? <Spinner /> : (
        <div className="space-y-4 pb-8">
          {e && (
            <div className="glass grid grid-cols-2 gap-x-6 gap-y-2 rounded-2xl p-4 text-sm sm:grid-cols-4">
              {[['Code', e.code], ['Position', e.position], ['Department', e.department], ['Work location', e.location], ['Company', e.company],
                ['Manager', e.manager], ['Joined', day(e.joined)], ['Status', e.current === false ? 'Not current in saifsys' : e.status],
                ['Salary', e.salary?.total ? `AED ${Number(e.salary.total).toLocaleString('en-US')} (${e.salary.paid_by || '—'})` : null]]
                .filter(([, v]) => v).map(([k, v]) => (
                  <div key={k}><p className="text-xs text-mute">{k}</p><p className="truncate">{v}</p></div>
                ))}
            </div>
          )}
          {open.kind === 'employee' && d.documents.some((x) => x.opens_case) && <ContractSalary code={open.code} />}
          {d.documents.length === 0 ? <p className="pt-8 text-center text-sm text-mute">No documents yet.</p> : (
            <ul className="space-y-2">
              {d.documents.map((doc) => <DocRow key={doc.id} doc={doc} onChanged={load} onCase={onCase} />)}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

function DocRow({ doc, onChanged, onCase }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const s = doc.state;
  // saifsys has the details but nothing scanned: there is nothing to open.
  const noFile = !doc.has_file && doc.saifsys_has_file === false;
  const act = async (what, body) => {
    setBusy(what); setError('');
    try { await api.patch(`/documents/${doc.id}`, body); await onChanged(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  // The document itself, in a new tab. The tab opens at once (a browser blocks one opened
  // after waiting); the file is fetched from saifsys first if Reem does not have it yet.
  const view = async () => {
    setError('');
    const tab = window.open('', '_blank');
    try {
      if (!doc.has_file) { setBusy('file'); await api.post(`/document-renewals/documents/${doc.id}/file`); }
      if (tab) tab.location = `/api/documents/${doc.id}/file`;
      else window.location.href = `/api/documents/${doc.id}/file`;
      if (!doc.has_file) onChanged();
    } catch (e) { tab?.close(); setError(e.message); }
    setBusy('');
  };
  // Renew or Terminate opens a case and goes straight to it, where the proposal is written.
  const startCase = async (kind) => {
    setBusy(kind); setError('');
    try { const c = await api.post(`/document-renewals/documents/${doc.id}/case`, { kind }); onCase(c.id); } catch (e) { setError(e.message); setBusy(''); }
  };
  return (
    <li className={`glass rounded-2xl p-4 ${s.step === 'expired' || s.step === 'd14' ? 'border border-bad/40' : ''}`}>
      <div className="flex items-start gap-3">
        <button onClick={view} disabled={noFile} title={noFile ? 'No file in saifsys' : 'Open the document'} className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-mute transition hover:bg-p1/30 hover:text-txt disabled:opacity-40 disabled:hover:bg-white/10">
          {busy === 'file' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          {noFile ? <p className="font-medium">{doc.type}</p> : <button onClick={view} className="text-left font-medium hover:underline">{doc.type}</button>}
          <p className="truncate text-xs text-mute">{doc.title || doc.name}{noFile ? ' · no file in saifsys' : ''}</p>
          {doc.summary && <p className="mt-0.5 text-xs text-mute/80">{doc.summary}</p>}
          <p className="mt-1 text-sm">{doc.expires_on ? <>Expires {day(doc.expires_on)}</> : <span className="text-mute">No expiry date read</span>}</p>
          {doc.not_renewing_note && <p className="text-xs text-mute">Not renewing: {doc.not_renewing_note}</p>}
        </div>
        <Chip step={s.step}>{daysWord(s)}</Chip>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {doc.open_case ? (
          <button onClick={() => onCase(doc.open_case.id)} className="flex items-center gap-1.5 rounded-full border border-p1/40 px-3 py-1.5 text-xs transition hover:bg-p1/10">
            Open case <StatusChip status={doc.open_case.status} />
          </button>
        ) : doc.opens_case && s.step !== 'not_renewing' && ( // only the labour contract: the company renews that, not the passport or ID
          <>
            <SmallBtn busy={busy === 'renew'} onClick={() => startCase('renew')} tone="p1"><RefreshCw size={13} /> Renew</SmallBtn>
            <SmallBtn busy={busy === 'cancel'} onClick={() => startCase('cancel')}><Ban size={13} /> Terminate</SmallBtn>
          </>
        )}
        {s.confirm.includes('expiry') && (
          <SmallBtn busy={busy === 'exp'} onClick={() => act('exp', { confirm_expiry: true })} tone="warn">
            <Check size={13} /> Confirm {day(doc.expires_on)}
          </SmallBtn>
        )}
        {s.confirm.includes('link') && (
          <SmallBtn busy={busy === 'link'} onClick={() => act('link', { confirm_link: true })} tone="warn">
            <Check size={13} /> Confirm it is {doc.employee_name || doc.subject}'s
          </SmallBtn>
        )}
        {s.step === 'not_renewing' && <SmallBtn busy={busy === 'undo'} onClick={() => act('undo', { not_renewing: null })}><Undo2 size={13} /> Renewing after all</SmallBtn>}
      </div>
      <Problem text={error} />
    </li>
  );
}

const SmallBtn = ({ busy, tone, children, ...p }) => (
  <button {...p} disabled={busy}
    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition disabled:opacity-40 ${tone ? TONE[tone] : 'border border-stroke text-mute hover:text-txt'}`}>
    {busy && <Loader2 size={12} className="animate-spin" />} {children}
  </button>
);

/**
 * The master's switch for everything Document Renewals sends: the case emails (Send) and the daily
 * expiry alerts. Saved with the other settings; turning it on asks first, because the first
 * day's alerts cover every document at once.
 */
function SendSwitch({ s, onChange }) {
  const on = !!s.send_on;
  const flip = () => {
    if (!on && !window.confirm('Turn on sending?\n\nThe Send button on renewal and termination emails will work, and the daily expiry alerts start today for every document (pushes and to-dos to you and the Document Renewals team).')) return;
    onChange(!on);
  };
  const since = s.send_changed_at ? new Date(s.send_changed_at * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className={`space-y-1.5 rounded-xl border p-3 ${on ? 'border-ok/40 bg-ok/10' : 'border-stroke bg-white/5'}`}>
      <div className="flex items-center gap-3">
        <span className="flex-1">
          <span className="block text-sm font-medium">Send emails and expiry alerts</span>
          <span className="block text-xs text-mute">{on ? 'On: Send works and the daily alerts go out.' : 'Off: nothing reaches anyone; the screen works as usual.'}</span>
        </span>
        <button type="button" role="switch" aria-checked={on} onClick={flip}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-ok' : 'bg-white/20'}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>
      {since && <p className="text-xs text-mute">Last turned {s.saved_on ? 'on' : 'off'}{s.send_changed_by ? ` by ${s.send_changed_by}` : ''} · {since}</p>}
      {on !== s.saved_on && <p className="text-xs text-warn">Takes effect when you press Save below.</p>}
    </div>
  );
}

/** The master's settings: whether sending is on, when a contract opens a case, and the alert days. */
function SettingsSheet({ onClose }) {
  const [s, setS] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api.get('/document-renewals/case-settings'), api.get('/document-renewals/alert-settings')])
      .then(([c, a]) => { setS({ ...c, saved_on: !!c.send_on }); setAlerts({ ...a, days: a.days.join(', ') }); })
      .catch((e) => setError(e.message));
  }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.put('/document-renewals/case-settings', { open_days: Number(s.open_days), send_on: !!s.send_on });
      await api.put('/document-renewals/alert-settings', { days: alerts.days.split(/[^\d]+/).filter(Boolean).map(Number), overdue_every_days: Number(alerts.overdue_every_days), hour: Number(alerts.hour) });
      onClose();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const field = 'w-full rounded-xl border border-stroke bg-black/10 px-3 py-2.5 text-sm outline-none focus:border-p1/60';
  return (
    <Sheet title="Document Renewals settings" onClose={onClose}>
      <div className="space-y-4 px-5 pb-6">
        {!s || !alerts ? (error ? <Problem text={error} /> : <Spinner />) : (
          <>
            <SendSwitch s={s} onChange={(on) => setS({ ...s, send_on: on })} />
            <label className="block space-y-1"><span className="text-xs text-mute">A contract opens a case this many days before it ends</span>
              <input inputMode="numeric" value={s.open_days} onChange={(e) => setS({ ...s, open_days: e.target.value })} className={field} /></label>
            <label className="block space-y-1"><span className="text-xs text-mute">Alerts this many days before expiry</span>
              <input value={alerts.days} onChange={(e) => setAlerts({ ...alerts, days: e.target.value })} placeholder="60, 30, 14" className={field} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1"><span className="text-xs text-mute">After expiry, remind every (days)</span>
                <input inputMode="numeric" value={alerts.overdue_every_days} onChange={(e) => setAlerts({ ...alerts, overdue_every_days: e.target.value })} className={field} /></label>
              <label className="block space-y-1"><span className="text-xs text-mute">At this hour (Dubai)</span>
                <input inputMode="numeric" value={alerts.hour} onChange={(e) => setAlerts({ ...alerts, hour: e.target.value })} className={field} /></label>
            </div>
            <Problem text={error} />
            <button onClick={save} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2.5 text-sm font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
