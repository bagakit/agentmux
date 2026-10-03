// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Adapted from Paseo connection-offer: framework-independent strict public DTO.
export function isLocalNetworkHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (['localhost', '::1'].includes(value) || value.endsWith('.local')) return true
  if (/^(fc|fd)[a-f0-9]{2}:/i.test(value) || /^fe[89ab][a-f0-9]:/i.test(value)) return true
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || parts[0] === 192 && parts[1] === 168 ||
      parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 169 && parts[1] === 254)
}
export type ConnectionOffer = { v: 2; serverId: string; daemonPublicKeyB64: string; relay: { endpoint: string; useTls: boolean } }
export function parseConnectionOffer(value: unknown): ConnectionOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection offer.')
  const p = value as Record<string, unknown>, relay = p.relay as Record<string, unknown> | undefined
  if (Object.keys(p).some(k => !['v', 'serverId', 'daemonPublicKeyB64', 'relay'].includes(k)) || p.v !== 2 ||
    typeof p.serverId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(p.serverId) ||
    typeof p.daemonPublicKeyB64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(p.daemonPublicKeyB64) ||
    !relay || typeof relay !== 'object' || Array.isArray(relay) || Object.keys(relay).some(k => !['endpoint','useTls'].includes(k)) ||
    typeof relay.endpoint !== 'string' || typeof relay.useTls !== 'boolean') throw new Error('Invalid connection offer.')
  const url = new URL(`${relay.useTls ? 'wss' : 'ws'}://${relay.endpoint}`)
  if (!relay.useTls && !isLocalNetworkHost(url.hostname)) throw new Error('Unencrypted Relay transport is restricted to the local network.')
  if (url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new Error('Invalid Relay address.')
  return p as ConnectionOffer
}
export function parseConnectionOfferUrl(input: string): ConnectionOffer | null {
  const url = new URL(input), fragment = new URLSearchParams(url.hash.slice(1)), encoded = fragment.get('offer')
  if (!encoded) return null
  if (encoded.length > 4096 || [...fragment.keys()].some(k => k !== 'offer') || fragment.getAll('offer').length !== 1) throw new Error('Invalid connection link.')
  const raw = encoded.replace(/-/g,'+').replace(/_/g,'/')
  const bytes = Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length/4)*4,'=')),c=>c.charCodeAt(0))
  return parseConnectionOffer(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))
}
export function connectionOfferUrl(appUrl: string, offer: ConnectionOffer): string {
  const url = new URL(appUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalNetworkHost(url.hostname))) throw new Error('The mobile application requires HTTPS outside the local network.')
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid mobile application address.')
  const bytes = new TextEncoder().encode(JSON.stringify(parseConnectionOffer(offer)))
  url.hash = 'offer='+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  return url.href
}
