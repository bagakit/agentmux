import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { TailcatKeyRole } from '@agentmux/core'
import './tailcat-setup-flow.css'

const DeviceIcon = semanticIconComponent('object.display')

/** Setup intent only. Saved fields and prepared keys do not establish a live connection. */
export function TailcatSetupFlow({ role, peerName }: { role: TailcatKeyRole; peerName: string }) {
  const receiving = role === 'server'
  const steps = receiving ? [
    ['Prepare this Mac', 'Create or reuse its receiving key.'],
    ['Add the other Mac', 'Paste its public connection code below.'],
    ['Allow & save', 'Save incoming connections to apply access.']
  ] : [
    ['Prepare this Mac', 'Get its public connection code.'],
    ['Exchange details', 'Share your code and paste the other Mac’s private address.'],
    ['Save & test', 'Save hosts, then test this connection.']
  ]
  return <section className="tailcat-setup-flow" data-tailcat-flow={role} aria-label="Tailcat connection setup">
    <div className="tailcat-setup-flow__heading"><span>Connection direction</span><small>{receiving ? "Incoming" : "Outgoing"}</small></div>
    <div className="tailcat-setup-flow__direction" aria-label="Connection direction">
      <span><DeviceIcon size={18} /><strong>{receiving ? 'The other Mac' : 'This Mac'}</strong></span>
      <svg viewBox="0 0 64 16" aria-hidden="true"><path d="M2 8h57m-6-5 6 5-6 5" /></svg>
      <span><DeviceIcon size={18} /><strong>{receiving ? 'This Mac' : peerName}</strong></span>
    </div>
    <p className="tailcat-setup-flow__caption">Steps on this Mac</p>
    <ol aria-label="Setup steps on this Mac">{steps.map(([title, detail], index) => <li key={title}>
      <span className="tailcat-setup-flow__number" aria-hidden="true">{index + 1}</span>
      <div><strong>{title}</strong><p>{detail}</p></div>
    </li>)}</ol>
  </section>
}
