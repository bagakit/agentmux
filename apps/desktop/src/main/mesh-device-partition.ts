import { createHash } from 'node:crypto'
import type { ConnectionOffer } from '@agentmux/relay/offer'

export function meshDevicePartition(offer: Pick<ConnectionOffer, 'serverId' | 'daemonPublicKeyB64'>) {
  const identity = JSON.stringify([offer.serverId, offer.daemonPublicKeyB64])
  return 'persist:agentmux-mesh-device-' + createHash('sha256').update(identity).digest('hex')
}
