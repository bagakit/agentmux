import { AgentMuxError, type AgentMuxRpcMobileLinkCandidate, type AgentMuxRpcDeviceAdministration, type AgentMuxRpcDeviceResult, type AgentMuxRpcDeviceMethod, type AgentMuxRpcMobileAccessState } from '@agentmux/core'
import type { DeviceAuthority } from './device-authority.js'
import { parseConnectionLinkUrl, parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'

export function createDeviceAdministration(authority: () => Promise<DeviceAuthority>, state: (url?: string) => AgentMuxRpcMobileAccessState,
  link: (address?: string, via?: 'local' | 'gateway') => Promise<{ url: string; offer: ConnectionOffer; candidates: readonly AgentMuxRpcMobileLinkCandidate[]; access?: AgentMuxRpcMobileAccessState }>): AgentMuxRpcDeviceAdministration {
  return { async call<M extends AgentMuxRpcDeviceMethod>(method: M, params: import('@agentmux/core').AgentMuxRpcDeviceParams<M>, context: import('@agentmux/core').AgentMuxRpcCallContext): Promise<AgentMuxRpcDeviceResult<M>> {
    const owner = await authority()
    context.signal?.throwIfAborted()
    let result: unknown
    if (method === 'device.ls') result = { hostId: owner.hostId, devices: owner.devices(), mobileAccess: state() }
    else if (method === 'device.link') {
      const { address, via } = params as import('@agentmux/core').AgentMuxRpcDeviceParams<'device.link'>
      const { url, candidates, access, offer: original } = await link(address, via), offer = parseConnectionOffer(original), encoded = parseConnectionLinkUrl(url)
      if (offer.serverId !== owner.hostId || !encoded || (encoded.kind === 'pin' ? encoded.pin.daemonPublicKeyB64 !== offer.daemonPublicKeyB64
        : encoded.offer.serverId !== offer.serverId || encoded.offer.daemonPublicKeyB64 !== offer.daemonPublicKeyB64 || encoded.offer.relay.endpoint !== offer.relay.endpoint || encoded.offer.relay.useTls !== offer.relay.useTls)) throw new AgentMuxError('The original Host connection offer is unavailable.', 'CONTROL_UNAVAILABLE')
      const page = new URL(url); page.hash = ''
      if (encoded.kind === 'pin' && (offer.relay.endpoint !== page.host || offer.relay.useTls !== (page.protocol === 'https:'))) throw new AgentMuxError('The original Host connection address changed.', 'CONTROL_UNAVAILABLE')
      result = { hostId: owner.hostId, url, pageUrl: page.href, relay: { ...offer.relay }, mobileAccess: { ...(access ?? state(url)), origin: page.origin },
        ...(via === 'gateway' ? { via } : {}),
        candidates: candidates.map(candidate => ({ ...candidate })) }
    }
    else if (method === 'device.revoke') result = { hostId: owner.hostId, device: await owner.revoke((params as { deviceId: string }).deviceId) }
    else {
      const principal = context.principal
      if (principal?.kind !== 'device' || !principal.id.startsWith(owner.hostId + ':')) throw new AgentMuxError('Device principal is not admitted by this Host.', 'CONTROL_PERMISSION_DENIED')
      result = { hostId: owner.hostId, device: await owner.hello(principal.id.slice(owner.hostId.length + 1), (params as { name: string }).name) }
    }
    return result as AgentMuxRpcDeviceResult<M>
  } }
}
