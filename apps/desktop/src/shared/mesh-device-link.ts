import { parseConnectionOfferUrl } from '@agentmux/relay/offer'

/** A gateway issues a complete endpoint offer at its own advertised origin. */
export function readMeshDeviceLink(input: string) {
  const url = new URL(input.trim())
  const offer = parseConnectionOfferUrl(url.href)
  if (!offer || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search ||
      url.pathname !== '/' || url.host !== offer.relay.endpoint || (url.protocol === 'https:') !== offer.relay.useTls) {
    throw new Error('Paste the complete access link issued by the gateway.')
  }
  return { url: url.href, offer }
}

/** Endpoint identity is independent of its path through a gateway. */
export function meshDeviceMapId(offer: { serverId: string; daemonPublicKeyB64: string }) {
  return 'device:' + JSON.stringify([offer.serverId, offer.daemonPublicKeyB64])
}
