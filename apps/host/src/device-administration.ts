import { AgentMuxError, type AgentMuxRpcDeviceAdministration, type AgentMuxRpcDeviceResult, type AgentMuxRpcDeviceMethod, type AgentMuxRpcMobileAccessState } from '@agentmux/core'
import type { DeviceAuthority } from './device-authority.js'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'

export function createDeviceAdministration(authority: Promise<DeviceAuthority>, state: (url?: string) => AgentMuxRpcMobileAccessState,
  link: () => string): AgentMuxRpcDeviceAdministration {
  return { async call<M extends AgentMuxRpcDeviceMethod>(method: M, params: import('@agentmux/core').AgentMuxRpcDeviceParams<M>, context: import('@agentmux/core').AgentMuxRpcCallContext): Promise<AgentMuxRpcDeviceResult<M>> {
    const owner = await authority
    context.signal?.throwIfAborted()
    let result: unknown
    if (method === 'device.ls') result = { hostId: owner.hostId, devices: owner.devices(), mobileAccess: state() }
    else if (method === 'device.link') {
      const url = link(), offer = parseConnectionOfferUrl(url)
      if (!offer || offer.serverId !== owner.hostId) throw new AgentMuxError('The original Host connection offer is unavailable.', 'CONTROL_UNAVAILABLE')
      const page = new URL(url); page.hash = ''
      result = { hostId: owner.hostId, url, pageUrl: page.href, relay: { ...offer.relay }, mobileAccess: { ...state(url), origin: page.origin } }
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
