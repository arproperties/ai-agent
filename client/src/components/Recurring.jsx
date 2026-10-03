import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, FileText, Loader2, Paperclip, Pencil, Plus, Trash2, Wallet, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import Picker from './Picker';

// Recurring: receivables (money owed to the office) and payables (money the office owes).
// Each side has its own chart of accounts - a parent (the company) and the accounts under
// it - kept here and nowhere else. The page's side decides which chart is used, so a
// receivable can never land on a payable account. The server is server/recurring.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const LABEL = 'text-[11px] font-medium tracking-[0.14em] text-mute';
const SIDE = {
  receivable: { tab: 'Receivables', one: 'receivable', empty: 'Money that is owed to you: who owes it, how much, and when it is due.' },
  payable: { tab: 'Payables', one: 'payable', empty: 'Money you owe: to whom, how much, and when it is due.' },
};
const METHOD = { cash: 'Cash', bank: 'Bank transfer', cheque: 'Cheque' };
const STATUS = { pending: 'Pending', overdue: 'Overdue', paid: 'Paid' };
const TONE = { pending: 'bg-warn/20 text-warn', overdue: 'bg-bad/20 text-bad', paid: 'bg-ok/20 text-ok' };
const money = (n) => `AED ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const fileUrl = (side, e) => `/api/recurring/${side}/entries/${e.id}/file?v=${e.updated_at}`;

/** Two or three choices side by side, in place of a dropdown. */
function Switch({ value, onChange, options, tone }) {
  return (
    <div className="flex rounded-full bg-white/5 p-0.5 text-sm">
      {Object.entries(options).map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)} aria-pressed={value === k}
          className={`flex-1 rounded-full px-3 py-1.5 transition ${value === k ? (tone?.[k] || 'bg-white/15 text-txt') : 'text-mute hover:text-txt'}`}>{l}</button>
      ))}
    </div>
  );
}

// A phone photo is several megabytes; a receipt reads fine at a fraction of that.
const MAX_SIDE = 2000;
async function shrink(file) {
  if (!file.type.startsWith('image/')) return file;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error('That picture could not be read'))), 'image/jpeg', 0.85));
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'attachment'}.jpg`, { type: 'image/jpeg' });
}

// ---------- the chart of accounts ----------

function NameBox({ start = '', placeholder, onSave, onCancel }) {
  const [name, setName] = useState(start);
  return (
    <div className="flex gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={placeholder} autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name); if (e.key === 'Escape') onCancel(); }}
        className="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-p1/70" />
      <button type="button" onClick={() => onSave(name)} disabled={!name.trim()} className="rounded-full border border-stroke px-3 text-sm text-mute hover:text-txt disabled:opacity-50">Save</button>
      <button type="button" onClick={onCancel} aria-label="Cancel" className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><X size={14} /></button>
    </div>
  );
}

