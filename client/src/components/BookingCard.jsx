import { useState } from 'react';
import { Loader2, Check, X, CalendarPlus, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

// An ARS booking Jarvis has got ready, waiting for the person. Nothing exists in saifsys
// until Create is tapped here; saifsys then checks the unit is still free and the price
// is still this one, or makes nothing.

const STATE = {
  pending: { label: 'Ready — check it, then tap Create', tone: 'border-warn/40 bg-warn/[0.06]', dot: 'text-warn' },
  creating: { label: 'Creating in saifsys…', tone: 'border-p1/40 bg-p1/[0.06]', dot: 'text-p1' },
  created: { label: 'Created in saifsys', tone: 'border-ok/40 bg-ok/[0.06]', dot: 'text-ok' },
  cancelled: { label: 'Cancelled', tone: 'border-stroke bg-white/[0.03]', dot: 'text-mute' },
  failed: { label: 'Not created', tone: 'border-bad/40 bg-bad/[0.06]', dot: 'text-bad' },
};

const VAT = { exclusive: 'VAT on top', inclusive: 'VAT included', none: 'No VAT' };
const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function Row({ label, children, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-mute">{label}</span>
      <span className={`text-right ${strong ? 'text-[15px] font-semibold' : ''}`}>{children}</span>
    </div>
  );
}

export default function BookingCard({ booking: b, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const s = STATE[b.status] || STATE.pending;
  const q = b.quote;
  const p = q.price;
  const cur = p.currency || 'AED';

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      onChanged(await api.post(`/saifsys/ars/bookings/${b.id}/${what}`));
    } catch (e) {
      setError(e.message);
    }
    setBusy(null);
  };

  const rate = p.pricing_mode === 'nightly' ? `${money(p.rate, cur)} / night${p.custom_rate ? ' (custom)' : ''}`
    : p.pricing_mode === 'monthly_package' ? 'Monthly package' : 'Fixed total';

  return (
    <div className={`rounded-2xl border p-3.5 text-sm ${s.tone}`}>
      <p className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${s.dot}`}>
        <CalendarPlus size={13} strokeWidth={2} />
        ARS booking · {s.label}
      </p>

      <p className="text-[15px] font-medium leading-snug">
        {q.unit.building} · Unit {q.unit.unit}
      </p>
      <p className="text-[13px] text-mute">
        {q.guest.name}{q.guest.new && ' · new guest'}{q.guest.phone && ` · ${q.guest.phone}`}
      </p>

      <div className="mt-2.5 border-t border-stroke/60 pt-2.5 text-[13px]">
        <Row label="Stay">{day(q.check_in)} → {day(q.check_out)} · {q.nights} night{q.nights > 1 ? 's' : ''}</Row>
        <Row label="Guests">{q.num_guests}</Row>
        <Row label="Rate">{rate}</Row>
        {p.discount > 0 && <Row label="Discount">− {money(p.discount, cur)}</Row>}
        <Row label="VAT">{VAT[p.vat_mode]}{p.vat_amount > 0 && ` · ${money(p.vat_amount, cur)}`}</Row>
        <Row label="Total" strong>{money(p.total, cur)}</Row>
        {q.deposit > 0 && <Row label="Deposit">{money(q.deposit, cur)}</Row>}
        {q.special_requests && <Row label="Requests">{q.special_requests}</Row>}
        {q.internal_notes && <Row label="Note">{q.internal_notes}</Row>}
        <Row label="Starts as">
          {q.historical ? `Past stay · ${q.historical.replace('_', ' ')}` : `Pending${q.pending_expiry_hours ? ` · expires in ${q.pending_expiry_hours}h unless confirmed` : ''}`}
        </Row>
        <Row label="Created by">{q.created_by} · direct booking</Row>
      </div>

      {q.warnings?.length > 0 && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-warn"><AlertTriangle size={13} className="mt-px shrink-0" />{q.warnings.join(' ')}</p>
      )}
      {b.note && b.status === 'pending' && <p className="mt-2.5 text-xs text-warn">{b.note}</p>}
      {b.status === 'created' && b.result && (
        <p className="mt-2.5 text-[13px] text-ok">Booking <span className="font-semibold">{b.result.booking_number}</span> · {b.result.status}</p>
      )}
      {b.status === 'failed' && b.error && <p className="mt-2.5 text-xs text-bad">{b.error}</p>}
      {error && <p className="mt-2.5 text-xs text-bad">{error}</p>}

      {b.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button onClick={() => act('create')} disabled={!!busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 py-2 text-sm font-medium text-white shadow-lg shadow-p1/25 active:scale-[0.98] disabled:opacity-60">
            {busy === 'create' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Create
          </button>
          <button onClick={() => act('cancel')} disabled={!!busy}
            className="flex items-center justify-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm text-mute hover:border-bad/60 hover:text-bad disabled:opacity-60">
            {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} Cancel
          </button>
        </div>
      )}
    </div>
  );
}
