import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, AlertTriangle, Search, X, ChevronRight, Check, FileText, Upload, Ban, Undo2, Building2, UserRound, Clock, HelpCircle, Link2Off,
} from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Picker from './Picker';

// Document Renewals (server/documentRenewals.js): the company's and the staff's papers that
// run out - passports, visas, contracts, trade licences. A strip of what needs someone on
// top, the employees (and the companies, vehicles, policies) underneath; tap one to see
// their documents, confirm what the AI read, upload the renewed one or mark it not renewing.

const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
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

// The strip on top: each count filters the list below to the people it is about.
const ALERTS = [
  ['expired', 'Expired', AlertTriangle, 'bad'],
  ['d14', 'Due in 14 days', Clock, 'bad'],
  ['d30', 'Due in 30 days', Clock, 'warn'],
  ['d60', 'Due in 60 days', Clock, 'p1'],
  ['confirm', 'To confirm', HelpCircle, 'warn'],
  ['unlinked', 'Not linked to anyone', Link2Off, 'mute'],
];

function AlertStrip({ alerts, active, onPick }) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {ALERTS.map(([key, label, Ico, tone]) => {
        const n = alerts?.[key] || 0;
        const on = active === key;
        return (
          <button key={key} onClick={() => onPick(on ? null : key)} disabled={!n && !on}
            className={`flex shrink-0 items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-left transition disabled:opacity-40 ${on ? 'border-p1/60 bg-white/10' : 'border-stroke bg-white/[0.04] hover:bg-white/[0.07]'}`}>
            <span className={`grid size-8 place-items-center rounded-full ${TONE[tone]}`}><Ico size={15} /></span>
            <span>
              <span className="block text-lg font-medium leading-none">{n}</span>
              <span className="text-xs text-mute">{label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Which rows an alert in the strip is about.
const matches = (row, alert) => {
  if (!alert) return true;
  if (alert === 'confirm') return row.confirm > 0;
  if (alert === 'unlinked') return false;
  return row.steps?.[alert] > 0;
};

// ---------- the list ----------

export default function DocumentRenewalsPage({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('employees');
  const [q, setQ] = useState('');
  const [alert, setAlert] = useState(null);
  const [open, setOpen] = useState(null); // { kind: 'employee', code } | { kind: 'subject', name } | { kind: 'unlinked' }

  const load = useCallback(() => api.get('/document-renewals').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (open) return <Holder open={open} types={data?.types || []} onBack={() => { setOpen(null); load(); }} />;

  const want = q.trim().toLowerCase();
  const people = (data?.employees || []).filter((e) => matches(e, alert)
    && (!want || [e.name, e.code, e.position, e.department, e.company].join(' ').toLowerCase().includes(want)));
  const subjects = (data?.subjects || []).filter((s) => matches(s, alert) && (!want || s.name.toLowerCase().includes(want)));
  const pickAlert = (a) => {
    if (a === 'unlinked') return setOpen({ kind: 'unlinked' });
    setAlert(a);
  };

  return (
    <Page title="Document Renewals" onBack={onBack}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !data ? <Spinner /> : (
        <div className="space-y-4 pb-8">
          {!data.saifsys && <Problem text="saifsys did not answer, so only the employees who already have documents are listed." />}
          <AlertStrip alerts={data.alerts} active={alert} onPick={pickAlert} />
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
            {alert && (
              <button onClick={() => setAlert(null)} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:text-txt">
                <X size={13} /> Show everyone
              </button>
            )}
          </div>
          {tab === 'employees' ? (
            people.length === 0 ? <p className="pt-12 text-center text-sm text-mute">Nobody here.</p> : (
              <ul className="glass divide-y divide-stroke/60 overflow-hidden rounded-2xl">
                {people.map((e) => (
                  <Row key={e.code} icon={<UserRound size={17} />} title={e.name} worst={e.worst} documents={e.documents} confirm={e.confirm}
                    sub={[e.code, e.position, e.department, e.company, e.current === false ? 'Not current in saifsys' : null].filter(Boolean).join(' · ')}
                    onClick={() => setOpen({ kind: 'employee', code: e.code })} />
                ))}
              </ul>
            )
          ) : (
            subjects.length === 0 ? <p className="pt-12 text-center text-sm text-mute">No company documents yet. File a trade licence, insurance policy or Mulkiya on the Shelf and it appears here.</p> : (
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
    </Page>
  );
}

function Row({ icon, title, sub, worst, documents, confirm, onClick }) {
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.06]">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-mute">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          {sub && <span className="block truncate text-xs text-mute">{sub}</span>}
        </span>
        {confirm > 0 && <span className={`hidden shrink-0 rounded-full px-2.5 py-0.5 text-xs sm:inline ${TONE.warn}`}>{confirm} to confirm</span>}
        <span className="hidden shrink-0 text-xs text-mute sm:inline">{documents} doc{documents === 1 ? '' : 's'}</span>
        <Chip step={worst} />
        <ChevronRight size={16} className="shrink-0 text-mute" />
      </button>
    </li>
  );
}

// ---------- one employee, company or the unlinked files ----------

function Holder({ open, types, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const path = open.kind === 'employee' ? `/document-renewals/employees/${encodeURIComponent(open.code)}`
    : open.kind === 'subject' ? `/document-renewals/subjects?name=${encodeURIComponent(open.name)}`
      : '/document-renewals/unlinked';
  const load = useCallback(() => api.get(path).then(setD).catch((e) => setError(e.message)), [path]);
  useEffect(() => { load(); }, [load]);

  const e = d?.employee;
  const title = open.kind === 'employee' ? (e?.name || open.code) : open.kind === 'subject' ? open.name : 'Not linked to anyone';
  // The types a new document here can be: the employee ones for a person, the others for a company.
  const offer = types.filter((c) => (open.kind === 'employee' ? c.links_to === 'employee' : open.kind === 'subject' ? c.links_to === 'subject' : false))
    .flatMap((c) => c.types.map((t) => ({ value: String(t.id), label: t.label, group: c.label })));

  return (
    <Page title={title} onBack={onBack}>
      {error ? <div className="pt-6"><Problem text={error} /></div> : !d ? <Spinner /> : (
        <div className="space-y-4 pb-8">
          {e && (
            <div className="glass grid grid-cols-2 gap-x-6 gap-y-2 rounded-2xl p-4 text-sm sm:grid-cols-4">
              {[['Code', e.code], ['Position', e.position], ['Department', e.department], ['Company', e.company], ['Joined', day(e.joined)], ['Status', e.current === false ? 'Not current in saifsys' : e.status]]
                .filter(([, v]) => v).map(([k, v]) => (
                  <div key={k}><p className="text-xs text-mute">{k}</p><p className="truncate">{v}</p></div>
                ))}
            </div>
          )}
          {offer.length > 0 && <AddDocument offer={offer} holder={open} onDone={load} />}
          {d.documents.length === 0 ? <p className="pt-8 text-center text-sm text-mute">No documents yet.</p> : (
            <ul className="space-y-2">
              {d.documents.map((doc) => <DocRow key={doc.id} doc={doc} onChanged={load} />)}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

function DocRow({ doc, onChanged }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const s = doc.state;
  const act = async (what, body) => {
    setBusy(what); setError('');
    try { await api.patch(`/documents/${doc.id}`, body); await onChanged(); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const notRenewing = () => {
    const note = window.prompt('Why is it not being renewed? (optional)', '');
    if (note !== null) act('not', { not_renewing: { note } });
  };
  return (
    <li className={`glass rounded-2xl p-4 ${s.step === 'expired' || s.step === 'd14' ? 'border border-bad/40' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-mute"><FileText size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{doc.type}</p>
          <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer" className="block truncate text-xs text-mute hover:text-txt hover:underline">{doc.title || doc.name}</a>
          <p className="mt-1 text-sm">{doc.expires_on ? <>Expires {day(doc.expires_on)}</> : <span className="text-mute">No expiry date read</span>}</p>
          {doc.not_renewing_note && <p className="text-xs text-mute">Not renewing: {doc.not_renewing_note}</p>}
        </div>
        <Chip step={s.step}>{daysWord(s)}</Chip>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
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
        {s.step === 'not_renewing'
          ? <SmallBtn busy={busy === 'undo'} onClick={() => act('undo', { not_renewing: null })}><Undo2 size={13} /> Renewing after all</SmallBtn>
          : ['expired', 'd14', 'd30', 'd60'].includes(s.step) && <SmallBtn busy={busy === 'not'} onClick={notRenewing}><Ban size={13} /> Not renewing</SmallBtn>}
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

/** Upload a document for this person or company: it lands on the Shelf already filed as the chosen type. */
function AddDocument({ offer, holder, onDone }) {
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const send = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('files', file);
      const [r] = await api.upload('/documents', form);
      await api.patch(`/documents/${r.id}`, holder.kind === 'employee'
        ? { type_id: Number(type), employee_code: holder.code, confirm_link: true }
        : { type_id: Number(type), subject: holder.name, confirm_link: true });
      setType('');
      await onDone();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="glass space-y-2 rounded-2xl p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Picker value={type} onChange={setType} options={offer} placeholder="Add a document: pick its kind" searchPlaceholder="Search kinds" className="flex-1" />
        <button onClick={() => input.current?.click()} disabled={!type || busy}
          className="flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98] disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload
        </button>
        <input ref={input} type="file" hidden accept="image/*,application/pdf" onChange={(e) => { send(e.target.files[0]); e.target.value = ''; }} />
      </div>
      <p className="text-xs text-mute">Reem reads the expiry date from it; confirm the date once it shows.</p>
      <Problem text={error} />
    </div>
  );
}
