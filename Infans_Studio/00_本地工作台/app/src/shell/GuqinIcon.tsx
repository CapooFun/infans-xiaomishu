/** A seven-string guqin, drawn in the same currentColor line style as shell icons. */
export function GuqinIcon() {
  return <svg width="24" height="24" viewBox="0 0 32 32" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
    <g transform="rotate(-40 16 16)" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12.5Q9 11.5 13 12.5Q16 14 19 12.3Q23 10.5 28 11.5V20.5Q23 21.5 19 19.7Q16 18 13 19.5Q9 20.5 3 19.5Z" strokeWidth="1.6"/>
      {[13.6,14.4,15.2,16,16.8,17.6,18.4].map(y=><path key={y} d={`M5 ${y}H26`} strokeWidth=".55"/>)}
      <path d="M6 12.4v7.2M25 11.5v9" strokeWidth="1.2"/>
    </g>
  </svg>;
}
