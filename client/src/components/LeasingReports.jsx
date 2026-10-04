import { useEffect, useState } from 'react';
import { Banknote, CalendarCheck, CalendarClock, DoorOpen, Download, FileText, Hourglass, Loader2, Printer, Table2 } from 'lucide-react';
import { api } from '../lib/api';
import Select from './Select';
import Pager, { usePaged } from './Pager';

// Leasing reports: the day's report, rent roll, overdue by age, collections, expiring leases, vacant units and
// a tenant's statement. The server (server/leasingReports.js) sends every one in the same
// shape (columns, rows, a total row and a few headline figures), so one table draws them
// all, and the same rows go out to Excel (a CSV file) or to the printer (save as PDF there).

const FIELD = 'glass h-10 w-full rounded-xl px-3.5 text-sm outline-none focus:border-p1/70';
const SELECT = `${FIELD} bg-surface`;
/** One filter: a small label over its field, so every field in the row reads and lines up the same. */
function Filter({ label, wide, children }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2 sm:w-80' : 'sm:w-52'}`}>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-mute">{label}</p>
      {children}
    </div>
  );
}
const GHOST ='flex items-center gap-1.5 rounded-full border border-stroke/70 px-3.5 py-2 text-xs text-mute hover:bg-white/5 hover:text-txt disabled:opacity-50';
// Each report: its key on the server, its name, what it is, then how the sidebar draws its
// shortcut (icon, colour, and a name short enough to sit under the disc).
export const REPORTS = [
  ['daily', 'Daily report', 'One day: the money that came in, what fell due, move-ins and move-outs, bookings made and cancelled.', CalendarCheck, 'violet', 'Daily'],
  ['rent-roll', 'Rent roll', 'Every unit: who is in it, the rent, the contract dates and what is overdue.', Table2, 'blue', 'Rent roll'],
  ['aging', 'Overdue by age', 'What each tenant owes, by how long it has been waiting.', Hourglass, 'from-orange-400 to-red-500 shadow-red-500/30', 'Overdue'],
  ['collections', 'Collections', 'Payments received between two dates, by method and by building.', Banknote, 'teal', 'Collected'],
  ['expiring', 'Expiring leases', 'Leases ending soon, and whether each is renewed.', CalendarClock, 'amber', 'Expiring'],
  ['vacancy', 'Vacant units', 'Empty units and how long each has stood empty.', DoorOpen, 'slate', 'Vacant'],
  ['statement', 'Tenant statement', 'One tenant: rent due, payments and the balance. Print it to send to them.', FileText, 'rose', 'Statement'],
];

