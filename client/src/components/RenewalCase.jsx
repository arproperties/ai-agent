import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Check, X, Pause, Play, Ban, FileText, RefreshCw, Send, ShieldCheck, ClipboardList, Sparkles, UserRound } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Picker from './Picker';

// One renewal case (server/renewalCases.js): a document being renewed or cancelled, step by
// step - decide, propose, approve, the PRO, the papers that come back, Verified. People decide
// every step; Reem compares and flags. Like Lease renewals' "Start the renewal", the proposal
// is a form with quick picks.

const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (secs) => new Date(secs * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const aed = (n) => (n === null || n === undefined ? '—' : `AED ${Number(n).toLocaleString('en-US')}`);
const addYears = (s, n) => {
  const d = new Date(`${s || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};
const TONE = { bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', p1: 'bg-p1/20 text-txt', ok: 'bg-ok/15 text-ok', mute: 'bg-white/10 text-mute' };
export const CASE_STATUS = {
  open: ['Needs a decision', 'warn'], renew_review: ['Renewal: proposal', 'p1'], cancel_review: ['Cancellation: proposal', 'p1'],
  needs_review: ['Needs review', 'warn'], awaiting_approval: ['Waiting for approval', 'warn'], approved: ['Approved: give it to the PRO', 'p1'],
  with_pro: ['With the PRO', 'p1'], checking_documents: ['Check the papers', 'warn'], writing_back: ['Update saifsys', 'p1'],
  paused: ['Paused', 'mute'], closed: ['Closed', 'ok'],
};
export const StatusChip = ({ status }) => {
  const [label, tone] = CASE_STATUS[status] || [status, 'mute'];
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${TONE[tone]}`}>{label}</span>;
};

const Problem = ({ text }) => (text ? <p className="flex items-start gap-1.5 text-sm text-bad"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {text}</p> : null);
const Box = ({ title, icon, children }) => (
  <section className="glass space-y-3 rounded-2xl p-4">
    {title && <h3 className="flex items-center gap-2 text-sm font-medium">{icon} {title}</h3>}
    {children}
  </section>
);
const Btn = ({ primary, danger, busy, children, className = '', ...p }) => (
  <button {...p} disabled={busy || p.disabled}
    className={`${primary ? 'bg-gradient-to-br from-p1 to-p2 font-medium text-white shadow-lg shadow-p1/25' : danger ? 'border border-bad/40 text-bad hover:bg-bad/10' : 'border border-stroke text-mute hover:text-txt'} flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-40 ${className}`}>
    {busy && <Loader2 size={14} className="animate-spin" />} {children}
  </button>
);
const Field = ({ label, children }) => (<label className="block space-y-1"><span className="text-xs text-mute">{label}</span>{children}</label>);
const input = 'w-full rounded-xl border border-stroke bg-black/10 px-3 py-2.5 text-sm outline-none focus:border-p1/60';
const Chips = ({ items, onPick, active }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map(([label, value]) => (
      <button key={label} type="button" onClick={() => onPick(value)}
        className={`rounded-full px-3 py-1 text-xs transition ${active === value ? 'bg-p1/30 text-txt' : 'bg-white/5 text-mute hover:text-txt'}`}>{label}</button>
    ))}
  </div>
);

