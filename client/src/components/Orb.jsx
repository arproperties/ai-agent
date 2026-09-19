export default function Orb({ state = 'idle', className = '' }) {
  return (
    <div className={`orb ${className}`} data-state={state}>
      <div className="bezel" />
      <div className="aura" />
      <div className="bl b5" /><div className="bl b1" /><div className="bl b2" />
      <div className="bl b3" /><div className="bl b4" />
      {/* five bars, matching the app icon */}
      <div className="wave">{Array.from({ length: 5 }, (_, i) => <i key={i} />)}</div>
    </div>
  );
}
