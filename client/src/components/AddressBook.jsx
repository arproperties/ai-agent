import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Lock } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// The company address book, the master's alone (server/addressBook.js). The built-in
// mailboxes are written into the code and only shown; the ones added here, or from a chat
// card, can be removed again.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';

export default function AddressBookPage({ onBack }) {
  const [book, setBook] = useState(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/address-book').then(setBook).catch((e) => { setError(e.message); setBook({ builtIn: [], added: [] }); });
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError('');
    try { await api.post('/address-book', { email }); setEmail(''); load(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const remove = async (r) => {
    if (!confirm(`Remove ${r.email} from the address book?`)) return;
    try { await api.del(`/address-book/${r.id}`); load(); } catch (err) { setError(err.message); }
  };

  return (
    <Page title="Address book" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        Reem only sends to company addresses (ainalreempro.com, madaralwadi.com) that are listed here, so a guessed one never goes out.
        Outside addresses always work and don't need adding.
      </p>

      <form onSubmit={add} className="mb-2 flex gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoCapitalize="none"
          placeholder="name@madaralwadi.com" className={FIELD} />
        <button disabled={busy || !email.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-5 text-sm font-medium text-white disabled:opacity-60">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
        </button>
      </form>
      {error && <p className="mb-2 text-sm text-bad">{error}</p>}

      {book === null ? <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" /> : (
        <>
          <h2 className="mb-2 mt-6 text-xs font-medium tracking-[0.12em] text-mute">ADDED</h2>
          {book.added.length === 0 && <p className="py-2 text-sm text-mute">None yet.</p>}
          <div className="space-y-1.5">
            {book.added.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-2">
                <span className="min-w-0 flex-1 break-all text-sm">{r.email}</span>
                <button onClick={() => remove(r)} aria-label={`Remove ${r.email}`} title="Remove"
                  className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>

          <h2 className="mb-2 mt-6 flex items-center gap-1.5 text-xs font-medium tracking-[0.12em] text-mute">
            <Lock size={11} /> BUILT IN
          </h2>
          <div className="space-y-1.5">
            {book.builtIn.map((a) => <div key={a} className="break-all rounded-2xl bg-white/[0.03] px-4 py-2 text-sm text-txt/80">{a}</div>)}
          </div>
        </>
      )}
    </Page>
  );
}