function AccountLine({ row, parent, onRename, onHide, onRemove }) {
  const btn = 'grid size-7 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10';
  return (
    <div className={`flex items-center gap-1 ${row.hidden ? 'opacity-50' : ''}`}>
      <p className={`min-w-0 flex-1 truncate ${parent ? 'font-medium' : 'text-sm'}`}>
        {row.name}
        {row.hidden && <span className="ml-2 text-xs text-mute">hidden</span>}
        {row.entries > 0 && <span className="ml-2 text-xs text-mute">{row.entries} {row.entries === 1 ? 'entry' : 'entries'}</span>}
      </p>
      <button onClick={onRename} aria-label={`Rename ${row.name}`} title="Rename" className={`${btn} hover:text-txt`}><Pencil size={13} /></button>
      {!parent && (
        <button onClick={onHide} aria-label={row.hidden ? `Show ${row.name}` : `Hide ${row.name}`} title={row.hidden ? 'Bring back' : 'Hide from the list'} className={`${btn} hover:text-txt`}>
          {row.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      )}
      <button onClick={onRemove} aria-label={`Remove ${row.name}`} title="Remove" className={`${btn} hover:text-bad`}><Trash2 size={13} /></button>
    </div>
  );
}

function Chart({ side, chart, onChanged }) {
  const [typing, setTyping] = useState(null); // { parent?: id, rename?: row } - the one name box that is open
  const [error, setError] = useState('');
  const act = async (fn) => {
    setError('');
    try { await fn(); setTyping(null); await onChanged(); } catch (e) { setError(e.message); }
  };
  const add = (parentId) => (name) => act(() => api.post(`/recurring/${side}/accounts`, { name, parent_id: parentId }));
  const rename = (row) => (name) => act(() => api.put(`/recurring/${side}/accounts/${row.id}`, { name }));
  const hide = (row) => act(() => api.put(`/recurring/${side}/accounts/${row.id}`, { hidden: !row.hidden }));
  const remove = (row) => confirm(`Remove "${row.name}"?`) && act(() => api.del(`/recurring/${side}/accounts/${row.id}`));
  const line = (row, parent) => (typing?.rename?.id === row.id
    ? <NameBox start={row.name} placeholder="Name" onSave={rename(row)} onCancel={() => setTyping(null)} />
    : <AccountLine row={row} parent={parent} onRename={() => setTyping({ rename: row })} onHide={() => hide(row)} onRemove={() => remove(row)} />);

  return (
    <div className="space-y-3">
      <p className="text-sm text-mute">
        The {SIDE[side].one} accounts. A parent account is the company; under it are its accounts, like "Cash to Mr Tauqeer".
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {chart.map((p) => (
        <section key={p.id} className="space-y-2 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
          {line(p, true)}
          <div className="space-y-1.5 border-l border-stroke/60 pl-3">
            {p.accounts.map((a) => <div key={a.id}>{line(a, false)}</div>)}
            {p.accounts.length === 0 && typing?.parent !== p.id && <p className="text-xs text-mute">No accounts under it yet.</p>}
            {typing?.parent === p.id
              ? <NameBox placeholder="e.g. Cash to Mr Tauqeer" onSave={add(p.id)} onCancel={() => setTyping(null)} />
              : <button onClick={() => setTyping({ parent: p.id })} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> Add account</button>}
          </div>
        </section>
      ))}
      {typing?.parent === 0
        ? <NameBox placeholder="Parent account, e.g. the company's name" onSave={add(null)} onCancel={() => setTyping(null)} />
        : (
          <button onClick={() => setTyping({ parent: 0 })}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
            <Plus size={16} /> Add parent account
          </button>
        )}
    </div>
  );
}

// ---------- adding or changing one entry ----------

function EntryForm({ side, chart, start, onSaved, onCancel, onAccounts }) {
  const [account, setAccount] = useState(start?.account_id || '');
  const [amount, setAmount] = useState(start ? String(start.amount) : '');
  const [method, setMethod] = useState(start?.method || 'cash');
  const [status, setStatus] = useState(start?.status === 'paid' ? 'paid' : 'pending');
  const [due, setDue] = useState(start?.due_date || '');
  const [note, setNote] = useState(start?.note || '');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const input = useRef(null);

  // Hidden accounts are left out, except the one this entry is already on.
  const accounts = useMemo(() => chart.flatMap((p) => p.accounts.filter((a) => !a.hidden || a.id === start?.account_id)
    .map((a) => ({ value: a.id, label: a.name, group: p.name }))), [chart, start]);

  const act = async (what, fn) => {
    if (busy) return;
    setBusy(what); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const pickFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) act('file', async () => setFile(await shrink(f)));
  };
  const save = (e) => {
    e.preventDefault();
    act('save', async () => {
      const form = new FormData();
      Object.entries({ account_id: account, amount, method, status, due_date: due, note }).forEach(([k, v]) => form.append(k, v));
      if (file) form.append('file', file, file.name);
      await api.upload(`/recurring/${side}/entries${start ? `/${start.id}` : ''}`, form, start ? 'PUT' : 'POST');
      await onSaved();
    });
  };
  const remove = () => confirm(`Remove this ${SIDE[side].one}?`)
    && act('delete', async () => { await api.del(`/recurring/${side}/entries/${start.id}`); await onSaved(); });
  const ready = account && Number(amount) > 0 && due && (file || start);

  return (
    <form onSubmit={save} className="space-y-3 rounded-2xl border border-stroke/60 bg-white/[0.03] p-3">
      <div className="space-y-1">
        <span className={LABEL}>ACCOUNT</span>
        <Picker value={account} onChange={setAccount} options={accounts} placeholder="Pick the account" searchPlaceholder="Search accounts" />
        <button type="button" onClick={onAccounts} className="flex items-center gap-1 text-xs text-mute hover:text-txt"><Plus size={13} /> New account</button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className={LABEL}>AMOUNT (AED)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" inputMode="decimal" min="0" step="any" placeholder="0.00" className={FIELD} />
        </div>
        <div className="space-y-1">
          <span className={LABEL}>DUE DATE</span>
          <input value={due} onChange={(e) => setDue(e.target.value)} type="date" aria-label="Due date" className={`${FIELD} [color-scheme:dark]`} />
        </div>
      </div>

      <div className="space-y-1">
        <span className={LABEL}>PAYMENT</span>
        <Switch value={method} onChange={setMethod} options={METHOD} />
      </div>

      <div className="space-y-1">
        <span className={LABEL}>STATUS</span>
        <Switch value={status} onChange={setStatus} options={{ pending: 'Pending', paid: 'Paid' }} tone={TONE} />
      </div>

      <div className="space-y-1">
        <span className={LABEL}>ATTACHMENT <span className="tracking-normal">(required)</span></span>
        <input ref={input} type="file" accept="image/*,application/pdf" onChange={pickFile} className="hidden" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => input.current?.click()} disabled={!!busy} className="flex items-center gap-1.5 rounded-full border border-stroke px-3 py-1.5 text-sm text-mute hover:text-txt disabled:opacity-50">
            {busy === 'file' ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />} {file || start ? 'Change' : 'Add a photo or PDF'}
          </button>
          {file
            ? <span className="min-w-0 truncate text-sm text-txt/80">{file.name}</span>
            : start && <a href={fileUrl(side, start)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-sm text-p1 hover:underline"><FileText size={14} className="shrink-0" /><span className="truncate">{start.file_name}</span></a>}
        </div>
      </div>

      <div className="space-y-1">
        <span className={LABEL}>NOTE <span className="tracking-normal">(optional)</span></span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className={`${FIELD} resize-none`} />
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {start && (
          <button type="button" onClick={remove} disabled={!!busy} aria-label="Remove" title="Remove"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-stroke text-mute transition hover:border-bad/50 hover:text-bad disabled:opacity-50"><Trash2 size={16} /></button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Cancel</button>
        <button disabled={!!busy || !ready} className="rounded-full bg-gradient-to-br from-p1 to-p2 px-6 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy === 'save' ? 'Saving…' : start ? 'Save' : `Add ${SIDE[side].one}`}
        </button>
      </div>
      {start?.updated_by && <p className="text-xs text-mute">Last changed by {start.updated_by}</p>}
    </form>
  );
}

// ---------- one side ----------

function EntryRow({ side, entry, onOpen, onPaid }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/5 pr-2 transition hover:bg-white/[0.08]">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-snug">{entry.account}</p>
          <p className="truncate text-xs text-mute">{entry.parent} · {METHOD[entry.method]} · due {day(entry.due_date)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm">{money(entry.amount)}</p>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[entry.status]}`}>{STATUS[entry.status]}</span>
        </div>
      </button>
      <a href={fileUrl(side, entry)} target="_blank" rel="noreferrer" aria-label="Open the attachment" title="Attachment"
        className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Paperclip size={15} /></a>
      {entry.status !== 'paid' && (
        <button onClick={onPaid} aria-label="Mark as paid" title="Mark as paid"
          className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-ok/20 hover:text-ok"><Check size={16} /></button>
      )}
    </div>
  );
}

function Side({ side, view, setView }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const load = useCallback(() => api.get(`/recurring/${side}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [side]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <p className="text-sm text-bad">{error}</p>;
  if (!data) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  if (view === 'accounts') return <Chart side={side} chart={data.chart} onChanged={load} />;
  if (view) {
    return (
      <EntryForm side={side} chart={data.chart} start={view === 'new' ? null : view}
        onCancel={() => setView(null)} onSaved={async () => { await load(); setView(null); }} onAccounts={() => setView('accounts')} />
    );
  }

  const paid = async (e) => {
    try { await api.put(`/recurring/${side}/entries/${e.id}/status`, { status: 'paid' }); await load(); } catch (err) { setError(err.message); }
  };
  const hasAccount = data.chart.some((p) => p.accounts.some((a) => !a.hidden));
  const entries = filter === 'all' ? data.entries : data.entries.filter((e) => e.status === filter);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {Object.entries(STATUS).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(filter === k ? 'all' : k)} aria-pressed={filter === k}
            className={`rounded-2xl border px-3 py-2 text-left transition ${filter === k ? 'border-p1/60 bg-white/[0.08]' : 'border-stroke/60 bg-white/[0.03] hover:bg-white/[0.06]'}`}>
            <p className={LABEL}>{l.toUpperCase()}</p>
            <p className="truncate text-sm">{money(data.totals[k])}</p>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setView(hasAccount ? 'new' : 'accounts')}
          className="flex flex-1 items-center justify-center gap-2 rounded-full border border-stroke/70 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-txt">
          <Plus size={16} /> Add {SIDE[side].one}
        </button>
        <button onClick={() => setView('accounts')} className="rounded-full border border-stroke/70 px-4 text-sm text-mute hover:bg-white/5 hover:text-txt">Accounts</button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {data.entries.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-14 text-center">
          <span className="grid size-20 place-items-center rounded-3xl bg-gradient-to-br from-p1/25 to-p2/10 text-p1"><Wallet size={34} strokeWidth={1.4} /></span>
          <div>
            <p className="text-lg font-light">Nothing here yet</p>
            <p className="max-w-xs text-sm text-mute">{SIDE[side].empty}{!hasAccount && ' Start by adding an account.'}</p>
          </div>
        </div>
      )}
      {data.entries.length > 0 && entries.length === 0 && <p className="py-8 text-center text-sm text-mute">Nothing {STATUS[filter].toLowerCase()}.</p>}
      <div className="space-y-2">
        {entries.map((e) => <EntryRow key={e.id} side={side} entry={e} onOpen={() => setView(e)} onPaid={() => paid(e)} />)}
      </div>
    </div>
  );
}

export default function RecurringPage({ onBack }) {
  const [side, setSide] = useState('receivable');
  const [view, setView] = useState(null); // null: the list. 'accounts', 'new', or the entry being changed
  const title = view === 'accounts' ? `${SIDE[side].tab} accounts` : view ? (view === 'new' ? `New ${SIDE[side].one}` : SIDE[side].tab.slice(0, -1)) : 'Recurring';

  return (
    <Page title={title} onBack={view ? () => setView(null) : onBack}>
      <div className="space-y-3">
        {!view && <Switch value={side} onChange={setSide} options={{ receivable: SIDE.receivable.tab, payable: SIDE.payable.tab }} />}
        <Side key={side} side={side} view={view} setView={setView} />
      </div>
    </Page>
  );
}
