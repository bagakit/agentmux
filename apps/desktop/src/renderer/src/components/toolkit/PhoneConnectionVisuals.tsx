import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { ConnectionLinkCode } from './ConnectionLinkCode'

const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')
const ThemeNetworkWifiIcon = semanticIconComponent('object.network-wifi')
const ThemeNetworkWiredIcon = semanticIconComponent('object.network-wired')
const ThemeObjectNetworkIcon = semanticIconComponent('object.network')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')

export type LinkCandidate = AgentMuxRpcResult<'device.link'>['candidates'][number]

/** Adapter kind from the OS port label first, then the device name; it only chooses an icon. */
function networkKind(candidate: LinkCandidate): 'wifi' | 'wired' | 'other' {
  const label = candidate.label?.toLowerCase() ?? ''
  if (/wi-?fi|airport|wlan|wireless/u.test(label)) return 'wifi'
  if (/lan|ethernet|thunderbolt|usb|cable/u.test(label)) return 'wired'
  return /^(eth|en[1-9])/u.test(candidate.interface) ? 'wired' : candidate.interface === 'en0' ? 'wifi' : 'other'
}
export function NetworkIcon({ candidate, size = 15 }: { candidate: LinkCandidate; size?: number }) {
  const kind = networkKind(candidate)
  return kind === 'wifi' ? <ThemeNetworkWifiIcon size={size} aria-hidden="true" /> : kind === 'wired'
    ? <ThemeNetworkWiredIcon size={size} aria-hidden="true" /> : <ThemeObjectNetworkIcon size={size} aria-hidden="true" />
}
const networkName = (candidate: LinkCandidate) => candidate.label ?? candidate.interface

/**
 * The QR code as the hero of the phone connection: a branded frame with the App mark in the middle and
 * a short reveal when the link changes. The code always encodes the exact owner-issued URL.
 */
export function PhoneConnectionCard({ url, network, state }: { url: string; network: LinkCandidate | null; state?: 'current' | 'saved' | 'updating' | undefined }) {
  return <figure className="phone-link-card" data-state={state ?? 'current'}>
    <div className="phone-link-card__frame" key={url}>
      <ConnectionLinkCode url={url} />
      <span className="phone-link-card__mark" aria-hidden="true"><ThemeObjectPhoneIcon size={18} strokeWidth={1.8} /></span>
    </div>
    <figcaption className="phone-link-card__network">
      {network ? <><NetworkIcon candidate={network} /><span>{networkName(network)}</span><code>{network.address}</code></> : <code>{new URL(url).host}</code>}
    </figcaption>
  </figure>
}

/**
 * A segmented choice of this Mac's local-network addresses. Hidden with one address; the Host's
 * preferred one carries a Recommended mark. Choosing only changes which address the next link uses.
 */
export function NetworkChoice({ candidates, value, disabled, onChoose }: { candidates: readonly LinkCandidate[]; value: string | null; disabled?: boolean | undefined; onChoose(address: string): void }) {
  if (candidates.length < 2) return null
  return <div className="phone-network-choice" role="radiogroup" aria-label="Connection network">
    {candidates.map(candidate => {
      const selected = candidate.address === value
      return <button key={candidate.address} type="button" role="radio" aria-checked={selected} data-selected={selected || undefined}
        disabled={disabled} onClick={() => { if (!selected) onChoose(candidate.address) }}
        aria-label={`${networkName(candidate)} · ${candidate.address}${candidate.preferred ? ' · recommended' : ''}`}>
        <NetworkIcon candidate={candidate} size={16} />
        <span className="phone-network-choice__text"><strong>{networkName(candidate)}</strong><small>{candidate.address}</small></span>
        {candidate.preferred ? <span className="phone-network-choice__badge">Recommended</span> : null}
        {selected ? <ThemeActionConfirmIcon className="phone-network-choice__check" size={14} aria-hidden="true" /> : null}
      </button>
    })}
  </div>
}

/** First-time steps; once any device has connected this collapses to nothing. */
export function PhoneConnectionSteps() {
  return <ol className="phone-connection-steps">
    <li><span>1</span>Put your phone on the same network as this Mac</li>
    <li><span>2</span>Scan the code, or open the link on your phone</li>
    <li><span>3</span>Your agents are on your phone</li>
  </ol>
}

/** Live presence: a breathing dot only for a device the Host confirms online. */
export function DevicePresence({ online }: { online: boolean | undefined }) {
  return <span className="phone-device-presence" data-online={online === true ? 'true' : online === false ? 'false' : 'unknown'} aria-hidden="true" />
}
