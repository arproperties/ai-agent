import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// The numbers Reem uses when you say "message Ahmed on WhatsApp" (server/whatsapp.js): seen,
// added, renamed, changed and removed by hand. Each person has their own list; nobody sees
// anyone else's. Not Reem's Memory: a number is kept here, exactly, and only removing it here
// (or telling Reem "forget Ahmed's number") takes it away.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

// 971544387902 -> +971 54 438 7902; any other country as +digits.
const shown = (phone) => {
  const m = /^971(\d{2})(\d{3})(\d{4})$/.exec(phone);
  return m ? `+971 ${m[1]} ${m[2]} ${m[3]}` : `+${phone}`;
};

function Row({ c, onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [phone, setPhone] = useState(`+${c.phone}`);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    onError('');
    try {
      await api.patch(`/whatsapp/${c.id}`, { name, phone });
      setEditing(false);
      onChanged();
    } catch (err) { onError(err.message); }
    setBusy(false);
  };
  const cancel = () => { setEditing(false); setName(c.name); setPhone(`+${c.phone}`); onError(''); };
  const remove = async () => {
    if (!confirm(`Delete ${c.name}'s number? Reem will ask for it again next time.`)) return;
    onError('');
    try { await api.del(`/whatsapp/${c.id}`); onChanged(); } catch (err) { onError(err.message); }
  };

  if (editing) {
    return (
      <form onSubmit={save} className="space-y-2 rounded-2xl bg-white/5 px-4 py-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" className={FIELD} autoFocus />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" placeholder="+971 50 123 4567" aria-label="WhatsApp number" className={FIELD} />
        <div className="flex gap-2">
          <button disabled={busy || !name.trim() || !phone.trim()}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
          </button>
          <button type="button" onClick={cancel} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-mute hover:bg-white/10 hover:text-txt">
            <X size={14} /> Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px]">{c.name}</p>
        <p className="text-sm text-mute">{shown(c.phone)}</p>
      </div>
      <button onClick={() => setEditing(true)} aria-label={`Edit ${c.name}`} title="Edit"
        className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt"><Pencil size={15} /></button>
      <button onClick={remove} aria-label={`Delete ${c.name}`} title="Delete"
        className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
    </div>
  );
}

export default function WhatsAppContactsPage({ onBack }) {
  const [rows, setRows] = useState(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/whatsapp').then(setRows).catch((e) => { setError(e.message); setRows([]); });
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (busy || !name.trim() || !phone.trim()) return;
    setBusy(true);
    setError('');
    try { await api.post('/whatsapp', { name, phone }); setName(''); setPhone(''); load(); } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <Page title="WhatsApp contacts" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        The numbers Reem uses when you say "message Ahmed on WhatsApp". Only you see them. Add one here, or just give Reem a number and a
        name in a chat and it is kept. Deleting one removes it for good; Reem asks for the number again next time. This is a separate list from Memory.
      </p>

      <form onSubmit={add} className="mb-2 space-y-2 sm:flex sm:space-y-0 sm:gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" className={FIELD} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" placeholder="050 123 4567 or +44 7911 123456" aria-label="WhatsApp number" className={FIELD} />
        <button disabled={busy || !name.trim() || !phone.trim()}
          className="flex w-full shrink-0 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60 sm:w-auto">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
        </button>
      </form>
      {error && <p className="mb-2 text-sm text-bad">{error}</p>}

      {rows === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <>
          <h2 className="mb-2 mt-6 text-xs font-medium tracking-[0.12em] text-mute">SAVED ({rows.length})</h2>
          {rows.length === 0 && <p className="py-2 text-sm text-mute">No numbers saved yet.</p>}
          <div className="space-y-1.5">
            {rows.map((c) => <Row key={c.id} c={c} onChanged={load} onError={setError} />)}
          </div>
        </>
      )}
    </Page>
  );
}