export default function RenewalCasePage({ id, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.get(`/document-renewals/cases/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  // Every step answers with the case as it now is.
  const act = async (what, path, body) => {
    setBusy(what); setError('');
    try { setD(await api.post(`/document-renewals/cases/${id}/${path}`, body)); } catch (e) { setError(e.message); }
    setBusy('');
  };

  if (!d) return <Page title="Renewal case" onBack={onBack}>{error ? <div className="pt-6"><Problem text={error} /></div> : <div className="grid place-items-center pt-16 text-mute"><Loader2 className="animate-spin" /></div>}</Page>;
  const c = d.case;
  const contract = !!d.document?.opens_case;
  const who = c.employee_name || c.subject || 'Document';

  return (
    <Page title={`${d.document?.type || 'Document'} – ${who}`} onBack={onBack}>
      <div className="space-y-4 pb-10">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={c.status} />
          {c.kind && <span className="text-xs text-mute">{c.kind === 'renew' ? 'Renewal' : contract ? 'Termination review' : 'Cancellation'}</span>}
          {c.ends_on && <span className="text-xs text-mute">· ends {day(c.ends_on)}</span>}
          <a href={`/api/documents/${c.document_id}/file`} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-xs text-mute hover:text-txt"><FileText size={13} /> Open the document</a>
        </div>
        <Problem text={error} />
        {c.status === 'paused' && <p className="rounded-xl bg-white/5 p-3 text-sm">Paused: {c.paused_reason}</p>}

        {d.employee && (
          <Box title="Employee (saifsys)" icon={<UserRound size={15} />}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              {[['Code', d.employee.code], ['Position', d.employee.position], ['Work location', d.employee.location], ['Company', d.employee.company],
                ['Manager', d.employee.manager], ['Joined', day(d.employee.joined)], ['Status', d.employee.left ? 'Left' : d.employee.status],
                ['Salary', d.employee.salary?.total ? `${aed(d.employee.salary.total)} (${d.employee.salary.paid_by || '—'})` : null]]
                .filter(([, v]) => v).map(([k, v]) => <div key={k}><p className="text-xs text-mute">{k}</p><p className="truncate">{v}</p></div>)}
            </div>
          </Box>
        )}

        {d.compare && <Compare compare={d.compare} />}

        {['open', 'needs_review'].includes(c.status) && (
          <Box title="What should happen?">
            <p className="text-sm text-mute">{contract ? 'The contract ends soon. Renew it, start a termination review, or put it aside for review.' : 'Renew this document, cancel it, or put it aside for review.'}</p>
            <div className="flex flex-wrap gap-2">
              <Btn primary busy={busy === 'renew'} onClick={() => act('renew', 'decision', { choice: 'renew' })}><RefreshCw size={14} /> Renew</Btn>
              <Btn danger busy={busy === 'cancel'} onClick={() => act('cancel', 'decision', { choice: 'cancel' })}><Ban size={14} /> {contract ? 'Terminate (start review)' : 'Cancel'}</Btn>
              {c.status === 'open' && <Btn busy={busy === 'review'} onClick={() => act('review', 'decision', { choice: 'needs_review' })}>Needs review</Btn>}
            </div>
          </Box>
        )}

        {['renew_review', 'cancel_review'].includes(c.status) && (
          <ProposalForm c={c} contract={contract} employee={d.employee} busy={busy}
            onSave={(body) => act('save', 'proposal', body)} onSubmit={() => act('submit', 'submit')} />
        )}

        {c.proposal && !['renew_review', 'cancel_review'].includes(c.status) && <ProposalView p={c.proposal} />}

        {c.status === 'awaiting_approval' && <Approval busy={busy} onApprove={() => act('approve', 'approve')} onReject={(note) => act('reject', 'reject', { note })} />}

        {['approved', 'with_pro'].includes(c.status) && <TaskForm pros={d.pros} c={c} busy={busy} onCreate={(body) => act('task', 'tasks', body)} />}
        {d.tasks.length > 0 && <Tasks tasks={d.tasks} />}

        {c.status === 'checking_documents' && (
          <Papers returned={d.returned} events={d.events} busy={busy}
            onCheck={(docId) => act(`check-${docId}`, `papers/${docId}/check`)} onVerify={(docId) => act(`verify-${docId}`, 'verify', { document_id: docId })} />
        )}
        {c.status === 'writing_back' && <Box title="Next: update saifsys"><p className="text-sm text-mute">The new terms are verified. Writing them back to saifsys comes in the next step of this module.</p></Box>}

        {!c.closed_at && (
          <div className="flex flex-wrap gap-2">
            {c.status === 'paused'
              ? <Btn busy={busy === 'resume'} onClick={() => act('resume', 'resume')}><Play size={14} /> Resume</Btn>
              : <Btn busy={busy === 'pause'} onClick={() => { const r = window.prompt('Why pause it? (missing information, dispute…)'); if (r) act('pause', 'pause', { reason: r }); }}><Pause size={14} /> Pause</Btn>}
            <Btn busy={busy === 'oos'} onClick={() => { const r = window.prompt('Why is this out of scope?'); if (r) act('oos', 'out-of-scope', { reason: r }); }}><X size={14} /> Out of scope</Btn>
          </div>
        )}
        {c.closed_at && <p className="rounded-xl bg-ok/10 p-3 text-sm text-ok">Closed: {c.closed_note}</p>}

        <Timeline events={d.events} />
      </div>
    </Page>
  );
}

function Compare({ compare }) {
  const label = { basic: 'Basic', allowance: 'Allowance', bonus: 'Bonus', total: 'Total', paid_by: 'Paid by' };
  const flag = { differs: ['Differs', 'bad'], missing: ['Missing', 'warn'], outdated: ['Old payroll', 'warn'], total_mismatch: ['Total ≠ sum', 'bad'] };
  return (
    <Box title="Contract terms against payroll" icon={<Sparkles size={15} />}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-mute"><th className="py-1 pr-3 font-normal">Item</th><th className="pr-3 font-normal">Employee record</th><th className="pr-3 font-normal">Payroll</th><th className="font-normal" /></tr></thead>
          <tbody>
            {compare.rows.map((r) => (
              <tr key={r.field} className="border-t border-stroke/50">
                <td className="py-1.5 pr-3">{label[r.field]}</td>
                <td className="pr-3">{r.field === 'paid_by' ? (r.contract || '—') : aed(r.contract)}</td>
                <td className="pr-3">{r.field === 'paid_by' ? (r.payroll || '—') : aed(r.payroll)}</td>
                <td>{r.flag && <span className={`rounded-full px-2 py-0.5 text-xs ${TONE[flag[r.flag][1]]}`}>{flag[r.flag][0]}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {compare.rows[0]?.period && <p className="text-xs text-mute">Payroll: {compare.rows[0].period} · {compare.rows[0].source}</p>}
      {compare.flags.map((f) => <p key={f} className="flex items-start gap-1.5 text-xs text-warn"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {f}</p>)}
    </Box>
  );
}

/** The "Start the renewal" form: keep or update the terms with quick picks, or the cancellation's details. */
function ProposalForm({ c, contract, employee, busy, onSave, onSubmit }) {
  const s = employee?.salary || {};
  const old = c.proposal?.terms || {};
  const [mode, setMode] = useState(c.proposal?.mode || (c.kind === 'cancel' ? 'cancel' : contract ? 'keep' : 'renew_document'));
  const [t, setT] = useState({
    basic: old.basic ?? s.basic ?? '', allowance: old.allowance ?? s.allowance ?? '', bonus: old.bonus ?? '',
    position: old.position ?? employee?.position ?? '', location: old.location ?? employee?.location ?? '', hours: old.hours ?? '', benefits: old.benefits ?? '',
    new_start: old.new_start ?? c.ends_on ?? '', new_end: old.new_end ?? (c.ends_on ? addYears(c.ends_on, 2) : ''), effective_date: old.effective_date ?? c.ends_on ?? '',
    expected_expiry: old.expected_expiry ?? (c.ends_on ? addYears(c.ends_on, 2) : ''),
    reason: old.reason ?? '', last_working_day: old.last_working_day ?? c.ends_on ?? '', notice_days: old.notice_days ?? 30, notice_given_on: old.notice_given_on ?? '',
  });
  const [pct, setPct] = useState(0);
  const [note, setNote] = useState(c.proposal?.note || '');
  const set = (k) => (e) => setT((x) => ({ ...x, [k]: e.target.value }));
  const base = Number(s.basic) || 0;
  const raise = (p) => { setPct(p); setT((x) => ({ ...x, basic: Math.round(base * (1 + p / 100)) })); };
  const total = (Number(t.basic) || 0) + (Number(t.allowance) || 0) + (Number(t.bonus) || 0);
  const save = () => onSave({ mode, terms: t, note });

  return (
    <Box title={c.kind === 'cancel' ? (contract ? 'Start the termination review' : 'Start the cancellation') : 'Start the renewal'} icon={<ClipboardList size={15} />}>
      {c.kind === 'renew' && contract && (
        <Chips items={[['Keep the terms', 'keep'], ['Update the terms', 'update'], ['Resolve the differences first', 'resolve_first']]} active={mode} onPick={setMode} />
      )}

      {c.kind === 'renew' && contract && mode === 'update' && (
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-mute">Increase on basic (now {aed(base)})</p>
            <Chips items={[['0%', 0], ['5%', 5], ['10%', 10], ['15%', 15], ['20%', 20]]} active={pct} onPick={raise} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Basic"><input inputMode="numeric" value={t.basic} onChange={set('basic')} className={input} /></Field>
            <Field label="Allowance"><input inputMode="numeric" value={t.allowance} onChange={set('allowance')} className={input} /></Field>
            <Field label="Bonus"><input inputMode="numeric" value={t.bonus} onChange={set('bonus')} className={input} /></Field>
          </div>
          <p className="rounded-xl bg-white/5 px-3 py-2 text-sm">New monthly total <b>{aed(total)}</b>{s.total ? <span className="text-mute"> (now {aed(s.total)})</span> : null}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Job title"><input value={t.position} onChange={set('position')} className={input} /></Field>
            <Field label="Work location"><input value={t.location} onChange={set('location')} className={input} /></Field>
            <Field label="Hours"><input value={t.hours} onChange={set('hours')} placeholder="e.g. 48 a week" className={input} /></Field>
            <Field label="Benefits"><input value={t.benefits} onChange={set('benefits')} placeholder="housing, transport…" className={input} /></Field>
          </div>
        </div>
      )}

      {c.kind === 'renew' && contract && mode !== 'resolve_first' && (
        <div className="space-y-2">
          <p className="text-xs text-mute">New contract period</p>
          <Chips items={[['1 year', 1], ['2 years', 2], ['3 years', 3]]} onPick={(n) => setT((x) => ({ ...x, new_end: addYears(x.new_start || c.ends_on, n) }))} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="Starts"><input type="date" value={t.new_start} onChange={set('new_start')} className={input} /></Field>
            <Field label="Ends"><input type="date" value={t.new_end} onChange={set('new_end')} className={input} /></Field>
            <Field label="New terms from"><input type="date" value={t.effective_date} onChange={set('effective_date')} className={input} /></Field>
          </div>
        </div>
      )}

      {c.kind === 'renew' && !contract && (
        <div className="space-y-2">
          <p className="text-xs text-mute">Expected new expiry</p>
          <Chips items={[['1 year', 1], ['2 years', 2], ['3 years', 3], ['5 years', 5], ['10 years', 10]]} onPick={(n) => setT((x) => ({ ...x, expected_expiry: addYears(c.ends_on, n) }))} />
          <input type="date" value={t.expected_expiry} onChange={set('expected_expiry')} className={input} />
        </div>
      )}

      {c.kind === 'cancel' && (
        <div className="space-y-2">
          <Field label="Reason"><input value={t.reason} onChange={set('reason')} placeholder={contract ? 'Resigned, not renewed, terminated…' : 'Left the company…'} className={input} /></Field>
          {contract && (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Last working day"><input type="date" value={t.last_working_day} onChange={set('last_working_day')} className={input} /></Field>
              <Field label="Notice (days)"><input inputMode="numeric" value={t.notice_days} onChange={set('notice_days')} className={input} /></Field>
              <Field label="Notice given on"><input type="date" value={t.notice_given_on} onChange={set('notice_given_on')} className={input} /></Field>
            </div>
          )}
        </div>
      )}

      <Field label="Note"><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={input} /></Field>
      <div className="flex flex-wrap gap-2">
        <Btn busy={busy === 'save'} onClick={save}><Check size={14} /> {mode === 'resolve_first' ? 'Pause to resolve' : 'Save the proposal'}</Btn>
        {c.proposal && mode !== 'resolve_first' && <Btn primary busy={busy === 'submit'} onClick={onSubmit}><Send size={14} /> Send for approval</Btn>}
      </div>
    </Box>
  );
}

function ProposalView({ p }) {
  const t = p.terms || {};
  const rows = [['Basic', t.basic != null && aed(t.basic)], ['Allowance', t.allowance != null && aed(t.allowance)], ['Bonus', t.bonus != null && aed(t.bonus)],
    ['Job title', t.position], ['Work location', t.location], ['Hours', t.hours], ['Benefits', t.benefits], ['Starts', day(t.new_start)], ['Ends', day(t.new_end)],
    ['New terms from', day(t.effective_date)], ['Expected new expiry', day(t.expected_expiry)], ['Reason', t.reason], ['Last working day', day(t.last_working_day)],
    ['Notice', t.notice_days ? `${t.notice_days} days` : null], ['Notice given on', day(t.notice_given_on)]].filter(([, v]) => v);
  const mode = { keep: 'Keep the terms', update: 'Update the terms', renew_document: 'Renew', cancel: 'Cancel' }[p.mode] || p.mode;
  return (
    <Box title={`Proposal: ${mode}`}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {rows.map(([k, v]) => <div key={k}><p className="text-xs text-mute">{k}</p><p>{v}</p></div>)}
      </div>
      {p.note && <p className="text-sm text-mute">“{p.note}”</p>}
    </Box>
  );
}

function Approval({ busy, onApprove, onReject }) {
  return (
    <Box title="Approval" icon={<ShieldCheck size={15} />}>
      <p className="text-sm text-mute">The approvers (or the master) approve it. Whoever proposed it cannot approve it.</p>
      <div className="flex flex-wrap gap-2">
        <Btn primary busy={busy === 'approve'} onClick={onApprove}><Check size={14} /> Approve</Btn>
        <Btn danger busy={busy === 'reject'} onClick={() => { const n = window.prompt('Why is it rejected?'); if (n) onReject(n); }}><X size={14} /> Reject</Btn>
      </div>
    </Box>
  );
}

function TaskForm({ pros, c, busy, onCreate }) {
  const [pro, setPro] = useState('');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  if (!pros.length) return <Box title="Give it to the PRO"><p className="text-sm text-warn">No PRO is set yet. The master adds the PROs under Settings on the Document Renewals screen.</p></Box>;
  return (
    <Box title="Give it to the PRO" icon={<Send size={15} />}>
      <Picker value={pro} onChange={setPro} options={pros.map((p) => ({ value: String(p.id), label: p.name || p.email }))} placeholder="Choose the PRO" />
      <Field label="Instructions"><textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} className={input}
        placeholder={c.kind === 'cancel' ? 'Cancel the visa and labour card…' : 'Renew the visa at ICP, bring back the new visa page…'} /></Field>
      <Field label="Due"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={input} /></Field>
      <Btn primary disabled={!pro} busy={busy === 'task'} onClick={() => onCreate({ assignee_id: Number(pro), kind: c.kind === 'cancel' ? 'cancellation' : 'renewal', instructions, due_date: due })}>
        <Send size={14} /> Send the task
      </Btn>
      <p className="text-xs text-mute">The PRO gets a notification with a link, never the papers; they see this case&apos;s papers only while the task is open.</p>
    </Box>
  );
}

function Tasks({ tasks }) {
  return (
    <Box title="PRO tasks">
      <ul className="space-y-2 text-sm">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2">
            <span className={`mt-0.5 rounded-full px-2 py-0.5 text-xs ${t.status === 'done' ? TONE.ok : t.status === 'blocked' ? TONE.bad : TONE.p1}`}>{t.status}</span>
            <span className="flex-1">{t.assignee_name}: {t.instructions || t.kind} <span className="text-mute">· due {day(t.due_date)}</span>
              {t.evidence?.blocked && <span className="block text-bad">Stuck: {t.evidence.blocked}</span>}
              {t.evidence?.note && <span className="block text-mute">“{t.evidence.note}”</span>}</span>
          </li>
        ))}
      </ul>
    </Box>
  );
}

function Papers({ returned, events, busy, onCheck, onVerify }) {
  const checks = events.filter((e) => e.kind === 'papers');
  return (
    <Box title="The papers that came back" icon={<ShieldCheck size={15} />}>
      {!returned.length && <p className="text-sm text-mute">The PRO did not upload anything.</p>}
      {returned.map((r) => {
        const check = checks.find((e) => e.detail.document_id === r.id);
        return (
          <div key={r.id} className="space-y-2 rounded-xl bg-white/5 p-3">
            <div className="flex items-center gap-2 text-sm">
              <a href={`/api/documents/${r.id}/file`} target="_blank" rel="noreferrer" className="flex-1 truncate hover:underline">{r.title || r.name}</a>
              <span className="text-xs text-mute">{r.expires_on ? `runs to ${day(r.expires_on)}` : 'no date read yet'}</span>
            </div>
            {check && (check.detail.ok
              ? <p className="text-xs text-ok">Reem found nothing wrong.</p>
              : check.detail.problems.map((p) => <p key={p} className="flex items-start gap-1.5 text-xs text-warn"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {p}</p>))}
            <div className="flex flex-wrap gap-2">
              <Btn busy={busy === `check-${r.id}`} onClick={() => onCheck(r.id)}><Sparkles size={14} /> Check with Reem</Btn>
              <Btn primary busy={busy === `verify-${r.id}`} onClick={() => onVerify(r.id)}><Check size={14} /> Verified</Btn>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-mute">Verified is always a person&apos;s tick: it confirms the new date and replaces the old document.</p>
    </Box>
  );
}

const EVENT = {
  opened: 'Case opened', decision: 'Decision', proposal: 'Proposal saved', submitted: 'Sent for approval', approved: 'Approved', rejected: 'Rejected',
  task: 'Task given to the PRO', task_file: 'PRO uploaded a paper', task_done: 'PRO finished', task_blocked: 'PRO is stuck', papers: 'Reem checked a paper',
  verified: 'Verified', paused: 'Paused', resumed: 'Resumed', moved: 'Moved to the newer document', closed: 'Closed',
};
function Timeline({ events }) {
  return (
    <Box title="Timeline">
      <ul className="space-y-1.5 text-sm">
        {events.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-28 shrink-0 text-xs text-mute">{when(e.at)}</span>
            <span className="flex-1">{EVENT[e.kind] || e.kind}{e.detail?.choice ? `: ${e.detail.choice.replace('_', ' ')}` : ''}{e.detail?.note ? ` — “${e.detail.note}”` : ''}{e.detail?.reason ? ` — ${e.detail.reason}` : ''}
              <span className="text-mute"> · {e.user_name || 'Reem'}</span></span>
          </li>
        ))}
      </ul>
    </Box>
  );
}
