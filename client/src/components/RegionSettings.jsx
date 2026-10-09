import { useMemo, useState } from 'react';
import { region, saveRegion, CURRENCIES } from '../lib/region';
import Page from './Page';
import Select from './Select';

// Where the business is: its currency, time zone, phone country code and usual tax. Opened from the
// settings menu, by the master only (the server refuses anyone else). Everything in
// Leasing and Properties follows it; the server is server/leasingRegion.js.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const PRIMARY = 'flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2 text-sm font-medium text-white disabled:opacity-60';

export default function RegionSettings({ onBack }) {
  const [v, setV] = useState(region());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Dubai', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London']; } }, []);
  const put = (k) => (e) => { setNote(''); setV({ ...v, [k]: e.target.value }); };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(''); setNote('');
    try { setV(await saveRegion(v)); setNote('Saved.'); } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <Page title="Currency and time zone" onBack={onBack}>
      <form onSubmit={save} className="space-y-5 rounded-3xl border border-stroke p-5 md:p-7">
        <p className="text-sm text-mute">For the whole of Leasing and Properties: the currency on screens, reports, receipts and reminders, what counts as “today”, when the alerts’ quiet hours fall, and the country code put in front of a local phone number for WhatsApp.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Currency</span>
            <Select value={v.currency} onChange={put('currency')} className={`${FIELD} bg-surface`}
              options={[...new Set([v.currency, ...CURRENCIES.map(([k]) => k)])].map((k) => [k, CURRENCIES.find(([c]) => c === k)?.[1] || k])} /></label>
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Time zone</span>
            <Select value={v.timezone} onChange={put('timezone')} className={`${FIELD} bg-surface`} options={[...new Set([v.timezone, ...zones])].map((z) => [z, z.replace(/_/g, ' ')])} /></label>
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Phone country code</span>
            <input value={v.phone_code} onChange={put('phone_code')} inputMode="numeric" placeholder="971" className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Tax name</span>
            <input value={v.tax_name} onChange={put('tax_name')} maxLength={20} placeholder="VAT" className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-xs text-txt/80">Usual tax (%)</span>
            <input type="number" min="0" max="100" step="any" value={v.tax_percent} onChange={put('tax_percent')} placeholder="0" className={FIELD} /></label>
        </div>
        <p className="text-xs text-mute">The usual tax is what a new lease starts with, on its rent and other charges (never on the deposit). Each lease can have another rate, or none. Leave it at 0 if leases are not usually taxed.</p>
        <p className="text-xs text-mute">Changing the currency relabels the amounts; it does not convert them.</p>
        <div className="flex items-center justify-end gap-3 border-t border-stroke/60 pt-3">
          {error && <p className="mr-auto text-sm text-bad">{error}</p>}
          {note && <p className="mr-auto text-sm text-ok">{note}</p>}
          <button type="button" onClick={onBack} className="rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10">Close</button>
          <button disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Page>
  );
}
