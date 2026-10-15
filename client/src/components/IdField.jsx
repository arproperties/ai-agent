import Select from './Select';

// An ID number with the US state that issued it in front: "TX 12345678". Both live in
// the one text the tenant row already has, so search finds "TX" and old IDs still read.
export const STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'],
  ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'],
  ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'],
  ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
];
const CODES = new Set(STATES.map(([c]) => c));

// "TX 12345678" → ['TX', '12345678']; an ID saved before the prefix has no state.
export function splitId(value = '') {
  const m = /^([A-Z]{2}) (.*)$/.exec(value || '');
  return m && CODES.has(m[1]) ? [m[1], m[2]] : ['', value || ''];
}

export default function IdField({ value, onChange, className = '' }) {
  const [state, no] = splitId(value);
  const send = (s, n) => onChange({ target: { value: s && n ? `${s} ${n}` : s ? `${s} ` : n } });
  return (
    <span className="flex gap-2">
      <Select value={state} onChange={(e) => send(e.target.value, no.trim())} placeholder="State" aria-label="State"
        options={[['', 'No state'], ...STATES.map(([c, n]) => [c, `${c} · ${n}`])]} className={className} wrap="w-40 shrink-0" />
      <input value={no} onChange={(e) => send(state, e.target.value)} aria-label="ID no." className={className} />
    </span>
  );
}
