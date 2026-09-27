import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * A password box with an eye to show what you typed. Every password field in the app
 * uses this one, so the toggle sits in the same place and behaves the same way wherever
 * you meet it.
 *
 * It takes the same props as an <input> -- value, onChange, placeholder, autoComplete,
 * required -- and passes them straight through. Only `type` is its own business.
 *
 * Showing is per-field and resets on every mount: a password revealed on the sign-in
 * screen is not still revealed the next time the screen opens.
 */
export default function PasswordField({ className = '', ...props }) {
  const [shown, setShown] = useState(false);

  return (
    <div className="relative">
      {/* pr-11 keeps the text from running underneath the button. */}
      <input {...props} type={shown ? 'text' : 'password'} className={`${className} pr-11`} />
      {/* type="button" matters: inside a form, a bare <button> submits it, so tapping
          the eye would try to sign you in with a half-typed password. */}
      <button type="button" onClick={() => setShown((s) => !s)} aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        title={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-2xl text-mute transition hover:text-txt">
        {shown ? <EyeOff size={17} strokeWidth={1.75} /> : <Eye size={17} strokeWidth={1.75} />}
      </button>
    </div>
  );
}