const date = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** A value as it reads on screen and on paper. */
function show(v, kind) {
  if (v == null || v === '') return '';
  return kind === 'money' ? num(v) : kind === 'date' ? date(v) : String(v);
}
const figure = (f, cur) => (f.kind === 'money' ? `${cur} ${num(f.value)}` : f.kind === 'int' ? num(f.value) : f.value);
const right = (kind) => kind === 'money' || kind === 'int';
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The report as a CSV file, which Excel opens. Numbers stay plain so they can be summed. */
function toExcel(r) {
  // Text that starts like a formula (=, +, -, @) is written as text, so a name can never run as one in Excel.
  const cell = (v) => {
    const s = v == null ? '' : typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    [r.title], [r.subtitle], [`As of ${r.generated}, amounts in ${r.currency}`], [],
    r.columns.map((c) => c.label),
    ...r.rows.map((row) => r.columns.map((c) => row[c.key])),
    ...(Object.keys(r.total).length ? [r.columns.map((c, i) => (c.key in r.total ? r.total[c.key] : i === 0 ? 'Total' : ''))] : []),
  ];
  const url = URL.createObjectURL(new Blob([`﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${r.name}-${r.generated}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The report on plain white paper, whatever theme the app is in. "Save as PDF" is in the print dialog. */
function toPrinter(r) {
  const td = (v, c, tag = 'td') => `<${tag}${right(c.kind) ? ' class="r"' : ''}>${esc(v)}</${tag}>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font: 11px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111; margin: 0; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 2px; } p { margin: 0; color: #555; }
    .figs { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 12px 0; } .figs b { display: block; font-size: 13px; color: #111; }
    table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid #111; } .r { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 600; border-top: 1px solid #111; border-bottom: 0; } thead { display: table-header-group; } tr { break-inside: avoid; }
  </style></head><body>
    <h1>${esc(r.title)}</h1><p>${esc(r.subtitle)} · as of ${esc(date(r.generated))} · amounts in ${esc(r.currency)}</p>
    <div class="figs">${r.summary.map((f) => `<p>${esc(f.label)}<b>${esc(figure(f, r.currency))}</b></p>`).join('')}</div>
    <table><thead><tr>${r.columns.map((c) => td(c.label, c, 'th')).join('')}</tr></thead>
    <tbody>${r.rows.map((row) => `<tr>${r.columns.map((c) => td(show(row[c.key], c.kind), c)).join('')}</tr>`).join('')}</tbody>
    ${Object.keys(r.total).length ? `<tfoot><tr>${r.columns.map((c, i) => td(c.key in r.total ? show(r.total[c.key], c.kind) : i === 0 ? 'Total' : '', c)).join('')}</tr></tfoot>` : ''}
    </table></body></html>`;
  const frame = Object.assign(document.createElement('iframe'), { srcdoc: html });
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 60_000); };
  document.body.appendChild(frame);
}

export default function LeasingReports({ name = 'daily', onName: setName, onPay }) {
  const [companies, setCompanies] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [f, setF] = useState({ company_id: '', building_id: '', from: '', to: '', days: '90', tenant_id: '', day: '' });
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { api.get('/properties/companies').then(setCompanies).catch(() => {}); api.get('/leasing/tenants').then(setTenants).catch(() => {}); }, []);
  useEffect(() => {
    if (!f.company_id) return setBuildings([]);
    api.get(`/properties/companies/${f.company_id}`).then((c) => setBuildings(c.list)).catch(() => setBuildings([]));
  }, [f.company_id]);

  const waiting = name === 'statement' && !f.tenant_id;
  useEffect(() => {
    setError('');
    if (waiting) return setR(null);
    setBusy(true);
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    let stale = false;
    api.get(`/leasing/reports/${name}?${q}`).then((x) => { if (!stale) setR(x); }).catch((e) => { if (!stale) { setR(null); setError(e.message); } }).finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [name, f.company_id, f.building_id, f.from, f.to, f.days, f.tenant_id, f.day]);

  const hasTotal = r && Object.keys(r.total).length > 0;
  // The screen shows a page at a time; the total row, Excel and the printer still cover every row.
  const paged = usePaged(r?.rows, [name, ...Object.values(f)].join('|'));
  return (
    <div className="space-y-4">
      <div className="flex gap-5 overflow-x-auto border-b border-stroke text-sm">
        {REPORTS.map(([k, l, , Icon]) => (
          <button key={k} onClick={() => setName(k)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 pb-2 pt-1 transition ${name === k ? 'border-p1 text-txt' : 'border-transparent text-mute hover:text-txt'}`}>
            <Icon size={15} className={name === k ? 'text-p1' : ''} />{l}
          </button>
        ))}
      </div>

      <div className="space-y-3 rounded-2xl border border-stroke p-3 sm:p-4">
        <p className="text-sm text-mute">{REPORTS.find(([k]) => k === name)[2]}</p>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          {name === 'statement' ? (
            <Filter label="Tenant" wide>
              <Select value={f.tenant_id} onChange={set('tenant_id')} aria-label="Tenant" className={SELECT} placeholder="Choose a tenant…"
                options={tenants.map((t) => [t.id, [t.full_name, t.phone].filter(Boolean).join(' · ')])} />
            </Filter>
          ) : (
            <>
              <Filter label="Company">
                <Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, building_id: '' })} aria-label="Company" className={SELECT}
                  options={[['', 'All companies'], ...companies.map((c) => [c.id, c.name])]} />
              </Filter>
              <Filter label="Building">
                <Select value={f.building_id} onChange={set('building_id')} aria-label="Building" className={SELECT} disabled={!f.company_id}
                  options={[['', f.company_id ? 'All buildings' : 'Choose a company first'], ...buildings.map((b) => [b.id, b.name])]} />
              </Filter>
            </>
          )}
          {name === 'daily' && r && (
            <Filter label="Day"><input type="date" aria-label="Day" value={f.day || r.day || ''} max={r.generated} onChange={set('day')} className={FIELD} /></Filter>
          )}
          {name === 'collections' && r && (
            <>
              <Filter label="From"><input type="date" aria-label="From" value={f.from || r.from || ''} max={f.to || r.to} onChange={set('from')} className={FIELD} /></Filter>
              <Filter label="To"><input type="date" aria-label="To" value={f.to || r.to || ''} min={f.from || r.from} onChange={set('to')} className={FIELD} /></Filter>
            </>
          )}
          {name === 'expiring' && (
            <Filter label="Ending within" wide>
              <div className="glass flex h-10 rounded-xl p-1 text-sm">
                {['30', '60', '90'].map((d) => (
                  <button key={d} onClick={() => setF({ ...f, days: d })} className={`flex-1 rounded-lg ${f.days === d ? 'bg-p1/20 text-p1' : 'text-mute hover:text-txt'}`}>{d} days</button>
                ))}
              </div>
            </Filter>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      {waiting ? <p className="rounded-2xl border border-dashed border-stroke px-4 py-6 text-center text-sm text-mute">Choose a tenant to see their statement.</p>
        : !r ? (busy && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />) : (
          <div className={`space-y-4 transition-opacity ${busy ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <h2 className="text-lg font-light">{r.title}</h2>
                <p className="text-xs text-mute">{r.subtitle} · as of {date(r.generated)}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => toExcel(r)} className={GHOST}><Download size={14} /> Excel</button>
                <button onClick={() => toPrinter(r)} className={GHOST}><Printer size={14} /> Print / PDF</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {r.summary.map((s) => (
                <div key={s.label} className="rounded-2xl border border-stroke p-3">
                  <p className="truncate text-xs text-mute">{s.label}</p>
                  <p className="mt-1 truncate text-lg font-light tracking-tight">{figure(s, r.currency)}</p>
                </div>
              ))}
            </div>
            {r.rows.length === 0 ? <p className="rounded-2xl border border-stroke px-4 py-6 text-center text-sm text-mute">Nothing to show for this choice.</p> : (
              <div className="overflow-x-auto rounded-2xl border border-stroke">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead>
                    <tr className="border-b border-stroke text-[11px] uppercase tracking-wider text-mute">
                      {r.columns.map((c) => <th key={c.key} className={`px-3 py-2.5 font-medium ${right(c.kind) ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stroke/60">
                    {paged.rows.map((row, i) => (
                      <tr key={paged.first + i} onClick={row.booking_id && onPay ? () => onPay(row.booking_id) : undefined}
                        title={row.booking_id && onPay ? 'Open this booking’s payments' : undefined}
                        className={row.booking_id && onPay ? 'cursor-pointer hover:bg-white/[0.04]' : ''}>
                        {r.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${right(c.kind) ? 'text-right tabular-nums' : ''}`}>{show(row[c.key], c.kind) || <span className="text-mute/50">—</span>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                  {hasTotal && (
                    <tfoot>
                      <tr className="border-t border-stroke font-medium">
                        {r.columns.map((c, i) => <td key={c.key} className={`px-3 py-2.5 ${right(c.kind) ? 'text-right tabular-nums' : ''}`}>{c.key in r.total ? show(r.total[c.key], c.kind) : i === 0 ? 'Total' : ''}</td>)}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            <Pager {...paged.pager} />
            <p className="text-xs text-mute">{r.rows.length} row{r.rows.length === 1 ? '' : 's'} · amounts in {r.currency}</p>
          </div>
        )}
    </div>
  );
}
