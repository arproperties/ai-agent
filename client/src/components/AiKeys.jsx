import { useEffect, useState } from 'react';
import { Loader2, KeyRound, Trash2, Check } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';

// The AI keys (server/aiKeys.js), the master's alone. The company keys are set here in
// Settings; a person's own keys on their profile in People, and win for that person.
// Whatever is not set falls back: own → company → the server's .env, which stays as it is.
// The keys never come back to the browser: only their last four characters.

const FIELD = 'glass w-full rounded-xl px-3.5 py-2.5 outline-none focus:border-p1/70';
const PROVIDERS = [
  ['anthropic', 'Claude', 'Chat, reading files, everything Reem writes', 'sk-ant-…'],
  ['openai', 'OpenAI', 'Voice notes, reading aloud, meetings, pictures', 'sk-…'],
];
const SOURCE = { company: 'the company key', server: 'the server key (.env)' };
const day = (s) => new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function KeyBox({ owner, provider, name, about, placeholder, info, onSaved }) {
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [passed, setPassed] = useState(false);
  const key = info?.key;

  const run = async (what, fn) => {
    setBusy(what); setError(''); setPassed(false);
    try { onSaved(await fn()); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(''); }
  };
  const save = async (e) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    if (await run('save', () => api.put(`/ai-keys/${owner}/${provider}`, { key: value }))) { setValue(''); setTyping(false); }
  };
  const test = async () => { if (await run('test', () => api.post(`/ai-keys/${owner}/${provider}/test`))) setPassed(true); };
  const remove = () => confirm(`Remove this ${name} key?`) && run('remove', () => api.del(`/ai-keys/${owner}/${provider}`));

  const fallback = info?.fallback ? `${SOURCE[info.fallback.source]} …${info.fallback.last4}` : null;

  return (
    <div className="rounded-[1.25rem] border border-stroke bg-white/[0.035] p-3.5">
      <div className="flex items-center gap-2">
        <KeyRound size={15} className="shrink-0 text-mute" />
        <span className="text-sm font-medium">{name}</span>
        <span className="min-w-0 truncate text-xs text-mute">{about}</span>
      </div>

      {key && !typing ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">…{key.last4}</span>
          <span className="text-xs text-mute">set {day(key.setAt)}</span>
          <span className="flex-1" />
          <button onClick={test} disabled={!!busy} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">
            {busy === 'test' ? <Loader2 size={13} className="animate-spin" /> : passed ? <Check size={13} className="text-ok" /> : null} Test
          </button>
          <button onClick={() => setTyping(true)} className="rounded-full px-3 py-1.5 text-xs text-mute hover:bg-white/10 hover:text-txt">Change</button>
          <button onClick={remove} disabled={!!busy} aria-label={`Remove the ${name} key`} title="Remove"
            className="grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-bad">
            {busy === 'remove' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="mt-2.5 flex gap-2">
          <input value={value} onChange={(e) => setValue(e.target.value)} type="password" autoComplete="off" spellCheck={false}
            placeholder={placeholder} className={`${FIELD} font-mono text-sm`} />
          <button disabled={!!busy || !value.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-p1 to-p2 px-4 text-sm font-medium text-white disabled:opacity-60">
            {busy === 'save' && <Loader2 size={14} className="animate-spin" />} Save
          </button>
          {key && <button type="button" onClick={() => { setTyping(false); setValue(''); setError(''); }} className="shrink-0 px-2 text-sm text-mute hover:text-txt">Cancel</button>}
        </form>
      )}

      {key?.unreadable && <p className="mt-2 text-xs text-warn">This key was saved on another server and can't be read here. Set it again.</p>}
      {key?.failedAt && (
        <p className="mt-2 text-xs leading-relaxed text-warn">
          {name} turned this key down on {day(key.failedAt)}{fallback ? `, so ${fallback} was used instead` : ''}: {key.failedReason}
        </p>
      )}
      {!key && (
        <p className="mt-2 text-xs text-mute">
          {fallback ? `Not set: using ${fallback}.` : `Not set, and there is nothing to fall back on: ${name} won't work.`}
        </p>
      )}
      {info?.serverFailed && <p className="mt-1 text-xs text-warn">The server key (.env) was turned down lately: {info.serverFailed}</p>}
      {busy === 'save' && <p className="mt-2 text-xs text-mute">Checking the key with {name}…</p>}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </div>
  );
}

function KeyList({ owner }) {
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setKeys(null); setError('');
    api.get(`/ai-keys/${owner}`).then(setKeys).catch((e) => { setError(e.message); setKeys({}); });
  }, [owner]);

  if (keys === null) return <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />;
  return (
    <div className="space-y-2.5">
      {PROVIDERS.map(([p, name, about, placeholder]) => (
        <KeyBox key={p} owner={owner} provider={p} name={name} about={about} placeholder={placeholder} info={keys[p]} onSaved={setKeys} />
      ))}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

/** Settings → AI keys: the company's, used by everyone without their own. */
export default function AiKeysPage({ onBack }) {
  return (
    <Page title="AI keys" onBack={onBack}>
      <p className="mb-4 text-sm leading-relaxed text-mute">
        Everyone uses these keys, unless they have their own on their profile in People.
        If a key here is missing or stops working, Reem uses the server key (.env), which stays as it is.
      </p>
      <KeyList owner="company" />
    </Page>
  );
}

/** A person's own keys, on their profile in People. */
export function PersonAiKeys({ person }) {
  if (person.role === 'master') {
    return <p className="py-3 text-sm text-mute">Your keys are the company keys: set them in Settings → AI keys.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-mute">
        Only if {person.name} should use a different key. Leave a key empty and they use the company key; if theirs stops working, the company key is used.
      </p>
      <KeyList owner={person.id} />
    </div>
  );
}
