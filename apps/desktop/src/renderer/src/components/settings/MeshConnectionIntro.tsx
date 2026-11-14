import { useId } from 'react'

/** A connection concept, never an observation of the user's current network. */
export function MeshConnectionIntro() {
  const id = useId()
  return <div className="mesh-connection-intro">
    <div><span className="mesh-section-kicker">AgentMux Mesh</span><h3>Your devices, connected.</h3><p>Connect through a gateway, or let this device provide one. Keep working with your Agents across machines.</p></div>
    <figure className="mesh-connection-concept">
      <svg viewBox="0 0 320 100" aria-hidden="true">
        <defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="var(--surface-3, var(--surface-2))" /><stop offset="1" stopColor="var(--surface-0)" /></linearGradient></defs>
        <g fill="none" stroke="var(--text-3)" strokeWidth="1.5"><path d="M71 43h41m96 0h41"/><path d="m101 39 4 4-4 4m118-8-4 4 4 4"/></g>
        <g fill={`url(#${id})`} stroke="var(--text-3)" strokeWidth="1"><path d="M15 24h47l9 9v30H15Z"/><path d="M7 64h73l-7 7H14Z"/><path d="M249 24h47l9 9v30h-56Z"/><path d="M241 64h73l-7 7h-59Z"/></g>
        <g fill="var(--surface-1)" stroke="var(--line-strong, var(--text-3))"><path d="m112 23 12-12h72l12 12v49h-96Z"/><path d="M119 28h82v36h-82Z"/></g>
        <g fill="var(--green)" opacity=".16"><path d="M21 31h43v25H21Zm234 0h43v25h-43Z"/><path d="M124 33h72v26h-72Z"/></g>
        <path d="M125 13h69m-77 12v44m87-44v44" fill="none" stroke="var(--text)" strokeOpacity=".25" />
        <g stroke="var(--text-2)" fill="none" strokeWidth="1.5"><path d="M134 38h12v14h-12Zm40 0h12v14h-12Zm-28 7h28"/><path d="M30 38h24m-24 6h15m220-6h24m-24 6h15"/></g>
        <g fill="var(--text-3)"><circle cx="126" cy="19" r="1.5"/><circle cx="194" cy="19" r="1.5"/><circle cx="126" cy="69" r="1.5"/><circle cx="194" cy="69" r="1.5"/></g>
        <g fill="var(--text-3)" textAnchor="middle" fontSize="8" fontFamily="var(--font-mono)"><text x="43" y="89">DEVICE</text><text x="160" y="89">GATEWAY</text><text x="277" y="89">DEVICE</text></g>
      </svg>
      <figcaption>Connection concept</figcaption>
    </figure>
  </div>
}
