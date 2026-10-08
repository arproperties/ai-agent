import { typePhone } from '../lib/usFormat';

// The one box for a phone number. The dashes go in as it is typed, 555-123-4567, and it
// stops at ten digits. A number begun with + has its own country code and is left as typed.
// onChange gets the same `e.target.value` an input would give, so a form's setters fit.

export default function PhoneField({ value, onChange, ...rest }) {
  return <input type="tel" inputMode="tel" autoComplete="tel" placeholder="555-123-4567" {...rest}
    value={value ?? ''} onChange={(e) => onChange?.({ target: { value: typePhone(e.target.value) } })} />;
}
