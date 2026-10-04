import { useState } from 'react';
import { Check, Download, Loader2, Upload } from 'lucide-react';
import { api } from '../lib/api';

// Bringing the office's existing spreadsheet in (master only). The sheet is saved from
// Excel as CSV, one row per tenancy. It is checked first and every row says what is wrong
// with it; nothing is kept until every row is right, and then all of them go in together.
// The server is server/leasingImport.js.

const GHOST = 'flex items-center gap-1.5 rounded-full border border-stroke/70 px-3.5 py-2 text-xs text-mute hover:bg-white/5 hover:text-txt';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-60';
const COLUMNS = [
  ['company', 'ACE Real Estate', true], ['building', 'Park Place Tower', true], ['unit_no', '304', true], ['tenant_name', 'Ahmed Al Mansoori', true],
  ['phone', '0501234567'], ['email', ''], ['emirates_id_no', '784-1990-1234567-1'], ['start_date', '2026-01-01', true], ['end_date', '2026-12-31', true],
  ['rent_amount', '60000', true], ['rent_period', 'year'], ['payment_frequency', 'quarterly'], ['security_deposit', '5000'], ['contract_no', ''], ['rent_paid_so_far', '45000'],
];

/** CSV text → rows of cells. Handles quoted cells, and the semicolons Excel uses in some regions. */
function parse(text) {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { rows.at(-1).push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; rows.at(-1).push(cell); cell = ''; rows.push([]); }
    else cell += ch;
  }
  rows.at(-1).push(cell);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function template() {
  const url = URL.createObjectURL(new Blob([`﻿${COLUMNS.map(([k]) => k).join(',')}\r\n${COLUMNS.map(([, eg]) => eg).join(',')}\r\n`], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: 'leasing-import-template.csv' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ImportBookings({ onDone }) {
  const [rows, setRows] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const read = async (file) => {
    setError(''); setCheck(null); setRows(null); setDone(false);
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return setError('That is not a CSV file. In Excel choose File → Save As → CSV UTF-8, then pick that file.');
    const [head, ...lines] = parse(await file.text());
    const keys = (head || []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const missing = COLUMNS.filter(([k, , need]) => need && !keys.includes(k)).map(([k]) => k);
    if (missing.length) return setError(`The first row must name the columns. Missing: ${missing.join(', ')}. Use the template.`);
    const list = lines.map((l) => Object.fromEntries(keys.map((k, i) => [k, (l[i] || '').trim()])));
    if (!list.length) return setError('The sheet has no rows under the headings.');
    setRows(list);
    setBusy(true);
    try { setCheck(await api.post('/leasing/import', { rows: list })); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const commit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/leasing/import', { rows, commit: true });
      setCheck(r);
      if (r.imported) setDone(true);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (done) return (
    <div className="rounded-2xl border border-stroke p-6 text-center">
      <Check size={28} className="mx-auto text-ok" />
      <p className="mt-2">{check.total} booking{check.total === 1 ? '' : 's'} imported and confirmed.</p>
      <p className="mt-1 text-sm text-mute">Their payment schedules are written, and the rent already paid is recorded against them.</p>
      <button onClick={onDone} className={`${PRIMARY} mx-auto mt-4`}>See the bookings</button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-2xl border border-stroke p-4 text-sm">
        <p>One row for each tenancy. Companies, buildings, units and tenants that are not in the app yet are created.</p>
        <p className="text-mute">Columns: {COLUMNS.map(([k, , need]) => (need ? `${k}*` : k)).join(', ')}. Dates as 2026-01-01 or 01/01/2026. rent_period is month or year; payment_frequency is monthly, quarterly, every 6 months, yearly or upfront. rent_paid_so_far is the total rent already received, and is applied to the oldest months first.</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={template} className={GHOST}><Download size={14} /> Download the template</button>
          <label className={`${PRIMARY} cursor-pointer`}>
            <Upload size={16} /> Choose the CSV file
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { read(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      {busy && <Loader2 size={18} className="mx-auto my-4 animate-spin text-mute" />}
      {check && rows && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm">{check.failed
              ? <span className="text-bad">{check.failed} of {check.total} rows need fixing. Nothing has been imported. Correct the sheet and choose it again.</span>
              : <span className="text-ok">All {check.total} rows are good. Nothing has been imported yet.</span>}</p>
            {!check.failed && <button onClick={commit} disabled={busy} className={PRIMARY}><Upload size={16} /> Import {check.total} booking{check.total === 1 ? '' : 's'}</button>}
          </div>
          <div className="overflow-x-auto rounded-2xl border border-stroke">
            <table className="w-full whitespace-nowrap text-sm">
              <thead><tr className="border-b border-stroke text-left text-[11px] uppercase tracking-wider text-mute">
                {['Row', 'Building', 'Unit', 'Tenant', 'From', 'To', 'Rent', 'Result'].map((h) => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-stroke/60">
                {rows.map((r, i) => {
                  const res = check.results[i];
                  return (
                    <tr key={i}>
                      <td className="px-3 py-2 text-mute">{i + 2}</td>
                      <td className="px-3 py-2">{r.building}</td><td className="px-3 py-2">{r.unit_no}</td><td className="px-3 py-2">{r.tenant_name}</td>
                      <td className="px-3 py-2">{r.start_date}</td><td className="px-3 py-2">{r.end_date}</td><td className="px-3 py-2">{r.rent_amount}</td>
                      <td className={`whitespace-normal px-3 py-2 ${res?.ok ? 'text-ok' : 'text-bad'}`}>{res?.ok ? 'Good' : res?.error}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
