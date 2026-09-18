import { useState } from 'react';
import { api } from '../lib/api';
import Orb from './Orb';

const field = 'glass w-full rounded-2xl px-4 py-3 outline-none placeholder:text-mute/70 focus:border-p1/70';

const COPY = {
  login: ['Welcome back', 'Sign in to talk to your agents', 'Sign in'],
  register: ['Create your account', 'Build your own team of AI agents', 'Create account'],
  forgot: ['Forgot your password?', "Enter your email and we'll send you a reset link", 'Send reset link'],
  reset: ['Set a new password', 'Choose a password with at least 8 characters', 'Save and sign in'],
};

export default function Auth({ inviteRequired, onAuthed }) {
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login');
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', code: '' });
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setError(''); };
  const go = (m) => { setMode(m); setError(''); setSent(false); };
  const [title, subtitle, cta] = COPY[mode];

  const submit = async (e) => {
    e.preventDefault();
    if (mode === 'reset' && f.password !== f.confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      if (mode === 'forgot') {
        await api.post('/auth/forgot', { email: f.email });
        setSent(true);
      } else if (mode === 'reset') {
        const { user } = await api.post('/auth/reset', { token: resetToken, password: f.password });
        window.history.replaceState(null, '', '/');
        onAuthed(user);
      } else {
        const { user } = await api.post(`/auth/${mode}`, f);
        onAuthed(user);
      }
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="relative z-10 flex h-dvh flex-col items-center justify-center overflow-y-auto px-6 pb-safe pt-safe">
      <form onSubmit={submit} className="rise flex w-full max-w-sm flex-col items-center gap-6">
        <Orb className="w-40" state={busy ? 'thinking' : 'idle'} />
        <div className="text-center">
          <h1 className="text-[27px] font-light leading-tight">{sent ? 'Check your email' : title}</h1>
          <p className="mt-1 text-sm text-mute">
            {sent ? `If an account exists for ${f.email}, a reset link is on its way. It works for 1 hour.` : subtitle}
          </p>
        </div>

        {(mode === 'login' || mode === 'register') && (
          <div className="grid w-full grid-cols-2 rounded-full bg-white/5 p-1 text-sm">
            {[['login', 'Sign in'], ['register', 'Create account']].map(([k, l]) => (
              <button type="button" key={k} onClick={() => go(k)}
                className={`rounded-full py-2 transition ${mode === k ? 'bg-white/15 text-txt' : 'text-mute'}`}>{l}</button>
            ))}
          </div>
        )}

        {!sent && (
          <div className="w-full space-y-3">
            {mode === 'register' && <input value={f.name} onChange={set('name')} placeholder="Your name" autoComplete="name" required className={field} />}
            {mode !== 'reset' && <input type="email" value={f.email} onChange={set('email')} placeholder="Email" autoComplete="email" required className={field} />}
            {mode !== 'forgot' && (
              <input type="password" value={f.password} onChange={set('password')}
                placeholder={mode === 'login' ? 'Password' : 'New password (8+ characters)'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? undefined : 8} required className={field} />
            )}
            {mode === 'reset' && <input type="password" value={f.confirm} onChange={set('confirm')} placeholder="Repeat new password" autoComplete="new-password" required className={field} />}
            {mode === 'register' && inviteRequired && <input value={f.code} onChange={set('code')} placeholder="Invite code" required className={field} />}
            {mode === 'login' && (
              <button type="button" onClick={() => go('forgot')} className="block w-full pt-1 text-right text-sm text-mute hover:text-txt">Forgot password?</button>
            )}
          </div>
        )}

        {error && <p className="-my-2 text-center text-sm text-bad">{error}</p>}

        {!sent && (
          <button disabled={busy} className="w-full rounded-full bg-gradient-to-br from-p1 to-p2 py-3 font-medium text-white shadow-lg shadow-p1/25 transition active:scale-[0.98] disabled:opacity-60">
            {busy ? 'Please wait…' : cta}
          </button>
        )}
        {(mode === 'forgot' || mode === 'reset') && (
          <button type="button" onClick={() => { window.history.replaceState(null, '', '/'); go('login'); }} className="-mt-2 text-sm text-mute hover:text-txt">
            ← Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}
